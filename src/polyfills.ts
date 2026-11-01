import { Buffer } from "buffer";

// isomorphic-git expects Node's Buffer global.
if (!("Buffer" in globalThis)) Object.assign(globalThis, { Buffer });
