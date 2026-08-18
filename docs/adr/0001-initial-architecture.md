# ADR-0001: Initial Python reference architecture

- Status: Superseded for the primary CLI by ADR-0002; retained for the Python compatibility runtime
- Decision owner: Maintainers
- Revisit trigger: adoption of a real LLM adapter or a durable backend

## Context

The master system prompt describes a multi-agent software company with 25
specialist agents, an orchestrator, policies, approvals, and full audit. The
project needed a concrete implementation a newcomer could read and run without
external runtime dependencies.

## Decision

1. Implement the original controls as a small Python package using only the
   standard library for its core.
2. Persist prompts as versioned Markdown/JSON under `prompts/`.
3. Define root JSON schemas and mirror them as Python dataclasses.
4. Use `unittest` for the compatibility test suite.
5. Expose a CLI through `python -m agentic_company`.
6. Keep model execution as a replaceable dispatcher boundary.

## Options considered

- TypeScript/turbo monorepo scaffold: deferred as premature for the initial
  reference release.
- Full framework with an application server and database: deferred because it
  obscured the small reference core.

## Consequences

- The Python core is small and auditable on Python 3.10+.
- Real model execution requires an external adapter.
- ADR-0002 introduces a TypeScript terminal-platform preview while preserving
  this implementation as an explicitly separate compatibility surface.
