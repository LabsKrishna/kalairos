"""Control plane — the visual ledger that reads every event the agent
runtime emits and renders it as a human-inspectable timeline.

This is the headline first slice per the agent-platform architecture:
the storage spine + agent runtime + cross-runtime handoff exist so
that *this* — a way to actually see what your agents did — can sit on
top of them. The control plane reads from the same Ledger that the
runtime writes to; no separate database, no separate event bus.

What it surfaces:
- A list of runs across all agents in the ledger (most-recent first).
- For each run: every event in order — LLM calls (with cache token
  counts), tool calls, branch decisions, cross-runtime handoffs.
- Status, duration, the user message that started it, and the final
  result or failure reason.

Phase 4.1 (this file): backend data shaping + a single HTML/JS page
served inline by LedgerServer. Phase 4.2 will add workflow-graph
visualization (the actual node graph, not just the timeline). Phase
4.3 will add live updates via SSE so the page reacts to new events
without polling.
"""

from __future__ import annotations

from typing import Any

from .ledger import Ledger


# Per-event metadata field that uniquely identifies which run an event
# belongs to. Run IDs are prefixed onto event ids by Run.emit:
#   <run_id>/<seq>/<event_type>
# but the run_id is *also* in metadata.run_id, which is what we read
# here because it's authoritative (the id format may evolve).
_META = "metadata"


# Event types we group under a coarser "what kind of step is this"
# bucket for the timeline rendering. Keep this map tight — the UI
# uses it to pick icons + colors.
EVENT_BUCKETS = {
    "run_started": "lifecycle",
    "run_completed": "lifecycle",
    "run_failed": "lifecycle",
    "thought": "think",
    "tool_call_requested": "tool",
    "tool_call_result": "tool",
    "tool_call_failed": "tool",
    "llm_request": "llm",
    "llm_response": "llm",
    "llm_text": "llm",
    "graph_defined": "node",
    "node_entered": "node",
    "node_completed": "node",
    "branch_chosen": "node",
    "handoff_requested": "handoff",
    "handoff_completed": "handoff",
    "handoff_failed": "handoff",
}


def list_runs(ledger: Ledger) -> list[dict]:
    """Return one summary dict per distinct run in the ledger.

    Iterates the JSONL once and groups by metadata.run_id. We read
    from the JSONL directly (not SQLite) because metadata isn't a
    SQLite column and a small ledger doesn't justify a richer schema
    yet. Sized for development-scale traces (thousands of events);
    Phase 4 follow-ups will move this to SQLite indexes once traces
    grow.

    Returned shape (most recent first):
      {
        "run_id":      "run-abc123",
        "agent":       "pr-risk-analyzer",
        "goal":        "Review PR #28.",          # may be None
        "status":      "completed" | "running" | "failed",
        "started_at":  1234567890,
        "ended_at":    1234567899,                # None while running
        "duration_ms": 9000,                      # None while running
        "event_count": 12,
        "result":      "...",                     # only on completed
        "error":       "...",                     # only on failed
      }
    """
    runs: dict[str, dict] = {}
    for rec in ledger.appender.load_raw():
        md = rec.get(_META) or {}
        run_id = md.get("run_id")
        if not run_id:
            continue
        bucket = runs.setdefault(
            run_id,
            {
                "run_id": run_id,
                "agent": md.get("agent_name"),
                "goal": None,
                "status": "running",
                "started_at": None,
                "ended_at": None,
                "duration_ms": None,
                "event_count": 0,
                "result": None,
                "error": None,
            },
        )
        bucket["event_count"] += 1
        if bucket["agent"] is None:
            bucket["agent"] = md.get("agent_name")
        event_type = md.get("event_type")
        payload = md.get("payload") or {}
        ts = _record_timestamp(rec)
        if event_type == "run_started":
            bucket["started_at"] = ts
            bucket["goal"] = payload.get("goal")
        elif event_type == "run_completed":
            bucket["status"] = "completed"
            bucket["ended_at"] = ts
            bucket["result"] = payload.get("result")
        elif event_type == "run_failed":
            bucket["status"] = "failed"
            bucket["ended_at"] = ts
            bucket["error"] = payload.get("error")

    # Compute durations and sort newest-first by start time, falling
    # back to "running" runs (no end yet) above anything ended.
    for run in runs.values():
        if run["started_at"] is not None and run["ended_at"] is not None:
            run["duration_ms"] = run["ended_at"] - run["started_at"]

    def _sort_key(r: dict) -> int:
        # Pin running runs at the top; among ended ones, newest end first.
        return -(r["ended_at"] or 10**15) if r["status"] != "running" else -(10**18)

    return sorted(runs.values(), key=_sort_key)


