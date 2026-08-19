# Local controller IPC protocol

## Implementation status

Authenticated local IPC is active. The current controller advertises descriptor
`software-agent.controller/v2` and protocol range 1 through 2. The v0.5
runtime-v2 method set is implemented alongside camelCase compatibility methods.
Primary run lifecycle and project-room flows use the dotted surface; several
inspection and approval commands still use compatibility calls.

For controller-backed CLI operations, the client first tries the selected
workspace's controller. If none is usable, the normal CLI path ensures a
detached controller is running and reconnects. Tests or deployments using
`SOFTWARE_AGENT_CONTROLLER_MODE=embedded` start a command-lifetime service.
Both modes cross the same authenticated socket or pipe.

The protocol provides local authenticated transport and concurrency controls.
It does not itself grant a connector mutation, approve an action, or make an
untrusted worker safe.

## Transport, discovery, and ownership

- Linux and macOS use a Unix domain socket below the short, workspace-bound
  `<runtime>/s/<workspaceHash>/` directory. If that would exceed the portable
  `sockaddr_un` limit, the endpoint moves to one owner-only, user/workspace-bound
  directory directly below `/tmp`; descriptors, locks, and nonces never move.
- Windows uses a named pipe derived from user binding, workspace hash, and instance ID.
- TCP is never a fallback.

`controllerRuntimePaths()` hashes the canonical workspace path to 24 lowercase
hexadecimal characters and stores `controller.json` and `controller.lock`
below `<runtime>/controllers/<workspaceHash>/`.

The current descriptor conforms to
[`controller-descriptor.schema.json`](../../schemas/vnext/controller-descriptor.schema.json)
and contains:

- `schema: software-agent.controller/v2`;
- process ID, start time, and refreshed heartbeat time;
- the exact derived endpoint and `unix` or `named-pipe` transport;
- a `ctl_` plus 32-hex instance ID;
- protocol `{min: 1, max: 2}`;
- build version, 48-hex local-user binding, and 24-hex workspace hash; and
- the safe basename of a separate nonce file.

The server writes a 32-byte random nonce as 64 lowercase hexadecimal characters
to `nonce-<instanceId>.key`; the descriptor never contains that value. The
descriptor heartbeat defaults to five seconds and clients reject a descriptor
more than 30 seconds stale by default.

On POSIX, the runtime directory is forced to `0700`, descriptor, lock, nonce,
and socket files are owner-checked, and group/other access is rejected. Windows
uses normal account filesystem and named-pipe ACL behavior; there is no
independent owner-only ACL or peer-credential verification.

An atomically created `software-agent.controller-lock/v2` lock serializes
startup. A server can recover a lock whose process no longer exists, refuses to
replace a live controller, and removes only files bound to its own instance on
clean shutdown.

The reader also recognizes `agent-company.controller/v1` and
`agent-company.controller-lock/v1` to connect to an already running legacy
service. Those have legacy endpoint derivation and are documented by the
explicit [legacy descriptor schema](../../schemas/vnext/legacy-controller-descriptor.schema.json).
Software Agent does not emit them.

## Framing

Every message is UTF-8 JSON preceded by a four-byte unsigned big-endian payload
length:

```text
0                   31 32
+---------------------+--------------------+
| payload byte length | UTF-8 JSON payload |
+---------------------+--------------------+
```

The default maximum JSON payload is 1 MiB. Zero-length and oversized frames are
rejected. The incremental decoder accepts fragmented and coalesced frames and
uses fatal UTF-8 decoding before JSON parsing. Duplicate JSON object keys are
not independently rejected; peers must send unique keys.

## Authenticated handshake

The first frame is a hello conforming to
[`ipc-handshake.schema.json`](../../schemas/vnext/ipc-handshake.schema.json):

