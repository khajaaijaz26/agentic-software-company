"""Open-Source Agentic Software Company — governed multi-agent delivery platform.

This package is a small, dependency-free reference implementation of the
architecture described in the *Open-Source Agentic Software Company Master
System Prompt*: an orchestrator that routes task envelopes to specialist
agents under policy control, with an append-only audit trail, bound approval
tokens, and deterministic tool authorization.
"""

from .approval_service import ApprovalService
from .agent_registry import AgentRegistry, AgentSpec
from .artifact_store import ArtifactStore
from .contracts import (
    Actor,
    ApprovalRequest,
    Artifact,
    Budget,
    BudgetUsage,
    DomainEvent,
    Evidence,
    ProjectRecord,
    ResultEnvelope,
    TaskEnvelope,
    WorkItem,
)
from .event_store import EventStore
from .orchestrator import Orchestrator, OrchestrationResult
from .policy_engine import AuthorizationDecision, PolicyEngine
from .state_store import StateStore
from .tool_gateway import ToolGateway, ToolGatewayError
from .workflow import RunStats, Workflow, WorkflowError

__version__ = "1.0.0"

__all__ = [
    "Actor",
    "AgentSpec",
    "AgentRegistry",
    "ApprovalRequest",
    "ApprovalService",
    "Artifact",
    "ArtifactStore",
    "AuthorizationDecision",
    "Budget",
    "BudgetUsage",
    "DomainEvent",
    "Evidence",
    "EventStore",
    "OrchestrationResult",
    "Orchestrator",
    "PolicyEngine",
    "ProjectRecord",
    "ResultEnvelope",
    "RunStats",
    "StateStore",
    "TaskEnvelope",
    "ToolGateway",
    "ToolGatewayError",
    "WorkItem",
    "Workflow",
    "WorkflowError",
    "__version__",
]