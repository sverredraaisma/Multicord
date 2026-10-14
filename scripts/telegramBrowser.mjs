// esbuild plugin: bundles GramJS ("telegram") for a sandboxed browser page,
// the way its own browser builds do. Its pure-JS crypto replaces Node's,
// and the Node-only transports (TCP, SOCKS), file system and localStorage
// shims become empty stubs; in a browser GramJS talks over WebSockets.
import path from "node:path";

const STUBS = {
  fs: "export default {};",
  net: "export default {};",
  socks: "export default {};",
  crypto: "export default {};",
  "node-localstorage": "export class LocalStorage {}",
  os: `export function type() { return "Multicord"; }
export function release() { return ""; }
export function hostname() { return ""; }
export default { type, release, hostname };`,
  util: `const custom = Symbol.for("nodejs.util.inspect.custom");
export const inspect = Object.assign((value) => String(value), { custom });
export default { inspect };`,
};

export function telegramBrowser() {
  return {
    name: "telegram-browser",
    setup(build) {
      const fromTelegram = (importer) => importer.includes(`${path.sep}node_modules${path.sep}telegram${path.sep}`) || importer.includes("/node_modules/telegram/");
      // CryptoFile exports Node's crypto as its default; the browser shim must too.
      build.onResolve({ filter: /(^|\/)CryptoFile$/ }, (args) =>
        fromTelegram(args.importer) ? { path: "CryptoFile", namespace: "telegram-crypto" } : undefined,
      );
      build.onLoad({ filter: /.*/, namespace: "telegram-crypto" }, () => ({
        contents: `const crypto = require(${JSON.stringify(path.resolve("node_modules/telegram/crypto/crypto.js"))});
module.exports = { __esModule: true, default: crypto };`,
        loader: "js",
        resolveDir: path.resolve("node_modules/telegram"),
      }));
      build.onResolve({ filter: /^path$/ }, (args) => (fromTelegram(args.importer) ? { path: path.resolve("node_modules/path-browserify/index.js") } : undefined));
      build.onResolve({ filter: new RegExp(`^(${Object.keys(STUBS).join("|")})$`) }, (args) =>
        fromTelegram(args.importer) || args.importer.includes("node-localstorage") ? { path: args.path, namespace: "telegram-stub" } : undefined,
      );
      build.onLoad({ filter: /.*/, namespace: "telegram-stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
    },
  };
}
