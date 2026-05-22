"""Tests for the declarative PR risk WorkflowGraph — Phase 3.2.

Covers:
- File-classification rules (critical / doc / mixed / unknown).
- The `llm_text_call` helper.
- The summarize tool factory (with a fake Anthropic client).
- Graph topology + validation.
- End-to-end Executor run with mocked subprocess + fake LLM.
"""

import json
import subprocess
import threading
import time
from typing import Any

import pytest

from kalairos import Executor, Ledger
from kalairos.agents.pr_risk import (
    DEP_GRAPH_SERVICE,
    SUMMARIZE_SYSTEM,
    _make_summarize_tool,
    build_pr_risk_graph,
    build_pr_risk_graph_agent,
    classify_file_list,
    is_critical_file,
    is_doc_only_file,
)
from kalairos.executor import EVENT_HANDOFF_REQUESTED, EVENT_HANDOFF_RESULT
from kalairos.llm import llm_text_call


# ── Dep-graph handoff auto-reply (mirrors test_handoff.auto_reply) ────────


_FAKE_DEP_GRAPH = {
    "nodes": ["src/server.py", "src/db.py"],
    "edges": [{"from": "src/server.py", "to": "src/db.py"}],
}


def _emit_handoff_result(
    ledger: Ledger, handoff_id: str, *, result=None, error=None
) -> None:
    ts = int(time.time() * 1000)
    payload = {"handoff_id": handoff_id, "result": result, "error": error}
    record = {
        "id": f"handoff/{handoff_id}/result",
        "text": json.dumps(payload, separators=(",", ":")),
        "type": "handoff-event",
        "memoryType": "long-term",
        "workspaceId": "agent-runs",
        "tags": ["handoff-event", EVENT_HANDOFF_RESULT, f"handoff:{handoff_id}"],
        "versions": [{"timestamp": ts, "text": json.dumps(payload), "ingestAt": ts}],
        "metadata": {"event_type": EVENT_HANDOFF_RESULT, "payload": payload},
    }
    ledger.append(record)


def auto_reply_dep_graph(
    ledger: Ledger, *, result=_FAKE_DEP_GRAPH, error: str | None = None
):
    """Subscribe to dep-graph handoff_requested events and post a fake
    result on a background thread. Mirrors the pattern in
    tests/test_handoff.auto_reply but specific to the dep-graph service
    so multiple handoff types in one ledger can be selectively answered."""

    def listener(record: dict) -> None:
        md = record.get("metadata") or {}
        if md.get("event_type") != EVENT_HANDOFF_REQUESTED:
            return
        payload = md["payload"]
        if payload.get("service") != DEP_GRAPH_SERVICE:
            return
        handoff_id = payload["handoff_id"]

        def reply() -> None:
            _emit_handoff_result(ledger, handoff_id, result=result, error=error)

        threading.Thread(target=reply, daemon=True).start()

    return ledger.subscribe(listener)


# ── Fake Anthropic client ──────────────────────────────────────────────────


class _Block:
    def __init__(self, type: str, **kw):
        self.type = type
        for k, v in kw.items():
            setattr(self, k, v)


class _Response:
    def __init__(self, content):
        self.content = content


class _FakeMessages:
    def __init__(self, reply_text: str = "VERDICT: LOW\n- looks fine"):
        self.reply_text = reply_text
        self.calls: list[dict] = []

    def create(self, **kw):
        self.calls.append(kw)
        return _Response([_Block(type="text", text=self.reply_text)])


class FakeAnthropicClient:
    def __init__(self, reply_text: str = "VERDICT: LOW\n- looks fine"):
        self.messages = _FakeMessages(reply_text)


# ── Classification rules ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        "src/server.py",
        "lib/index.ts",
        "package.json",
        "pyproject.toml",
        "Dockerfile",
        ".github/workflows/ci.yml",
        "db/migrations/001_init.sql",
        "scripts/deploy.sh",
        "config.yaml",
    ],
)
def test_is_critical_file_matches(path):
    assert is_critical_file(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "README.md",
        "docs/intro.md",
        "CHANGELOG.md",
        "LICENSE",
        "notes.rst",
    ],
)
def test_is_doc_only_file_matches(path):
    assert is_doc_only_file(path) is True


def test_classify_file_list_critical_wins():
    """One critical file → 'critical', even alongside docs."""
    files = "README.md\nsrc/server.py\nCHANGELOG.md\n"
    assert classify_file_list(files) == "critical"


