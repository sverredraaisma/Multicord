// Opens the built component gallery in the default browser.
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const url = pathToFileURL(path.resolve("dist/gallery.html")).href;
const [command, args] =
  process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
spawn(command, args, { stdio: "ignore", detached: true }).unref();
console.log(`Gallery: ${url}`);
