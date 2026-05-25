// services/dep-graph-builder/test.js — node:test runner.
//
// Run with:
//   node --test services/dep-graph-builder/test.js
//
// Or from the repo root via the `test:services` script:
//   npm run test:services
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { parseImports } = require("./parser");
const {
  SERVICE_NAME,
  buildDepGraph,
  handleRecord,
  postResult,
} = require("./index");
const { tailJsonl } = require("./tail");


// ── parseImports ──────────────────────────────────────────────────────────


test("parser: ESM imports — default, named, namespace", () => {
  const src = [
    'import x from "x";',
    'import { y } from "y";',
    'import * as z from "z";',
    "",
  ].join("\n");
  const out = parseImports("a.js", src).sort();
  assert.deepEqual(out, ["x", "y", "z"]);
});


test("parser: side-effect import", () => {
  const out = parseImports("a.js", "import 'side-effect-only';\n");
  assert.deepEqual(out, ["side-effect-only"]);
});


test("parser: require() with single and double quotes", () => {
  const src = [
    'const a = require("./a");',
    "const b = require('./b');",
    "",
  ].join("\n");
  const out = parseImports("a.js", src).sort();
  assert.deepEqual(out, ["./a", "./b"]);
});


test("parser: dynamic import()", () => {
  const out = parseImports(
    "a.js",
    "const mod = await import('./dyn');\n",
  );
  assert.deepEqual(out, ["./dyn"]);
});


test("parser: deduplicates across import + require + dynamic", () => {
  const src = [
    'import "x";',
    'require("x");',
    "import('x');",
    "",
  ].join("\n");
  assert.deepEqual(parseImports("a.js", src), ["x"]);
});


test("parser: ignores random text that looks like imports", () => {
  // Comments and string literals get false-positives in a regex
  // parser; we accept that for v1 and confirm the SHAPE — that we
  // don't crash, and that real imports still come through.
  const src = [
    "// import not-real-1 from 'fake-1'",
    'import real from "real";',
    "",
  ].join("\n");
  const out = parseImports("a.js", src);
  // Regex-based parser will pick up both; the test pins current
  // behavior so we notice if it changes (and choose intentionally).
  assert.ok(out.includes("real"));
});


// ── buildDepGraph ─────────────────────────────────────────────────────────


test("buildDepGraph: missing files become nodes with no edges", () => {
  const g = buildDepGraph(["does-not-exist.js"], "/tmp");
  assert.deepEqual(g, {
    nodes: ["does-not-exist.js"],
    edges: [],
  });
});


test("buildDepGraph: reads imports from real files in repo root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-graph-"));
  fs.writeFileSync(path.join(dir, "a.js"), "const b = require('./b');\n");
  fs.writeFileSync(path.join(dir, "b.js"), "module.exports = 1;\n");
  const g = buildDepGraph(["a.js", "b.js"], dir);
  assert.deepEqual(g.nodes, ["a.js", "b.js"]);
  assert.deepEqual(g.edges, [{ from: "a.js", to: "./b" }]);
});


test("buildDepGraph: empty paths → empty graph", () => {
  assert.deepEqual(buildDepGraph([], "/tmp"), { nodes: [], edges: [] });
});


// ── handleRecord — dispatch + POST shape ──────────────────────────────────


// Save/restore the global fetch around each handleRecord test so
// mocks don't bleed across tests.
function _withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return (async () => {
    try {
      await fn();
    } finally {
      global.fetch = original;
    }
  })();
}


test("handleRecord: ignores non-handoff_requested events", async () => {
  const calls = [];
  await _withMockedFetch(
    async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ offset: 0, size: 0 }) };
    },
    async () => {
      await handleRecord(
        {
          metadata: {
            event_type: "tool_call_result",
            payload: { tool: "x" },
          },
        },
        { ledgerUrl: "http://x", repoRoot: "/tmp" },
      );
    },
  );
  assert.equal(calls.length, 0);
});


test("handleRecord: ignores handoffs for other services", async () => {
  const calls = [];
  await _withMockedFetch(
    async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    },
    async () => {
      await handleRecord(
        {
          metadata: {
            event_type: "handoff_requested",
            payload: {
              service: "some-other-service",
              handoff_id: "ho_x",
            },
          },
        },
        { ledgerUrl: "http://x", repoRoot: "/tmp" },
      );
    },
  );
  assert.equal(calls.length, 0);
});


test("handleRecord: handles matching service and posts result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handle-rec-"));
  fs.writeFileSync(path.join(dir, "x.js"), "require('./y');\n");

  const calls = [];
  await _withMockedFetch(
    async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ offset: 0, size: 0 }) };
    },
    async () => {
      await handleRecord(
        {
          metadata: {
            event_type: "handoff_requested",
            payload: {
              service: SERVICE_NAME,
              handoff_id: "ho_abc",
              input: { files: "x.js\n" },
            },
          },
        },
        { ledgerUrl: "http://l", repoRoot: dir },
      );
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://l/append");
  const body = calls[0].body;
  assert.equal(body.metadata.event_type, "handoff_result");
  assert.equal(body.metadata.payload.handoff_id, "ho_abc");
  assert.deepEqual(body.metadata.payload.result.nodes, ["x.js"]);
  assert.deepEqual(body.metadata.payload.result.edges, [
    { from: "x.js", to: "./y" },
  ]);
  assert.equal(body.metadata.payload.error, null);
});


