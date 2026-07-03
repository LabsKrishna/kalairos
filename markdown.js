// markdown.js — human-readable markdown <-> memory-entity conversion.
//
// Bridges agents that think in .md and Kalairos's NDJSON persistence. This
// module is intentionally PURE: it builds strings from entity objects and
// parses strings into plain fact descriptors. All stateful orchestration
// (init guard, workspace filtering, the ingest loop, persistence) stays in
// index.js — these functions never touch module state, so they're trivially
// testable and carry no coupling to the engine singletons.
"use strict";

/**
 * Render one entity as a markdown section (## header + body + metadata list,
 * optionally a version-history subsection). Pure.
 * @returns {string[]} lines (no trailing separator)
 */
function entityToMarkdownLines(e, { includeHistory = false } = {}) {
  const lines = [];
  lines.push(`## [${e.id}] ${(e.type || "text").toUpperCase()}`);
  lines.push("");
  lines.push(e.text);
  lines.push("");
  lines.push(`- **ID:** ${e.id}`);
  lines.push(`- **Type:** ${e.type || "text"}`);
  lines.push(`- **Memory type:** ${e.memoryType || "long-term"}`);
  lines.push(`- **Workspace:** ${e.workspaceId || "default"}`);
  lines.push(`- **Classification:** ${e.classification || "internal"}`);
  lines.push(`- **Tags:** ${(e.tags || []).join(", ") || "none"}`);
  lines.push(`- **Source:** ${e.source?.type || "user"}${e.source?.actor ? " (" + e.source.actor + ")" : ""}`);
  lines.push(`- **Created:** ${new Date(e.createdAt).toISOString()}`);
  lines.push(`- **Updated:** ${new Date(e.updatedAt).toISOString()}`);
  lines.push(`- **Versions:** ${e.versions?.length || 1}`);

  if (includeHistory && e.versions?.length > 1) {
    lines.push("");
    lines.push("### Version History");
    lines.push("");
    const versionsOldest = [...e.versions].reverse();
    for (let i = 0; i < versionsOldest.length; i++) {
      const v = versionsOldest[i];
      const delta = v.delta ? ` [${v.delta.type}] ${v.delta.summary}` : " (initial)";
      lines.push(`${i + 1}. **${new Date(v.timestamp).toISOString()}**${delta}`);
      if (v.text !== e.text) lines.push(`   > ${v.text.slice(0, 120)}`);
    }
  }
  return lines;
}

/**
 * Render a full markdown export document for a list of entities. The caller
 * is responsible for filtering/sorting; this just formats. Pure.
 * @returns {string}
 */
function renderExport(entities, { includeHistory = false } = {}) {
  const lines = ["# Kalairos — Memory Export", ""];
  lines.push(`> Exported ${entities.length} entities at ${new Date().toISOString()}`, "");
  for (const e of entities) {
    lines.push(...entityToMarkdownLines(e, { includeHistory }));
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Parse markdown (in the renderExport format, or a plain bullet/line list)
 * into fact descriptors ready for ingest. Pure — no ingestion happens here.
 *
 * Returns `{ mode, facts }`:
 *   - mode "structured": facts are `{ type, text }`, one per `## [id] TYPE`
 *     section (metadata/history lines stripped). Type comes from the header.
 *   - mode "bullets": facts are `{ text }`, one per bullet/plain line; the
 *     caller supplies the type from its defaults.
 *   - mode "empty": nothing parseable.
 *
 * @param {string} mdText
 * @returns {{ mode: "structured"|"bullets"|"empty", facts: Array<{type?: string, text: string}> }}
 */
function parseMarkdownFacts(mdText) {
  const text = String(mdText || "");
  if (!text.trim()) return { mode: "empty", facts: [] };

  const headerRe = /^##\s+\[(\d+)\]\s+(.+)/;
  const lines = text.split("\n");
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    const headerMatch = line.match(headerRe);
    if (headerMatch) {
      if (currentSection) sections.push(currentSection);
      currentSection = { type: headerMatch[2].trim().toLowerCase(), lines: [] };
      continue;
    }
    if (currentSection) {
      // Skip metadata / history / separator / blockquote lines.
      const trimmed = line.trim();
      if (/^- \*\*/.test(trimmed) || /^###/.test(trimmed) || /^---$/.test(trimmed) || /^>/.test(trimmed)) continue;
      if (trimmed) currentSection.lines.push(trimmed);
    }
  }
  if (currentSection) sections.push(currentSection);

  if (sections.length > 0) {
    const facts = [];
    for (const sec of sections) {
      const factText = sec.lines.join(" ").trim();
      if (!factText) continue;
      facts.push({ type: sec.type === "text" ? "text" : sec.type, text: factText });
    }
    return { mode: "structured", facts };
  }

  // Fallback: treat bullet points or plain lines as individual facts.
  const bullets = lines
    .map(l => l.replace(/^[\s]*[-*]\s+/, "").trim())
    .filter(l => l.length > 0 && !l.startsWith("#") && !l.startsWith(">"));
  if (!bullets.length) return { mode: "empty", facts: [] };
  return { mode: "bullets", facts: bullets.map(text => ({ text })) };
}

module.exports = { entityToMarkdownLines, renderExport, parseMarkdownFacts };
