"""Scenario: delivery of a small CLI tool with a security review gate.

Each scenario exercises the reference implementation end-to-end: create a
project, dispatch specialists in dependency order, gate a production action
behind an approval, and assert the audit trail.
"""

import json
import pathlib

from agentic_company.agent_registry import AgentRegistry, AgentSpec
from agentic_company.approval_service import ApprovalService
from agentic_company.contracts import Actor, Evidence, ResultEnvelope, TaskEnvelope
from agentic_company.event_store import EventStore
from agentic_company.orchestrator import Orchestrator
from agentic_company.policy_engine import PolicyEngine
from agentic_company.state_store import StateStore

ROLES = [
    "client-intake-account",
    "discovery-business-analyst",
    "product-manager",
    "project-manager",
    "technical-lead",
    "security-engineer",
    "release-manager",
]


def dispatcher(envelope: TaskEnvelope) -> ResultEnvelope:
    return ResultEnvelope(
        task_id=envelope.task_id,
        correlation_id=envelope.correlation_id,
        project_id=envelope.project_id,
        agent_role=envelope.agent_role,
        status="COMPLETE",
        summary=f"scenario result for {envelope.agent_role}",
        evidence=[
            Evidence(
                criterion_id="c1",
                criterion="scenario acceptance",
                outcome="pass",
                proof="scenario",
            )
        ],
    )


def run() -> dict:
    state = StateStore()
    events = EventStore()
    policy = PolicyEngine()
    approvals = ApprovalService()
    registry = AgentRegistry()
    for role in ROLES:
        registry.register(
            AgentSpec(role=role, prompt_file=f"prompts/roles/{role}.md", prompt_sha=f"sha-{role}")
        )
    orchestrator = Orchestrator(
        state=state,
        events=events,
        policy=policy,
        approvals=approvals,
        registry=registry,
        dispatcher=dispatcher,
    )

    project = orchestrator.begin_project(
        request="build a CLI that summarizes repos",
        name="cli-summarizer",
        owner="carol",
        scope_goals=["summarize a repository from a path"],
        scope_non_goals=["no cloud storage"],
        acceptance_criteria=["CLI exits 0 on success"],
    )

    order = [
        ("discovery-business-analyst", "derive goals and criteria"),
        ("technical-lead", "design architecture"),
        ("product-manager", "refine acceptance criteria"),
        ("security-engineer", "security review of design"),
        ("project-manager", "plan tasks and budget"),
    ]
    for role, instruction in order:
        orchestrator.dispatch(project=project, agent_role=role, kind="delivery", instructions=instruction)

    approval = orchestrator.require_approval(
        project=project,
        action="publish:release",
        resource="cli-summarizer",
        environment="prod",
        artifact_sha="a1b2c3d4e5f6",
        requested_by="release-manager",
        gate="G4",
    )
    orchestrator.resolve_approval(project=project, approval=approval, approver="carol", granted=True)

    release = orchestrator.dispatch(project=project, agent_role="release-manager", kind="release", instructions="release the CLI")

    return {
        "project_id": project.project_id,
        "dispatch_count": len(events.events_for(project.project_id, event_type="task.dispatch")),
        "release_status": release.result.status,
        "approval_resolved": len(events.events_for(project.project_id, event_type="approval.resolved")) == 1,
        "total_events": len(events.events_for(project.project_id)),
    }


if __name__ == "__main__":
    result = run()
    print(json.dumps(result, indent=2))
    assert result["dispatch_count"] == 6
    assert result["release_status"] == "COMPLETE"
    assert result["approval_resolved"]
    print("SCENARIO PASSED")