"""The orchestrator: composes task envelopes, dispatches specialists, and
applies the policy/approval gates described in the master system prompt.

The orchestrator does not make business decisions. It routes work, checks the
policy engine, attaches bound approval tokens, and records every handoff as a
domain event.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .agent_registry import AgentRegistry
from .approval_service import ApprovalService
from .contracts import (
    Actor,
    ApprovalRequest,
    Budget,
    DomainEvent,
    ProjectRecord,
    ResultEnvelope,
    TaskEnvelope,
    new_id,
    utc_now,
)
from .event_store import EventStore
from .policy_engine import PolicyEngine
from .state_store import StateStore

Dispatcher = Callable[[TaskEnvelope], ResultEnvelope]

@dataclass
class OrchestrationResult:
    correlation_id: str
    task_id: str
    project_id: str
    result: ResultEnvelope
    event_ids: list[str]


class Orchestrator:
    """Routes task envelopes to specialist agents under policy control."""

    def __init__(
        self,
        state: StateStore,
        events: EventStore,
        policy: PolicyEngine,
        approvals: ApprovalService,
        registry: AgentRegistry,
        dispatcher: Dispatcher,
        prompt_versions: dict[str, str] | None = None,
    ) -> None:
        self._state = state
        self._events = events
        self._policy = policy
        self._approvals = approvals
        self._registry = registry
        self._dispatcher = dispatcher
        self._prompt_versions = prompt_versions or {}

    def _record(self, event_type: str, actor: Actor, data: dict[str, Any], project_id: str, correlation_id: str) -> str:
        event = self._events.append(
            DomainEvent(
                event_type=event_type,
                actor=actor,
                data=data,
                project_id=project_id,
                correlation_id=correlation_id,
            )
        )
        return event.event_id

    def begin_project(
        self,
        request: str,
        name: str,
        owner: str,
        scope_goals: list[str],
        scope_non_goals: list[str],
        acceptance_criteria: list[str],
    ) -> ProjectRecord:
        correlation_id = new_id("corr")
        project_id = new_id("proj")
        record = ProjectRecord(
            project_id=project_id,
            request_id=new_id("req"),
            correlation_id=correlation_id,
            name=name,
            status="planning",
            owner=owner,
            created_at=utc_now(),
            scope_goals=scope_goals,
            scope_non_goals=scope_non_goals,
            acceptance_criteria=acceptance_criteria,
        )
        self._state.save_project(record)
        self._record("project.created", Actor.system(), {"project_id": project_id, "name": name}, project_id, correlation_id)
        return record

    def dispatch(
        self,
        project: ProjectRecord,
        agent_role: str,
        kind: str,
        instructions: str,
        approvals: list[ApprovalRequest] | None = None,
        budget_max_cost: float = 0.0,
    ) -> OrchestrationResult:
        """Dispatch one task to a specialist agent with a bound envelope."""
        registry_spec = self._registry.get(agent_role)
        if registry_spec is None:
            raise KeyError(f"unregistered agent role: {agent_role}")

        task_id = new_id("task")
        approvals = approvals or []
        envelope = TaskEnvelope(
            task_id=task_id,
            correlation_id=project.correlation_id,
            project_id=project.project_id,
            request_id=project.request_id,
            kind=kind,
            owner=project.owner,
            agent_role=agent_role,
            instructions=instructions,
            prompt_versions={
                "constitution": self._prompt_versions.get("constitution", ""),
                "role": registry_spec.prompt_sha,
                "project_policy": self._prompt_versions.get("project_policy", ""),
            },
            approvals=approvals,
            budget=Budget(max_cost=budget_max_cost),
        )

        self._record(
            "task.dispatch",
            Actor.agent("orchestrator"),
            {"task_id": task_id, "agent_role": agent_role, "kind": kind},
            project.project_id,
            project.correlation_id,
        )

        result = self._dispatcher(envelope)

        self._record(
            "task.complete",
            Actor.agent(agent_role),
            {"task_id": task_id, "status": result.status, "summary": result.summary},
            project.project_id,
            project.correlation_id,
        )
        return OrchestrationResult(
            correlation_id=project.correlation_id,
            task_id=task_id,
            project_id=project.project_id,
            result=result,
            event_ids=[e.event_id for e in self._events.events_for(project.project_id)],
        )

    def require_approval(
        self,
        project: ProjectRecord,
        action: str,
        resource: str,
        environment: str,
        artifact_sha: str,
        requested_by: str,
        gate: str = "G3",
        reason: str = "",
    ) -> ApprovalRequest:
        """Create a bound approval request; the caller must have it resolved."""
        approval = self._approvals.request(
            ApprovalRequest(
                action=action,
                resource=resource,
                environment=environment,
                artifact_sha=artifact_sha,
                requested_by=requested_by,
                project_id=project.project_id,
                gate=gate,
                reason=reason,
            )
        )
        self._record(
            "approval.requested",
            Actor.agent("orchestrator"),
            {"request_id": approval.request_id, "action": action, "resource": resource, "gate": gate},
            project.project_id,
            project.correlation_id,
        )
        return approval

    def resolve_approval(
        self, project: ProjectRecord, approval: ApprovalRequest, approver: str, granted: bool, reason: str = ""
    ) -> ApprovalRequest:
        resolved = self._approvals.resolve(approval, approver, granted, reason)
        self._record(
            "approval.resolved",
            Actor.human(approver),
            {"request_id": approval.request_id, "decision": resolved.decision},
            project.project_id,
            project.correlation_id,
        )
        return resolved
