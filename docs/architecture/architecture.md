# Terminal platform architecture

## Status and scope

This document describes the implemented `@agent-company/cli` v0.2 vertical
slice and the separate Python/MCP compatibility runtime. v0.2 now has an active
authenticated local IPC boundary and child-process worker supervision. It
remains a preview: scheduling, recovery, connector execution, and operator UI
do not yet meet the blueprint's full stable scope.

## Component map

```text
                         HUMAN / AUTOMATION
                                |
                    +-----------+-----------+
                    | CLI / plain / JSON    |
                    | operator console      |
                    +-----------+-----------+
                                |
                  authenticated framed IPC
                  Unix socket / Windows pipe
                                v
                    +-----------------------+
                    | controller service    |
                    | one-shot or standalone|
                    +---+------+------+----+
                        |      |      |
          +-------------+      |      +----------------+
          v                    v                       v
  SQLite event store     approval + budget      worker supervisor
  WAL, receipts          SQLite tables          child Node process
          |                    |                       |
          v                    v                       v
  snapshot projection     policy/tool gate       leased manifest
          |                    |                  bound result
          +--------------------+-----------------------+
                               v
                      normalized connector plans
                         /        |        \
                     GitHub     Vercel   Supabase
                    provider-owned CLI authentication

  Attachments --> scan receipt --> content-addressed artifact store
```

## CLI and operator console

`apps/cli` owns command parsing, global selection flags, output envelopes, exit
codes, and the controller client facade. For every controller-backed command it
attempts an IPC connection. When none is usable, it starts an in-process
one-shot IPC server, connects to that server, executes the RPC, then closes both
client and server. If the standalone controller is already alive, the CLI uses
it and leaves it running.

Even the one-shot path crosses the framed authenticated socket/pipe boundary;
the CLI no longer opens `LocalController` or its SQLite database directly.
Attachments, artifacts, Git inspection, and provider probes are separate local
CLI paths.

`apps/operator-console` renders a controller snapshot with Ink for a TTY or as
stable plain text for narrow/non-interactive terminals. It does not yet
subscribe to live events or expose the blueprint's full project-room controls.
Machine output is documented in [CLI ABI](../protocols/cli-abi.md).

## Controller service and IPC

`apps/controller-daemon` constructs `LocalController` plus
`ControllerIpcServer`. It can run inside the CLI for one command or as the
standalone `dist/controller.js` process until signaled.

The server discovers a workspace-specific runtime directory, writes a
heartbeat descriptor and separate nonce file, listens on a Unix domain socket
or Windows named pipe, and never falls back to TCP. Frames have a four-byte
big-endian JSON payload length with a 1 MiB default limit.

Before RPC, the client proves possession of a random 32-byte nonce with
HMAC-SHA-256 over request/protocol/instance/user-binding fields. The server
negotiates protocol v1 and correlates concurrent requests with `rpc_...` IDs.
Descriptors and nonce files are owner-private and ownership-checked on POSIX.
Windows relies on ordinary account ACLs in v0.2 and does not perform an
independent ACL/peer-credential check.

The exposed methods are `snapshot`, `createRun`, `listApprovals`, `approve`,
`deny`, `resume`, `pause`, and `cancel`. Method-specific parameter validation
rejects missing, extra, blank, and oversized inputs. RPC authentication only
grants access to this local service; domain approval and policy remain separate.

See [Local IPC](../protocols/local-ipc.md) and the controller descriptor/request/
response schemas for the exact wire contract.

## Controller and durable state

`apps/control-plane` coordinates the current vertical slice:

1. Load `.agent-company/project.toml`.
2. Open `.agent-company/state.sqlite` in the controller service.
3. Create a run and deterministic task DAG.
4. Record why/scopes/model class/cost estimate for lazily activated specialists.
5. Persist run, task, agent, approval, and state-change events.
6. Wait for an exact plan approval.
7. Issue and verify an HMAC-protected short-lived approval authorization, then
   atomically consume the underlying approval.
8. Claim each task with an attempt/lease manifest and execute it in a child
   worker process in DAG order.
9. Verify the bound result, persist evidence, and reach `SUCCEEDED`.

The event store is the replay source for run projections. Approval and budget
tables share the same SQLite database, with dedicated invariants. SQLite uses
foreign keys, a busy timeout, WAL journaling, and full synchronous writes.
Appends use `BEGIN IMMEDIATE`, expected stream versions, and idempotent command
receipts.

Only one active descriptor/server may own a workspace through the supported
IPC lifecycle. This is application-level single-writer coordination, not a
cryptographic defense against the local account directly opening state files.

## Domain states

Run states:

```text
DRAFT, PLANNING, WAITING_INPUT, WAITING_APPROVAL, RUNNING, PAUSING,
PAUSED, RECOVERING, NEEDS_RECONCILIATION, SUCCEEDED, PARTIAL, FAILED,
CANCELED
```

Task states:

```text
PROPOSED, BLOCKED, READY, CLAIMED, RUNNING, WAITING_TOOL, WAITING_INPUT,
WAITING_APPROVAL, REVIEW, REWORK, PASSED, FAILED, SKIPPED, CANCELED
```

Agent states:

```text
ACTIVATING, PLANNING, RUNNING, WAITING_TOOL, WAITING_INPUT,
WAITING_APPROVAL, BLOCKED, REVIEWING, PAUSED, SUCCEEDED, FAILED, STOPPED
```

Approval states:

```text
PENDING, APPROVED, DENIED, CHANGES_REQUESTED, CANCELED, SUPERSEDED,
EXPIRED, CONSUMED, INVALIDATED
```

