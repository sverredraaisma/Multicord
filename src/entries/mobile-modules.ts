import { nativeModuleTable } from "../mobile/modules";

// Bundled and run by scripts/build.mjs, which writes this as dist/mobile/modules.json for native code.
export default nativeModuleTable();
