// remote.mjs — ESM wrapper for Database X Remote Client
// Enables `import { connect } from "dbx-memory/remote"` in ESM environments.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const lib = require("./remote.js");

export const { connect } = lib;
export default lib;
