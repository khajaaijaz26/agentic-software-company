"""Tests for the agentic-company reference implementation.

Run with:  python -m unittest discover -s tests -v
"""

import unittest

from agentic_company.contracts import (
    Actor,
    ApprovalRequest,
    Budget,
    BudgetUsage,
    Evidence,
    ProjectRecord,
    ResultEnvelope,
    TaskEnvelope,
    WorkItem,
    new_id,
    utc_now,
)


class TestContracts(unittest.TestCase):
    def test_budget_rejects_negative(self) -> None:
        with self.assertRaises(ValueError):
            Budget(max_cost=-1)

    def test_result_rejects_invalid_status(self) -> None:
        with self.assertRaises(ValueError):
            ResultEnvelope(
                task_id="t", correlation_id="c", project_id="p",
                agent_role="r", status="NOT_A_STATE", summary="",
            )

    def test_result_success_property(self) -> None:
        ok = ResultEnvelope(task_id="t", correlation_id="c", project_id="p", agent_role="r", status="COMPLETE", summary="done")
        self.assertTrue(ok.is_success)

    def test_approval_fingerprint_binds_identity(self) -> None:
        a = ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="agent")
        b = ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="zzz9999", requested_by="agent")
        self.assertNotEqual(a.bound_fingerprint, b.bound_fingerprint)
        self.assertTrue(a.matches(a))

    def test_approval_fingerprint_ignores_nonce_fields(self) -> None:
        a = ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="agent")
        b = ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="other")
        self.assertEqual(a.bound_fingerprint, b.bound_fingerprint)

    def test_artifact_requires_substantial_sha(self) -> None:
        with self.assertRaises(ValueError):
            from agentic_company.contracts import Artifact
            Artifact(path="x", sha="ab")


if __name__ == "__main__":
    unittest.main()