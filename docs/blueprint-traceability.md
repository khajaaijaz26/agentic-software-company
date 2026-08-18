# Terminal Platform Blueprint v0.2 traceability

## Reading this matrix

The source blueprint is intentionally broader than this release. Status values:

- **Implemented**: exercised by current source/tests as a working v0.2 path.
- **Partial**: meaningful controls exist, but mandatory stable-scope behavior is
  missing.
- **Specified**: public contract/docs/schema exist; runtime wiring is pending.
- **Not implemented**: no working v0.2 capability should be inferred.
- **Compatibility**: available only through the preserved Python/MCP runtime.

This matrix is a release truth record, not a promise that a heading implies
completion.

## Core platform

| Blueprint capability | Status | Evidence and limitation |
| --- | --- | --- |
| Strict TypeScript npm CLI | Implemented | `package.json`, `apps/cli`, TypeScript checks |
| Human/plain/JSON/NDJSON output | Implemented | `apps/cli/src/output.ts`; NDJSON shares envelope path and is not yet live streaming |
| Stable machine exit codes | Implemented | `EXIT_CODES`, [CLI ABI](protocols/cli-abi.md) |
| Project initialization/config paths | Implemented | `packages/config`; project TOML and policy TOML |
| TUI project room | Partial | Ink snapshot dashboard exists; no live subscriptions or full navigation |
| Local controller | Implemented | `apps/control-plane`, reached through the CLI IPC facade |
| Authenticated single-writer IPC service | Implemented local slice | Startup lock, framed Unix socket/Windows pipe, HMAC nonce proof, heartbeat descriptor, one-shot CLI service and standalone entry; no service-manager install or Windows ACL verification |
| SQLite WAL event source | Implemented | `packages/event-store-sqlite`; command receipts and stream versions |
| Complete event upcasting/schema registry | Not implemented | Envelope schema exists; event-type payload/upcaster registry pending |
| Run/task state machines | Partial | Canonical transitions and replay checks exist; general recovery/revision workflow remains incomplete |
| DAG planning and readiness | Implemented for slice | `packages/domain/dag.ts`; fixed five-task slice, not general planner |
| Durable scheduler/worker leasing | Partial | Controller records attempt/lease manifests and supervises a bound child process; no persistent lease heartbeat, retry scheduler, restart adoption, or full orphan recovery |
| Pause/cancel/recovery/reconciliation | Partial | state vocabulary and basic pause/cancel; full crash recovery absent |

## Governance and safety

| Blueprint capability | Status | Evidence and limitation |
| --- | --- | --- |
| A0-A5 classification | Implemented | policy engine and connector action classifier |
| Exact expiring approvals | Implemented | SQLite approval service |
| Atomic single-use consumption | Implemented | conditional SQLite transition in transaction |
| Human-only decisions | Implemented | approval service rejects non-human approvers |
| Unknown action deny-by-default | Implemented | policy engine |
| Production/destructive hard denials | Implemented for named cases | protected force-push, production Supabase reset/seed/secret copy |
| Tool schema validation/guards/audit | Implemented as gateway | current remote plan commands are not execution-wired through it |
| Budgets and atomic reservations | Implemented | micro-dollar SQLite budget ledger |
| Full pricing catalog/unpriced governance | Partial | deterministic usage/cost path; catalog and delayed provider reconciliation absent |
| Secret references and leases | Partial | environment reference backend; OS keychain/rotation/non-exportable sessions pending |
| Cryptographic audit signing/export | Not implemented | local append discipline only |

## Inputs, artifacts, models, and agents

| Blueprint capability | Status | Evidence and limitation |
| --- | --- | --- |
| SHA-256 content-addressed artifacts | Implemented | `packages/artifact-store` verifies reads |
| Attachment allowed-root/limit scans | Implemented | file/folder/stdin byte ingestion and receipts |
| Malware/secret/PII/injection checks | Partial | deterministic patterns, not comprehensive AV/DLP/sandbox |
| Attachment transfer consent | Implemented safe default | receipt fixes `transfer_count` to zero; no transfer executor |
| 25 specialist roles | Implemented catalog | lazy activation based on objective keywords |
| Multi-provider model gateway | Partial | deterministic and OpenAI-compatible interfaces; controller uses deterministic only |
| Prompt pinning/context provenance | Partial | prompt pack retained; complete vNext context manifest not implemented |
| Independent review/evidence | Implemented for slice | review and verification tasks, deterministic evidence text |
| General autonomous delivery | Not implemented | fixed offline vertical slice only |

## Connected platforms

| Blueprint capability | Status | Evidence and limitation |
| --- | --- | --- |
| GitHub auth/account/inventory | Implemented read-only | official `gh` CLI adapter |
| Vercel auth/project inventory | Implemented read-only | official `vercel` CLI adapter |
| Supabase auth/project inventory | Implemented read-only | official `supabase` CLI adapter |
| Normalized connector action | Implemented | `agent-company.connector-action/v1` |
| Approval-backed remote mutation | Not implemented | CLI emits plans and approval-required exit only |
| Deployment/database postcondition verification | Not implemented | no remote executor/reconciler |
| Provider webhook/event ingestion | Not implemented | polling inventory only |

## Compatibility, operations, and distribution

| Blueprint capability | Status | Evidence and limitation |
| --- | --- | --- |
| Python prompt/MCP compatibility | Compatibility | existing Python package and MCP server retained |
| Cross-runtime migration | Not implemented | documented parallel cutover only |
| Backup/recovery guidance | Implemented documentation | no automated backup command |
| Threat model/security policy | Implemented documentation | must evolve before remote execution |
| Draft 2020-12 vNext schemas | Implemented | `schemas/vnext/`, including the active controller descriptor and RPC envelopes |
| Plugin SDK/marketplace | Not implemented | plugin API version label is reserved, not a working ecosystem |
| Auto-update/rollback/installers | Not implemented | npm source build/development install only |
| Telemetry/analytics | Safe default | telemetry reported off; no telemetry subsystem |

## Roadmap order

1. Add durable worker lease heartbeats/extensions, bounded retries, restart
   adoption, OS sandboxing, and crash/orphan reconciliation.
2. Harden controller service lifecycle with background/service-manager support,
   Windows ACL verification, OS peer credentials where available, and live
   event subscriptions.
3. Route every external execution through policy, budgets, exact approval consumption,
   tool validation, and append-before/after audit.
4. Implement one connector mutation end to end with provider idempotency and
   read-only postcondition reconciliation, starting outside production.
5. Add schema/upcaster registry, context manifests, OS credential backends,
   signed export/import, and automated backup/migration.
6. Expand TUI interaction, compatibility/evaluation suites, packaging, and
   operational hardening before any stable claim.
