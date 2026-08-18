"""Model Context Protocol (MCP) server for the Agentic Software Company.

Exposes the governed multi-agent platform to any MCP-capable AI coding agent
(terminal CLIs, IDEs, desktop apps) over a single, standard interface. The AI
host acts as the executing specialist: it receives a bound task envelope with
the constitution, role prompt, project policy, budget, and approval tokens,
performs the work, and reports the result through the governance layer.

Run with:

    uv run --with "mcp[cli]" mcp run src/agentic_company/mcp_server.py

or (after installing the optional dependency):

    python -m agentic_company.mcp_server

Core package remains dependency-free; the MCP adapter only needs the ``mcp``
SDK, declared as the ``mcp`` extra.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:  # pragma: no cover - exercised only when the extra is absent
    print(
        "The MCP server requires the optional dependency.\n"
        "  uv run --with 'mcp[cli]' mcp run src/agentic_company/mcp_server.py\n"
        "  python -m pip install 'agentic-company[mcp]'",
        file=sys.stderr,
    )
    raise SystemExit(2)

from .agent_registry import AgentRegistry, AgentSpec
from .approval_service import ApprovalService
from .contracts import TERMINAL_STATES, ProjectRecord, TaskEnvelope, new_id
from .contracts import Actor as _Actor
from .contracts import Budget as _Budget
from .contracts import DomainEvent as _DomainEvent
from .event_store import EventStore
from .orchestrator import Orchestrator
from .policy_engine import PolicyEngine
from .resources import PROMPTS_ROOT, SCHEMAS_ROOT, WORKFLOWS_ROOT
from .state_store import StateStore
from .tool_gateway import ToolGateway

mcp = FastMCP("agentic-software-company")

_BASE = Path(os.environ.get("AGENTIC_COMPANY_STATE_DIR", Path.cwd() / ".agentic_company"))
_STATE = StateStore(_BASE / "state.json")
_EVENTS = EventStore(_BASE / "events.jsonl")
_POLICY = PolicyEngine()
_APPROVALS = ApprovalService()
_REGISTRY = AgentRegistry()
_GATEWAY = ToolGateway(policy=_POLICY, events=_EVENTS, approvals=_APPROVALS)
_MCP_LOCK = threading.RLock()


def _build_orchestrator() -> Orchestrator:
    registry = _REGISTRY
    if not registry.roles():
        registry.register(
            AgentSpec(
                role="orchestrator",
                prompt_file=str(PROMPTS_ROOT / "master-orchestrator.md"),
                prompt_sha="sha-orchestrator",
            )
        )
        for path in sorted((PROMPTS_ROOT / "roles").glob("*.md")):
            registry.register(
                AgentSpec(
                    role=path.stem,
                    prompt_file=str(path),
                    prompt_sha=f"sha-{path.stem}",
                )
            )
    return Orchestrator(
        state=_STATE,
        events=_EVENTS,
        policy=_POLICY,
        approvals=_APPROVALS,
        registry=registry,
        dispatcher=_deferred_dispatcher,
    )


def _deferred_dispatcher(envelope: TaskEnvelope) -> Any:
    """Placeholder used until the host completes the task via complete_task.

    The orchestrator dispatch path is driven through the MCP tools; a
    dispatched-but-uncompleted envelope is reported as NEEDS_INPUT so the host
    can pick it up without introducing a status outside the canonical schema.
    """
    from .contracts import ResultEnvelope

    return ResultEnvelope(
        task_id=envelope.task_id,
        correlation_id=envelope.correlation_id,
        project_id=envelope.project_id,
        agent_role=envelope.agent_role,
        status="NEEDS_INPUT",
        summary="awaiting host execution; use complete_task to record a terminal result",
    )


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------


@mcp.tool()
def begin_project(name: str, owner: str, goal: str) -> dict[str, Any]:
    """Begin a governed project and return its project record."""
    project = _build_orchestrator().begin_project(
        request=f"request for {name}",
        name=name,
        owner=owner,
        scope_goals=[goal],
        scope_non_goals=[],
        acceptance_criteria=[f"{name} is accepted"],
    )
    return _record(project)


@mcp.tool()
def assign_task(project_id: str, role: str, instructions: str, kind: str = "delivery") -> dict[str, Any]:
    """Assign a task envelope to a specialist role.

    Returns the full envelope (task_id, prompt versions, budget, approvals)
    that the host should execute as the named agent.
    """
    _build_orchestrator()
    project = _load_project(project_id)
    registry_spec = _REGISTRY.get(role)
    if registry_spec is None:
        raise ValueError(f"unregistered agent role: {role}; list_roles for available roles")
    envelope = TaskEnvelope(
        task_id=new_id("task"),
        correlation_id=project.correlation_id,
        project_id=project.project_id,
        request_id=project.request_id,
        kind=kind,
        owner=project.owner,
        agent_role=role,
        instructions=instructions,
        prompt_versions={
            "constitution": str(PROMPTS_ROOT / "base-agent-constitution.md"),
            "role": registry_spec.prompt_file,
            "project_policy": str(PROMPTS_ROOT / "policies" / "default-project-policy.md"),
        },
        approvals=[],
        budget=_Budget(max_cost=0.0),
    )
    _EVENTS.append(
        _DomainEvent(
            event_type="task.dispatch",
            actor=_Actor.agent("orchestrator"),
            data={"task_id": envelope.task_id, "agent_role": role, "kind": kind},
            project_id=project.project_id,
            correlation_id=project.correlation_id,
        )
    )
    return _record(envelope)


@mcp.tool()
def complete_task(project_id: str, task_id: str, status: str, summary: str) -> dict[str, Any]:
    """Record the host's execution result for a previously assigned task."""
    project = _load_project(project_id)
    if status not in TERMINAL_STATES:
        raise ValueError(f"invalid terminal task status: {status}")
    with _MCP_LOCK:
        dispatches = [
            event
            for event in _EVENTS.events_for(project.project_id, event_type="task.dispatch")
            if event.data.get("task_id") == task_id
        ]
        if len(dispatches) != 1:
            raise ValueError(f"unknown task for project: {task_id}")
        completed = [
            event
            for event in _EVENTS.events_for(project.project_id, event_type="task.complete")
            if event.data.get("task_id") == task_id
        ]
        if completed:
            raise ValueError(f"task already completed: {task_id}")
        role = str(dispatches[0].data.get("agent_role", "agent"))
        _EVENTS.append(
            _DomainEvent(
                event_type="task.complete",
                actor=_Actor.agent(role),
                data={"task_id": task_id, "status": status, "summary": summary},
                project_id=project.project_id,
                correlation_id=project.correlation_id,
            )
        )
    return {"task_id": task_id, "status": status, "summary": summary, "recorded": True}


