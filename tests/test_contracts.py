"""Tests for the agentic-company reference implementation.

Run with:  python -m unittest discover -s tests -v
"""

import json
import unittest

try:
    from jsonschema import Draft202012Validator
    JSONSCHEMA_AVAILABLE = True
except ImportError:  # pragma: no cover - optional MCP dependency supplies it in CI
    Draft202012Validator = None  # type: ignore[assignment]
    JSONSCHEMA_AVAILABLE = False

from agentic_company.contracts import (
    ApprovalRequest,
    Budget,
    ProjectRecord,
    ResultEnvelope,
    TaskEnvelope,
    utc_now,
)
from agentic_company.resources import SCHEMAS_ROOT


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

    def test_approval_fingerprint_binds_actor(self) -> None:
        a = ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="agent")
        b = ApprovalRequest(action="deploy:production", resource="svc", environment="prod", artifact_sha="abc1234", requested_by="other")
        self.assertNotEqual(a.bound_fingerprint, b.bound_fingerprint)

    def test_artifact_requires_substantial_sha(self) -> None:
        with self.assertRaises(ValueError):
            from agentic_company.contracts import Artifact
            Artifact(path="x", sha="ab")


@unittest.skipUnless(JSONSCHEMA_AVAILABLE, "jsonschema is provided by the MCP test extra")
class TestSchemaAlignment(unittest.TestCase):
    def assert_valid(self, schema_name: str, instance: dict) -> None:
        schema = json.loads((SCHEMAS_ROOT / f"{schema_name}.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(instance)

    def test_runtime_contracts_match_canonical_schemas(self) -> None:
        project = ProjectRecord("proj", "req", "corr", "name", "planning", "owner", utc_now())
        task = TaskEnvelope("task", "corr", "proj", "req", "delivery", "owner", "technical-lead", "do it", {})
        result = ResultEnvelope("task", "corr", "proj", "technical-lead", "COMPLETE", "done")
        approval = ApprovalRequest("deploy:production", "svc", "prod", "abc1234", "technical-lead", project_id="proj")

        self.assert_valid("project", project.to_dict())
        self.assert_valid("task-envelope", task.to_dict())
        self.assert_valid("result-envelope", result.to_dict())
        self.assert_valid("approval-request", approval.__dict__)

    def test_project_loader_accepts_legacy_flat_scope(self) -> None:
        legacy = {
            "project_id": "proj",
            "request_id": "req",
            "correlation_id": "corr",
            "name": "name",
            "status": "planning",
            "owner": "owner",
            "created_at": utc_now(),
            "scope_goals": ["goal"],
            "scope_non_goals": ["non-goal"],
            "acceptance_criteria": ["accepted"],
        }
        project = ProjectRecord.from_dict(legacy)
        self.assertEqual(project.scope_goals, ["goal"])
        self.assertIn("scope", project.to_dict())


if __name__ == "__main__":
    unittest.main()
