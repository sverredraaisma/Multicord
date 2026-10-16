// The USB camera in a page (docs/mobile.md, section 4.2, steps 4 and 5): a document-start script native code
// injects into the page's main world (Discord's page, and Multicord's own chat views), shaped like the
// desktop's screenAudioPatch. It touches browser APIs only, never the page's own code or data:
//
// - enumerateDevices lists "USB camera (<name>)" while native code says a USB camera is attached, last, so it
//   never becomes the page's default camera; devicechange fires when it comes and goes.
// - getUserMedia for that deviceId (exact, ideal or a list) asks the original for audio only and adds a video
//   track made here; with `prefer` (Multicord's chat views, whose calls have no camera choice yet) a request
//   for video that names no device takes the USB camera too. Everything else passes through untouched.
// - The track is a MediaStreamTrackGenerator fed with VideoFrames decoded from the camera's MJPEG frames
//   (ImageDecoder), or a canvas stream where the generator is missing; getSettings and getCapabilities report
//   the camera's real size and rate.
// - Frames come from native code over a MessagePort (CameraPort.kt) that it posts to this page's origin only,
//   and only while the user turned the USB camera on for the service. They are asked for only while a USB
//   track is open ("want", then "idle"), checked (size, JPEG start) and dropped rather than queued when the
//   page is behind: the newest waiting frame replaces an older one.
//
// It does not reference anything outside its own module, and reads every global from the window it is given.

/** What native code's handover carries (CameraPort.HELLO). */
export const USB_HELLO = "multicord-usb-camera";
export const USB_DEVICE_ID = "multicord-usb-0";
export const USB_GROUP_ID = "multicord-usb-group";
/** The largest JPEG taken (UvcNative.MAX_FRAME_BYTES). */
export const MAX_JPEG = 4 * 1024 * 1024;
const MIN_JPEG = 64;
const MAX_NAME = 100;

/** A USB camera as native code describes it: attached, and whether it streams yet (its real format once it does). */
export interface UsbStatus {
  name: string;
  width: number;
  height: number;
  fps: number;
  streaming: boolean;
}

export interface UsbCameraOptions {
  /** Requests for video that name no device take the USB camera while one is attached. */
  prefer: boolean;
}

const isSize = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 8192;

/** A status message from native code: a camera, null for none, undefined when it is not one. */
export function parseStatus(text: string): UsbStatus | null | undefined {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Record<string, unknown>;
  if (m.type !== "status") return undefined;
  if (m.available === false) return null;
  const ok =
    m.available === true &&
    typeof m.streaming === "boolean" &&
    typeof m.name === "string" &&
    m.name.length > 0 &&
    m.name.length <= MAX_NAME &&
    isSize(m.width) &&
    isSize(m.height) &&
    typeof m.fps === "number" &&
    Number.isInteger(m.fps) &&
    m.fps > 0 &&
    m.fps <= 240;
  return ok ? { name: m.name as string, width: m.width as number, height: m.height as number, fps: m.fps as number, streaming: m.streaming as boolean } : undefined;
}

/** The deviceIds a constraint names: a string, a list, or {exact|ideal: either}. */
export function deviceIds(constraint: unknown): string[] {
  if (constraint === undefined || constraint === null) return [];
  if (typeof constraint === "string") return [constraint];
  if (Array.isArray(constraint)) return constraint.filter((v): v is string => typeof v === "string");
  if (typeof constraint === "object") {
    const c = constraint as { exact?: unknown; ideal?: unknown };
    return [...deviceIds(c.exact), ...deviceIds(c.ideal)];
  }
  return [];
}

/** Whether the USB camera answers a getUserMedia request: named by its id, or, with `prefer`, video naming no device. */
export function wantsUsb(constraints: MediaStreamConstraints | undefined, prefer: boolean): boolean {
  const video = constraints?.video;
  if (!video) return false;
  if (video === true) return prefer;
  const ids = deviceIds(video.deviceId);
  if (ids.includes(USB_DEVICE_ID)) return true;
  return prefer && ids.length === 0;
}

/** Whether an ArrayBuffer from the port could be one camera frame: a JPEG of sensible size. */
export function isJpegFrame(data: unknown): data is ArrayBuffer {
  if (!(data instanceof ArrayBuffer) || data.byteLength < MIN_JPEG || data.byteLength > MAX_JPEG) return false;
  const head = new Uint8Array(data, 0, 2);
  return head[0] === 0xff && head[1] === 0xd8;
}