@mcp.tool()
def request_approval(
    project_id: str,
    action: str,
    resource: str,
    environment: str,
    artifact_sha: str,
    gate: str = "G3",
    reason: str = "",
    requested_by: str = "agent",
) -> dict[str, Any]:
    """Request a human approval gate (G2/G3/G4) for a deployment action."""
    orchestrator = _build_orchestrator()
    project = _load_project(project_id)
    approval = orchestrator.require_approval(
        project=project,
        action=action,
        resource=resource,
        environment=environment,
        artifact_sha=artifact_sha,
        requested_by=requested_by,
        gate=gate,
        reason=reason,
    )
    return _record(approval)


@mcp.tool()
def resolve_approval(project_id: str, request_id: str, approver: str, granted: bool) -> dict[str, Any]:
    """Resolve a pending approval request as a human approver."""
    orchestrator = _build_orchestrator()
    project = _load_project(project_id)
    pending = _APPROVALS.get(request_id)
    if pending is None:
        raise ValueError(f"unknown approval request: {request_id}")
    resolved = orchestrator.resolve_approval(
        project=project,
        approval=pending,
        approver=approver,
        granted=granted,
        reason="resolved via MCP",
    )
    return _record(resolved)


@mcp.tool()
def audit(project_id: str) -> dict[str, Any]:
    """Return the append-only event log for a project."""
    events = [
        {
            "event_type": e.event_type,
            "occurred_at": e.occurred_at,
            "actor": f"{e.actor.type}:{e.actor.id}",
            "data": e.data,
        }
        for e in _EVENTS.events_for(project_id)
    ]
    return {"project_id": project_id, "event_count": len(events), "events": events}


@mcp.tool()
def list_roles() -> dict[str, Any]:
    """List every registered specialist role and its prompt file."""
    roles = [{"role": "orchestrator", "prompt_file": str(PROMPTS_ROOT / "master-orchestrator.md")}]
    for path in sorted((PROMPTS_ROOT / "roles").glob("*.md")):
        roles.append({"role": path.stem, "prompt_file": str(path)})
    return {"roles": roles, "count": len(roles)}


