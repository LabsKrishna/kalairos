"""PR risk analyzer — reads GitHub PR file changes and summarizes risk.

Phase 3.1 ships an LLM-driven version: a `fetch_pr_files` + `fetch_pr_diff`
tool pair plus an Agent whose instructions tell the model to classify
files (critical / doc / test), deep-scan the critical ones, and produce
a terse risk verdict. The LLMLoop decides the flow autonomously — the
model picks which tool to call, in what order, and when to stop.

Phase 3.2 will layer a declarative WorkflowGraph (explicit branches on
critical-file vs. doc, per-file deep-scan steps) on the same tools so
high-stakes runs can be deterministic and inspectable.

Phase 3.3 will add a HandoffNode that delegates dependency-graph
construction to a Node service per the agent-platform architecture
(Python owns the JSONL ledger; Node services build state/nodes/edges
in parallel and POST results back).
"""

from __future__ import annotations

import re
import subprocess
from typing import Any

from ..agent import Agent
from ..llm import DEFAULT_MODEL, llm_text_call
from ..tool import Tool, tool
from ..workflow_graph import BranchNode, HandoffNode, StepNode, WorkflowGraph

# Name of the Node-side service that builds the file-relationship
# dependency graph. Surfaced in the `handoff_requested` event payload
# so a real service (or a test simulator) knows which handoffs to
# answer. Keep this stable — production routing keys off it.
DEP_GRAPH_SERVICE = "kalairos-dep-graph-builder"

# Default timeout for the dep-graph handoff. Dep-graph construction on
# a 50-file PR runs in seconds; 30s is the safety net so authoring
# mistakes (Node service down, queue stuck) fail the run instead of
# hanging it.
DEP_GRAPH_TIMEOUT_S = 30.0


# Timeouts on the `gh` subprocess calls. `pr diff` can be slow on huge
# PRs; `pr view --json files` returns quickly even on hundreds of files.
_DIFF_TIMEOUT_S = 30
_VIEW_TIMEOUT_S = 15


@tool(
    description=(
        "Fetch the list of changed files in a GitHub pull request by "
        "number. Returns one filename per line. Use this first to see "
        "what's touched — it's lighter than the full diff."
    ),
    parameters={
        "type": "object",
        "properties": {
            "pr_number": {
                "type": "integer",
                "description": "The PR number to inspect",
            },
        },
        "required": ["pr_number"],
    },
)
def fetch_pr_files(pr_number: int) -> str:
    """Run `gh pr view <pr_number> --json files --jq '.files[].path'`.

    Returns the stdout (one file path per line) on success. On failure
    returns a string starting with "Error: ..." rather than raising —
    the LLM sees the error and adapts (e.g., tries a different PR
    number or gives up gracefully). Tool exceptions in the LLM loop
    become `is_error` tool_results, but a clean error-string keeps the
    happy path on rails.
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                str(pr_number),
                "--json",
                "files",
                "--jq",
                ".files[].path",
            ],
            capture_output=True,
            text=True,
            timeout=_VIEW_TIMEOUT_S,
        )
    except FileNotFoundError:
        return "Error: `gh` CLI is not installed or not on PATH"
    except subprocess.TimeoutExpired:
        return f"Error: gh pr view timed out after {_VIEW_TIMEOUT_S}s"

    if result.returncode != 0:
        return (
            f"Error: gh pr view exited {result.returncode}: "
            f"{result.stderr.strip()}"
        )
    return result.stdout


@tool(
    description=(
        "Fetch the unified diff of a GitHub pull request by number. "
        "Returns the diff as a string. Use this after `fetch_pr_files` "
        "to read the actual changes for files you've classified as "
        "critical. Requires the `gh` CLI authenticated to the repo."
    ),
    parameters={
        "type": "object",
        "properties": {
            "pr_number": {"type": "integer"},
        },
        "required": ["pr_number"],
    },
)
def fetch_pr_diff(pr_number: int) -> str:
    """Run `gh pr diff <pr_number>` and return the unified diff.

    Same error-string convention as `fetch_pr_files`.
    """
    try:
        result = subprocess.run(
            ["gh", "pr", "diff", str(pr_number)],
            capture_output=True,
            text=True,
            timeout=_DIFF_TIMEOUT_S,
        )
    except FileNotFoundError:
        return "Error: `gh` CLI is not installed or not on PATH"
    except subprocess.TimeoutExpired:
        return f"Error: gh pr diff timed out after {_DIFF_TIMEOUT_S}s"

    if result.returncode != 0:
        return (
            f"Error: gh pr diff exited {result.returncode}: "
            f"{result.stderr.strip()}"
        )
    return result.stdout


# The system prompt is the load-bearing piece of context the LLM sees;
# every word counts. Keep it terse — the agent's job is well-defined.
PR_RISK_INSTRUCTIONS = """\
You are a PR risk reviewer. Your job is to read a GitHub pull request,
identify the changes, and produce a concise risk summary for a human
reviewer who reads many of these per day.

