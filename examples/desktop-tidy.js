#!/usr/bin/env node
// examples/desktop-tidy.js
// ─────────────────────────────────────────────────────────────────────────────
// Kalairos v0 — "the agent that earns the right to stop asking."
//
// A watch-and-approve desktop tidier. It proposes ONE move at a time, you tap
// y/n, and it files the clutter into the right folder. Every approval is stored
// in Kalairos memory — so the NEXT run asks less. That "second run asks me
// less" moment is the whole point.
//
//   Run 1:  asks you once per file-type, learns your answers.
//   Run 2:  auto-files everything you already approved. Baam.
//
// Safety: it only MOVES files into folders. It never deletes anything.
//
//   node examples/desktop-tidy.js              # tidy ~/Desktop, asking first
//   node examples/desktop-tidy.js --dry        # show what it WOULD do, touch nothing
//   node examples/desktop-tidy.js --dir <path> # tidy a different folder
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const path     = require("path");
const fs       = require("fs");
const os       = require("os");
const readline = require("readline");
const kalairos = require(path.resolve(__dirname, "..", "index"));

// ── tiny ANSI helpers (zero deps) ───────────────────────────────────────────
const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow= (s) => `\x1b[33m${s}\x1b[0m`;

// ── zero-dependency embedder (bag-of-words, no API key) ──────────────────────
// Kalairos needs an embedder to init. We don't lean on semantic recall here —
// rules are looked up deterministically by tag — but init requires one.
const EMBED_DIM = 256;
function localEmbed(text) {
  const vec = new Float64Array(EMBED_DIM);
  const words = String(text).toLowerCase().replace(/[^a-z0-9.\s]/g, " ").split(/\s+/).filter(Boolean);
  for (const w of words) {
    let h = 2654435769;
    for (let i = 0; i < w.length; i++) h = ((h << 5) - h + w.charCodeAt(i)) | 0;
    vec[(h >>> 0) % EMBED_DIM] += 1;
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return Array.from(vec);
}

// ── filing rules: filename → { category, folder } ───────────────────────────
// First match wins, so screenshots are checked before generic images.
const HOME = os.homedir();
const CATEGORIES = [
  { category: "screenshots",   folder: path.join(HOME, "Pictures", "Screenshots"),
    test: (n) => /^(screen ?shot|cleanshot|screen recording|screencap)/i.test(n) },
  { category: "images",        folder: path.join(HOME, "Pictures"),
    test: (n) => /\.(png|jpe?g|gif|heic|webp|svg|tiff?|bmp)$/i.test(n) },
  { category: "pdfs",          folder: path.join(HOME, "Documents", "PDFs"),
    test: (n) => /\.pdf$/i.test(n) },
  { category: "documents",     folder: path.join(HOME, "Documents"),
    test: (n) => /\.(docx?|pages|rtf|odt|txt|md)$/i.test(n) },
  { category: "spreadsheets",  folder: path.join(HOME, "Documents", "Spreadsheets"),
    test: (n) => /\.(xlsx?|csv|numbers|tsv)$/i.test(n) },
  { category: "presentations", folder: path.join(HOME, "Documents", "Presentations"),
    test: (n) => /\.(pptx?|key)$/i.test(n) },
  { category: "archives",      folder: path.join(HOME, "Downloads", "Archives"),
    test: (n) => /\.(zip|dmg|tar|gz|tgz|rar|7z|pkg)$/i.test(n) },
  { category: "videos",        folder: path.join(HOME, "Movies"),
    test: (n) => /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(n) },
  { category: "audio",         folder: path.join(HOME, "Music"),
    test: (n) => /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(n) },
];

function classify(name) {
  for (const rule of CATEGORIES) if (rule.test(name)) return rule;
  return null; // unknown → leave it alone (never touch working files)
}

// ── move helper: cross-device safe, collision safe, never overwrites ─────────
function moveFile(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, path.basename(src));
  if (fs.existsSync(dest)) {
    const ext  = path.extname(dest);
    const stem = path.basename(dest, ext);
    let i = 1;
    while (fs.existsSync(dest)) dest = path.join(destDir, `${stem} (${i++})${ext}`);
  }
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === "EXDEV") { fs.copyFileSync(src, dest); fs.unlinkSync(src); }
    else throw e;
  }
  return dest;
}

