#!/usr/bin/env node
// mcp.mjs — ESM entry point for the Database X MCP Server.
// Delegates to mcp.js (CJS) so the full implementation lives in one place.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
require("./mcp.js");