def events_for_run(ledger: Ledger, run_id: str) -> list[dict]:
    """Return all events belonging to one run, ordered by sequence.

    The returned shape is suitable for the timeline UI directly:
      {
        "seq":         0,
        "event_type":  "run_started",
        "bucket":      "lifecycle",
        "timestamp":   1234567890,
        "delta_ms":    0,                     # ms since first event
        "payload":     {...},                 # event-specific
      }
    """
    raw_events: list[dict] = []
    for rec in ledger.appender.load_raw():
        md = rec.get(_META) or {}
        if md.get("run_id") != run_id:
            continue
        raw_events.append(rec)

    raw_events.sort(key=lambda r: (r.get(_META) or {}).get("seq", 0))

    first_ts = _record_timestamp(raw_events[0]) if raw_events else 0
    out: list[dict] = []
    for rec in raw_events:
        md = rec.get(_META) or {}
        event_type = md.get("event_type")
        ts = _record_timestamp(rec)
        out.append(
            {
                "seq": md.get("seq"),
                "event_type": event_type,
                "bucket": EVENT_BUCKETS.get(event_type, "other"),
                "timestamp": ts,
                "delta_ms": ts - first_ts,
                "payload": md.get("payload") or {},
            }
        )
    return out


def _record_timestamp(rec: dict) -> int:
    """Pluck the canonical timestamp off a record. Run events store one
    version per event (see Run.emit), so versions[0].timestamp is the
    event time. Fall back to 0 for malformed records."""
    versions = rec.get("versions") or []
    if versions:
        ts = versions[0].get("timestamp")
        if isinstance(ts, (int, float)):
            return int(ts)
    return 0


