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
  // A thing's key and fields, which parseMarkdownFacts reads back so an
  // import lands on the same thing. Entities without them export as before.
  // A link is a keyed record whose fields hold { from, rel, to }, so it
  // comes back as a link.
  if (e.key != null)    lines.push(`- **Key:** ${e.key}`);
  if (e.fields != null) lines.push(`- **Fields:** ${JSON.stringify(e.fields)}`);
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
 *   - mode "structured": facts are `{ type, text, key?, fields? }`, one per
 *     `## [id] TYPE` section (metadata/history lines stripped). Type comes
 *     from the section's `- **Type:**` line, which keeps its case, or else
 *     the header; key and fields from its `- **Key:**` and `- **Fields:**`
 *     lines, when it has them.
 *   - mode "bullets": facts are `{ text }`, one per bullet/plain line; the
 *     caller supplies the type from its defaults.
 *   - mode "empty": nothing parseable.
 *
 * Throws when a Fields line isn't a JSON object: importing the thing without
 * its facts would be silent loss.
 *
 * @param {string} mdText
 * @returns {{ mode: "structured"|"bullets"|"empty", facts: Array<{type?: string, text: string, key?: string, fields?: object}> }}
 */
function parseMarkdownFacts(mdText) {
  const text = String(mdText || "");
  if (!text.trim()) return { mode: "empty", facts: [] };

  const headerRe = /^##\s+\[(\d+)\]\s+(.+)/;
  const typeRe   = /^- \*\*Type:\*\*\s*(.+)$/;
  const keyRe    = /^- \*\*Key:\*\*\s*(.+)$/;
  const fieldsRe = /^- \*\*Fields:\*\*\s*(.+)$/;
  const lines = text.split("\n");
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    const headerMatch = line.match(headerRe);
    if (headerMatch) {
      if (currentSection) sections.push(currentSection);
      currentSection = { id: headerMatch[1], type: headerMatch[2].trim().toLowerCase(), lines: [] };
      continue;
    }
    if (currentSection) {
      // Skip metadata / history / separator / blockquote lines, reading back
      // the ones that make up a thing's identity: type, key and fields.
      const trimmed = line.trim();
      // Version history closes a section, and its numbered entries are past
      // versions, not this one's text.
      if (/^###\s+Version History\b/.test(trimmed)) { currentSection.inHistory = true; continue; }
      if (currentSection.inHistory) continue;
      let m;
      if ((m = trimmed.match(typeRe)))   { currentSection.type   = m[1].trim(); continue; }
      if ((m = trimmed.match(keyRe)))    { currentSection.key    = m[1].trim(); continue; }
      if ((m = trimmed.match(fieldsRe))) { currentSection.fields = _parseFieldsLine(m[1], currentSection.id); continue; }
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
      const fact = { type: sec.type === "text" ? "text" : sec.type, text: factText };
      if (sec.key != null)    fact.key    = sec.key;
      if (sec.fields != null) fact.fields = sec.fields;
      facts.push(fact);
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

// A Fields line is the JSON object entityToMarkdownLines wrote.
function _parseFieldsLine(raw, sectionId) {
  let fields;
  try { fields = JSON.parse(raw); }
  catch (err) { throw new Error(`Section [${sectionId}]: the Fields line is not valid JSON (${err.message})`); }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error(`Section [${sectionId}]: the Fields line must be a JSON object`);
  }
  return fields;
}

module.exports = { entityToMarkdownLines, renderExport, parseMarkdownFacts };