Transition helpers reject invalid run/task edges and stale revisions. Replay
also checks each recorded run/task transition against its current projected
state and fails with `CORRUPT_EVENT_STREAM` on inconsistency. Agent lifecycle
metadata is projected, although the current fixed slice does not emit a full
agent-state event lifecycle.

## Events and projections

Each stored event has a global `sequence`, per-stream `streamVersion`, unique
event ID, schema version, timestamp, actor, type, data, and metadata. Commands
bind an `operationHash` and response to their first and last event sequences.
Repeating the same command ID/binding returns the receipt; reusing the ID for
different input is rejected.

Current projections are rebuilt by replay. Event payloads remain
event-type-specific JSON objects. The vNext event schema validates the envelope
and deliberately does not claim to validate every event payload/upcast.

## Policy and approvals

Contracts canonicalize JSON before SHA-256 hashing. Operation candidates bind
actor, connector, action, resource, environment, artifact digest, and
parameters. Approval records bind the operation hash plus a binding hash.

| Approval class | Boundary | v0.2 policy |
| --- | --- | --- |
| A0 | observation | permitted without human approval |
| A1 | reversible local | permitted within local policy |
| A2 | reversible isolated remote | approval required |
| A3 | shared non-production | approval required |
| A4 | production/security-sensitive | approval required |
| A5 | destructive/irreversible | denied by default |

Unknown connector operations are denied. Dynamic escalation accounts for
production environments and protected GitHub targets. Selected dangerous
operations are hard-denied before an action plan exists.

Approval decisions require a human actor. `APPROVED` is not execution: resume
issues a signed authorization bound to the stored approval and expiry, verifies
it, then uses a SQLite compare-and-update for single-use consumption.

## Worker process and lease boundary

`ChildWorkerSupervisor` creates a `agent-company.run-manifest/v1` record with
attempt ID, lease ID/expiry, run/task/role/workspace/model binding, objective,
wall-time limit, and maximum output bytes. The controller records
`worker.lease_granted` before execution.

The supervisor spawns a separate Node process with:

- the workspace as its current directory;
- no shell and a reduced environment;
- hidden window on Windows;
- piped stdin/stdout/stderr;
- a wall-clock timeout (30 seconds by default, at most one hour);
- bounded stdout (1 MiB by default, at most 16 MiB); and
- exactly one NDJSON result line.

The worker rejects a lease already expired at startup, validates the manifest,
runs the deterministic model adapter, and returns an attempt/lease-bound result.
The supervisor checks attempt, lease, and task identity before accepting it.
The controller records completion/evidence or failure/task/run transitions.
Pause/cancel abort an active child through the controller's `AbortSignal`.

The lease is not yet durable scheduling infrastructure: there are no lease
heartbeats/extensions, retry policy, attempt adoption after restart, OS
sandbox/container, network restriction, or complete orphan-process recovery.
Separate-process execution and environment reduction are isolation controls,
not a security sandbox.

## Tools, models, and budgets

The tool gateway validates input/output with Zod, applies path/network/shell
guards, requires an approval consumer for gated classes, passes an
`AbortSignal`, and emits sanitized audit records. Current connected commands
emit action plans rather than routing a remote mutation executor through it.

The model gateway has deterministic and OpenAI-compatible adapter interfaces;
the controller/worker slice intentionally uses the deterministic adapter.
Budget reservations store integer micro-dollars and reserve transactionally.
Complete provider pricing, delayed usage reconciliation, and unpriced-usage
governance remain incomplete.

## Attachments and artifacts

Artifacts are stored by the SHA-256 digest of bytes and verified on read.
Manifests record logical name, media type, producer, classification, size,
digest, and optional source revision.

Attachment ingestion resolves real paths under allowed roots, skips directory
symlinks, applies file/folder limits, detects basic types, and performs
deterministic malware-test, secret, PII, and injection-pattern checks. The
receipt fixes `transfer_count` at zero. These checks are defense in depth, not
a malware sandbox or authorization to upload/execute content.

## Connectors and secrets

Adapters use installed provider CLIs for authentication discovery and read-only
inventory. They run without a shell, with a reduced environment, timeout,
output cap, hidden Windows process window, and terminal sanitization.

Normalized action plans contain identity, capability, target, environment,
arguments, preconditions, risk, and operation hash. v0.2 does not execute the
planned remote mutations.

The secret broker accepts references and produces short-lived in-memory lease
values. Environment-variable lookup is implemented. OS credential-store
adapters, rotation, revocation, and non-exportable provider sessions remain
incomplete.

## Python/MCP compatibility boundary

`src/agentic_company` preserves the Python reference runtime and MCP surface.
Its state and contracts do not share a protocol with vNext. Python uses
`.agentic_company/state.json` plus `events.jsonl`; TypeScript uses
`.agent-company/state.sqlite`. See [Compatibility](../compatibility.md).

## Failure and recovery model

Transactions roll back failed writes; artifacts detect digest mismatch;
approval expiry/binding mismatch fail closed; framed IPC is bounded; worker
result binding is checked. Clean controller shutdown removes its descriptor,
nonce, and Unix socket.

Full crash recovery is not implemented. There is no persistent lease heartbeat,
automatic retry, attempt adoption, or definitive orphan reconciliation. Once a
remote executor exists, uncertain postconditions must use
`NEEDS_RECONCILIATION`, not guessed success. See
[Backup and recovery](../runbooks/backup-and-recovery.md).

## References

- [ADR-0002](../adr/0002-typescript-terminal-platform-preview.md)
- [Local IPC](../protocols/local-ipc.md)
- [Threat model](../security/threat-model.md)
- [Blueprint traceability](../blueprint-traceability.md)
- [vNext schemas](../../schemas/vnext)
