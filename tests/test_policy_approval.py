"""Tests for the policy engine and approval service."""

import unittest

from agentic_company.approval_service import ApprovalService
from agentic_company.contracts import ApprovalRequest
from agentic_company.policy_engine import PolicyEngine


class TestPolicyEngine(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = PolicyEngine()

    def test_read_is_autonomous(self) -> None:
        d = self.engine.decide("read:repository", environment="local")
        self.assertTrue(d.allowed)
        self.assertEqual(d.gate, "G0")
        self.assertFalse(d.requires_approval)

    def test_workspace_write_is_reversible(self) -> None:
        d = self.engine.decide("edit:source", environment="local")
        self.assertTrue(d.allowed)
        self.assertEqual(d.gate, "G1")
        self.assertFalse(d.requires_approval)

    def test_production_deploy_requires_approval(self) -> None:
        d = self.engine.decide("deploy:production", environment="prod")
        self.assertEqual(d.gate, "G3")
        self.assertTrue(d.requires_approval)
        self.assertFalse(d.allowed)

    def test_approved_artifact_allows_gated_action(self) -> None:
        d = self.engine.decide("deploy:production", environment="prod", artifact_approved=True)
        self.assertTrue(d.allowed)

    def test_unknown_operation_denied(self) -> None:
        d = self.engine.decide("rm -rf /", environment="local")
        self.assertFalse(d.allowed)

    def test_workspace_edit_escalates_in_prod(self) -> None:
        d = self.engine.decide("edit:source", environment="prod")
        self.assertEqual(d.gate, "G3")

    def test_denied_operation_never_allowed(self) -> None:
        self.engine.deny("post:project_channel")
        d = self.engine.decide("post:project_channel", environment="dev")
        self.assertFalse(d.allowed)

    def test_custom_rule_override(self) -> None:
        self.engine.register_custom("run:local_test", "G2")
        d = self.engine.decide("run:local_test", environment="local")
        self.assertEqual(d.gate, "G2")
        self.assertTrue(d.requires_approval)


class TestApprovalService(unittest.TestCase):
    def setUp(self) -> None:
        self.service = ApprovalService(ttl_seconds=3600)

    def test_lifecycle(self) -> None:
        req = self.service.request(
            ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="orchestrator")
        )
        self.assertEqual(req.decision, "pending")
        self.assertTrue(req.expires_at)

        resolved = self.service.resolve(req, approver="carol", granted=True, reason="verified")
        self.assertEqual(resolved.decision, "approved")
        self.assertEqual(resolved.approved_by, "carol")
        self.assertTrue(self.service.verify(resolved))

    def test_rejected_token_never_verifies(self) -> None:
        req = self.service.request(
            ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="orchestrator")
        )
        self.service.resolve(req, approver="carol", granted=False)
        self.assertFalse(self.service.verify(req))

    def test_cannot_resolve_twice(self) -> None:
        req = self.service.request(
            ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="orchestrator")
        )
        self.service.resolve(req, approver="carol", granted=True)
        with self.assertRaises(ValueError):
            self.service.resolve(req, approver="dave", granted=True)

    def test_approval_expires(self) -> None:
        req = self.service.request(
            ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="orchestrator")
        )
        resolved = self.service.resolve(req, approver="carol", granted=True)
        before_expiry = "2026-01-01T00:00:00Z"
        far_future = "2999-01-01T00:00:00Z"
        self.assertTrue(self.service.verify(resolved, now=before_expiry))
        self.assertFalse(self.service.verify(resolved, now=far_future))

        # Emulate expiry: re-request with ttl=0
        svc = ApprovalService(ttl_seconds=0)
        req2 = svc.request(
            ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="orchestrator")
        )
        self.assertFalse(svc.verify(req2))

    def test_bound_fingerprint_rejects_different_artifact(self) -> None:
        approved = ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="orchestrator")
        different = ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="zzz9999", requested_by="orchestrator")
        self.assertFalse(approved.matches(different))


if __name__ == "__main__":
    unittest.main()