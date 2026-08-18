"""Integration tests for the MCP server adapter (requires the ``mcp`` extra)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_STATE_TEMP = tempfile.TemporaryDirectory(prefix="agentic-company-mcp-tests-")
_PREVIOUS_STATE_DIR = os.environ.get("AGENTIC_COMPANY_STATE_DIR")
os.environ["AGENTIC_COMPANY_STATE_DIR"] = str(Path(_STATE_TEMP.name) / "state")
MCP_IMPORT_ERROR = None

try:
    from mcp.server.fastmcp import FastMCP
    MCP_AVAILABLE = True
except ImportError as exc:  # pragma: no cover
    FastMCP = None  # type: ignore[assignment]
    MCP_AVAILABLE = False
    MCP_IMPORT_ERROR = exc

if not MCP_AVAILABLE and os.environ.get("AGENTIC_REQUIRE_MCP") == "1":  # pragma: no cover
    raise RuntimeError("MCP tests are required but the supported MCP SDK could not be imported") from MCP_IMPORT_ERROR

if MCP_AVAILABLE and sys.version_info >= (3, 10):
    from contextlib import asynccontextmanager

    from mcp.shared.memory import create_connected_server_and_client_session

    from agentic_company import mcp_server

    @asynccontextmanager
    async def _session():
        async with create_connected_server_and_client_session(mcp_server.mcp) as client:
            yield client

    def _run(coro):
        import asyncio

        return asyncio.run(coro)


@unittest.skipUnless(MCP_AVAILABLE, "mcp extra not installed (pip install 'agentic-company[mcp]')")
class McpServerTest(unittest.TestCase):
    def test_lists_tools(self):
        async def scenario():
            async with _session() as client:
                tools = await client.list_tools()
                return {t.name for t in tools.tools}

        names = _run(scenario())
        self.assertIn("begin_project", names)
        self.assertIn("assign_task", names)
        self.assertIn("complete_task", names)
        self.assertIn("request_approval", names)
        self.assertIn("resolve_approval", names)
        self.assertIn("audit", names)
        self.assertIn("list_roles", names)
        self.assertIn("list_workflows", names)

    def test_lists_resources_and_templates(self):
        async def scenario():
            async with _session() as client:
                templates = await client.list_resource_templates()
                return [t.uriTemplate for t in templates.resourceTemplates]

        templates = _run(scenario())
        self.assertIn("prompts://roles/{role}", templates)
        self.assertIn("schemas://{schema}", templates)
        self.assertIn("workflows://{workflow}", templates)
        self.assertIn("prompts://policies/{policy}", templates)

    def test_reads_template_resource(self):
        async def scenario():
            async with _session() as client:
                res = await client.read_resource("prompts://roles/technical-lead")
                return res.contents[0].text

        text = _run(scenario())
        self.assertTrue(text.strip())
        self.assertGreater(len(text), 100)

    def test_end_to_end_governed_flow(self):
        async def scenario():
            async with _session() as client:
                project = await client.call_tool(
                    "begin_project", {"name": "mcp-e2e", "owner": "tester", "goal": "deliver"}
                )
                project_id = json.loads(project.content[0].text)["project_id"]

                assigned = await client.call_tool(
                    "assign_task",
                    {
                        "project_id": project_id,
                        "role": "technical-lead",
                        "instructions": "plan the delivery",
                    },
                )
                assigned_record = json.loads(assigned.content[0].text)
                self.assertEqual(assigned_record["agent_role"], "technical-lead")
                task_id = assigned_record["task_id"]

                completed = await client.call_tool(
                    "complete_task",
                    {"project_id": project_id, "task_id": task_id, "status": "COMPLETE", "summary": "done"},
                )
                self.assertTrue(json.loads(completed.content[0].text)["recorded"])

                audit = await client.call_tool("audit", {"project_id": project_id})
                events = json.loads(audit.content[0].text)["events"]
                types = {e["event_type"] for e in events}
                self.assertIn("project.created", types)
                self.assertIn("task.dispatch", types)
                self.assertIn("task.complete", types)
                return True

        self.assertTrue(_run(scenario()))

    def test_task_ids_are_unique_and_completion_is_validated(self):
        project = mcp_server.begin_project(name="mcp-task-validation", owner="tester", goal="deliver")
        first = mcp_server.assign_task(project["project_id"], "technical-lead", "first")
        second = mcp_server.assign_task(project["project_id"], "technical-lead", "second")
        self.assertNotEqual(first["task_id"], second["task_id"])

        with self.assertRaises(ValueError):
            mcp_server.complete_task(project["project_id"], "unknown", "COMPLETE", "done")
        with self.assertRaises(ValueError):
            mcp_server.complete_task(project["project_id"], first["task_id"], "PENDING", "done")

        recorded = mcp_server.complete_task(project["project_id"], first["task_id"], "COMPLETE", "done")
        self.assertTrue(recorded["recorded"])
        with self.assertRaises(ValueError):
            mcp_server.complete_task(project["project_id"], first["task_id"], "COMPLETE", "again")

    def test_approval_round_trip(self):
        async def scenario():
            async with _session() as client:
                project = await client.call_tool(
                    "begin_project", {"name": "mcp-approval", "owner": "tester", "goal": "release"}
                )
                project_id = json.loads(project.content[0].text)["project_id"]
                req = await client.call_tool(
                    "request_approval",
                    {
                        "project_id": project_id,
                        "action": "deploy",
                        "resource": "app",
                        "environment": "staging",
                        "artifact_sha": "abc1234",
                        "gate": "G3",
                    },
                )
                request_id = json.loads(req.content[0].text)["request_id"]
                resolved = await client.call_tool(
                    "resolve_approval",
                    {"project_id": project_id, "request_id": request_id, "approver": "bob", "granted": True},
                )
                self.assertEqual(json.loads(resolved.content[0].text)["decision"], "approved")
                return True

        self.assertTrue(_run(scenario()))


def tearDownModule():
    if _PREVIOUS_STATE_DIR is None:
        os.environ.pop("AGENTIC_COMPANY_STATE_DIR", None)
    else:
        os.environ["AGENTIC_COMPANY_STATE_DIR"] = _PREVIOUS_STATE_DIR
    _STATE_TEMP.cleanup()


if __name__ == "__main__":
    unittest.main()
