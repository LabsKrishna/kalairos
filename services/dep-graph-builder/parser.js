// services/dep-graph-builder/parser.js
//
// JS/TS import parser — regex-based, not AST-based. Adequate for v1: we
// only need to know which modules a file references so the PR risk
// reviewer can reason about fan-out. False positives (e.g. matches
// inside string literals or comments) are tolerable because the
// downstream summarizer reads context.
//
// Languages later: Python (`import x`, `from x import y`), Go
// (`import "x"`), etc. Each language gets a small extractor pulled in
// here.
"use strict";

// `import X from "y"` / `import { X } from "y"` / `import * as X from "y"`
// `import "y"` (side-effect imports).
const IMPORT_RE = /^[\s\t]*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gm;

// `require("y")` / `require('y')`. Handles whitespace inside the parens.
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

// Dynamic `import("y")`. Looser match — common patterns only.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;


function parseImports(filePath, content) {
  const imports = new Set();
  for (const re of [IMPORT_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0; // shared regex state — reset before each scan
    let m;
    while ((m = re.exec(content)) !== null) {
      imports.add(m[1]);
    }
  }
  return Array.from(imports);
}


module.exports = { parseImports };
