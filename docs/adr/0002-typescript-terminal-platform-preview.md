# ADR-0002: TypeScript terminal-platform preview

- Status: Accepted for v0.2 (2026-08-18)
- Decision owner: khajaaijaz26
- Supersedes: ADR-0001 only for the primary terminal CLI
- Revisit trigger: durable scheduler/recovery implementation or v1.0 stability review

## Context

The Terminal Platform Blueprint v0.2 describes a durable, local-first operator
experience with strict machine contracts, SQLite event sourcing, approvals,
budgets, workers, attachments, and connected-platform governance. The compact
Python reference runtime demonstrates governance principles but does not supply
that complete terminal architecture.

## Decision

Build the new primary CLI in strict TypeScript for Node.js 22.13+, with:

1. a versioned Commander CLI and Ink operator console;
2. SQLite WAL as the durable vNext event, approval, and budget store;
3. canonical JSON/SHA-256 operation bindings;
4. A0-A5 policy classification and exact single-use approvals;
5. provider-owned GitHub, Vercel, and Supabase CLI sessions;
6. scanned local attachments and content-addressed artifacts;
7. authenticated, bounded local controller IPC with one-shot and standalone
   service lifecycles;
8. leased attempt manifests executed in bound child worker processes; and
9. separate vNext Draft 2020-12 schemas.

Preserve the Python package and MCP server as a compatibility runtime. Do not
claim cross-runtime state compatibility.

## Alternatives

- Extend only the Python runtime: rejected for the primary CLI because the
  blueprint and selected TUI ecosystem target Node/TypeScript.
- Replace Python immediately: rejected because it would break current MCP and
  prompt-pack consumers without a migration path.
- Implement every blueprint subsystem before a runnable slice: rejected because
  an auditable vertical slice gives earlier integration evidence and keeps
  unfinished remote effects disabled.

## Consequences

- The repository temporarily has two distribution versions and state formats.
- Node.js 22.13+ is mandatory for built-in SQLite.
- v0.2 offers authenticated IPC and an optional standalone controller entry;
  ordinary commands start a one-shot service instead of detaching a daemon.
- Worker attempt leases and process separation exist, while heartbeat,
  automatic retry, OS sandboxing, restart adoption, and reconciliation remain
  incomplete.
- Remote mutations remain plans until approval-backed executors and provider
  reconciliation exist.
- Compatibility and traceability documentation are release requirements.