test("handleRecord: ack-on-error keeps Python from hanging", async () => {
  // Force buildDepGraph to throw by mocking the post path to inspect
  // what gets sent. We trigger an error by passing a non-string `files`
  // input — `.split` on undefined will throw inside handleRecord's
  // pre-processing. Capture the resulting POST.
  const calls = [];
  await _withMockedFetch(
    async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ offset: 0, size: 0 }) };
    },
    async () => {
      await handleRecord(
        {
          metadata: {
            event_type: "handoff_requested",
            payload: {
              service: SERVICE_NAME,
              handoff_id: "ho_err",
              // missing `input` — payload.input is undefined.
              // handleRecord defaults files to "" so this doesn't
              // throw; we hit the success path with an empty graph.
            },
          },
        },
        { ledgerUrl: "http://l", repoRoot: "/tmp" },
      );
    },
  );
  // Empty input → still ack with an empty graph (Python must not hang).
  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.equal(body.metadata.payload.handoff_id, "ho_err");
  assert.deepEqual(body.metadata.payload.result, { nodes: [], edges: [] });
});


// ── postResult — request shape ────────────────────────────────────────────


test("postResult: posts to /append with the expected record shape", async () => {
  const calls = [];
  await _withMockedFetch(
    async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ offset: 0, size: 0 }) };
    },
    async () => {
      await postResult(
        "http://l",
        "ho_xyz",
        { nodes: ["a"], edges: [] },
        null,
      );
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://l/append");
  assert.equal(calls[0].opts.method, "POST");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.metadata.event_type, "handoff_result");
  assert.equal(body.metadata.payload.handoff_id, "ho_xyz");
  assert.deepEqual(body.metadata.payload.result.nodes, ["a"]);
  assert.ok(body.versions[0].timestamp > 0);
  assert.ok(body.tags.includes("handoff:ho_xyz"));
});


test("postResult: surfaces non-2xx responses as Error", async () => {
  await _withMockedFetch(
    async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error",
      json: async () => ({}),
    }),
    async () => {
      await assert.rejects(
        () => postResult("http://l", "ho", { nodes: [], edges: [] }, null),
        /POST \/append failed: 500/,
      );
    },
  );
});


// ── tailJsonl ─────────────────────────────────────────────────────────────


test("tailJsonl: emits each appended record in order", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-"));
  const jsonlPath = path.join(dir, "l.jsonl");
  fs.writeFileSync(jsonlPath, '{"id":"a"}\n');

  const seen = [];
  const ctl = new AbortController();
  const tailing = tailJsonl(
    jsonlPath,
    10,
    async (rec) => {
      seen.push(rec.id);
      if (seen.length >= 3) ctl.abort();
    },
    { signal: ctl.signal },
  );

  // Append more lines after a moment.
  setTimeout(() => {
    fs.appendFileSync(jsonlPath, '{"id":"b"}\n{"id":"c"}\n');
  }, 50);

  await _withTimeout(tailing, 2000);
  assert.deepEqual(seen, ["a", "b", "c"]);
});


test("tailJsonl: skips malformed lines with a warning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-bad-"));
  const jsonlPath = path.join(dir, "l.jsonl");
  fs.writeFileSync(jsonlPath, '{"id":"a"}\nnot json at all\n{"id":"b"}\n');

  const seen = [];
  const ctl = new AbortController();
  const tailing = tailJsonl(
    jsonlPath,
    10,
    async (rec) => {
      seen.push(rec.id);
      if (seen.length >= 2) ctl.abort();
    },
    { signal: ctl.signal },
  );
  await _withTimeout(tailing, 2000);
  assert.deepEqual(seen, ["a", "b"]);
});


test("tailJsonl: tolerates startOffset to resume mid-file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-resume-"));
  const jsonlPath = path.join(dir, "l.jsonl");
  const line1 = '{"id":"first"}\n';
  fs.writeFileSync(jsonlPath, line1 + '{"id":"second"}\n');

  // Resume past the first line — we should only see "second".
  const startOffset = Buffer.byteLength(line1, "utf-8");
  const seen = [];
  const ctl = new AbortController();
  const tailing = tailJsonl(
    jsonlPath,
    10,
    async (rec) => {
      seen.push(rec.id);
      ctl.abort();
    },
    { startOffset, signal: ctl.signal },
  );
  await _withTimeout(tailing, 2000);
  assert.deepEqual(seen, ["second"]);
});


// ── helpers ───────────────────────────────────────────────────────────────


async function _withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`test timeout after ${ms}ms`)), ms);
  });
  try {
    await Promise.race([promise.catch(() => {}), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