Steps:
1. Call `fetch_pr_files` first to see what's touched. This is the
   lightest call.
2. Classify each file:
   - critical: source code, schema/migrations, security-sensitive
     configuration, CI/CD pipelines, package manifests
   - doc: markdown/RST/AsciiDoc, README, CHANGELOG, comments-only
     changes
   - test: files under tests/, *test*, *spec*
3. For files classified critical, call `fetch_pr_diff` once and reason
   about risk in the diff: data loss, breaking changes, API drift,
   security implications, missing tests for new behavior.
4. Produce the final summary as plain text:
   - First line: VERDICT: LOW | MEDIUM | HIGH
   - 2-5 bullets explaining the verdict
   - Specific files/lines to scrutinize manually

Be terse. Reference the diff; don't quote it back. Every word should
earn its place.
"""


def build_pr_risk_agent() -> Agent:
    """Construct the canonical LLM-driven PR risk analyzer (Phase 3.1).

    Returns a fresh `Agent` ready to pass to `LLMLoop`. The agent itself
    is stateless — callers can reuse one instance across many runs since
    tools and instructions are immutable.
    """
    return Agent(
        name="pr-risk-analyzer",
        instructions=PR_RISK_INSTRUCTIONS,
        tools=[fetch_pr_files, fetch_pr_diff],
    )


# ── Phase 3.2 — declarative WorkflowGraph version ─────────────────────────


# Classification rules. Critical = code/config/migrations that can break
# behavior or security. Doc-only = markdown/RST/CHANGELOG/README.
# A file matched by both wins critical (safe default — surface for review).
_CRITICAL_PATTERNS = tuple(
    re.compile(p)
    for p in (
        r"\.(py|js|ts|tsx|jsx|mjs|cjs|sql|sh|yaml|yml|toml|json|rs|go|java|kt|swift|rb|php|c|h|cpp|hpp)$",
        r"(^|/)Dockerfile(\.|$)",
        r"(^|/)\.github/workflows/",
        r"(^|/)package\.json$",
        r"(^|/)package-lock\.json$",
        r"(^|/)pyproject\.toml$",
        r"(^|/)Cargo\.toml$",
        r"(^|/)go\.mod$",
        r"(^|/)migrations?/",
    )
)
_DOC_PATTERNS = tuple(
    re.compile(p)
    for p in (
        r"\.(md|rst|txt|adoc)$",
        r"(^|/)README(\.|$)",
        r"(^|/)CHANGELOG(\.|$)",
        r"(^|/)LICENSE(\.|$)",
    )
)


def is_critical_file(path: str) -> bool:
    """Whether one file path classifies as critical."""
    return any(p.search(path) for p in _CRITICAL_PATTERNS)


def is_doc_only_file(path: str) -> bool:
    """Whether one file path classifies as doc-only."""
    return any(p.search(path) for p in _DOC_PATTERNS)


def classify_file_list(file_list_text: str) -> str:
    """Classify a newline-separated file list as 'critical' or 'doc'.

    Returns 'critical' if any file matches the critical patterns,
    'doc' if every non-blank line matches doc-only patterns, else
    'critical' as the safe default (unknown patterns get surfaced for
    review rather than skipped).
    """
    paths = [
        line.strip() for line in file_list_text.splitlines() if line.strip()
    ]
    if not paths:
        # Empty file list — treat as doc so the graph short-circuits
        # rather than running the deep-scan path on nothing.
        return "doc"
    if any(is_critical_file(p) for p in paths):
        return "critical"
    if all(is_doc_only_file(p) for p in paths):
        return "doc"
    # Unknown extensions (e.g. .env, .conf) — safer to scrutinize.
    return "critical"


# System prompt for the per-tool LLM summarize call. Distinct from
# PR_RISK_INSTRUCTIONS (which steers the LLMLoop): this one is a tight
# one-shot prompt for the cache-friendly llm_text_call helper.
SUMMARIZE_SYSTEM = """\
You are a terse PR risk reviewer. Given a list of changed files, the
diff (for critical PRs), and a file-relationship dependency graph,
produce:
  Line 1: VERDICT: LOW | MEDIUM | HIGH
  Then 2-5 bullets explaining the verdict. Use the dependency graph
    to call out fan-out: which other files depend on what's changed,
    and whether the diff likely breaks them.
  Then a "Look at:" line naming specific files/lines to scrutinize.

