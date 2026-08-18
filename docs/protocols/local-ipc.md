# Local controller IPC protocol

## Implementation status

Authenticated local IPC is active in v0.2. Every controller-backed CLI command
first attempts to connect to the selected workspace's controller. If no usable
service is present, the CLI starts a one-shot `ControllerIpcServer` inside the
CLI process, connects through IPC, executes the command, then closes the client and
that one-shot service. A separately launched controller entry can remain alive
and serve later CLI processes until it receives `SIGINT` or `SIGTERM`.

The controller service is the only application component that opens the
project's SQLite event/approval/budget database for controller commands.
Attachments, artifacts, and read-only connector probes still have separate CLI
paths and are not controller RPC methods.

## Transport and discovery

- Unix/macOS: Unix domain socket below the workspace-bound runtime directory.
- Windows: named pipe derived from the user binding, workspace hash, and
  controller instance.
- TCP is not implemented as a fallback.

`controllerRuntimePaths()` hashes the resolved workspace path to 24 lowercase
hex characters and stores `controller.json` below
`<runtime>/controllers/<workspaceHash>/`. The server writes the descriptor
atomically and refreshes `heartbeatAt` (five seconds by default; the CLI's
one-shot server requests one second).

The descriptor conforms to
[`controller-descriptor.schema.json`](../../schemas/vnext/controller-descriptor.schema.json)
and contains:

- `schema: "agent-company.controller/v1"`;
- PID, `startedAt`, and `heartbeatAt`;
- exact local endpoint and `unix`/`named-pipe` transport;
- `ctl_...` instance ID and protocol `{min,max}`;
- build version, user binding, workspace hash, and a safe `nonceRef` basename.

It never contains the nonce value. The 32-byte random nonce is stored as 64
lowercase hexadecimal characters in a separate
`nonce-<instanceId>.key` file. On POSIX, the runtime directory is forced to
`0700`, descriptor/nonce/socket files are `0600`, ownership is checked, and
group/other access is rejected. On Windows, v0.2 uses the account's normal
filesystem/pipe ACL behavior but does not independently verify an owner-only
ACL; this is a documented residual risk.

Clients reject a descriptor whose workspace hash, user binding, derived
endpoint, heartbeat age, or protocol range does not match local expectations.
Startup is serialized by an atomically created, user/workspace/instance-bound
`controller.lock` held for the server lifetime. A server recovers a lock and
descriptor whose process is dead, refuses to replace a live controller, and
removes its own lock, descriptor, nonce, and Unix socket on clean shutdown.

## Framing

Each wire message is JSON encoded as UTF-8 and preceded by a four-byte unsigned
big-endian payload length:

```text
0                   31 32
+---------------------+--------------------+
| payload byte length | UTF-8 JSON payload |
+---------------------+--------------------+
```

The default maximum JSON payload is 1 MiB. Zero-length and oversized frames
are rejected. The decoder supports fragmented frames and multiple coalesced
frames. It uses fatal UTF-8 decoding before JavaScript `JSON.parse`, so malformed
byte sequences are rejected. v0.2 does not separately reject duplicate object
keys, so peers must emit canonical JSON with unique keys.

## Authenticated handshake

The first frame is a client hello. Request IDs match `rpc_` plus 32 lowercase
hex characters. Protocol v1 currently negotiates the highest overlap of client
and server ranges (both are `1` in this release).

```json
{
  "kind": "hello",
  "requestId": "rpc_0123456789abcdef0123456789abcdef",
  "protocolMin": 1,
  "protocolMax": 1,
  "instanceId": "ctl_0123456789abcdef0123456789abcdef",
  "userBinding": "0123456789abcdef0123456789abcdef0123456789abcdef",
  "nonceProof": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

`nonceProof` is HMAC-SHA-256 using the nonce bytes as the key and the exact JSON
serialization of `requestId`, protocol range, instance ID, and user binding as
the message. Verification uses a timing-safe digest comparison. The raw nonce
never crosses the socket.

On success the server replies:

```json
{
  "kind": "welcome",
  "requestId": "rpc_0123456789abcdef0123456789abcdef",
  "protocolVersion": 1,
  "instanceId": "ctl_0123456789abcdef0123456789abcdef",
  "buildVersion": "0.2.0",
  "serverTime": "2026-08-18T12:00:00.000Z"
}
```

A rejected handshake returns `kind: "handshake_error"`, the request ID, and an
error object, then closes the socket. The server's handshake timer defaults to
five seconds.

Authentication proves possession of the workspace/user-bound nonce material;
it is not a human approval and does not bypass domain policy. v0.2 does not use
an OS peer-credential API to identify the connecting process.

## RPC requests

After welcome, requests conform to
[`ipc-request.schema.json`](../../schemas/vnext/ipc-request.schema.json):

```json
{
  "kind": "request",
  "requestId": "rpc_11111111111111111111111111111111",
  "protocolVersion": 1,
  "method": "createRun",
  "params": {"objective": "Build a bounded local change"}
}
```

The exact method/parameter set is:

| Method | Parameters | Result |
| --- | --- | --- |
| `snapshot` | `{}` | controller snapshot |
| `createRun` | `{objective}` | run view |
| `listApprovals` | optional `{runId}` | approval records |
| `approve` | `{approvalId}`, optional `reason` | approval record |
| `deny` | `{approvalId}`, optional `reason` | approval record |
| `resume` | `{runId}` | run view |
| `pause` | `{runId}` | run view |
| `cancel` | `{runId}` | run view |

Unknown methods and unknown/missing parameters fail closed. IPC requests do
not currently carry caller-supplied command IDs or expected revisions. Backend
commands still use event-store idempotency receipts internally, but the RPC
surface does not expose those keys.

## RPC responses

Responses conform to
[`ipc-response.schema.json`](../../schemas/vnext/ipc-response.schema.json).
A successful response is:

```json
{
  "kind": "response",
  "requestId": "rpc_11111111111111111111111111111111",
  "ok": true,
  "result": {"example": "method-specific value"}
}
```

A failed response is:

```json
{
  "kind": "response",
  "requestId": "rpc_11111111111111111111111111111111",
  "ok": false,
  "error": {
    "code": "INVALID_PARAMS",
    "message": "unknown parameter: example",
    "retryable": false
  }
}
```

Responses echo the request ID but do not repeat the negotiated protocol
version. They contain exactly one of `result` or `error`; errors have exactly
`code`, `message`, and `retryable`.

The client correlates concurrent requests, has per-request timeouts, supports
`AbortSignal`, and ignores responses for unknown/already-timed-out IDs. A slow
request can time out without closing the entire client connection.

## Standalone controller

After `npm run build`, start the bundled entry directly:

```bash
node dist/controller.js --workspace /absolute/project/path
```

For source development:

```bash
npx tsx apps/controller-daemon/src/index.ts --workspace /absolute/project/path
```

Optional flags are `--runtime`, `--build-version`, and `--heartbeat-ms` (at
least 100 ms). Startup prints a small JSON descriptor summary, not the nonce.
The npm package does not currently install a separate `agent-company-controller`
binary alias.

## Incomplete lifecycle features

- No event subscription or server-push stream; the CLI requests snapshots.
- No caller-supplied RPC idempotency key or optimistic revision field.
- No automatic background daemon spawn/detach or service manager integration.
- No full recovery protocol for a controller or worker that dies mid-attempt.
- No Windows ACL verification or OS peer-credential check.

These limitations do not turn an IPC connection into authority. Approvals,
budgets, state transitions, and connector hard denials still apply in the
controller/tool layers.
