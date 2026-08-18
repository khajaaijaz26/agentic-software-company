"""Cross-file checks for packaged runtime resources and workflow roles."""

from __future__ import annotations

import re
import unittest

from agentic_company.resources import PROMPTS_ROOT, SCHEMAS_ROOT, WORKFLOWS_ROOT


class TestRuntimeResources(unittest.TestCase):
    def test_resource_directories_are_complete(self) -> None:
        self.assertEqual(len(list((PROMPTS_ROOT / "roles").glob("*.md"))), 25)
        self.assertEqual(len(list(SCHEMAS_ROOT.glob("*.schema.json"))), 6)
        self.assertEqual(len(list(WORKFLOWS_ROOT.glob("*.yaml"))), 4)

    def test_every_workflow_agent_has_a_canonical_prompt(self) -> None:
        roles = {path.stem for path in (PROMPTS_ROOT / "roles").glob("*.md")}
        roles.add("orchestrator")
        referenced: set[str] = set()
        for path in WORKFLOWS_ROOT.glob("*.yaml"):
            for match in re.finditer(r"^\s*agent:\s*([^\s#]+)", path.read_text(encoding="utf-8"), re.MULTILINE):
                referenced.add(match.group(1))
        self.assertTrue(referenced)
        self.assertEqual(referenced - roles, set())


if __name__ == "__main__":
    unittest.main()
