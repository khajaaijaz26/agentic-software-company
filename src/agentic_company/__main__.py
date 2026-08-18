"""Command-line entry point for the agentic software company platform.

Provides a small set of operations to exercise the reference implementation
without any external dependencies:

    python -m agentic_company init-project <name> <owner>
    python -m agentic_company dispatch <role> <instructions>
    python -m agentic_company audit <project_id>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .agent_registry import AgentRegistry, AgentSpec
from .approval_service import ApprovalService
from .contracts import ResultEnvelope, TaskEnvelope
from .event_store import EventStore
from .orchestrator import Orchestrator
from .policy_engine import PolicyEngine
from .resources import PROMPTS_ROOT
from .state_store import StateStore


def _stub_dispatcher(envelope: TaskEnvelope) -> ResultEnvelope:
    """A no-op dispatcher for CLI demonstration. Replace with a real agent adapter."""
    return ResultEnvelope(
        task_id=envelope.task_id,
        correlation_id=envelope.correlation_id,
        project_id=envelope.project_id,
        agent_role=envelope.agent_role,
        status="COMPLETE",
        summary=f"stubbed result for {envelope.agent_role}: {envelope.instructions[:80]}",
    )


def _build() -> tuple[Orchestrator, StateStore, EventStore]:
    base = Path.cwd() / ".agentic_company"
    state = StateStore(base / "state.json")
    events = EventStore(base / "events.jsonl")
    policy = PolicyEngine()
    approvals = ApprovalService()
    registry = AgentRegistry()
    for role in ("orchestrator", "technical-lead", "frontend-engineer", "backend-engineer"):
        prompt_file = (
            PROMPTS_ROOT / "master-orchestrator.md"
            if role == "orchestrator"
            else PROMPTS_ROOT / "roles" / f"{role}.md"
        )
        registry.register(
            AgentSpec(role=role, prompt_file=str(prompt_file), prompt_sha=f"sha-{role}")
        )
    orchestrator = Orchestrator(
        state=state,
        events=events,
        policy=policy,
        approvals=approvals,
        registry=registry,
        dispatcher=_stub_dispatcher,
    )
    return orchestrator, state, events


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentic-company")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init-project", help="begin a project")
    p_init.add_argument("name")
    p_init.add_argument("owner")
    p_init.add_argument("--goal", action="append", default=[])

    p_dispatch = sub.add_parser("dispatch", help="dispatch a task to a specialist")
    p_dispatch.add_argument("role")
    p_dispatch.add_argument("instructions")

    p_audit = sub.add_parser("audit", help="print events for a project")
    p_audit.add_argument("project_id")

    args = parser.parse_args(argv)

    orchestrator, state, events = _build()

    if args.command == "init-project":
        project = orchestrator.begin_project(
            request=f"request for {args.name}",
            name=args.name,
            owner=args.owner,
            scope_goals=args.goal or [f"deliver {args.name}"],
            scope_non_goals=[],
            acceptance_criteria=[f"{args.name} is accepted"],
        )
        print(project.project_id)
        return 0

    if args.command == "dispatch":
        projects = state.keys()
        if not projects:
            print("no project yet; run init-project first", file=sys.stderr)
            return 2
        project = state.load_project(projects[-1])
        result = orchestrator.dispatch(
            project=project,
            agent_role=args.role,
            kind="delivery",
            instructions=args.instructions,
        )
        print(result.task_id, result.result.status)
        return 0

    if args.command == "audit":
        for event in events.events_for(args.project_id):
            print(event.occurred_at, event.event_type, event.actor.type, event.actor.id)
        return 0

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
