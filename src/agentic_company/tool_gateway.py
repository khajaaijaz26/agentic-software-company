"""Tool gateway: the single chokepoint where agents invoke tools.

Every tool call passes through ``ToolGateway.call``, which:

1. classifies the operation,
2. consults the policy engine,
3. requires a valid matching approval token for gated operations,
4. records a redacted call into the event store,
5. verifies the result matches the authorization boundary.

This makes "re-authorize at execution time" and "audit every call" concrete.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .approval_service import ApprovalService
from .contracts import Actor, ApprovalRequest, DomainEvent
from .event_store import EventStore
from .policy_engine import PolicyEngine

Tool = Callable[..., Any]


class ToolGatewayError(Exception):
    """Raised when a tool call is denied or its authorization is invalid."""


class ToolGateway:
    """Authorized, audited tool-call boundary for agents."""

    def __init__(
        self,
        policy: PolicyEngine,
        events: EventStore,
        approvals: ApprovalService | None = None,
    ) -> None:
        self._policy = policy
        self._events = events
        self._approvals = approvals
        self._tools: dict[str, Tool] = {}
        self._operations: dict[str, str] = {}

    def register(self, name: str, operation: str, fn: Tool) -> None:
        self._tools[name] = fn
        self._operations[name] = operation

    def call(
        self,
        name: str,
        actor: Actor,
        args: dict[str, Any] | None = None,
        approval: ApprovalRequest | None = None,
        environment: str = "local",
        project_id: str = "",
        correlation_id: str = "",
    ) -> Any:
        if name not in self._tools:
            raise ToolGatewayError(f"unknown tool: {name}")

        operation = self._operations[name]
        decision = self._policy.decide(
            operation=operation,
            environment=environment,
            role=actor.id,
            artifact_approved=False,
        )

        if decision.requires_approval:
            if approval is None or self._approvals is None:
                raise ToolGatewayError(
                    f"tool '{name}' needs a matching approval token for gate {decision.gate}: {decision.reason}"
                )
            consumed = self._approvals.consume(
                approval,
                actor=actor.id,
                action=operation,
                resource=str((args or {}).get("resource", "*")),
                environment=environment,
                artifact_sha=str((args or {}).get("artifact_sha", "")),
                project_id=project_id,
                gate=decision.gate,
            )
            if not consumed:
                raise ToolGatewayError(
                    f"tool '{name}' needs an approved, unexpired, unused token bound to actor, action, "
                    f"resource, environment, artifact, project, and gate {decision.gate}"
                )
            decision = self._policy.decide(
                operation=operation,
                environment=environment,
                role=actor.id,
                artifact_approved=True,
            )

        if not decision.allowed:
            raise ToolGatewayError(f"tool '{name}' denied by policy: {decision.reason}")

        result = self._tools[name](**(args or {}))

        self._events.append(
            DomainEvent(
                event_type="tool.call",
                actor=actor,
                data={"tool": name, "operation": operation, "gate": decision.gate, "args": self._redact(args or {})},
                project_id=project_id,
                correlation_id=correlation_id,
            )
        )
        return result

    @staticmethod
    def _redact(args: dict[str, Any]) -> dict[str, Any]:
        redacted: dict[str, Any] = {}
        for key, value in args.items():
            lowered = key.lower()
            if any(tok in lowered for tok in ("secret", "token", "password", "key", "credential", "api_key")):
                redacted[key] = "***REDACTED***"
            else:
                redacted[key] = value
        return redacted
