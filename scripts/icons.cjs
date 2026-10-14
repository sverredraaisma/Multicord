// Renders assets/icon.svg into the PNGs the app and its installers use:
// build/icon.png (1024 px, from which electron-builder makes .ico and .icns)
// and static/icon.png with icon@2x.png (the tray). Run with Electron:
//   npx electron scripts/icons.cjs
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const svg = fs.readFileSync(path.join(root, "assets", "icon.svg"), "utf8");

// Drawn on a canvas of its own, so the window's size on this screen does not matter.
const render = (size) => `new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ${size};
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    resolve(canvas.toDataURL("image/png"));
  };
  img.onerror = reject;
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(${JSON.stringify(svg)});
})`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("about:blank");
  const write = async (size, file) => {
    const url = await win.webContents.executeJavaScript(render(size));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, nativeImage.createFromDataURL(url).toPNG());
  };
  await write(1024, path.join(root, "build", "icon.png"));
  await write(32, path.join(root, "static", "icon.png"));
  await write(64, path.join(root, "static", "icon@2x.png"));
  console.log("icons written");
  app.quit();
});
