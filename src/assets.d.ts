// esbuild bundles .wasm files as their bytes (the "binary" loader).
declare module "*.wasm" {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}
