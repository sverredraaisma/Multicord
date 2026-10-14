// Runs in Discord's main world. When Discord shares a screen with audio, asks
// Chromium to leave Multicord's own sound out of the capture (restrictOwnAudio,
// the study's Windows answer), so people in the call don't hear themselves
// back. Serialized into the page: it must not reference anything outside its
// own body.

export function discordScreenAudio(): void {
  const media = (navigator as any).mediaDevices;
  const original = media?.getDisplayMedia;
  if (typeof original !== "function" || original.__multicord) return;
  const patched = function (this: unknown, constraints?: any): Promise<MediaStream> {
    const audio = constraints?.audio;
    if (audio) {
      const own = typeof audio === "object" ? audio : {};
      constraints = { ...constraints, audio: { ...own, restrictOwnAudio: true } };
    }
    return original.call(this, constraints);
  };
  (patched as any).__multicord = true;
  media.getDisplayMedia = patched;
}
