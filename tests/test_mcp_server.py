"""Integration tests for the MCP server adapter (requires the ``mcp`` extra)."""

from __future__ import annotations

import json
import os
import sys
import unittest

try:
    from mcp.server.fastmcp import FastMCP
    MCP_AVAILABLE = True
except ImportError:  # pragma: no cover
    FastMCP = None  # type: ignore[assignment]
    MCP_AVAILABLE = False

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
                self.assertEqual(json.loads(assigned.content[0].text)["agent_role"], "technical-lead")

                completed = await client.call_tool(
                    "complete_task",
                    {"project_id": project_id, "task_id": "task-x", "status": "COMPLETE", "summary": "done"},
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


if __name__ == "__main__":
    unittest.main()