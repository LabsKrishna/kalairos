#!/usr/bin/env node
// examples/demo.js — Interactive Kalairos demo (flat API).
// Runs the three-layer walk-through with a built-in embedder. No API key needed.
"use strict";

const path = require("path");
const kalairos = require(path.resolve(__dirname, "..", "index"));

// ── ANSI helpers (zero dependencies) ────────────────────────────────────────

const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function section(n, title) {
  console.log("");
  console.log(bold(`  ━━━ ${n}. ${title} ${"━".repeat(Math.max(1, 48 - title.length))}`));
  console.log("");
}

function code(s)   { console.log(`    ${cyan(s)}`); }
function result(s) { console.log(`    ${green("→")} ${s}`); }
function note(s)   { console.log(`    ${dim(s)}`); }

// ── Demo embedder — bag-of-words with multi-hash, no API key needed ─────────

const EMBED_DIM = 256;

function demoEmbed(text) {
  const vec   = new Float64Array(EMBED_DIM);
  const words = String(text).toLowerCase().replace(/[^a-z0-9$.\s]/g, " ").split(/\s+/).filter(Boolean);
  for (const w of words) {
    for (let seed = 0; seed < 3; seed++) {
      let h = seed * 2654435769;
      for (let i = 0; i < w.length; i++) h = ((h << 5) - h + w.charCodeAt(i)) | 0;
      vec[(h >>> 0) % EMBED_DIM] += 1;
    }
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return Array.from(vec);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Suppress engine console.log during demo for clean output ────────────────

const _origLog     = console.log;
const _origTime    = console.time;
const _origTimeEnd = console.timeEnd;
let _muteEngine = false;
console.log = function (...args) {
  if (_muteEngine && typeof args[0] === "string" && args[0].startsWith("[kalairos]")) return;
  _origLog.apply(console, args);
};
console.time    = function (...args) { if (!_muteEngine) _origTime.apply(console, args); };
console.timeEnd = function (...args) { if (!_muteEngine) _origTimeEnd.apply(console, args); };

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  _origLog("");
  _origLog(bold("  ╔══════════════════════════════════════════════════╗"));
  _origLog(bold("  ║          Kalairos — Live Demo                    ║"));
  _origLog(bold("  ║          No API key. No config. In-memory.       ║"));
  _origLog(bold("  ╚══════════════════════════════════════════════════╝"));
  _origLog("");

  _muteEngine = true;

  // Lower thresholds for the bag-of-words demo embedder (production would use
  // real embeddings with the defaults).
  await kalairos.init({
    embedFn:                async (text) => demoEmbed(text),
    embeddingDim:           EMBED_DIM,
    dataFile:               ":memory:",
    strictEmbeddings:       true,
    versionThreshold:       0.55,
    consolidationThreshold: 0.40,
    linkThreshold:          0.35,
    minFinalScore:          0.10,
    minSemanticScore:       0.08,
  });
  result("Engine ready (in-memory, nothing written to disk)");

  // ── Layer 1: init, remember, query ─────────────────────────────────────────

  section(1, "Layer 1 — init, remember, query");

  code('kalairos.remember("Employees must submit reports by Friday", { source: { type: "policy", actor: "HR" } })');
  const id1 = await kalairos.remember("Employees must submit reports by Friday", {
    who:    { agent: "policy-bot", onBehalfOf: "HR" },
    source: { type: "policy", actor: "HR" },
  });
  result(`Stored as entity ${bold(String(id1))}`);

  const tBeforeUpdate = Date.now();
  await sleep(60);

  code('kalairos.remember("Deadline changed to Wednesday", { effectiveAt: "2026-04-15", why: "Policy update from HR memo" })');
  await kalairos.remember("Deadline changed to Wednesday", {
    who:         { agent: "policy-bot", onBehalfOf: "HR" },
    why:         "Policy update from HR memo",
    source:      { type: "policy", actor: "HR", ref: "hr-memo-2026-04-15" },
    effectiveAt: "2026-04-15",
  });
  result(`Updated entity ${bold(String(id1))} ${dim("→ version 2")}`);
  note("Same entity detected automatically — no ID required.");

  code('kalairos.query("report deadline")');
  const current = await kalairos.query("report deadline");
  if (current.results && current.results.length > 0) {
    result(`"${current.results[0].text}" ${dim("(current)")}`);
  } else {
    note("(no results — query similarity below threshold with demo embedder)");
  }

  // ── Layer 2: time-aware memory ─────────────────────────────────────────────

  section(2, "Layer 2 — Time-aware memory");

  code('kalairos.queryAt("report deadline", lastWeek)');
  const lastWeek = Date.now() - 7 * 86_400_000;
  const past = await kalairos.queryAt("report deadline", Math.max(lastWeek, tBeforeUpdate));
  if (past.results && past.results.length > 0) {
    result(`"${past.results[0].text}" ${dim("(what was true then)")}`);
  } else {
    note("(time-travel query — result depends on embedder similarity)");
  }

  code(`kalairos.getHistory(${id1})`);
  const history = await kalairos.getHistory(id1);
  if (history && history.versions) {
    for (const v of history.versions) {
      const delta = v.delta ? dim(` — ${v.delta.summary}`) : "";
      const flag  = v.delta && v.delta.contradicts ? yellow(" [CONTRADICTION]") : "";
      result(`v${v.version} [${v.action}]: "${v.text}"${delta}${flag}`);
    }
  }

  code(`kalairos.trail({ entity: ${id1} })`);
  const trail = await kalairos.trail({ entity: id1 });
  for (const ev of trail) {
    const who = ev.who?.agent ? dim(` by ${ev.who.agent}`) : "";
    const why = ev.why ? dim(` — ${ev.why}`) : "";
    result(`${ev.action}${who}${why}`);
  }

  code('kalairos.checkpoint("policy-snapshot", { entity: id1, why: "audit reference" })');
  const cp = await kalairos.checkpoint("policy-snapshot", { entity: id1, why: "audit reference" });
  result(`Checkpoint frozen with ${bold(String((cp.eventIds || []).length))} event(s)`);

  // ── Layer 3: advanced maintenance ──────────────────────────────────────────

  section(3, "Layer 3 — Contradiction detection");

  code('kalairos.remember("The API rate limit is 1000 requests per minute")');
  const id2 = await kalairos.remember("The API rate limit is 1000 requests per minute");
  result(`Stored as entity ${bold(String(id2))}`);

  await sleep(30);

  code('kalairos.remember("The API rate limit is 500 requests per minute")');
  await kalairos.remember("The API rate limit is 500 requests per minute");
  result(`Updated entity ${bold(String(id2))} ${dim("→ version 2")}`);

  code(`kalairos.getContradictions(${id2})`);
  const { contradictions } = await kalairos.getContradictions(id2);
  if (contradictions.length > 0) {
    result(`${yellow(contradictions.length + " contradiction(s)")} found across versions`);
    for (const c of contradictions) {
      note(`v${c.version}: ${c.delta.summary}`);
    }
  } else {
    result("No contradictions flagged (delta type depends on embedder precision)");
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const status = await kalairos.getStatus();

  _origLog("");
  _origLog(bold("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  _origLog("");
  result(`Demo complete. ${bold(String(status.entities))} entities, ${bold(String(status.totalVersions))} versions, ${bold("0")} cloud calls.`);
  _origLog("");
  _origLog(`    ${bold("Get started:")}`);
  _origLog(`      npm install kalairos`);
  _origLog(`      https://github.com/LabsKrishna/kalairos`);
  _origLog("");

  await kalairos.shutdown();
  _muteEngine = false;
}

main().catch((err) => {
  console.error("\n  Demo failed:", err.message || err);
  process.exit(1);
});
