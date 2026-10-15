// The "Element" side's Electron: one window on the media page that run.mjs
// serves (--mc-media-page=<url>), with media permissions granted and no
// background throttling, so it keeps decoding while other windows are in front.
const { app, BrowserWindow, session } = require("electron");

const arg = process.argv.find((a) => a.startsWith("--mc-media-page="));
if (!arg) throw new Error("--mc-media-page=<url> is required");
const url = arg.slice("--mc-media-page=".length);

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  const win = new BrowserWindow({ width: 640, height: 480, title: "mc-media element", webPreferences: { backgroundThrottling: false } });
  void win.loadURL(url);
});
app.on("window-all-closed", () => app.quit());