def test_classify_file_list_all_docs():
    files = "README.md\nCHANGELOG.md\ndocs/intro.md\n"
    assert classify_file_list(files) == "doc"


def test_classify_file_list_empty():
    """Empty file list → 'doc' so the graph short-circuits the
    deep-scan path rather than running it on nothing."""
    assert classify_file_list("") == "doc"
    assert classify_file_list("\n\n  \n") == "doc"


def test_classify_file_list_unknown_extension_defaults_critical():
    """Unknown patterns surface for review — safer default than skipping."""
    assert classify_file_list("mystery.xyz\n") == "critical"


# ── llm_text_call helper ──────────────────────────────────────────────────


def test_llm_text_call_returns_assistant_text():
    client = FakeAnthropicClient(reply_text="hello world")
    out = llm_text_call(
        client,
        model="m",
        system="be terse",
        user_message="ping",
    )
    assert out == "hello world"


def test_llm_text_call_caches_system_prompt():
    """The system block must carry cache_control so repeated tool
    invocations from the same factory hit the prompt cache."""
    client = FakeAnthropicClient()
    llm_text_call(client, model="m", system="cached!", user_message="x")
    call = client.messages.calls[0]
    sys_block = call["system"][0]
    assert sys_block["cache_control"] == {"type": "ephemeral"}
    assert sys_block["text"] == "cached!"


def test_llm_text_call_passes_user_message_as_only_message():
    client = FakeAnthropicClient()
    llm_text_call(client, model="m", system="s", user_message="the question")
    call = client.messages.calls[0]
    assert call["messages"] == [{"role": "user", "content": "the question"}]


# ── summarize tool factory ────────────────────────────────────────────────


def test_make_summarize_tool_returns_a_tool():
    client = FakeAnthropicClient()
    t = _make_summarize_tool(client, model="m")
    assert t.name == "summarize_pr_risk"
    assert "files" in t.parameters["properties"]
    assert "diff" in t.parameters["properties"]


def test_summarize_tool_calls_llm_with_files_diff_and_dep_graph():
    client = FakeAnthropicClient(reply_text="VERDICT: HIGH\n- bad")
    t = _make_summarize_tool(client, model="m")
    out = t.call(
        files="src/x.py\n",
        diff="--- a/x\n+++ b/x\n+rm -rf /\n",
        dep_graph='{"nodes": ["src/x.py", "src/y.py"]}',
    )
    assert "VERDICT: HIGH" in out
    # Sanity: all three inputs appear in the user message
    user_content = client.messages.calls[0]["messages"][0]["content"]
    assert "src/x.py" in user_content
    assert "rm -rf" in user_content
    assert "src/y.py" in user_content


def test_summarize_tool_doc_only_message_when_diff_and_dep_graph_empty():
    """Empty diff + empty dep_graph (doc-only path) should send explicit
    "no diff" / "no dep graph" markers so the model knows it's not a
    critical PR — avoids the model inventing risks from nothing."""
    client = FakeAnthropicClient()
    t = _make_summarize_tool(client, model="m")
    t.call(files="README.md\n", diff="", dep_graph="")
    user_content = client.messages.calls[0]["messages"][0]["content"].lower()
    assert "doc-only" in user_content or "no diff" in user_content
    assert "no dependency graph" in user_content


def test_summarize_system_prompt_mentions_dep_graph():
    """The summarize system prompt must teach the model to use the dep
    graph for fan-out reasoning — not just the diff in isolation."""
    text = SUMMARIZE_SYSTEM.lower()
    assert "dependency graph" in text
    assert "fan-out" in text


# ── Graph topology + agent wiring ─────────────────────────────────────────


def test_graph_has_expected_nodes_and_topology():
    g = build_pr_risk_graph()
    expected = {
        "fetch_files",
        "classify",
        "fetch_diff",
        "build_dep_graph",
        "summarize",
        "skip_doc",
        "summarize_doc",
    }
    assert set(g.names()) == expected
    g.validate()  # no raise — topology is sound


def test_graph_critical_path_routes_through_handoff():
    """fetch_diff must hand off to build_dep_graph before summarize —
    that's the contract that distinguishes Phase 3.3 from 3.2."""
    g = build_pr_risk_graph()
    assert g.get("fetch_diff").next == "build_dep_graph"
    assert g.get("build_dep_graph").next == "summarize"
    assert g.get("build_dep_graph").service == DEP_GRAPH_SERVICE


