# Changelog

All notable changes to this project are documented here. The project follows
[semantic versioning](https://semver.org).

## [Unreleased]

### Added
- Prompt library: `prompts/base-agent-constitution.md`, `prompts/master-orchestrator.md` (verbatim extract), 25 role prompts under `prompts/roles/`, and policies under `prompts/policies/`.
- Envelope templates under `prompts/templates/` (task, result, approval).
- JSON schemas under `schemas/` (project, event, capability, task/result/approval envelopes).
- Dependency-free Python reference implementation under `src/agentic_company/`:
  - `contracts.py` — envelopes, approvals, budgets, events
  - `orchestrator.py` — task routing and audit
  - `policy_engine.py` — deterministic G0–G4 gate decisions
  - `approval_service.py` — bound, short-lived approval tokens
  - `tool_gateway.py` — authorized, audited, redacted tool boundary
  - `agent_registry.py` — role → capability → prompt-version mapping
  - `state_store.py`, `event_store.py`, `artifact_store.py` — durable stores
  - `workflow.py` — dependency-aware WorkItem execution
  - `__main__.py` — CLI entry point
- `tests/` — 43 unittest tests (stdlib only).
- Governance: `LICENSE` (Apache-2.0), `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`.
- CI workflow under `.github/workflows/ci.yml`.

## [1.0.0] — 2026-08-17

Initial release.