// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { deviceIds, installUsbCamera, isJpegFrame, MAX_JPEG, parseStatus, USB_DEVICE_ID, USB_HELLO, wantsUsb } from "../../src/mobile/usbCamera";

const STATUS = { type: "status", available: true, streaming: true, name: "StreamCam", width: 1280, height: 720, fps: 30 };

function jpeg(size = 100): ArrayBuffer {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes.buffer;
}

describe("parseStatus", () => {
  it("reads a camera, or none", () => {
    expect(parseStatus(JSON.stringify(STATUS))).toEqual({ name: "StreamCam", width: 1280, height: 720, fps: 30, streaming: true });
    expect(parseStatus(JSON.stringify({ type: "status", available: false }))).toBeNull();
  });

  it("refuses anything else", () => {
    for (const bad of ["x", "null", "5", JSON.stringify({ type: "other" }), JSON.stringify({ ...STATUS, available: "yes" }), JSON.stringify({ ...STATUS, streaming: 1 }), JSON.stringify({ ...STATUS, name: "" }), JSON.stringify({ ...STATUS, name: "n".repeat(101) }), JSON.stringify({ ...STATUS, width: 0 }), JSON.stringify({ ...STATUS, height: 9000 }), JSON.stringify({ ...STATUS, fps: 1.5 }), JSON.stringify({ ...STATUS, fps: 500 }), JSON.stringify({ ...STATUS, fps: "30" })]) {
      expect(parseStatus(bad), bad).toBeUndefined();
    }
  });
});

describe("which requests take the USB camera", () => {
  it("reads deviceId constraints in every form", () => {
    expect(deviceIds(undefined)).toEqual([]);
    expect(deviceIds("a")).toEqual(["a"]);
    expect(deviceIds(["a", 5, "b"])).toEqual(["a", "b"]);
    expect(deviceIds({ exact: "a", ideal: ["b"] })).toEqual(["a", "b"]);
    expect(deviceIds(5)).toEqual([]);
  });

  it("takes requests that name it, and with prefer those that name no camera", () => {
    expect(wantsUsb({ video: { deviceId: { exact: USB_DEVICE_ID } } }, false)).toBe(true);
    expect(wantsUsb({ video: { deviceId: "front" } }, true)).toBe(false);
    expect(wantsUsb({ video: true }, false)).toBe(false);
    expect(wantsUsb({ video: true }, true)).toBe(true);
    expect(wantsUsb({ video: { width: 1280 } }, true)).toBe(true);
    expect(wantsUsb({ audio: true }, true)).toBe(false);
    expect(wantsUsb(undefined, true)).toBe(false);
  });

  it("takes only JPEG frames of a sensible size", () => {
    expect(isJpegFrame(jpeg())).toBe(true);
    expect(isJpegFrame(new ArrayBuffer(100))).toBe(false);
    expect(isJpegFrame(jpeg(10))).toBe(false);
    expect(isJpegFrame(jpeg(MAX_JPEG + 1))).toBe(false);
    expect(isJpegFrame("frame")).toBe(false);
  });
});

class FakeTrack extends EventTarget {
  stopped = false;
  label = "";
  readonly kind = "video";
  constructor(readonly written: unknown[] = []) {
    super();
  }
  stop(): void {
    this.stopped = true;
  }
  getSettings() {
    return {};
  }
  getCapabilities() {
    return {};
  }
  getConstraints() {
    return {};
  }
  async applyConstraints() {}
}

class FakeStream {
  tracks: unknown[] = [];
  constructor(readonly from = "new") {}
  addTrack(track: unknown) {
    this.tracks.push(track);
  }
}