type Image = { close(): void };
interface Sink {
  deliver(image: Image, timestamp: number): void;
  end(): void;
}

/** The globals the patch uses, read from the window it is given (tests give fakes). */
type CameraWindow = Window & {
  MediaStreamTrackGenerator?: new (init: { kind: "video" }) => MediaStreamTrack & { writable: WritableStream<unknown> };
  VideoFrame?: new (image: unknown, init: { timestamp: number }) => unknown;
  ImageDecoder?: new (init: { data: ArrayBuffer; type: string }) => { decode(): Promise<{ image: Image }>; close(): void };
  InputDeviceInfo?: { prototype: object };
  MediaStream: new () => MediaStream;
};

export function installUsbCamera(win: Window, options: UsbCameraOptions): boolean {
  const w = win as CameraWindow;
  const media = w.navigator.mediaDevices as (MediaDevices & { __multicordUsb?: true }) | undefined;
  if (!media || typeof media.getUserMedia !== "function" || media.__multicordUsb) return false;
  media.__multicordUsb = true;
  const originalGetUserMedia = media.getUserMedia;
  const originalEnumerate = media.enumerateDevices;

  let port: MessagePort | undefined;
  let status: UsbStatus | null = null;
  const sinks: Sink[] = [];
  let decoding = false;
  let pending: ArrayBuffer | undefined;

  const label = (): string => `USB camera (${status?.name ?? "unplugged"})`;
  const settings = () => {
    const s = status ?? { width: 0, height: 0, fps: 0 };
    return { deviceId: USB_DEVICE_ID, groupId: USB_GROUP_ID, width: s.width, height: s.height, frameRate: s.fps, aspectRatio: s.height ? s.width / s.height : 0, resizeMode: "none" };
  };
  const capabilities = () => {
    const s = status ?? { width: 1280, height: 720, fps: 30 };
    return {
      deviceId: USB_DEVICE_ID,
      groupId: USB_GROUP_ID,
      width: { min: 1, max: s.width },
      height: { min: 1, max: s.height },
      frameRate: { min: 1, max: s.fps },
      aspectRatio: { min: 1 / s.height, max: s.width },
      resizeMode: ["none"],
    };
  };

  const onStatus = (next: UsbStatus | null): void => {
    const was = status;
    status = next;
    // Like an unplugged camera: its tracks end.
    if (!next) for (const sink of [...sinks]) sink.end();
    if (!was !== !next) media.dispatchEvent(new Event("devicechange"));
  };

  /** JPEG to one decoded picture: ImageDecoder, or createImageBitmap where WebCodecs is missing. */
  const decodeImage = async (buffer: ArrayBuffer): Promise<Image> => {
    if (typeof w.ImageDecoder === "function") {
      const decoder = new w.ImageDecoder({ data: buffer, type: "image/jpeg" });
      try {
        return (await decoder.decode()).image;
      } finally {
        decoder.close();
      }
    }
    return w.createImageBitmap(new Blob([buffer], { type: "image/jpeg" }));
  };

  const decode = (buffer: ArrayBuffer): void => {
    decoding = true;
    const timestamp = Math.round(w.performance.now() * 1000);
    decodeImage(buffer)
      .then((image) => {
        try {
          for (const sink of sinks) sink.deliver(image, timestamp);
        } finally {
          image.close();
        }
      })
      .catch(() => {
        // A frame that does not decode is skipped; the next one may.
      })
      .then(() => {
        decoding = false;
        const next = pending;
        pending = undefined;
        if (next && sinks.length > 0) decode(next);
      });
  };

  const onPortMessage = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (typeof data === "string") {
      const next = parseStatus(data);
      if (next !== undefined) onStatus(next);
      return;
    }
    if (!isJpegFrame(data) || sinks.length === 0) return;
    // At most one frame waits: a camera should lag by one frame at most.
    if (decoding) pending = data;
    else decode(data);
  };

  // Native code's handover: a port posted to this origin's main frame. A page's own postMessage carries its
  // window as the source; native code's carries none. The page's own listeners never see it.
  w.addEventListener(
    "message",
    (event: MessageEvent) => {
      if (event.data !== USB_HELLO || event.source !== null || event.ports?.length !== 1) return;
      event.stopImmediatePropagation();
      port?.close();
      onStatus(null);
      port = event.ports[0]!;
      port.onmessage = onPortMessage;
      if (sinks.length > 0) port.postMessage("want");
    },
    true,
  );

  /** Makes a generated track look like a camera's: label, settings, capabilities, constraints, and stop. */
  const dress = (track: MediaStreamTrack, onStop: () => void): MediaStreamTrack => {
    const name = label();
    let constraints: MediaTrackConstraints = {};
    let stopped = false;
    const stop = track.stop.bind(track);
    const done = (): void => {
      if (stopped) return;
      stopped = true;
      onStop();
    };
    Object.defineProperty(track, "label", { get: () => name });
    track.getSettings = () => settings() as MediaTrackSettings;
    track.getCapabilities = () => capabilities() as MediaTrackCapabilities;
    track.getConstraints = () => ({ ...constraints });
    track.applyConstraints = async (next?: MediaTrackConstraints) => {
      constraints = next ?? {};
    };
    track.stop = () => {
      done();
      stop();
    };
    track.addEventListener("ended", done);
    return track;
  };

  const makeTrack = (): MediaStreamTrack => {
    let track: MediaStreamTrack;
    let sink: Sink;
    if (typeof w.MediaStreamTrackGenerator === "function" && typeof w.VideoFrame === "function") {
      const generator = new w.MediaStreamTrackGenerator({ kind: "video" });
      const writer = generator.writable.getWriter();
      const VideoFrame = w.VideoFrame;
      let writing = false;
      track = generator;
      sink = {
        deliver(image, timestamp) {
          // The sink is behind: drop this frame rather than queue it.
          if (writing) return;
          writing = true;
          // The generator takes the frame and closes it.
          writer.write(new VideoFrame(image, { timestamp })).then(
            () => void (writing = false),
            () => void (writing = false),
          );
        },
        end() {},
      };
    } else {
      const canvas = w.document.createElement("canvas");
      canvas.width = status!.width;
      canvas.height = status!.height;
      const context = canvas.getContext("2d")!;
      track = canvas.captureStream(status!.fps).getVideoTracks()[0]!;
      sink = {
        deliver(image) {
          context.drawImage(image as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
        },
        end() {},
      };
    }
    sink.end = () => {
      track.stop();
      track.dispatchEvent(new Event("ended"));
    };
    dress(track, () => {
      const i = sinks.indexOf(sink);
      if (i >= 0) sinks.splice(i, 1);
      if (sinks.length === 0) {
        pending = undefined;
        port?.postMessage("idle");
      }
    });
    if (sinks.length === 0) port?.postMessage("want");
    sinks.push(sink);
    return track;
  };

  const getUserMedia = async function (this: MediaDevices, constraints?: MediaStreamConstraints): Promise<MediaStream> {
    if (!wantsUsb(constraints, options.prefer)) return originalGetUserMedia.call(this, constraints);
    if (!status) {
      // Named by its id but gone; a request that only preferred it gets the phone's own camera.
      if (deviceIds((constraints!.video as MediaTrackConstraints).deviceId).includes(USB_DEVICE_ID)) throw new DOMException("The USB camera is not attached", "NotFoundError");
      return originalGetUserMedia.call(this, constraints);
    }
    const stream = constraints!.audio ? await originalGetUserMedia.call(this, { audio: constraints!.audio }) : new w.MediaStream();
    stream.addTrack(makeTrack());
    return stream;
  };

  const enumerateDevices = async function (this: MediaDevices): Promise<MediaDeviceInfo[]> {
    const devices = [...(await originalEnumerate.call(this))];
    if (!status) return devices;
    const values = { deviceId: USB_DEVICE_ID, kind: "videoinput", label: label(), groupId: USB_GROUP_ID };
    // An entry that passes `instanceof InputDeviceInfo` and serialises like a real one.
    const info = Object.create(w.InputDeviceInfo?.prototype ?? Object.prototype) as MediaDeviceInfo;
    for (const [key, value] of Object.entries(values)) Object.defineProperty(info, key, { value, enumerable: true });
    Object.defineProperty(info, "toJSON", { value: () => ({ ...values }) });
    Object.defineProperty(info, "getCapabilities", { value: capabilities });
    devices.push(info);
    return devices;
  };

  media.getUserMedia = getUserMedia;
  media.enumerateDevices = enumerateDevices;
  return true;
}
