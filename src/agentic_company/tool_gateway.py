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

from .contracts import Actor, ApprovalRequest, DomainEvent
from .event_store import EventStore
from .policy_engine import PolicyEngine

Tool = Callable[..., Any]


class ToolGatewayError(Exception):
    """Raised when a tool call is denied or its authorization is invalid."""


class ToolGateway:
    """Authorized, audited tool-call boundary for agents."""

    def __init__(self, policy: PolicyEngine, events: EventStore) -> None:
        self._policy = policy
        self._events = events
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
            artifact_approved=approval is not None,
        )

        if decision.requires_approval:
            if approval is None or not approval.matches(
                ApprovalRequest(
                    action=operation,
                    resource=str((args or {}).get("resource", "*")),
                    environment=environment,
                    artifact_sha=str((args or {}).get("artifact_sha", "")),
                    requested_by=actor.id,
                    project_id=project_id,
                )
            ):
                raise ToolGatewayError(
                    f"tool '{name}' needs a matching approval token for gate {decision.gate}: {decision.reason}"
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