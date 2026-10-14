// Screen-share audio in the sharing page: Discord's (serialized into its main
// world, so it must not reference anything outside its own body) and
// Multicord's native view.
//
// - Asks Chromium to leave Multicord's own sound out of the capture
//   (restrictOwnAudio, the study's Windows answer), so people in the call
//   don't hear themselves back.
// - Where the capture brings no sound of its own (Linux), adds the virtual
//   microphone venmic feeds with the speakers' sound, and says when the
//   share ends so the shell stops feeding it.

export function screenAudioPatch(virtualMic: string, endEvent: string): void {
  const media = (navigator as any).mediaDevices;
  const original = media?.getDisplayMedia;
  if (typeof original !== "function" || original.__multicord) return;
  const patched = async function (this: unknown, constraints?: any): Promise<MediaStream> {
    const audio = constraints?.audio;
    if (audio) {
      const own = typeof audio === "object" ? audio : {};
      constraints = { ...constraints, audio: { ...own, restrictOwnAudio: true } };
    }
    const stream: MediaStream = await original.call(this, constraints);
    if (!audio || stream.getAudioTracks().length > 0) return stream;
    try {
      const devices: MediaDeviceInfo[] = await media.enumerateDevices();
      const mic = devices.find((d) => d.kind === "audioinput" && d.label.includes(virtualMic));
      if (!mic) return stream;
      const extra: MediaStream = await media.getUserMedia({
        audio: { deviceId: { exact: mic.deviceId }, autoGainControl: false, echoCancellation: false, noiseSuppression: false, channelCount: 2 },
      });
      const track = extra.getAudioTracks()[0];
      if (!track) return stream;
      stream.addTrack(track);
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        track.stop();
        document.dispatchEvent(new CustomEvent(endEvent));
      });
    } catch {
      // The share goes ahead without sound.
    }
    return stream;
  };
  (patched as any).__multicord = true;
  media.getDisplayMedia = patched;
}
