"""Tests for the workflow engine and agent registry."""

import unittest

from agentic_company.agent_registry import AgentRegistry, AgentSpec
from agentic_company.contracts import Budget, WorkItem
from agentic_company.workflow import Workflow, WorkflowError


def _ok(item: WorkItem) -> str:
    return f"ran:{item.item_id}"


def _boom(item: WorkItem) -> str:
    raise RuntimeError("boom")


class TestWorkflow(unittest.TestCase):
    def test_runs_in_dependency_order(self) -> None:
        wf = Workflow()
        items = [
            WorkItem(item_id="a", project_id="p", title="a", owner="x"),
            WorkItem(item_id="b", project_id="p", title="b", owner="x", depends_on=("a",)),
        ]
        stats = wf.run(items, _ok)
        self.assertEqual(stats.completed, 2)
        self.assertEqual(stats.failed, 0)
        # a must have run before b
        self.assertEqual(wf._results["a"], "ran:a")

    def test_failed_dependency_blocks_dependents(self) -> None:
        wf = Workflow()
        items = [
            WorkItem(item_id="a", project_id="p", title="a", owner="x"),
            WorkItem(item_id="b", project_id="p", title="b", owner="x", depends_on=("a",)),
        ]

        def executor(item):
            if item.item_id == "a":
                raise RuntimeError("boom")
            return "ok"

        stats = wf.run(items, executor)
        self.assertEqual(stats.failed, 1)
        self.assertEqual(stats.blocked, 1)
        self.assertEqual(stats.completed, 0)

    def test_dependency_cycle_detected(self) -> None:
        wf = Workflow()
        items = [
            WorkItem(item_id="a", project_id="p", title="a", owner="x", depends_on=("b",)),
            WorkItem(item_id="b", project_id="p", title="b", owner="x", depends_on=("a",)),
        ]
        with self.assertRaises(WorkflowError):
            wf.run(items, _ok)

    def test_missing_dependency_fails_dependents(self) -> None:
        wf = Workflow()
        items = [WorkItem(item_id="b", project_id="p", title="b", owner="x", depends_on=("ghost",))]
        with self.assertRaises(WorkflowError):
            wf.run(items, _ok)

    def test_budget_time_exhaustion(self) -> None:
        wf = Workflow(budget=Budget(max_time_seconds=1))
        items = [
            WorkItem(item_id=f"i{i}", project_id="p", title=str(i), owner="x") for i in range(5)
        ]

        class CountingExecutor:
            def __init__(self) -> None:
                self.calls = 0

            def __call__(self, item):
                self.calls += 1
                if self.calls > 1:
                    raise WorkflowError("workflow exceeded time budget")
                return "ok"

        with self.assertRaises(WorkflowError):
            wf.run(items, CountingExecutor())


class TestAgentRegistry(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = AgentRegistry()

    def test_register_and_query(self) -> None:
        spec = AgentSpec(role="qa", prompt_file="roles/qa.md", prompt_sha="sha")
        self.registry.register(spec)
        self.assertEqual(self.registry.get("qa"), spec)
        self.assertIn("qa", self.registry.roles())
        self.assertEqual(self.registry.capabilities("qa"), ())

    def test_activate_unknown_role_raises(self) -> None:
        with self.assertRaises(KeyError):
            self.registry.activate("ghost")

    def test_activation_tracking(self) -> None:
        self.registry.register(AgentSpec(role="tl", prompt_file="roles/tl.md", prompt_sha="sha"))
        actor = self.registry.activate("tl")
        self.assertEqual(actor.id, "tl")
        self.assertIn("tl", self.registry.active())
        self.registry.deactivate("tl")
        self.assertNotIn("tl", self.registry.active())


if __name__ == "__main__":
    unittest.main()