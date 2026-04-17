#!/usr/bin/env node
// examples/support-agent-demo.js
// Repeatable enterprise support-agent memory demo for sales calls.
"use strict";

const path = require("path");
const smriti = require(path.resolve(__dirname, "..", "index"));

const EMBED_DIM = 256;
const DAY = 86_400_000;

function supportEmbed(text) {
  const vec = new Float64Array(EMBED_DIM);
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9$.\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const word of words) {
    for (let seed = 0; seed < 3; seed++) {
      let hash = seed * 2654435769;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      vec[(hash >>> 0) % EMBED_DIM] += 1;
    }
  }

  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;

  const out = new Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = vec[i] / norm;
  return out;
}

function line(title) {
  console.log("");
  console.log(`=== ${title} ===`);
}

function showResult(label, result) {
  const top = result.results && result.results[0];
  console.log(`${label}:`);
  if (!top) {
    console.log("  No result returned.");
    return;
  }
  console.log(`  ${top.text}`);
  console.log(`  score=${top.score} source=${JSON.stringify(top.source)} classification=${top.classification}`);
}

async function main() {
  await smriti.init({
    dataFile: ":memory:",
    embedFn: async (text) => supportEmbed(text),
    embeddingDim: EMBED_DIM,
    versionThreshold: 0.58,
    consolidationThreshold: 0.45,
    linkThreshold: 0.35,
    minFinalScore: 0.08,
    minSemanticScore: 0.05,
  });

  const agent = smriti.createAgent({
    name: "support-agent",
    defaultClassification: "confidential",
    defaultTags: ["support", "refund-policy"],
  });

  const t1 = Date.UTC(2026, 0, 10, 9, 0, 0);
  const t2 = t1 + 14 * DAY;
  const beforePolicyChange = t2 - 1;

  line("1. Store support policy v1");
  const policyV1 = "Refund policy for premium customers: full refund allowed within 30 days when the order is unopened.";
  const policyId = await agent.remember(policyV1, {
    timestamp: t1,
    source: { type: "tool", uri: "support-kb://refund-policy" },
    workspaceId: "support-prod",
    memoryType: "long-term",
    importance: 0.95,
  });
  console.log(`Stored policy memory id=${policyId}`);

  line("2. Update policy v2");
  const policyV2 = "Refund policy for premium customers: full refund allowed within 45 days when the order is unopened.";
  const updatedPolicyId = await agent.remember(policyV2, {
    timestamp: t2,
    source: { type: "user", actor: "support-ops-lead" },
    workspaceId: "support-prod",
    memoryType: "long-term",
    importance: 0.95,
  });
  console.log(`Updated same memory id=${updatedPolicyId}`);

  line("3. Store customer-specific support context");
  await agent.remember("Customer Acme Robotics has premium support entitlement and prefers email follow-up after refunds.", {
    timestamp: t2 + 1_000,
    source: { type: "tool", uri: "ticket://ACME-1042" },
    workspaceId: "support-prod",
    tags: ["customer-acme", "entitlement"],
    importance: 0.8,
  });
  console.log("Stored customer context for Acme Robotics.");

  line("4. Recall current policy");
  const current = await agent.recall("premium customer refund policy unopened order", {
    limit: 3,
    filter: { workspaceId: "support-prod" },
  });
  showResult("Current answer", current);

  line("5. Recall historical policy with asOf");
  const historical = await agent.recall("premium customer refund policy unopened order", {
    limit: 3,
    asOf: beforePolicyChange,
    filter: { workspaceId: "support-prod" },
  });
  showResult("Historical answer before policy change", historical);

  line("6. Show version history and delta");
  const history = await agent.getHistory(policyId);
  for (const version of history.versions) {
    const date = new Date(version.timestamp).toISOString().slice(0, 10);
    const delta = version.delta ? ` | ${version.delta.summary}` : " | initial";
    console.log(`v${version.version} ${date}: ${version.text}${delta}`);
  }

  line("7. Show provenance and governance fields");
  const entity = await smriti.get(policyId);
  console.log(JSON.stringify({
    id: entity.id,
    source: entity.source,
    classification: entity.classification,
    workspaceId: entity.workspaceId,
    memoryType: entity.memoryType,
    tags: entity.tags,
    versionCount: entity.versionCount,
  }, null, 2));

  line("8. Export markdown for human review");
  const markdown = await smriti.exportMarkdown({
    filter: { workspaceId: "support-prod" },
    includeHistory: true,
  });
  console.log(markdown.split("\n").slice(0, 28).join("\n"));
  console.log("...");

  await smriti.shutdown();
}

main().catch(async (err) => {
  console.error("Support-agent demo failed:", err.message || err);
  try { await smriti.shutdown(); } catch {}
  process.exit(1);
});