@mcp.tool()
def list_workflows() -> dict[str, Any]:
    """List the governed workflows (delivery, change-control, release, incident)."""
    workflows = []
    for path in sorted(WORKFLOWS_ROOT.glob("*.yaml")):
        workflows.append({"name": path.stem, "file": str(path)})
    return {"workflows": workflows, "count": len(workflows)}


# --------------------------------------------------------------------------
# Resources
# --------------------------------------------------------------------------


def _read_text(root: Path, name: str) -> str:
    if "/" in name or ".." in name or name.startswith("."):
        raise ValueError("invalid resource name")
    path = root / name
    if not path.is_file():
        available = ", ".join(p.stem for p in root.glob("*"))
        raise FileNotFoundError(f"unknown resource '{name}'; available: {available}")
    return path.read_text(encoding="utf-8")


@mcp.resource("prompts://base-agent-constitution")
def constitution() -> str:
    """The base agent constitution applied to every role."""
    return _read_text(PROMPTS_ROOT, "base-agent-constitution.md")


@mcp.resource("prompts://master-orchestrator")
def orchestrator_prompt() -> str:
    """The master orchestrator system prompt."""
    return _read_text(PROMPTS_ROOT, "master-orchestrator.md")


@mcp.resource("prompts://roles/{role}")
def role_prompt(role: str) -> str:
    """The system prompt for a specialist role (e.g. technical-lead)."""
    return _read_text(PROMPTS_ROOT / "roles", f"{role}.md")


@mcp.resource("prompts://policies/{policy}")
def policy_prompt(policy: str) -> str:
    """A governance policy (default-project-policy, production-policy, data-handling-policy)."""
    return _read_text(PROMPTS_ROOT / "policies", f"{policy}.md")


@mcp.resource("schemas://{schema}")
def schema_resource(schema: str) -> str:
    """A JSON schema (project, event, capability, task-envelope, result-envelope, approval-request)."""
    return _read_text(SCHEMAS_ROOT, f"{schema}.schema.json")


@mcp.resource("workflows://{workflow}")
def workflow_resource(workflow: str) -> str:
    """A governed workflow definition (delivery, change-control, release, incident)."""
    return _read_text(WORKFLOWS_ROOT, f"{workflow}.yaml")


# --------------------------------------------------------------------------
# Prompts (pre-assembled chat instructions for the host)
# --------------------------------------------------------------------------


@mcp.prompt()
def act_as_role(role: str) -> str:
    """Compose a system prompt instructing the host to act as a specialist."""
    return _read_text(PROMPTS_ROOT / "roles", f"{role}.md")


@mcp.prompt()
def conduct_code_review() -> str:
    """Ask the host to run a governed code review with the reviewer role."""
    return (
        "You are acting as the code-reviewer agent of the Agentic Software Company.\n"
        "Review the codebase under policy control. Produce a result envelope with:\n"
        "  - findings (severity, location, rationale)\n"
        "  - policy checks applied\n"
        "  - approval gates required before merge\n"
        "Respect the security and data-handling policies. Record every decision."
    )


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _load_project(project_id: str) -> ProjectRecord:
    project = _STATE.load_project(project_id)
    if project is None:
        projects = _STATE.keys()
        if project_id in projects:
            project = _STATE.load_project(project_id)
    if project is None:
        raise ValueError(f"unknown project: {project_id}; run begin_project first")
    return project


def _record(obj: Any) -> dict[str, Any]:
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    if isinstance(obj, dict):
        return obj
    from dataclasses import asdict

    try:
        return asdict(obj)
    except TypeError:
        return {"value": str(obj)}


def main(argv: list[str] | None = None) -> None:
    """Run the MCP server. Supports stdio, sse, and streamable-http transports."""
    import argparse

    parser = argparse.ArgumentParser(prog="agentic-company-mcp")
    parser.add_argument(
        "--transport",
        choices=("stdio", "sse", "streamable-http"),
        default="stdio",
        help="MCP transport (default: stdio). Use sse or streamable-http to expose a remote URL.",
    )
    parser.add_argument(
        "--mount-path",
        default="/mcp",
        help="HTTP mount path for sse/streamable-http transports (default: /mcp)",
    )
    parser.add_argument("--host", default="0.0.0.0", help="bind host for HTTP transports")
    parser.add_argument("--port", type=int, default=8000, help="bind port for HTTP transports")
    args = parser.parse_args(argv)
    if args.transport == "stdio":
        mcp.run()
        return
    if args.transport == "sse":
        mcp.run(transport="sse", mount_path=args.mount_path)
        return
    mcp.run(transport="streamable-http", mount_path=args.mount_path)


if __name__ == "__main__":
    main()