def test_graph_doc_path_skips_handoff():
    """Doc-only path goes skip_doc → summarize_doc directly. No handoff
    in this leg — the Node service shouldn't be bothered for a docs PR."""
    g = build_pr_risk_graph()
    assert g.get("skip_doc").next == "summarize_doc"
    # summarize_doc is terminal
    assert g.get("summarize_doc").next is None


def test_graph_starts_at_fetch_files():
    g = build_pr_risk_graph()
    assert g.start_node().name == "fetch_files"


def test_build_pr_risk_graph_agent_with_explicit_client():
    """Injecting a client (test path) should work without needing the
    real `anthropic` package or an API key."""
    client = FakeAnthropicClient()
    agent = build_pr_risk_graph_agent(client=client, model="m")
    assert agent.name == "pr-risk-analyzer-graph"
    for name in ("fetch_pr_files", "fetch_pr_diff", "summarize_pr_risk"):
        assert name in agent.tools


def test_summarize_system_prompt_mentions_load_bearing_terms():
    """Same guard as PR_RISK_INSTRUCTIONS — the summarize system prompt
    is what shapes the per-tool output. Lock its key vocabulary."""
    text = SUMMARIZE_SYSTEM.lower()
    assert "verdict" in text
    assert "low" in text and "medium" in text and "high" in text
    assert "look at" in text


# ── End-to-end: Executor over the graph ───────────────────────────────────


@pytest.fixture
def ledger(tmp_path):
    led = Ledger(tmp_path / "ledger.jsonl", tmp_path / "index.sqlite")
    led.open()
    try:
        yield led
    finally:
        led.close()


