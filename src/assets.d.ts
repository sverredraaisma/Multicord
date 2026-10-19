// esbuild bundles .wasm files as their bytes (the "binary" loader).
declare module "*.wasm" {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}

// esbuild bundles .dat files as their text (the "text" loader): the Public Suffix List.
declare module "*.dat" {
  const text: string;
  export default text;
}
