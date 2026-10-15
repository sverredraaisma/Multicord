// Builds the Flatpak bundle (release/Multicord-<version>-x86_64.flatpak) from the
// Linux build electron-builder left in release/linux-unpacked, with the manifest in
// build/flatpak/. Needs Linux with flatpak and flatpak-builder, and the flathub
// remote added for the user; missing runtimes are installed from flathub.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const APP_ID = "io.github.sverredraaisma.Multicord";
const MANIFEST = `build/flatpak/${APP_ID}.yml`;
const METAINFO = `build/flatpak/${APP_ID}.metainfo.xml`;
const WORK = "release/flatpak";

if (process.platform !== "linux") throw new Error("Flatpaks are built on Linux.");
if (!existsSync("release/linux-unpacked")) throw new Error("No release/linux-unpacked: run `npm run dist` first.");

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (!readFileSync(METAINFO, "utf8").includes(`<release version="${version}"`)) {
  console.warn(`warning: ${METAINFO} has no <release> for ${version}; software centres will show an older version.`);
}

const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
run("flatpak-builder", [
  "--user",
  "--install-deps-from=flathub",
  "--force-clean",
  // Copies instead of a FUSE overlay, which containers and WSL often lack.
  "--disable-rofiles-fuse",
  `--state-dir=${WORK}/state`,
  `--repo=${WORK}/repo`,
  `${WORK}/build`,
  MANIFEST,
]);
const bundle = `release/Multicord-${version}-x86_64.flatpak`;
// --runtime-repo lets `flatpak install` fetch the runtime from flathub on its own.
run("flatpak", ["build-bundle", "--runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo", `${WORK}/repo`, bundle, APP_ID]);
console.log(`Built ${bundle}`);
