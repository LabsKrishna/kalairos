"""Pre-built agents shipping with the Kalairos package.

Each module under `kalairos.agents` defines an agent — its tools,
instructions, and (in later sub-phases) workflow graph — that can be
used directly or copied as a template for a custom agent.

`pr_risk` is the canonical example. Phase 3.2 will layer a declarative
WorkflowGraph on top; Phase 3.3 will add a HandoffNode that delegates
dependency-graph construction to a Node service.
"""

from .pr_risk import build_pr_risk_agent

__all__ = ["build_pr_risk_agent"]
