"""Core contracts for the agentic software company.

These dataclasses mirror the JSON schemas in ``schemas/`` and the prompt
templates in ``prompts/templates/``. The orchestrator composes task envelopes,
dispatch specialists, collect result envelopes, and persist domain events.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

TERMINAL_STATES = ("COMPLETE", "BLOCKED", "NEEDS_APPROVAL", "NEEDS_INPUT", "ESCALATED")

TaskKind = Literal[
    "clarification", "defect", "delivery", "review", "research", "approval", "release", "incident"
]
ApprovalGate = Literal["G0", "G1", "G2", "G3", "G4"]
Environment = Literal["local", "dev", "staging", "prod"]
ActorType = Literal["human", "agent", "system"]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@dataclass(frozen=True)
class Actor:
    """Who performed an action: a human, an agent, or the system itself."""

    type: ActorType
    id: str

    @classmethod
    def human(cls, name: str) -> "Actor":
        return cls(type="human", id=name)

    @classmethod
    def agent(cls, role: str) -> "Actor":
        return cls(type="agent", id=role)

    @classmethod
    def system(cls) -> "Actor":
        return cls(type="system", id="platform")


@dataclass(frozen=True)
class Budget:
    currency: str = "USD"
    max_cost: float = 0.0
    max_tokens: int = 0
    max_time_seconds: int = 0

    def __post_init__(self) -> None:
        for name, value in (
            ("max_cost", self.max_cost),
            ("max_tokens", self.max_tokens),
            ("max_time_seconds", self.max_time_seconds),
        ):
            if value < 0:
                raise ValueError(f"{name} must be non-negative")


@dataclass(frozen=True)
class BudgetUsage:
    cost: float = 0.0
    tokens: int = 0
    time_seconds: int = 0


@dataclass(frozen=True)
class ApprovalRequest:
    """A scoped, bound, single-use approval token request.

    ``artifact_sha`` and ``expires_at`` are mandatory because silence is never
    approval and an approval is never transferable to a different artifact.
    """

    action: str
    resource: str
    environment: Environment
    artifact_sha: str
    requested_by: str
    project_id: str = ""
    gate: ApprovalGate = "G3"
    request_id: str = field(default_factory=lambda: new_id("apr"))
    requested_at: str = field(default_factory=utc_now)
    expires_at: str = ""
    decision: str = "pending"
    approved_by: str = ""
    approved_at: str = ""
    reason: str = ""

    def __post_init__(self) -> None:
        if not self.expires_at:
            object.__setattr__(self, "expires_at", utc_now())

    @property
    def bound_fingerprint(self) -> str:
        """A stable identity of exactly what is being approved."""
        return "|".join(
            (self.gate, self.action, self.resource, self.environment, self.artifact_sha, self.project_id)
        )

    def matches(self, other: "ApprovalRequest") -> bool:
        return self.bound_fingerprint == other.bound_fingerprint


@dataclass(frozen=True)
class Evidence:
    criterion_id: str
    criterion: str
    outcome: str = "blocked"
    proof: str = ""


@dataclass(frozen=True)
class Artifact:
    path: str
    kind: str = "file"
    sha: str = ""
    status: str = "created"

    def __post_init__(self) -> None:
        if self.sha and len(self.sha) < 7:
            raise ValueError("artifact sha must be a real (substring) commit hash")


@dataclass(frozen=True)
class TaskEnvelope:
    """The immutable instruction bundle handed to a specialist agent."""

    task_id: str
    correlation_id: str
    project_id: str
    request_id: str
    kind: TaskKind
    owner: str
    agent_role: str
    instructions: str
    prompt_versions: dict[str, str]
    policy_ids: list[str] = field(default_factory=list)
    approvals: list[ApprovalRequest] = field(default_factory=list)
    budget: Budget = field(default_factory=Budget)
    expects: dict[str, Any] = field(default_factory=dict)
    envelope_version: int = 1

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), default=str)


@dataclass(frozen=True)
class ResultEnvelope:
    """The structured output a specialist agent returns to the orchestrator."""

    task_id: str
    correlation_id: str
    project_id: str
    agent_role: str
    status: str
    summary: str
    evidence: list[Evidence] = field(default_factory=list)
    artifacts: list[Artifact] = field(default_factory=list)
    budget_used: BudgetUsage = field(default_factory=BudgetUsage)
    next_owner: str = ""
    next_action: str = ""
    envelope_version: int = 1

    def __post_init__(self) -> None:
        if self.status not in TERMINAL_STATES:
            raise ValueError(f"invalid status: {self.status}")

    @property
    def is_success(self) -> bool:
        return self.status == "COMPLETE"


@dataclass(frozen=True)
class DomainEvent:
    event_type: str
    actor: Actor
    data: dict[str, Any]
    event_id: str = field(default_factory=lambda: new_id("evt"))
    version: int = 1
    project_id: str = ""
    correlation_id: str = ""
    occurred_at: str = field(default_factory=utc_now)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), default=str)


@dataclass(frozen=True)
class WorkItem:
    """A unit of executable work produced by the orchestrator's plan."""

    item_id: str
    project_id: str
    title: str
    owner: str
    kind: TaskKind = "delivery"
    status: str = "queued"
    depends_on: tuple[str, ...] = ()


@dataclass(frozen=True)
class ProjectRecord:
    """The canonical project record carried in the state store."""

    project_id: str
    request_id: str
    correlation_id: str
    name: str
    status: str
    owner: str
    created_at: str
    scope_goals: list[str] = field(default_factory=list)
    scope_non_goals: list[str] = field(default_factory=list)
    acceptance_criteria: list[str] = field(default_factory=list)
    updated_at: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "updated_at", self.updated_at or self.created_at)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "ProjectRecord":
        return cls(
            project_id=raw["project_id"],
            request_id=raw["request_id"],
            correlation_id=raw["correlation_id"],
            name=raw["name"],
            status=raw["status"],
            owner=raw["owner"],
            created_at=raw["created_at"],
            scope_goals=list(raw.get("scope_goals", [])),
            scope_non_goals=list(raw.get("scope_non_goals", [])),
            acceptance_criteria=list(raw.get("acceptance_criteria", [])),
            updated_at=raw.get("updated_at", raw.get("created_at", "")),
        )

    def touch(self) -> "ProjectRecord":
        return ProjectRecord(
            project_id=self.project_id,
            request_id=self.request_id,
            correlation_id=self.correlation_id,
            name=self.name,
            status=self.status,
            owner=self.owner,
            created_at=self.created_at,
            scope_goals=self.scope_goals,
            scope_non_goals=self.scope_non_goals,
            acceptance_criteria=self.acceptance_criteria,
            updated_at=utc_now(),
        )
