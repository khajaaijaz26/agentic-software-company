"""Policy engine: decides whether an action is allowed and which gate applies.

Implements the baseline approval gates from ``prompts/policies/default-project-policy.md``:

- ``G0`` autonomous read
- ``G1`` reversible workspace change
- ``G2`` shared or external non-production effect
- ``G3`` production or sensitive effect
- ``G4`` irreversible, legal, financial, or high-impact effect

The engine is deterministic: given the same action, scope, and environment it
always returns the same gate and authorization decision.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .contracts import ApprovalGate, Environment

# Operations are classed by their sensitivity so the engine can map them to gates.
_OPERATION_CLASS: dict[str, ApprovalGate] = {
    # G0 — read-only, autonomous
    "read:file": "G0",
    "read:repository": "G0",
    "read:documentation": "G0",
    "read:telemetry": "G0",
    "search:approved_source": "G0",
    # G1 — reversible workspace change
    "write:workspace": "G1",
    "edit:source": "G1",
    "run:local_test": "G1",
    "build:preview": "G1",
    # G2 — shared or external non-production effect
    "create:branch": "G2",
    "open:pull_request": "G2",
    "post:project_channel": "G2",
    "create:staging_resource": "G2",
    "use:paid_api": "G2",
    # G3 — production or sensitive effect
    "deploy:production": "G3",
    "migrate:production_data": "G3",
    "rotate:credential": "G3",
    "access:restricted_data": "G3",
    "send:customer_communication": "G3",
    # G4 — irreversible, legal, financial, high impact
    "delete:production_data": "G4",
    "incur:material_charge": "G4",
    "accept:terms": "G4",
    "change:access_control": "G4",
    "publish:release": "G4",
    "disclose:security": "G4",
}

# Environment escalation: actions that are G1 in a workspace become G3 when the
# target is a production resource, regardless of the configured class.
_ENV_ESCALATION: set[tuple[str, Environment]] = {
    ("edit:source", "prod"),
    ("write:workspace", "prod"),
    ("run:local_test", "prod"),
}


@dataclass(frozen=True)
class AuthorizationDecision:
    allowed: bool
    gate: ApprovalGate
    requires_approval: bool
    reason: str = ""
    matched_operation: str = ""


class PolicyEngine:
    """Deterministic policy decisions for tool-call authorization."""

    def __init__(self) -> None:
        self._bypass_roles: set[str] = {"production_approver"}
        self._denied_operations: set[str] = set()
        self._custom_rules: dict[str, ApprovalGate] = {}

    def register_custom(self, operation: str, gate: ApprovalGate) -> None:
        self._custom_rules[operation] = gate

    def deny(self, operation: str) -> None:
        self._denied_operations.add(operation)

    def decide(
        self,
        operation: str,
        environment: Environment = "local",
        role: str = "",
        artifact_approved: bool = False,
    ) -> AuthorizationDecision:
        if operation in self._denied_operations:
            return AuthorizationDecision(
                allowed=False, gate="G0", requires_approval=False,
                reason=f"operation explicitly denied: {operation}", matched_operation=operation,
            )

        gate = self._custom_rules.get(operation) or _OPERATION_CLASS.get(operation)
        if gate is None:
            return AuthorizationDecision(
                allowed=False, gate="G0", requires_approval=False,
                reason=f"unknown operation (deny by default): {operation}", matched_operation=operation,
            )

        if (operation, environment) in _ENV_ESCALATION:
            gate = "G3"

        if gate == "G0":
            return AuthorizationDecision(allowed=True, gate=gate, requires_approval=False, matched_operation=operation)

        if gate == "G1":
            return AuthorizationDecision(allowed=True, gate=gate, requires_approval=False, matched_operation=operation)

        if role in self._bypass_roles and gate in ("G2", "G3"):
            return AuthorizationDecision(allowed=True, gate=gate, requires_approval=False, matched_operation=operation)

        requires_approval = gate in ("G2", "G3", "G4")
        allowed = not requires_approval or artifact_approved
        return AuthorizationDecision(
            allowed=allowed,
            gate=gate,
            requires_approval=requires_approval,
            reason="requires an explicit matching approval token" if requires_approval else "",
            matched_operation=operation,
        )


def default_engine() -> PolicyEngine:
    return PolicyEngine()