Reference the diff and dep graph; don't quote them back. Every word
should earn its place — your reader does dozens of these per day.
"""


def _make_summarize_tool(client: Any, *, model: str) -> Tool:
    """Build a `summarize_pr_risk` tool that wraps `llm_text_call`.

    Factored as a tool factory (rather than a module-level
    `@tool`-decorated function) so the LLM client is injected at
    build time — production builds construct `anthropic.Anthropic()`,
    tests inject a fake. The closed-over `client` is the only state.
    """

    @tool(
        description=(
            "Summarize the risk of a PR given its file list, (for "
            "critical PRs) the unified diff, and a dependency graph "
            "describing file relationships. Returns a terse "
            "VERDICT + bullets + 'Look at:' lines."
        ),
        parameters={
            "type": "object",
            "properties": {
                "files": {
                    "type": "string",
                    "description": "Newline-separated changed file paths",
                },
                "diff": {
                    "type": "string",
                    "description": (
                        "Unified diff of the PR; empty string for "
                        "doc-only changes"
                    ),
                },
                "dep_graph": {
                    "type": "string",
                    "description": (
                        "JSON-encoded dependency graph from the Node "
                        "service, or empty string when not available "
                        "(doc-only path, or handoff disabled)"
                    ),
                },
            },
            "required": ["files", "diff", "dep_graph"],
        },
    )
    def summarize_pr_risk(files: str, diff: str, dep_graph: str) -> str:
        parts = [f"Files changed:\n{files}"]
        parts.append(f"Diff:\n{diff}" if diff else "No diff (doc-only PR).")
        parts.append(
            f"Dependency graph:\n{dep_graph}"
            if dep_graph
            else "No dependency graph available."
        )
        return llm_text_call(
            client,
            model=model,
            system=SUMMARIZE_SYSTEM,
            user_message="\n\n".join(parts),
        )

    return summarize_pr_risk


def build_pr_risk_graph_agent(
    client: Any | None = None, *, model: str = DEFAULT_MODEL
) -> Agent:
    """Construct the Agent for the declarative WorkflowGraph version.

    Carries three tools: the two `gh`-backed fetchers plus an
    LLM-backed summarizer (wrapped with `llm_text_call` so it stays
    cache-friendly across calls). If `client` is None, an
    `anthropic.Anthropic()` is constructed from env at first use.
    """
    if client is None:
        import anthropic

        client = anthropic.Anthropic()
    summarize = _make_summarize_tool(client, model=model)
    return Agent(
        name="pr-risk-analyzer-graph",
        instructions="",  # graph drives flow; no system prompt needed
        tools=[fetch_pr_files, fetch_pr_diff, summarize],
    )


def build_pr_risk_graph() -> WorkflowGraph:
    """Build the declarative PR risk WorkflowGraph.

    Topology (Phase 3.3 — with cross-runtime dep-graph handoff):

        fetch_files → classify(branch)
                        ↓ critical
                      fetch_diff
                        ↓
                      build_dep_graph (HANDOFF → Node service)
                        ↓
                      summarize
                        ↓ doc
                      skip_doc (think)
                        ↓
                      summarize_doc

    The critical path hands off to a Node service that builds a
    file-relationship dependency graph (which file imports which) by
    parsing the changed files. The Python executor blocks until the
    Node service POSTs a `handoff_result` event back to the Ledger;
    the result is fed into `summarize` so the verdict can reason about
    fan-out, not just the diff itself.

    The doc-only path skips the handoff — no dep graph needed for
    README/CHANGELOG changes — and feeds an empty `dep_graph` string
    to `summarize_doc` so the same tool handles both paths.
    """
    g = WorkflowGraph(name="pr-risk-analyzer-graph")

    g.add(
        StepNode(
            name="fetch_files",
            tool="fetch_pr_files",
            inputs=lambda s: {"pr_number": s["pr_number"]},
            output_key="files",
            next="classify",
        )
    )
    g.add(
        BranchNode(
            name="classify",
            condition=lambda s: classify_file_list(s["files"]),
            branches={"critical": "fetch_diff", "doc": "skip_doc"},
        )
    )
    g.add(
        StepNode(
            name="fetch_diff",
            tool="fetch_pr_diff",
            inputs=lambda s: {"pr_number": s["pr_number"]},
            output_key="diff",
            next="build_dep_graph",
        )
    )
    g.add(
        HandoffNode(
            name="build_dep_graph",
            service=DEP_GRAPH_SERVICE,
            inputs=lambda s: {
                "pr_number": s["pr_number"],
                "files": s["files"],
            },
            output_key="dep_graph",
            timeout=DEP_GRAPH_TIMEOUT_S,
            next="summarize",
        )
    )
    g.add(
        StepNode(
            name="summarize",
            tool="summarize_pr_risk",
            inputs=lambda s: {
                "files": s["files"],
                "diff": s["diff"],
                # JSON-encode the dep_graph dict so the tool receives a
                # string (matches the parameter schema and the doc-only
                # path's "" sentinel).
                "dep_graph": _stringify_dep_graph(s.get("dep_graph")),
            },
            output_key="verdict",
        )
    )
    g.add(
        StepNode(
            name="skip_doc",
            think="No critical files changed — doc-only PR.",
            next="summarize_doc",
        )
    )
    g.add(
        StepNode(
            name="summarize_doc",
            tool="summarize_pr_risk",
            inputs=lambda s: {
                "files": s["files"],
                "diff": "",
                "dep_graph": "",
            },
            output_key="verdict",
        )
    )

    g.set_start("fetch_files")
    return g


def _stringify_dep_graph(dep_graph: Any) -> str:
    """Render whatever the Node service returned into a string the
    summarize tool can pass to the model. Dicts get JSON-encoded;
    strings pass through; None/missing becomes empty so the model
    sees the explicit 'No dependency graph available.' marker."""
    if dep_graph is None or dep_graph == "":
        return ""
    if isinstance(dep_graph, str):
        return dep_graph
    try:
        import json

        return json.dumps(dep_graph, separators=(",", ":"))
    except (TypeError, ValueError):
        return repr(dep_graph)
