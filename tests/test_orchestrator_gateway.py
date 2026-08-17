"""Tests for the tool gateway and orchestrator routing."""

import unittest

from agentic_company.agent_registry import AgentRegistry, AgentSpec
from agentic_company.approval_service import ApprovalService
from agentic_company.contracts import Actor, ApprovalRequest, DomainEvent, ResultEnvelope, TaskEnvelope
from agentic_company.event_store import EventStore
from agentic_company.orchestrator import Orchestrator
from agentic_company.policy_engine import PolicyEngine
from agentic_company.state_store import StateStore
from agentic_company.tool_gateway import ToolGateway, ToolGatewayError


def _ok_dispatcher(envelope: TaskEnvelope) -> ResultEnvelope:
    return ResultEnvelope(
        task_id=envelope.task_id,
        correlation_id=envelope.correlation_id,
        project_id=envelope.project_id,
        agent_role=envelope.agent_role,
        status="COMPLETE",
        summary="done",
    )


class TestToolGateway(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = PolicyEngine()
        self.events = EventStore()
        self.gateway = ToolGateway(self.policy, self.events)

    def test_g0_tool_calls_freely_and_is_audited(self) -> None:
        self.gateway.register("read_file", "read:file", lambda path: f"content of {path}")
        result = self.gateway.call("read_file", Actor.agent("tl"), {"path": "README.md"}, environment="local")
        self.assertEqual(result, "content of README.md")
        self.assertEqual(len(self.events.events_for(event_type="tool.call")), 1)

    def test_gated_tool_requires_approval(self) -> None:
        self.gateway.register("deploy", "deploy:production", lambda **kw: "deployed")
        with self.assertRaises(ToolGatewayError):
            self.gateway.call("deploy", Actor.agent("devops"), environment="prod")

    def test_approval_must_match_artifact(self) -> None:
        self.gateway.register("deploy", "deploy:production", lambda **kw: "deployed")
        approval = ApprovalRequest(
            action="deploy:production", resource="svc", environment="prod",
            artifact_sha="abc1234", requested_by="orchestrator",
        )
        with self.assertRaises(ToolGatewayError):
            self.gateway.call(
                "deploy", Actor.agent("devops"),
                {"resource": "svc", "artifact_sha": "different_sha"},
                approval=approval, environment="prod",
            )

    def test_approval_matching_artifact_succeeds(self) -> None:
        self.gateway.register("deploy", "deploy:production", lambda **kw: "deployed")
        approval = ApprovalRequest(
            action="deploy:production", resource="svc", environment="prod",
            artifact_sha="abc1234", requested_by="orchestrator",
        )
        result = self.gateway.call(
            "deploy", Actor.agent("devops"),
            {"resource": "svc", "artifact_sha": "abc1234"},
            approval=approval, environment="prod",
        )
        self.assertEqual(result, "deployed")

    def test_secrets_redacted_in_audit(self) -> None:
        self.gateway.register("call_api", "read:file", lambda **kw: "ok")
        self.gateway.call("call_api", Actor.agent("devops"), {"api_key": "super-secret", "url": "https://x"}, environment="local")
        recorded = self.events.events_for(event_type="tool.call")[-1]
        self.assertIn("***REDACTED***", json_dumps(recorded.data))

    def test_unknown_tool_raises(self) -> None:
        with self.assertRaises(ToolGatewayError):
            self.gateway.call("nope", Actor.system())


class TestOrchestrator(unittest.TestCase):
    def setUp(self) -> None:
        self.state = StateStore()
        self.events = EventStore()
        self.policy = PolicyEngine()
        self.approvals = ApprovalService()
        self.registry = AgentRegistry()
        self.registry.register(AgentSpec(role="technical-lead", prompt_file="roles/technical-lead.md", prompt_sha="sha1"))
        self.registry.register(AgentSpec(role="orchestrator", prompt_file="roles/orchestrator.md", prompt_sha="sha0"))
        self.orchestrator = Orchestrator(
            state=self.state, events=self.events, policy=self.policy,
            approvals=self.approvals, registry=self.registry, dispatcher=_ok_dispatcher,
        )

    def test_project_lifecycle(self) -> None:
        project = self.orchestrator.begin_project(
            request="build a CLI", name="cli-tool", owner="carol",
            scope_goals=["ship"], scope_non_goals=["no cloud"], acceptance_criteria=["cli works"],
        )
        self.assertEqual(project.status, "planning")
        self.assertEqual(len(self.events.events_for(project.project_id)), 1)

        result = self.orchestrator.dispatch(
            project=project, agent_role="technical-lead", kind="delivery",
            instructions="design the architecture",
        )
        self.assertEqual(result.result.status, "COMPLETE")
        self.assertEqual(len(result.event_ids), 3)

    def test_dispatch_unknown_role_raises(self) -> None:
        project = self.orchestrator.begin_project(
            request="x", name="x", owner="o", scope_goals=["g"], scope_non_goals=[], acceptance_criteria=["a"],
        )
        with self.assertRaises(KeyError):
            self.orchestrator.dispatch(project=project, agent_role="ghost", kind="delivery", instructions="x")

    def test_approval_gate_lifecycle(self) -> None:
        project = self.orchestrator.begin_project(
            request="x", name="x", owner="o", scope_goals=["g"], scope_non_goals=[], acceptance_criteria=["a"],
        )
        req = self.orchestrator.require_approval(
            project=project, action="deploy:production", resource="svc",
            environment="prod", artifact_sha="abc1234", requested_by="devops", gate="G3",
        )
        self.assertEqual(req.decision, "pending")
        resolved = self.orchestrator.resolve_approval(project=project, approval=req, approver="carol", granted=True)
        self.assertEqual(resolved.decision, "approved")
        self.assertTrue(self.approvals.verify(resolved))
        self.assertEqual(len(self.events.events_for(project.project_id, event_type="approval.resolved")), 1)


def json_dumps(obj) -> str:
    import json
    return json.dumps(obj, default=str)


if __name__ == "__main__":
    unittest.main()