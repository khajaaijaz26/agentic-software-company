# Open-Source Agentic Software Company

[![Apache 2.0 License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![Tests: 43 passing](https://img.shields.io/badge/tests-43%20passing-brightgreen.svg)](https://github.com/khajaaijaz26/agentic-software-company/actions)
[![CI: test+lint](https://img.shields.io/badge/CI-test%2Blint-brightgreen.svg)](https://github.com/khajaaijaz26/agentic-software-company/actions)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-orange.svg)](https://github.com/khajaaijaz26/agentic-software-company/pulls)
[![GitHub Issues](https://img.shields.io/github/issues/khajaaijaz26/agentic-software-company.svg)](https://github.com/khajaaijaz26/agentic-software-company/issues)
[![GitHub Stars](https://img.shields.io/github/stars/khajaaijaz26/agentic-software-company.svg?style=social)](https://github.com/khajaaijaz26/agentic-software-company/stargazers)

---

## 🏢 About

A governed, multi-agent software delivery platform. This repository is the **reference implementation** of the **Open-Source Agentic Software Company Master System Prompt** (v1.0, 17 August 2026): a blueprint for a coordinated team of specialist AI agents that plan, build, review, test, secure, deploy, and support software — under explicit human authority, policy control, and full audit.

Everything in this repo — the prompt library, JSON schemas, YAML workflows, policies, and a dependency-free Python reference implementation — is open source under the Apache-2.0 license.

---

## 🔥 Features

| Feature | Description |
|---------|-------------|
| **25 Specialist Role Prompts** | Extracted verbatim from the master doc: client-intake-account, sales-qualification, discovery-business-analyst, product-manager, project-manager, ux-researcher, ux-ui-designer, solution-architect, risk-compliance-advisor, finops-commercial, technical-lead, frontend-engineer, backend-engineer, data-database-engineer, integration-engineer, code-reviewer, qa-strategist, test-automation-engineer, security-engineer, performance-reliability, devops-platform, release-manager, sre-incident-manager, technical-writer, customer-support-success |
| **Five Governance Layers** | Base Agent Constitution, Project Policy, Production Policy, Data Handling Policy, and Approval Gating (G0–G4) |
| **Deterministic Policy Engine** | Maps operations to approval gates (G0=read-only, G1=reversible workspace, G2=shared/non-prod, G3=production/sensitive, G4=irreversible/high-impact); environment escalation (e.g. workspace edits in prod auto-upgrade to G3) |
| **Bound & Short-Lived Approvals** | Single-use approval tokens bound to actor, action, resource, environment, artifact sha, and project; silence is never consent |
| **Full Audit Trail** | Append-only event store with immutable domain events; every tool call, approval, and handoff is recorded |
| **Content-Addressed Artifacts** | SHA-256 content-addressed storage with path-traversal protection |
| **Dependency-Free Python** | Reference implementation using only the Python standard library (`unittest` tests only; no pip install required) |
| **Four YAML Workflows** | Delivery pipeline, change-control classification, production release gating, incident response |
| **JSON Schemas** | 6 canonical schemas: project, event, capability, task/result/approval envelopes (mirrors in `contracts.py`) |
| **Full Eval Suite** | 1 delivery scenario + structured rubrics under `evals/` |

---

## 🚀 Quick Start

### 1. Run the test suite (stdlib only)

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
# → 43 tests pass
```

### 2. Initialize a project

```bash
PYTHONPATH=src python -m agentic_company init-project "DemoApp" "carol" --goal "ship v1"
# Output: proj_a1effd13844a
```

### 3. Dispatch a specialist

```bash
PYTHONPATH=src python -m agentic_company dispatch technical-lead "design the architecture"
# Output: task_32d15eeb9d1d COMPLETE
```

### 4. Audit a project's event trail

```bash
PYTHONPATH=src python -m agentic_company audit proj_a1effd13844a
# → Prints one event line per dispatch/approval/handoff
```

### 5. Run the delivery scenario

```bash
PYTHONPATH=src python evals/scenarios/delivery_cli.py
# → SCENARIO PASSED
```

### 6. Run the full suite end-to-end

```bash
python -m pytest tests/  # if pytest is available, or
PYTHONPATH=src python -m unittest discover -s tests
```

---

## 📦 Integration with AI Coding Platforms

This platform is designed so any LLM‑based coding assistant can act as a **specialist agent** by consuming the prompt files under `prompts/roles/` and routing work through the **task envelope** / **result envelope** contract.

### OpenCode

```bash
# Set up OpenCode session
opencode_setup

# Reference the prompt library
export PROMPTS_ROOT=/path/to/agentic-software-company/prompts

# Use the dispatcher pattern: the orchestrator builds a TaskEnvelope,
# passes it to the LLM, the LLM returns a ResultEnvelope.
# See src/agentic_company/orchestrator.py for the exact contract.
```

### Claude Code / Claude Code Agent

1. Add the **Base Agent Constitution** (`prompts/base-agent-constitution.md`) as your system prompt.
2. Select a **role prompt** from `prompts/roles/` matching the agent's function.
3. Compose the agent's instructions: `constitution + role + project_policy + task_envelope`.
4. All tool calls should pass through your own `ToolGateway`-style authorization layer that mirrors the policy‑engine gate logic (G0–G4).
5. Record every hand‑off as a domain event for audit.

### GitHub Copilot / Copilot Workspace

- The `prompts/templates/` JSON envelopes define the contract for memory/artifact passing.
- Use the **policy engine** logic as a guardrail before any tool invocation.
- The `approval_service` contract (`request → resolve → verify`) maps naturally to Copilot's approval UI for production‑gate actions.

### Custom MCP Server

If you want to serve the prompt library (and schemas/workflows) via an MCP server so any agent can discover and version the library:

1. Add an MCP server config (see `.mcp.json` example below).
2. The server exposes three resources:
   - `GET /prompts/base-agent-constitution.md`
   - `GET /prompts/roles/<name>.md`
   - `GET /schemas/<name>.json`
3. Agents authenticate via your preferred method (API key, OAuth, etc.).
4. Example `.mcp.json`:

```json
{
  "servers": {
    "agentic-prompt-lib": {
      "command": "python",
      "args": ["-m", "agentic_company.mcp_adapter"],
      "env": {
        "PROMPTS_ROOT": "/path/to/agentic-software-company/prompts"
      }
    }
  }
}
```

### Manual Terminal (No CLI)

All functionality is callable from Python:

```python
from agentic_company.state_store import StateStore
from agentic_company.event_store import EventStore
from agentic_company.orchestrator import Orchestrator
from agentic_company.approval_service import ApprovalService
from agentic_agent_registry import AgentRegistry

state = StateStore(path=".agentic_company/state.json")
events = EventStore(path=".agentic_company/events.jsonl")
registry = AgentRegistry()
for role in ("client-intake-account", "technical-lead", ...):
    registry.register(AgentSpec(role=role, prompt_file=f"prompts/roles/{role}.md", prompt_sha=f"sha-{role}"))

policy = PolicyEngine()
approvals = ApprovalService()
orchestrator = Orchestrator(state=state, events=events, policy=policy, approvals=approvals, registry=registry, dispatcher=_my_dispatcher)

# Begin a project
project = orchestrator.begin_project(
    request="build a CLI tool",
    name="my-cli",
    owner="alice",
    scope_goals=["summarize a repo"],
    scope_non_goals=[],
    acceptance_criteria=["CLI exits 0"],
)

# Dispatch a task
result = orchestrator.dispatch(
    project=project,
    agent_role="technical-lead",
    kind="delivery",
    instructions="design the architecture",
)
```

---

## 🏗️ Architecture

```mermaid
flowchart TB
    subgraph "Prompt Library"
        P1[base-agent-constitution.md]
        P2[master-orchestrator.md]
        P3[roles/*.md]:::roles
        P4[policies/*.md]:::policies
        P5[templates/*.json]:::templates
    end

    subgraph "Python Reference"
        C1[contracts.py]:::py
        C2[orchestrator.py]:::py
        C3[policy_engine.py]:::py
        C4[approval_service.py]:::py
        C5[tool_gateway.py]:::py
        C6[agent_registry.py]:::py
        C7[state_store.py]:::py
        C8[event_store.py]:::py
        C9[artifact_store.py]:::py
        C10[workflow.py]:::py
        C11[__main__.py]:::py
    end

    subgraph "Governance"
        G1[LICENSE]:::license
        G2[CONTRIBUTING.md]:::md
        G3[GOVERNANCE.md]:::md
        G4[CODE_OF_CONDUCT.md]:::md
        G5[SECURITY.md]:::md
        G6[CHANGELOG.md]:::md
    end

    style Prompts fill:#e3f2fd,stroke:#1976d2,stroke-width:2px
    style Python fill:#e8f5e9,stroke:#388e3c,stroke-width:2px
    style Governance fill:#fff3e0,ff6f00,stroke-width:2px
    classDef roles fill:#e3f2fd,stroke:#1976d2,stroke-width:2px;
    classDef py fill:#e8f5e9,stroke:#388e3c,stroke-width:2px;
    classDef md fill:#fff3e0,ff6f00,stroke:#e65100,stroke-width:2px;
    classDef license fill:#e8f4f0,stroke:#00838f,stroke-width:2px;
```

---

## 📁 Repository Layout

```
├─ .github/
│  └─ workflows/
│     ├─ ci.yml            # CI: test, lint, JSON parse, prompt completeness
│     ├─ delivery.yaml     # Delivery pipeline workflow
│     ├─ change-control.yaml
│     ├─ release.yaml
│     └─ incident.yaml
├─ ATTRIBUTION.md         # Attribution of extracted prompts
├─ CHANGELOG.md          # Version history
├─ CODE_OF_CONDUCT.md
├─ CONTRIBUTING.md       # How to contribute
├─ docs/
│  ├─ architecture/
│  │   └─ architecture.md   # High-level architecture
│  ├─ adr/
│  │   └─ 0001-initial-architecture.md   # Architecture decision record
│  ├─ protocols/
│  │   └─ ...              # Protocol notes
│  ├─ runbooks/
│  │   └─ local-development.md   # Local dev runbook
│  ├─ security/
│  │   └─ ...              # Security posture
│  └─ contributing/
│      └─ ...              # Contribution guide
├─ evals/
│  └─ scenarios/
│     └─ delivery_cli.py   # End-to-end delivery scenario
├─ .gitignore
├─ LICENSE               # Apache-2.0
├─ pyproject.toml        # Build metadata (setuptools, package‑dir)
├─ prompts/
│  ├─ base-agent-constitution.md           # Mandatory foundation
│  ├─ master-orchestrator.md               # Orchestrator prompt (verbatim)
│  ├─ roles/                               # 25 specialist agent prompts
│  ├─ policies/                            # Project / Production / Data‑handling policies
│  └─ templates/                           # Task / Result / Approval envelope JSON schemas
├─ prompts/system/   # Pre‑seeded scaffold (duplicates canonical prompts;
│   ├─ base-agent-constitution.md
│   └─ master-orchestrator.md
│   └─ agents/   # 3 sample agent prompt markdown files
│  └─ schemas/
│     └─ task/                             # task-envelope-v1.json
├─ prompts/roles/      # ← canonical 25 role prompt markdown files
├─ prompts/policies/   # ← canonical 3 policy markdown files
├─ prompts/templates/  # ← canonical envelope JSON files
├─ README.md           # ← This file
├─ schemas/
│  ├─ project.schema.json
│  ├─ event.schema.json
│  ├─ capability.schema.json
│  ├─ task-envelope.schema.json
│  ├─ result-envelope.schema.json
│  └─ approval-request.schema.json
├─ scripts/            # Helper scripts (optional)
├─ src/
│  └─ agentic_company/
│     ├─ __init__.py
│     ├─ __main__.py      # CLI entry point
│     ├─ agent_registry.py
│     ├─ approval_service.py
│     ├─ artifact_store.py
│     ├─ contracts.py
│     ├─ event_store.py
│     ├─ orchestrator.py
│     ├─ policy_engine.py
│     ├─ state_store.py
│     ├─ tool_gateway.py
│     └─ workflow.py
├─ tests/
│  ├─ test_contracts.py
│  ├─ test_policy_approval.py
│  ├─ test_stores.py
│  ├─ test_orchestrator_gateway.py
│  └─ test_workflow_registry.py
└─ workflows/
   ├─ delivery.yaml
   ├─ change-control.yaml
   ├─ release.yaml
   └─ incident.yaml
```

---

## 🛠️ Development

| Goal | Command |
|------|---------|
| Run all tests | `PYTHONPATH=src python -m unittest discover -s tests -v` |
| Lint / compile check | `python -m compileall -q src tests` |
| Validate JSON schemas parse | `python -c "import glob, json; [json.load(open(p,encoding='utf-8')) for p in glob.glob('schemas/*.json')]; [json.load(open(p,encoding='utf-8')) for p in glob.glob('prompts/templates/*.json')]; print('JSON OK')"` |
| Verify prompt-library completeness | `python -c "import pathlib; r=list(pathlib.Path('prompts/roles').glob('*.md')); assert len(r)==25, len(r); assert pathlib.Path('prompts/master-orchestrator.md').exists(); print('prompts OK')"` |
| Run the delivery eval scenario | `PYTHONPATH=src python evals/scenarios/delivery_cli.py` |
| Initialize a project via CLI | `python -m agentic_company init-project "Name" "owner" --goal "goal"` |
| Dispatch a specialist | `python -m agentic_company dispatch <role> "<instructions>"` |
| Audit a project | `python -m agentic_company audit <project_id>` |

---

## 📄 License

[Apache-2.0](https://opensource.org/licenses/Apache-2.0) — See [LICENSE](LICENSE).

---

## 👐 Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before opening an issue or pull request.

We work in small reversible steps, add or update tests, and never commit secrets.