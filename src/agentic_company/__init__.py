"""Software Agent governed multi-agent delivery compatibility runtime.

The public Python import is :mod:`software_agent`. This module remains as a
deprecated compatibility alias so existing integrations continue to work.
"""

from .agent_registry import AgentRegistry, AgentSpec
from .approval_service import ApprovalService
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
from .event_store import EventStore, EventStoreError
from .orchestrator import OrchestrationResult, Orchestrator
from .policy_engine import AuthorizationDecision, PolicyEngine
from .state_store import StateStore
from .tool_gateway import ToolGateway, ToolGatewayError
from .workflow import RunStats, Workflow, WorkflowError

__version__ = "1.0.0"

__all__ = [
    "Actor",
    "AgentRegistry",
    "AgentSpec",
    "ApprovalRequest",
    "ApprovalService",
    "Artifact",
    "ArtifactStore",
    "AuthorizationDecision",
    "Budget",
    "BudgetUsage",
    "DomainEvent",
    "EventStore",
    "EventStoreError",
    "Evidence",
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