function fakeWindow(withGenerator = true) {
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const media = new EventTarget() as EventTarget & Record<string, unknown>;
  media.getUserMedia = vi.fn(async (c: MediaStreamConstraints) => new FakeStream(JSON.stringify(c)));
  media.enumerateDevices = vi.fn(async () => [{ deviceId: "front", kind: "videoinput" }]);
  const written: unknown[] = [];
  const closed: unknown[] = [];
  win.navigator = { mediaDevices: media };
  win.MediaStream = FakeStream;
  win.performance = { now: () => 1 };
  win.document = document;
  if (withGenerator) {
    win.MediaStreamTrackGenerator = class extends FakeTrack {
      writable = { getWriter: () => ({ write: async (frame: unknown) => void written.push(frame) }) };
    };
    win.VideoFrame = class {
      constructor(readonly image: unknown) {}
    };
    win.ImageDecoder = class {
      constructor(readonly init: { data: ArrayBuffer }) {}
      async decode() {
        if (this.init.data.byteLength === 99) throw new Error("bad jpeg");
        return { image: { close: () => void closed.push(this.init.data) } };
      }
      close() {}
    };
  } else {
    win.createImageBitmap = vi.fn(async () => ({ close: () => void closed.push("bitmap") }));
  }
  const channel = new MessageChannel();
  const fromPage: unknown[] = [];
  channel.port2.onmessage = (event) => void fromPage.push(event.data);
  // Native code's handover: no source window, one port.
  const handOver = () => win.dispatchEvent(new MessageEvent("message", { data: USB_HELLO, ports: [channel.port1] }));
  const send = async (data: unknown) => {
    channel.port1.onmessage!(new MessageEvent("message", { data }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { win: win as unknown as Window, media: media as unknown as MediaDevices & { getUserMedia: ReturnType<typeof vi.fn> }, written, closed, handOver, send, fromPage, flush, port: channel.port1 };
}

describe("installUsbCamera", () => {
  it("passes everything through until native code says a camera is attached", async () => {
    const { win, media } = fakeWindow();
    const original = media.getUserMedia;
    expect(installUsbCamera(win, { prefer: true })).toBe(true);
    expect(installUsbCamera(win, { prefer: true })).toBe(false);
    expect(await media.enumerateDevices()).toEqual([{ deviceId: "front", kind: "videoinput" }]);
    // Preferred but not attached: the phone's own camera.
    expect(await media.getUserMedia({ video: true })).toEqual(new FakeStream(JSON.stringify({ video: true })));
    await expect(media.getUserMedia({ video: { deviceId: USB_DEVICE_ID } })).rejects.toThrow("not attached");
    expect(original).toHaveBeenCalledTimes(1);
    expect(installUsbCamera({ navigator: {} } as unknown as Window, { prefer: false })).toBe(false);
  });

  it("lists the camera native code describes, and says when it comes and goes", async () => {
    const { win, media, handOver, send } = fakeWindow();
    installUsbCamera(win, { prefer: false });
    const changes = vi.fn();
    media.addEventListener("devicechange", changes);
    handOver();
    await send(JSON.stringify(STATUS));
    const devices = await media.enumerateDevices();
    expect(devices).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(devices[1]))).toEqual({ deviceId: USB_DEVICE_ID, kind: "videoinput", label: "USB camera (StreamCam)", groupId: "multicord-usb-group" });
    expect((devices[1] as unknown as { getCapabilities(): { width: { max: number } } }).getCapabilities().width.max).toBe(1280);
    await send(JSON.stringify({ ...STATUS, streaming: false }));
    await send("not a status");
    await send(JSON.stringify({ type: "other" }));
    expect(changes).toHaveBeenCalledTimes(1);
    await send(JSON.stringify({ type: "status", available: false }));
    expect(changes).toHaveBeenCalledTimes(2);
    expect(await media.enumerateDevices()).toHaveLength(1);
  });

  it("ignores a handover that is not native code's", async () => {
    const { win, media } = fakeWindow();
    installUsbCamera(win, { prefer: false });
    const channel = new MessageChannel();
    win.dispatchEvent(new MessageEvent("message", { data: USB_HELLO, ports: [channel.port1], source: win as unknown as MessageEventSource }));
    win.dispatchEvent(new MessageEvent("message", { data: "other", ports: [channel.port1] }));
    win.dispatchEvent(new MessageEvent("message", { data: USB_HELLO }));
    channel.port1.onmessage?.(new MessageEvent("message", { data: JSON.stringify(STATUS) }));
    expect(channel.port1.onmessage).toBeNull();
    expect(await media.enumerateDevices()).toHaveLength(1);
  });

  it("opens a generated track that looks like the camera, fed with decoded frames while it is open", async () => {
    const { win, media, handOver, send, written, closed, fromPage, flush } = fakeWindow();
    installUsbCamera(win, { prefer: false });
    handOver();
    await send(JSON.stringify(STATUS));
    // A frame while no track is open is not decoded.
    await send(jpeg());
    expect(closed).toEqual([]);
    const stream = (await media.getUserMedia({ audio: true, video: { deviceId: { exact: USB_DEVICE_ID } } })) as unknown as FakeStream;
    expect(stream.from).toBe(JSON.stringify({ audio: true }));
    const track = stream.tracks[0] as MediaStreamTrack;
    expect(track.label).toBe("USB camera (StreamCam)");
    expect(track.getSettings()).toMatchObject({ deviceId: USB_DEVICE_ID, width: 1280, height: 720, frameRate: 30, aspectRatio: 1280 / 720 });
    expect(track.getCapabilities()).toMatchObject({ frameRate: { min: 1, max: 30 } });
    await track.applyConstraints({ width: 640 });
    expect(track.getConstraints()).toEqual({ width: 640 });
    await track.applyConstraints();
    expect(track.getConstraints()).toEqual({});
    await flush();
    expect(fromPage).toEqual(["want"]);
    await send(jpeg());
    await flush();
    expect(written).toHaveLength(1);
    expect(closed).toHaveLength(1);
    // Not JPEG, or one that does not decode: skipped.
    await send(new ArrayBuffer(100));
    await send(jpeg(99));
    await flush();
    expect(written).toHaveLength(1);
    track.stop();
    track.stop();
    await flush();
    expect(fromPage).toEqual(["want", "idle"]);
  });

  it("keeps only the newest frame waiting while one decodes", async () => {
    const { win, media, handOver, send, closed, flush } = fakeWindow();
    installUsbCamera(win, { prefer: true });
    handOver();
    await send(JSON.stringify(STATUS));
    await media.getUserMedia({ video: true });
    const first = jpeg(200);
    const second = jpeg(300);
    const third = jpeg(400);
    // Three in a row: the second is replaced by the third before the first is done.
    await Promise.all([send(first), send(second), send(third)]);
    await flush();
    expect(closed).toEqual([first, third]);
  });

  it("ends open tracks when the camera goes, and when a new channel replaces the old", async () => {
    const { win, media, handOver, send } = fakeWindow();
    installUsbCamera(win, { prefer: false });
    handOver();
    await send(JSON.stringify(STATUS));
    const stream = (await media.getUserMedia({ video: { deviceId: [USB_DEVICE_ID] } })) as unknown as FakeStream;
    const track = stream.tracks[0] as FakeTrack;
    const ended = vi.fn();
    track.addEventListener("ended", ended);
    await send(JSON.stringify({ type: "status", available: false }));
    expect(track.stopped).toBe(true);
    expect(ended).toHaveBeenCalledTimes(1);
    handOver();
    await send(JSON.stringify(STATUS));
    const again = (await media.getUserMedia({ video: { deviceId: USB_DEVICE_ID } })) as unknown as FakeStream;
    // A new channel (a page loaded again, the setting turned off and on) ends what the old one fed.
    handOver();
    expect((again.tracks[0] as FakeTrack).stopped).toBe(true);
  });

  it("draws to a canvas where there is no track generator", async () => {
    const { win, media, handOver, send, closed, flush } = fakeWindow(false);
    const canvasTrack = new FakeTrack();
    const draw = vi.fn();
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((name: string) => {
      if (name !== "canvas") return createElement(name);
      return { width: 0, height: 0, getContext: () => ({ drawImage: draw }), captureStream: () => ({ getVideoTracks: () => [canvasTrack] }) } as unknown as HTMLElement;
    }) as typeof document.createElement);
    installUsbCamera(win, { prefer: true });
    handOver();
    await send(JSON.stringify(STATUS));
    const stream = (await media.getUserMedia({ video: true })) as unknown as FakeStream;
    expect(stream.from).toBe("new");
    expect(stream.tracks[0]).toBe(canvasTrack);
    await send(jpeg());
    await flush();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(closed).toEqual(["bitmap"]);
  });
});