# ── Inline HTML/CSS/JS page ────────────────────────────────────────────────
#
# Kept as a single string so LedgerServer can serve it with zero static-
# file plumbing. Vanilla JS + fetch — no framework, no build step. The
# whole page is ~250 lines including style + script.
HTML_PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Kalairos · Control Plane</title>
<style>
  :root {
    --bg: #fafaf9;
    --fg: #1c1917;
    --muted: #78716c;
    --border: #e7e5e4;
    --card: #ffffff;
    --accent: #0369a1;
    --lifecycle: #525252;
    --think: #6b7280;
    --tool: #047857;
    --llm: #6d28d9;
    --node: #b45309;
    --handoff: #be185d;
    --other: #404040;
    --ok: #16a34a;
    --fail: #dc2626;
    --running: #2563eb;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg); color: var(--fg);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  header {
    padding: 12px 20px; border-bottom: 1px solid var(--border);
    background: var(--card); display: flex; align-items: center; gap: 16px;
  }
  header h1 { font-size: 16px; font-weight: 600; margin: 0; }
  header .sub { color: var(--muted); font-size: 12px; }
  header button {
    margin-left: auto; padding: 4px 10px; border: 1px solid var(--border);
    background: var(--card); border-radius: 4px; cursor: pointer;
    font: inherit; color: var(--fg);
  }
  header button:hover { background: var(--bg); }
  main { display: grid; grid-template-columns: 320px 1fr; height: calc(100% - 49px); }
  #graph-panel {
    padding: 12px 20px; border-bottom: 1px solid var(--border);
    background: var(--card);
  }
  #graph-panel h3 {
    margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--muted); font-weight: 600;
  }
  #graph-svg { width: 100%; height: auto; display: block; }
  #graph-svg .node rect, #graph-svg .node circle {
    fill: var(--card); stroke: var(--border); stroke-width: 1.5;
    transition: fill 0.15s, stroke 0.15s;
  }
  #graph-svg .node.traversed rect, #graph-svg .node.traversed circle {
    fill: #dcfce7; stroke: var(--ok);
  }
  #graph-svg .node.failed rect, #graph-svg .node.failed circle {
    fill: #fee2e2; stroke: var(--fail);
  }
  #graph-svg .node text { font: 11px ui-monospace, monospace; fill: var(--fg); }
  #graph-svg .node .kind {
    font: 9px -apple-system, sans-serif; fill: var(--muted);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  #graph-svg .node.handoff rect { stroke-dasharray: 4 3; stroke: var(--handoff); }
  #graph-svg .node.branch circle { stroke: var(--node); }
  #graph-svg .edge {
    fill: none; stroke: var(--border); stroke-width: 1.5;
    marker-end: url(#arrow);
  }
  #graph-svg .edge.traversed { stroke: var(--ok); stroke-width: 2; }
  #graph-svg .edge.handoff   { stroke: var(--handoff); stroke-dasharray: 4 3; }
  #graph-svg .edge-label {
    font: 10px ui-monospace, monospace; fill: var(--muted);
  }
  #graph-svg .edge-label.traversed { fill: var(--ok); font-weight: 600; }
  #runs {
    overflow-y: auto; border-right: 1px solid var(--border);
    background: var(--card);
  }
  #runs .run {
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  #runs .run:hover { background: var(--bg); }
  #runs .run.selected { background: #e0f2fe; }
  #runs .run .id { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
  #runs .run .agent { font-weight: 500; }
  #runs .run .meta {
    display: flex; gap: 8px; font-size: 11px; color: var(--muted); margin-top: 2px;
  }
  #runs .run .badge {
    padding: 1px 6px; border-radius: 3px; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
  }
  .badge.completed { background: #dcfce7; color: var(--ok); }
  .badge.failed    { background: #fee2e2; color: var(--fail); }
  .badge.running   { background: #dbeafe; color: var(--running); }
  #events { overflow-y: auto; padding: 16px 20px; }
  #events .empty { color: var(--muted); font-style: italic; }
  #events .run-header { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  #events .run-header h2 { margin: 0 0 4px 0; font-size: 16px; }
  #events .run-header .info { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
  #events .run-header .info .label { font-weight: 500; color: var(--fg); }
  #events .run-result {
    margin-top: 8px; padding: 10px; background: var(--card);
    border: 1px solid var(--border); border-radius: 4px;
    white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px;
  }
  .event {
    display: grid; grid-template-columns: 80px 28px 1fr; gap: 10px;
    padding: 6px 0; border-bottom: 1px solid var(--border); align-items: start;
  }
  .event:last-child { border-bottom: none; }
  .event .delta { color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; }
  .event .bucket {
    width: 24px; height: 18px; border-radius: 3px;
    font-size: 9px; text-align: center; line-height: 18px; color: white;
    text-transform: uppercase; font-weight: 600; letter-spacing: 0.04em;
  }
  .event .bucket.lifecycle { background: var(--lifecycle); }
  .event .bucket.think     { background: var(--think); }
  .event .bucket.tool      { background: var(--tool); }
  .event .bucket.llm       { background: var(--llm); }
  .event .bucket.node      { background: var(--node); }
  .event .bucket.handoff   { background: var(--handoff); }
  .event .bucket.other     { background: var(--other); }
  .event .body { min-width: 0; }
  .event .body .type {
    font-family: ui-monospace, monospace; font-size: 12px; color: var(--fg);
  }
  .event .body .summary { color: var(--muted); font-size: 12px; margin-top: 2px; word-break: break-word; }
  .event .body details { margin-top: 4px; }
  .event .body details summary { cursor: pointer; color: var(--accent); font-size: 11px; }
  .event .body pre {
    margin: 4px 0 0 0; padding: 6px; background: var(--card);
    border: 1px solid var(--border); border-radius: 3px;
    overflow-x: auto; font-size: 11px;
  }
</style>
</head>
<body>
<header>
  <h1>Kalairos · Control Plane</h1>
  <span class="sub" id="conn">connecting…</span>
  <button id="refresh">Refresh</button>
</header>
<main>
  <aside id="runs"><div class="empty" style="padding:16px;color:#78716c;font-style:italic">Loading runs…</div></aside>
  <section id="events"><div class="empty">Select a run on the left.</div></section>
</main>
<script>
  let selectedRunId = null;
  const runsEl   = document.getElementById('runs');
  const eventsEl = document.getElementById('events');
  const connEl   = document.getElementById('conn');

  function fmt(ms) {
    if (!ms && ms !== 0) return '—';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }
  function fmtTime(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function summary(ev) {
    const p = ev.payload || {};
    switch (ev.event_type) {
      case 'run_started':       return p.agent + (p.goal ? ` — ${p.goal}` : '');
      case 'run_completed':     return 'completed';
      case 'run_failed':        return p.error || 'failed';
      case 'thought':           return p.text || '';
      case 'tool_call_requested':
        return `${p.tool}(${Object.entries(p.input || {}).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`;
      case 'tool_call_result':  return `${p.tool} → ${JSON.stringify(p.result)}`;
      case 'tool_call_failed':  return `${p.tool} !! ${p.error}`;
      case 'llm_request':       return `iter=${p.iteration} model=${p.model}`;
      case 'llm_response':
        const u = p.usage || {};
        return `stop=${p.stop_reason} in:${u.input_tokens}/out:${u.output_tokens}` +
          (u.cache_read_input_tokens ? ` cached:${u.cache_read_input_tokens}` : '');
      case 'llm_text':          return (p.text || '').slice(0, 120);
      case 'node_entered':      return `→ ${p.node}`;
      case 'node_completed':    return `✓ ${p.node}`;
      case 'branch_chosen':     return `${p.node}: ${p.key} → ${p.target}`;
      case 'handoff_requested': return `${p.service} (${p.handoff_id})`;
      case 'handoff_completed': return `${p.service} ✓ (${p.handoff_id})`;
      case 'handoff_failed':    return `${p.service} !! ${p.error}`;
      default:                  return '';
    }
  }

  async function loadRuns() {
    try {
      const resp = await fetch('/runs');
      if (!resp.ok) throw new Error(`/runs returned ${resp.status}`);
      const { runs } = await resp.json();
      connEl.textContent = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
      renderRuns(runs);
    } catch (err) {
      connEl.textContent = `error: ${err.message}`;
    }
  }

  function renderRuns(runs) {
    if (!runs.length) {
      runsEl.innerHTML = '<div class="empty" style="padding:16px;color:#78716c;font-style:italic">No runs in the ledger yet.</div>';
      return;
    }
    runsEl.innerHTML = runs.map(r => `
      <div class="run ${r.run_id === selectedRunId ? 'selected' : ''}" data-id="${escapeHtml(r.run_id)}">
        <div class="agent">${escapeHtml(r.agent || '—')}</div>
        <div class="id">${escapeHtml(r.run_id)}</div>
        <div class="meta">
          <span class="badge ${r.status}">${r.status}</span>
          <span>${fmt(r.duration_ms)}</span>
          <span>${r.event_count} ev</span>
        </div>
      </div>
    `).join('');
    runsEl.querySelectorAll('.run').forEach(el => {
      el.addEventListener('click', () => selectRun(el.dataset.id));
    });
  }

  async function selectRun(runId) {
    selectedRunId = runId;
    runsEl.querySelectorAll('.run').forEach(el => {
      el.classList.toggle('selected', el.dataset.id === runId);
    });
    eventsEl.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const [runsResp, evResp] = await Promise.all([
        fetch('/runs'),
        fetch('/runs/' + encodeURIComponent(runId) + '/events'),
      ]);
      const { runs } = await runsResp.json();
      const { events } = await evResp.json();
      const run = runs.find(r => r.run_id === runId);
      renderEvents(run, events);
    } catch (err) {
      eventsEl.innerHTML = `<div class="empty">error: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderEvents(run, events) {
    if (!run) {
      eventsEl.innerHTML = '<div class="empty">Run not found.</div>';
      return;
    }
    const header = `
      <div class="run-header">
        <h2>${escapeHtml(run.agent || 'agent')} · <span style="color:#78716c">${escapeHtml(run.run_id)}</span></h2>
        <div class="info">
          <span><span class="label">status:</span> <span class="badge ${run.status}">${run.status}</span></span>
          <span><span class="label">started:</span> ${fmtTime(run.started_at)}</span>
          <span><span class="label">duration:</span> ${fmt(run.duration_ms)}</span>
          <span><span class="label">events:</span> ${run.event_count}</span>
          ${run.goal ? `<span><span class="label">goal:</span> ${escapeHtml(run.goal)}</span>` : ''}
        </div>
        ${run.result ? `<div class="run-result">${escapeHtml(typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2))}</div>` : ''}
        ${run.error ? `<div class="run-result" style="color:#dc2626">${escapeHtml(run.error)}</div>` : ''}
      </div>
    `;
    const graphPanel = renderGraphPanel(events, run);
    const rows = events.map(ev => `
      <div class="event">
        <div class="delta">+${fmt(ev.delta_ms)}</div>
        <div class="bucket ${ev.bucket}">${ev.bucket.slice(0, 4)}</div>
        <div class="body">
          <div class="type">${escapeHtml(ev.event_type)}</div>
          <div class="summary">${escapeHtml(summary(ev))}</div>
          <details>
            <summary>payload</summary>
            <pre>${escapeHtml(JSON.stringify(ev.payload, null, 2))}</pre>
          </details>
        </div>
      </div>
    `).join('');
    eventsEl.innerHTML = header + graphPanel + rows;
  }

  // ── Workflow-graph visualization (Phase 4.2) ───────────────────────────
  //
  // Rendered only for runs that emitted a `graph_defined` event (which
  // means they were driven by the Executor over a WorkflowGraph;
  // LLMLoop-driven runs have no graph, so this panel is hidden).
  //
  // Layout: layered DAG. Depth assigned by BFS from the start node;
  // nodes at the same depth fan out horizontally. Edges drawn as
  // straight lines with arrowheads; the chosen branch from a
  // BranchNode is highlighted from the trail's branch_chosen events.

  function renderGraphPanel(events, run) {
    const defined = events.find(e => e.event_type === 'graph_defined');
    if (!defined) return '';
    const graph = (defined.payload || {}).graph;
    if (!graph || !graph.nodes) return '';

    const visited = new Set(
      events.filter(e => e.event_type === 'node_entered')
            .map(e => (e.payload || {}).node)
    );
    const branchChoices = new Map(
      events.filter(e => e.event_type === 'branch_chosen').map(e => {
        const p = e.payload || {};
        return [p.node, { key: p.key, target: p.target }];
      })
    );
    const failed = run.status === 'failed';

    const svg = layoutAndRenderGraph(graph, visited, branchChoices, failed);
    return `
      <div id="graph-panel">
        <h3>Workflow graph · ${escapeHtml(graph.name)}</h3>
        ${svg}
      </div>
    `;
  }

  function layoutAndRenderGraph(graph, visited, branchChoices, failed) {
    const nodes = graph.nodes;
    const byName = new Map(nodes.map(n => [n.name, n]));

    // Assign depth via BFS from start.
    const depth = new Map();
    const order = new Map(); // insertion order for tiebreak
    nodes.forEach((n, i) => order.set(n.name, i));
    const queue = [[graph.start, 0]];
    while (queue.length) {
      const [name, d] = queue.shift();
      if (!byName.has(name)) continue;
      if (depth.has(name) && depth.get(name) <= d) continue;
      depth.set(name, d);
      const n = byName.get(name);
      const successors = n.kind === 'branch'
        ? Object.values(n.branches || {})
        : (n.next ? [n.next] : []);
      for (const s of successors) {
        queue.push([s, d + 1]);
      }
    }
    // Any unreachable nodes go to depth 0 (shouldn't happen for a
    // validated graph, but defensive).
    for (const n of nodes) {
      if (!depth.has(n.name)) depth.set(n.name, 0);
    }

    // Group by depth.
    const byDepth = new Map();
    for (const n of nodes) {
      const d = depth.get(n.name);
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d).push(n);
    }
    for (const [d, list] of byDepth) {
      list.sort((a, b) => order.get(a.name) - order.get(b.name));
    }

    // Layout geometry.
    const COL_W = 180;
    const ROW_H = 90;
    const PAD = 30;
    const NODE_W = 140;
    const NODE_H = 50;
    const maxCols = Math.max(...[...byDepth.values()].map(l => l.length));
    const width = PAD * 2 + maxCols * COL_W;
    const height = PAD * 2 + byDepth.size * ROW_H;

    const pos = new Map();
    for (const [d, list] of byDepth) {
      // Center the row within `width`.
      const rowWidth = list.length * COL_W;
      const xStart = (width - rowWidth) / 2 + COL_W / 2;
      list.forEach((n, i) => {
        pos.set(n.name, { x: xStart + i * COL_W, y: PAD + d * ROW_H + NODE_H / 2 });
      });
    }

    // Build edges with metadata about whether they were traversed.
    const edges = [];
    for (const n of nodes) {
      const fromName = n.name;
      if (n.kind === 'branch') {
        const choice = branchChoices.get(fromName);
        for (const [key, target] of Object.entries(n.branches || {})) {
          edges.push({
            from: fromName, to: target, label: key,
            traversed: choice && choice.target === target,
          });
        }
      } else if (n.next) {
        edges.push({
          from: fromName, to: n.next,
          // A linear next-edge is "traversed" iff both ends were entered.
          traversed: visited.has(fromName) && visited.has(n.next),
          handoff: n.kind === 'handoff',
        });
      }
    }

    // Render SVG.
    const arrows = `
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
    `;

    const edgeSvg = edges.map(e => {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return '';
      // Start/end at node edges (rough).
      const x1 = a.x, y1 = a.y + NODE_H / 2;
      const x2 = b.x, y2 = b.y - NODE_H / 2;
      const cls = [
        'edge',
        e.traversed ? 'traversed' : '',
        e.handoff ? 'handoff' : '',
      ].filter(Boolean).join(' ');
      const labelSvg = e.label ? `
        <text class="edge-label ${e.traversed ? 'traversed' : ''}"
              x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2}">${escapeHtml(e.label)}</text>
      ` : '';
      return `
        <line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
        ${labelSvg}
      `;
    }).join('');

    const nodeSvg = nodes.map(n => {
      const p = pos.get(n.name);
      if (!p) return '';
      const isLast = visited.has(n.name) && Array.from(visited).slice(-1)[0] === n.name;
      const traversed = visited.has(n.name);
      const classes = [
        'node', n.kind,
        traversed ? 'traversed' : '',
        failed && isLast ? 'failed' : '',
      ].filter(Boolean).join(' ');
      const x = p.x - NODE_W / 2;
      const y = p.y - NODE_H / 2;
      // Branch nodes get a circle; everything else a rect.
      const shape = n.kind === 'branch'
        ? `<circle cx="${p.x}" cy="${p.y}" r="${NODE_H / 2 + 2}" />`
        : `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="4" ry="4" />`;
      const label = n.kind === 'step' && n.tool
        ? `${n.name}\n${n.tool}()`
        : n.kind === 'handoff'
          ? `${n.name}\n↗ ${n.service}`
          : n.kind === 'branch'
            ? n.name
            : n.kind === 'step' && n.think
              ? `${n.name}\n(think)`
              : n.name;
      const lines = label.split('\n');
      const textSvg = lines.map((line, i) => `
        <text x="${p.x}" y="${p.y - (lines.length - 1) * 6 + i * 12 + 4}"
              text-anchor="middle">${escapeHtml(line)}</text>
      `).join('');
      const kindLabel = `
        <text class="kind" x="${p.x}" y="${y - 4}" text-anchor="middle">${n.kind}</text>
      `;
      return `<g class="${classes}">${shape}${textSvg}${kindLabel}</g>`;
    }).join('');

    return `
      <svg id="graph-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMin meet">
        ${arrows}
        ${edgeSvg}
        ${nodeSvg}
      </svg>
    `;
  }

  document.getElementById('refresh').addEventListener('click', () => {
    loadRuns();
    if (selectedRunId) selectRun(selectedRunId);
  });

  loadRuns();
</script>
</body>
</html>
"""