```json
{
  "kind": "hello",
  "requestId": "rpc_0123456789abcdef0123456789abcdef",
  "protocolMin": 1,
  "protocolMax": 2,
  "instanceId": "ctl_0123456789abcdef0123456789abcdef",
  "userBinding": "0123456789abcdef0123456789abcdef0123456789abcdef",
  "nonceProof": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

`nonceProof` is HMAC-SHA-256 using the nonce bytes as the key. The message is the
exact JSON serialization of `requestId`, `protocolMin`, `protocolMax`,
`instanceId`, and `userBinding` in that order. Verification uses a timing-safe
digest comparison. A hello also has to match the discovered instance and local
user binding. Handshake request IDs are replay-protected within the running
server's bounded 4,096-ID set.

The server negotiates the highest common version. A current client normally
receives:

```json
{
  "kind": "welcome",
  "requestId": "rpc_0123456789abcdef0123456789abcdef",
  "protocolVersion": 2,
  "instanceId": "ctl_0123456789abcdef0123456789abcdef",
  "buildVersion": "0.5.0",
  "serverTime": "2026-08-19T12:00:00.000Z"
}
```

A rejected hello receives `kind: handshake_error`, a correlated error, and then
connection closure. The default server and client handshake timeouts are five
seconds.

## Request and response envelopes

After welcome, a request conforms to
[`ipc-request.schema.json`](../../schemas/vnext/ipc-request.schema.json):

```json
{
  "kind": "request",
  "requestId": "rpc_11111111111111111111111111111111",
  "protocolVersion": 2,
  "method": "snapshot.get",
  "params": {"recentEventLimit": 50}
}
```

The request version must equal the value negotiated for that connection. A
request ID can be used once per connection, and one connection accepts at most
4,096 request IDs. Unknown methods, missing or extra parameters, blank required
strings, oversized values, and out-of-range integers fail closed.

Responses conform to
[`ipc-response.schema.json`](../../schemas/vnext/ipc-response.schema.json):

```json
{
  "kind": "response",
  "requestId": "rpc_11111111111111111111111111111111",
  "ok": true,
  "result": {"schema": "software-agent.snapshot/v2"}
}
```

```json
{
  "kind": "response",
  "requestId": "rpc_11111111111111111111111111111111",
  "ok": false,
  "error": {
    "code": "RUN_REVISION_CONFLICT",
    "message": "expected run revision 12, found 14",
    "retryable": false
  }
}
```

A response has exactly one of `result` and `error`. It echoes the request ID but
does not repeat method or protocol version, so the client supplies the
method-specific result type from its pending request. The default client request
timeout is 30 seconds, supports `AbortSignal`, and does not close the whole
connection merely because one request times out.

## Runtime-v2 methods

The dotted method namespace is the current runtime contract:

| Method | Parameters beyond the envelope | Result |
| --- | --- | --- |
| `snapshot.get` | optional `recentEventLimit` from 0 to 250 | [`software-agent.snapshot/v2`](../../schemas/vnext/snapshot.schema.json) |
| `events.poll` | `afterCursor`; optional `limit` 1-250 and `waitMs` 0-30000 | [`software-agent.events/v2`](../../schemas/vnext/events-page.schema.json) |
| `events.history` | `afterCursor`; optional `runId` and `limit` 1-250 | event page |
| `mutation.acquire` | `commandId`, `attachmentId`, `correlationId` | [mutation lease](../../schemas/vnext/mutation-lease.schema.json) |
| `mutation.renew` | acquire fields plus `leaseId` and positive `fence` | mutation lease |
| `mutation.release` | acquire fields plus `leaseId` and positive `fence` | mutation lease |
| `run.create` | command context plus `objective` and `maxParallel` 1-3 | [runtime-v2 run](../../schemas/vnext/run.schema.json) |
| `run.resume` | command context plus `runId` | [command receipt](../../schemas/vnext/command-receipt.schema.json) |
| `run.pause` | command context plus `runId` | command receipt |
| `run.cancel` | command context plus `runId` | command receipt |
| `question.ask` | command context plus `runId`, `sessionId`, and `prompt` | question plus resulting run revision |
| `question.answer` | command context plus `runId`, `questionId`, and `answer` | question plus resulting run revision |
| `instruction.submit` | command context plus `runId`, target `{kind,id}`, and `text` | queued mailbox message plus resulting run revision; the same commit creates a runnable conversation task |
| `daemon.stop` | `{}` | `software-agent.daemon-stop/v1` acceptance |

Mutation-lease methods do not carry an actor. The IPC service binds them to
`{type: human, id: local-user}`. Every run, question, and instruction method
instead carries the complete command context:

```json
{
  "schema": "software-agent.command/v2",
  "commandId": "cmd_123",
  "actor": {"type": "human", "id": "local-user"},
  "expectedRunRevision": 12,
  "correlationId": "corr_123",
  "causationId": "cause_123",
  "uiAttachmentId": "ui_123",
  "mutationLease": {"leaseId": "mut_123", "fence": 4}
}
```

For a running or terminal run, `instruction.submit` schedules the new turn
after the atomic command commit. A paused run stays paused so the returned
revision can be used safely by `run.resume`; the project-room adapter performs
that second command. Team-targeted text is deterministically routed to one of
the three execution seats without a separate model call. Model completion is
reported later through `software-agent.turn.completed`, not in the instruction
receipt.

`run.create` requires `expectedRunRevision: 0`. Every other run-bound command
compares the supplied revision with the current stream version. Command IDs are
durably idempotent: replaying the same ID and operation returns its receipt;
reusing it for another operation is an idempotency conflict. The mutation lease
must be active and match UI attachment, lease ID, and fence.

The backend interface makes runtime-v2 capabilities optional so an older
controller implementation can return `CAPABILITY_UNAVAILABLE`. The repository's
`LocalController` implements all methods in the table.

## Event cursors and resynchronization

The snapshot cursor is the latest global SQLite event sequence. Recent events
and unfiltered history can contain explicit compatibility events already in the
shared log in addition to current `software-agent.event/v2` events.

`events.poll` waits for events after a cursor. The server reads at most 513
events to detect overflow and counts the serialized backlog before applying the
requested page limit. More than 512 events or more than 512 KiB returns:

```json
{
  "schema": "software-agent.events/v2",
  "events": [],
  "cursor": 100,
  "hasMore": true,
  "resyncRequired": true
}
```

The client must then load a fresh snapshot rather than guessing over a gap.
There is no server-push subscription.

`events.history` scans the global sequence first and filters by `runId` second.
Consequently a filtered page may contain fewer events than its requested limit,
and its cursor can advance across unrelated streams. This behavior is part of
the current implementation.

## Compatibility methods

These methods remain active for older clients and the residual CLI inspection
and approval projection:

| Method | Parameters | Result |
| --- | --- | --- |
| `snapshot` | `{}` | compatibility controller snapshot |
| `createRun` | `objective` | compatibility run view |
| `listApprovals` | optional `runId` | approval records |
| `approve` | `approvalId`; optional `reason` | approval record |
| `deny` | `approvalId`; optional `reason` | approval record |
| `resume` | `runId` | compatibility run view |
| `pause` | `runId` | compatibility run view |
| `cancel` | `runId` | compatibility run view |

These are not runtime-v2 aliases. They use broader legacy run/task state
machines, approval-gated plan execution, and the legacy worker/result path.
They should be treated as a temporary cutover surface.

The server currently registers both compatibility and dotted methods after a
protocol 1 or protocol 2 handshake. It does not enforce a method/version matrix.
Clients should negotiate 2 before relying on dotted methods, but this is a
convention until server-side gating or explicit capability negotiation is
chosen.

## TUI adapter boundary

The live project room consumes a `ProjectRoomSource`, not raw IPC. Its UI
commands use a committed-event `expectedCursor`, while runtime-v2 mutation
commands require a run revision, UI attachment, and live mutation lease. The
installed `IpcProjectRoomSource` acquires and renews that lease, becomes
read-only when another room owns it, rejects a stale cursor, loads the current
run revision, maps the intent to one or more RPC calls, and releases control on
leave. It uses snapshot reload plus bounded poll/history catch-up to resync.

`objective.create` maps to `run.create` followed by `run.resume`.
`instruction.submit` maps to the dotted method. Pause/cancel leave choices map
to the corresponding run methods; continue only releases the UI lease. There
is still no dotted runtime-v2 approval method, so `approval.decide` bridges to
compatibility `approve` or `deny` when a matching approval exists. The
project-room command remains an adapter-level intent and is never itself sent
as an IPC envelope.

## Service lifecycle

After `npm run build`, the standalone entry is:

```bash
node dist/controller.js --workspace /absolute/project/path
```

For source development:

```bash
npx tsx apps/controller-daemon/src/index.ts --workspace /absolute/project/path
```

Optional flags are `--runtime`, `--build-version`, and `--heartbeat-ms` of at
least 100 ms. Startup prints descriptor identity but never the nonce. The daemon
module also implements status inspection, detached spawn/ensure, and a
`daemon.stop` request; these are module APIs, not a separately installed
controller binary.

## Known protocol decisions still open

- Gate dotted methods to protocol 2, or formally define the current mixed namespace as valid under both versions.
- Filter runtime-v2 event pages to current events, or continue returning the explicit legacy-event union from the shared store.
- Define a native runtime-v2 approval command and remove the compatibility approval bridge.
- Decide when residual inspection commands and external clients can stop using compatibility methods and the legacy worker path.
- Add Windows ACL or peer-credential verification if local-account nonce possession is insufficient for the threat model.