// ── readline y/n prompt ──────────────────────────────────────────────────────
function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim().toLowerCase())));
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const dirIdx = args.indexOf("--dir");
  const targetDir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : path.join(HOME, "Desktop");

  if (!fs.existsSync(targetDir)) {
    console.error(`\n  ${yellow("✗")} Folder not found: ${targetDir}\n`);
    process.exit(1);
  }

  // Memory persists across runs — this file is how it "remembers your rules".
  const memDir = path.join(HOME, ".kalairos");
  fs.mkdirSync(memDir, { recursive: true });
  await kalairos.init({
    embedFn:          async (t) => localEmbed(t),
    embeddingDim:     EMBED_DIM,
    dataFile:         path.join(memDir, "tidy.jsonl"),
    strictEmbeddings: true,
    // Each filing rule is a distinct setting, not an evolving fact — keep them
    // separate. Thresholds above 1.0 are unreachable, so rules never auto-merge.
    versionThreshold:       1.1,
    consolidationThreshold: 1.1,
  });

  // Load the rules it learned on previous runs.
  const known = await kalairos.listEntities({ tags: ["tidy-rule"], limit: 100 });
  const approved = new Map(); // category → { folder, approvedAt }
  for (const e of known.entities || []) {
    const m = e.metadata || {};
    if (m.category && m.folder) approved.set(m.category, { folder: m.folder, approvedAt: m.approvedAt });
  }

  console.log("");
  console.log(bold(`  🧹  Kalairos Desktop Tidy`) + (dryRun ? dim("  (dry run — nothing will move)") : ""));
  console.log(dim(`  Tidying: ${targetDir}`));
  if (approved.size) {
    console.log(green(`  I remember ${approved.size} rule${approved.size > 1 ? "s" : ""} from last time — I'll auto-file those without asking.`));
  } else {
    console.log(dim(`  First run — I'll ask once per file type, then remember your answers.`));
  }
  console.log("");

  // Gather loose files on the Desktop (skip folders, dotfiles, aliases).
  const entries = fs.readdirSync(targetDir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("."));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let moved = 0, autoMoved = 0, skipped = 0, learned = 0, untouched = 0;
  let quit = false;

  for (const entry of entries) {
    if (quit) break;
    const name = entry.name;
    const rule = classify(name);
    if (!rule) { untouched++; continue; } // unknown type → leave it

    const src = path.join(targetDir, name);
    const remembered = approved.get(rule.category);

    // ── learned rule → auto-file, no question ──
    if (remembered) {
      const destShown = remembered.folder.replace(HOME, "~");
      if (dryRun) {
        console.log(`  ${cyan("↪")} would auto-file  ${bold(name)}  →  ${destShown}  ${dim("(rule approved earlier)")}`);
      } else {
        const dest = moveFile(src, remembered.folder);
        console.log(`  ${green("✓")} auto-filed  ${bold(name)}  →  ${dest.replace(HOME, "~")}  ${dim("(you approved this before)")}`);
      }
      autoMoved++;
      continue;
    }

    // ── new type → ask once ──
    const destShown = rule.folder.replace(HOME, "~");
    const a = await ask(rl, `  Move ${bold(name)} → ${cyan(destShown)} ? ${dim("[y/n/q]")} `);

    if (a === "q") { quit = true; break; }
    if (a !== "y" && a !== "yes") { skipped++; continue; }

    if (dryRun) {
      console.log(`  ${cyan("↪")} would move and remember rule: ${rule.category} → ${destShown}`);
      moved++;
      continue;
    }

    const dest = moveFile(src, rule.folder);
    moved++;

    // Remember the APPROVAL — this is the Kalairos part. Next run won't ask.
    await kalairos.remember(
      `Filing rule: "${rule.category}" files should move to ${rule.folder}`,
      {
        who:      { agent: "desktop-tidy", onBehalfOf: "user" },
        source:   { type: "user-approval", actor: "user" },
        why:      "User approved this filing destination interactively",
        tags:     ["tidy-rule"],
        metadata: { category: rule.category, folder: rule.folder, approvedAt: new Date().toISOString() },
      }
    );
    approved.set(rule.category, { folder: rule.folder });
    learned++;
    console.log(`  ${green("✓")} moved → ${dest.replace(HOME, "~")}  ${dim(`· learned: I'll auto-file ${rule.category} from now on`)}`);
  }

  rl.close();

  // ── summary ──
  console.log("");
  console.log(bold("  ── done ──"));
  if (autoMoved) console.log(`  ${green(autoMoved)} auto-filed from memory`);
  if (moved)     console.log(`  ${green(moved)} moved`);
  if (learned)   console.log(`  ${cyan(learned)} new rule${learned > 1 ? "s" : ""} learned ${dim("(next run won't ask)")}`);
  if (skipped)   console.log(`  ${dim(skipped + " skipped")}`);
  if (untouched) console.log(`  ${dim(untouched + " left alone (unknown type)")}`);
  if (!dryRun && (moved || learned)) {
    console.log("");
    console.log(dim(`  Run it again — the types you approved will file themselves.`));
  }
  console.log("");

  await kalairos.shutdown();
}

main().catch((e) => { console.error("\n  ✗", e.message, "\n"); process.exit(1); });
