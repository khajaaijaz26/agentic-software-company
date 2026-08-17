# ADR-0001: Initial architecture for the reference implementation

- Status: Approved (2026-08-17)
- Decision owner: Maintainers
- Revisit trigger: adoption of a real LLM adapter or a durable backend

## Context

The master system prompt describes a multi-agent software company with 25
specialist agents, an orchestrator, policies, approvals, and full audit. We
needed a concrete, verifiable implementation that a newcomer can read and run
without external dependencies.

## Decision

1. Implement the platform controls as a small Python package using only the
   standard library (contracts, orchestrator, policy engine, approval service,
   tool gateway, agent registry, and file-backed stores).
2. Persist prompts as versioned markdown/JSON under `prompts/`, with the role
   prompts extracted verbatim from the master document.
3. Define canonical JSON schemas under `schemas/` and mirror them as dataclasses
   in `contracts.py`.
4. Use `unittest` (stdlib) for tests so CI needs no package installation.
5. Expose an interactive CLI through `python -m agentic_company`.
6. Provide a stub dispatcher; a real LLM adapter can replace it without changing
   the orchestration contracts.

## Options considered

- **TypeScript/turbo monorepo scaffold**: rejected as premature — the skeleton
  referenced workspaces and tooling that did not exist, and it duplicated the
  prompt library in an inconsistent layout.
- **Full framework (FastAPI + DB)**: rejected for the reference implementation —
  adds operational burden with no added clarity for the core controls.

## Consequences

- Zero-dependency, auditable core that runs on Python 3.10+.
- 43 unit tests pass deterministically; CI validates tests, compilation, JSON
  parsing, and prompt-library completeness.
- Real agent execution requires an external adapter, which is an explicit
  extension point.