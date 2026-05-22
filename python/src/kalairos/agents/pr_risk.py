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

import subprocess

from ..agent import Agent
from ..tool import tool


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
    """Construct the canonical PR risk analyzer agent.

    Returns a fresh `Agent` ready to pass to `LLMLoop` (Phase 3.1) or
    `Executor` over a `WorkflowGraph` (Phase 3.2). The agent itself is
    stateless — callers can reuse one instance across many runs since
    tools and instructions are immutable.
    """
    return Agent(
        name="pr-risk-analyzer",
        instructions=PR_RISK_INSTRUCTIONS,
        tools=[fetch_pr_files, fetch_pr_diff],
    )