def test_e2e_critical_pr_walks_full_path_with_handoff(ledger, monkeypatch):
    """Critical-classified PR: fetch_files → fetch_diff → build_dep_graph
    (handoff) → summarize. Dep graph from the auto_reply lands in state
    and reaches the summarize tool's user message."""
    def fake_run(args, **kw):
        if "view" in args:
            return subprocess.CompletedProcess(
                args=args,
                returncode=0,
                stdout="src/server.py\nREADME.md\n",
                stderr="",
            )
        if "diff" in args:
            return subprocess.CompletedProcess(
                args=args,
                returncode=0,
                stdout="diff --git a/src/server.py b/src/server.py\n+os.system(cmd)\n",
                stderr="",
            )
        return subprocess.CompletedProcess(
            args=args, returncode=1, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    client = FakeAnthropicClient(reply_text="VERDICT: HIGH\n- os.system on user cmd")
    agent = build_pr_risk_graph_agent(client=client, model="m")
    graph = build_pr_risk_graph()

    auto_reply_dep_graph(ledger)

    run, state = Executor(graph).run(
        agent, ledger, initial_state={"pr_number": 99}
    )

    assert run.status == "completed"
    assert "VERDICT: HIGH" in state["verdict"]
    # The graph took the critical path — fetch_diff ran
    assert "os.system" in state["diff"]
    # The handoff happened — dep_graph from the auto_reply is in state
    assert state["dep_graph"] == _FAKE_DEP_GRAPH
    # The summarize tool saw the dep graph in its user message
    user_content = client.messages.calls[0]["messages"][0]["content"]
    assert "src/server.py" in user_content and "src/db.py" in user_content


def test_e2e_doc_only_pr_skips_diff(ledger, monkeypatch):
    """Doc-only PR: fetch_files → classify → skip_doc → summarize_doc.
    `fetch_pr_diff` is NOT invoked — verifies the branch routes correctly."""
    diff_call_count = {"n": 0}

    def fake_run(args, **kw):
        if "view" in args:
            return subprocess.CompletedProcess(
                args=args,
                returncode=0,
                stdout="README.md\nCHANGELOG.md\n",
                stderr="",
            )
        if "diff" in args:
            diff_call_count["n"] += 1
            return subprocess.CompletedProcess(
                args=args,
                returncode=0,
                stdout="(should not be called)",
                stderr="",
            )
        return subprocess.CompletedProcess(
            args=args, returncode=1, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    client = FakeAnthropicClient(reply_text="VERDICT: LOW\n- doc only")
    agent = build_pr_risk_graph_agent(client=client, model="m")
    graph = build_pr_risk_graph()

    run, state = Executor(graph).run(
        agent, ledger, initial_state={"pr_number": 7}
    )

    assert run.status == "completed"
    assert "VERDICT: LOW" in state["verdict"]
    assert diff_call_count["n"] == 0, "fetch_pr_diff must not run on doc path"


def test_e2e_critical_pr_emits_handoff_requested(ledger, monkeypatch):
    """The handoff_requested payload should carry pr_number + files
    so the Node service has what it needs to build the dep graph."""
    def fake_run(args, **kw):
        if "view" in args:
            return subprocess.CompletedProcess(
                args=args, returncode=0, stdout="src/x.py\n", stderr=""
            )
        if "diff" in args:
            return subprocess.CompletedProcess(
                args=args, returncode=0, stdout="diff stuff\n", stderr=""
            )
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    client = FakeAnthropicClient()
    agent = build_pr_risk_graph_agent(client=client, model="m")
    graph = build_pr_risk_graph()

    auto_reply_dep_graph(ledger)

    run, _ = Executor(graph).run(
        agent, ledger, initial_state={"pr_number": 42}
    )

    rows = ledger.appender.load_raw()
    requested = [
        r for r in rows
        if (r.get("metadata") or {}).get("event_type") == EVENT_HANDOFF_REQUESTED
    ]
    assert len(requested) == 1
    payload = requested[0]["metadata"]["payload"]
    assert payload["service"] == DEP_GRAPH_SERVICE
    assert payload["input"]["pr_number"] == 42
    assert "src/x.py" in payload["input"]["files"]


def test_e2e_doc_only_skips_handoff_entirely(ledger, monkeypatch):
    """Doc-only PRs must NOT emit a handoff_requested event — the Node
    service shouldn't see traffic for changes that don't need a dep graph."""
    def fake_run(args, **kw):
        if "view" in args:
            return subprocess.CompletedProcess(
                args=args, returncode=0, stdout="README.md\n", stderr=""
            )
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    client = FakeAnthropicClient()
    agent = build_pr_risk_graph_agent(client=client, model="m")
    graph = build_pr_risk_graph()

    # Subscribe an auto-reply anyway — if it ever fires on this path,
    # we want to know.
    auto_reply_dep_graph(ledger)

    Executor(graph).run(agent, ledger, initial_state={"pr_number": 7})

    rows = ledger.appender.load_raw()
    handoff_events = [
        r
        for r in rows
        if (r.get("metadata") or {}).get("event_type") == EVENT_HANDOFF_REQUESTED
    ]
    assert handoff_events == []


def test_e2e_handoff_timeout_fails_run(ledger, monkeypatch):
    """If no Node service ever replies, the handoff times out and the
    run fails. Tests against an actual TimeoutError so we know the
    real production failure mode is correct."""
    def fake_run(args, **kw):
        if "view" in args:
            return subprocess.CompletedProcess(
                args=args, returncode=0, stdout="src/x.py\n", stderr=""
            )
        if "diff" in args:
            return subprocess.CompletedProcess(
                args=args, returncode=0, stdout="diff\n", stderr=""
            )
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    # NO auto_reply registered — handoff will timeout.
    # Patch DEP_GRAPH_TIMEOUT_S indirectly by building a graph with a
    # short-timeout handoff manually. Simpler: monkeypatch the module
    # constant before constructing the graph.
    from kalairos.agents import pr_risk as pr

    monkeypatch.setattr(pr, "DEP_GRAPH_TIMEOUT_S", 0.05)

    client = FakeAnthropicClient()
    agent = build_pr_risk_graph_agent(client=client, model="m")
    graph = pr.build_pr_risk_graph()

    with pytest.raises(TimeoutError, match="timed out"):
        Executor(graph).run(agent, ledger, initial_state={"pr_number": 1})


def test_e2e_emits_branch_chosen_event(ledger, monkeypatch):
    """The branch_chosen event records which path the graph took — that's
    the inspection knob the control plane will visualize in Phase 4."""

    def fake_run(args, **kw):
        if "view" in args:
            return subprocess.CompletedProcess(
                args=args, returncode=0, stdout="README.md\n", stderr=""
            )
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout="", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    client = FakeAnthropicClient()
    agent = build_pr_risk_graph_agent(client=client, model="m")
    graph = build_pr_risk_graph()

    run, _ = Executor(graph).run(
        agent, ledger, initial_state={"pr_number": 1}
    )

    rows = ledger.appender.load_raw()
    branch_events = [
        r
        for r in rows
        if (r.get("metadata") or {}).get("event_type") == "branch_chosen"
    ]
    assert len(branch_events) == 1
    payload = branch_events[0]["metadata"]["payload"]
    assert payload["node"] == "classify"
    assert payload["key"] == "doc"
    assert payload["target"] == "skip_doc"
