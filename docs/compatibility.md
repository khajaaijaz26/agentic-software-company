# Compatibility and migration

## Runtime matrix

| Concern | TypeScript terminal preview | Python/MCP compatibility |
| --- | --- | --- |
| Distribution | `@agent-company/cli` 0.2.x | `agentic-company` 1.x |
| Runtime | Node.js 22.13+ | Python 3.10+ |
| Local state directory | `.agent-company/` | `.agentic_company/` |
| State format | SQLite + WAL, content-addressed files | JSON state + JSONL events + files |
| Primary CLI | `agent-company` from npm build | `python -m agentic_company` / Python console script |
| Agent execution | deterministic v0.2 vertical slice | host/deferred dispatcher compatibility flow |
| Integration | provider CLI probes and normalized plans | MCP tools/resources/prompts |
| Schema directory | `schemas/vnext/` | root `schemas/` and Python dataclasses |
| Shared durable runs | No | No |

The two packages currently install an executable with the same human-facing
name. In a development environment containing both, invoke the Python runtime
as `python -m agentic_company` and the TypeScript runtime through `npm run dev`
or a deliberately selected npm link to avoid PATH ambiguity.

## What is preserved

- The 25 specialist role prompts, orchestrator, constitution, and policy files.
- Python project/task/result/approval contracts and root schemas.
- Python CLI workflows, append-only JSONL events, and artifact behavior.
- MCP tools, resources, prompts, and stdio/SSE/streamable-HTTP entry points.
- Existing project ownership, Apache-2.0 license, and attribution.

Preservation does not mean vNext uses those files as its internal source of
truth. vNext has uppercase run/task/approval states, canonical operation hashes,
SQLite command receipts, A0-A5 classes, and separate schemas.

## No automatic state migration in v0.2

Do not rename `.agentic_company` to `.agent-company`, import JSONL directly into
SQLite, or copy an approval token between runtimes. Identifiers can collide in
meaning even when their strings differ, and approval bindings are not
interchangeable.

For an existing Python project:

1. Stop Python CLI/MCP processes.
2. Back up `.agentic_company/`, prompts/policies used, package version, and
   source commit.
3. Initialize a new vNext mapping with `agent-company init`.
4. Re-enter the current objective and constraints as a new vNext run.
5. Review and approve the newly generated vNext plan. Old approvals do not
   transfer.
6. Keep the Python backup read-only for audit continuity.
7. Record a human-authored migration note linking old project/correlation IDs
   to the new mapping/run IDs.

This is a parallel cutover, not a lossless migration. Historical Python events
remain authoritative for work performed by Python; new SQLite events are
authoritative only for vNext work.

## Contract compatibility policy

- Within schema v1, producers may add new output/event `type` values.
- Schemas with `additionalProperties: false` require a new schema version to
  add top-level fields unless the field was explicitly reserved.
- Enum removals/renames, digest representation changes, altered canonicalization,
  and exit-code reuse are breaking changes.
- Root schemas may not be silently redirected to vNext `$id` values.
- A future importer must validate source version, preserve raw bytes, produce a
  deterministic report, and never create `APPROVED`/`CONSUMED` vNext approvals
  from legacy records.

## Backup compatibility

SQLite backups must include a consistent database snapshot and the artifact
tree. A database without artifacts can replay metadata but cannot prove artifact
bytes. Artifacts without the database lose logical provenance. Python backups
must keep `state.json`, `events.jsonl`, and its artifact content together.

See [Backup and recovery](runbooks/backup-and-recovery.md).
