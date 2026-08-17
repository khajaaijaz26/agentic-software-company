# Open-Source Agentic Software Company

A governed, multi-agent software delivery platform. This repository is the
reference implementation of the **Open-Source Agentic Software Company Master
System Prompt** (v1.0, 17 August 2026): a blueprint for a coordinated team of
specialist AI agents that plan, build, review, test, secure, deploy, and
support software — under explicit human authority, policy control, and full
audit.

Everything in this repo — the prompt library, schemas, workflows, policies,
and a dependency-free Python reference implementation — is open source under
the Apache-2.0 license.

## Why this exists

LLM agents are powerful but dangerous when given unchecked authority. This
platform encodes the operating discipline of a *well-run software company* into
a reusable, auditable system:

- **Evidence before claims** — nothing is reported as "done" without recorded proof.
- **Least privilege** — every agent gets only the tools, data, and budget its task requires.
- **Human authority at material gates** — approvals are scoped, bound, and short-lived; silence is never consent.
- **One source of truth** — requirements, decisions, code, and evidence live in canonical, versioned artifacts.
- **Full audit trail** — every dispatch, tool call, approval, and handoff is an immutable domain event.

## Repository layout

```
prompts/                      Prompt library (the "operating system" of the company)
  base-agent-constitution.md  Mandatory foundation for every agent
  master-orchestrator.md      The orchestrator prompt (verbatim from the master doc)
  roles/                      25 specialist agent prompts
  policies/                   Project, production, and data-handling policies
  templates/                  Task, result, and approval envelope templates
schemas/                      JSON schemas for projects, events, approvals, capabilities
workflows/                    Delivery, change, release, and incident workflows
src/agentic_company/          Dependency-free Python reference implementation
tests/                        unittest test suite (stdlib only)
evals/                        Evaluation scenarios and rubrics
docs/                         Architecture, protocols, ADRs, runbooks, security
examples/                     Worked usage examples
```

## Quick start

Requires Python 3.10+. No third-party dependencies.

```bash
# Run the test suite
PYTHONPATH=src python -m unittest discover -s tests -v

# Or via the CLI
PYTHONPATH=src python -m agentic_company init-project "MyApp" "carol" --goal "ship v1"
PYTHONPATH=src python -m agentic_company dispatch technical-lead "design the architecture"
PYTHONPATH=src python -m agentic_company audit <project_id>
```

The CLI persists state under `.agentic_company/` in the current directory and
uses a stubbed dispatcher. Swap `_stub_dispatcher` in `__main__.py` for a real
LLM adapter to run actual agents.

## Reference implementation

The `src/agentic_company` package is a small, auditable reference
implementation of the platform's core controls:

| Module | Responsibility |
|--------|----------------|
| `contracts.py` | Task/result envelopes, approvals, events, budgets (mirrors the JSON schemas) |
| `orchestrator.py` | Routes task envelopes to specialists; records every handoff as an event |
| `policy_engine.py` | Deterministic gate decisions (G0–G4) per operation and environment |
| `approval_service.py` | Bound, short-lived, single-use approval tokens |
| `tool_gateway.py` | Authorized, audited, redacted tool-call boundary |
| `agent_registry.py` | Declarative role → capability → prompt-version mapping |
| `state_store.py` | Canonical project/state records |
| `event_store.py` | Append-only audit trail |
| `artifact_store.py` | Content-addressed artifact storage with path-traversal protection |
| `workflow.py` | Dependency-aware WorkItem execution with budget limits |

## Governance

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute
- [GOVERNANCE.md](GOVERNANCE.md) — decision-making, roles, and maintainer process
- [SECURITY.md](SECURITY.md) — vulnerability reporting and security posture
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards
- [CHANGELOG.md](CHANGELOG.md) — version history

## License

Apache-2.0. See [LICENSE](LICENSE).

## Attribution

The role prompts under `prompts/roles/` and `prompts/master-orchestrator.md`
are extracted verbatim from the *Open-Source Agentic Software Company Master
System Prompt* v1.0 (17 August 2026). See `ATTRIBUTION.md`.