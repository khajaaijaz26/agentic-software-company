# Security policy

## Supported versions

| Distribution | Version | Security fixes |
| --- | --- | --- |
| npm `software-agent` | 0.7.x preview | Yes |
| Python `software-agent` | 1.x compatibility | Yes |
| Earlier/unreleased snapshots | other | No |

The npm CLI is a preview, not an unattended production deployment engine.
Support means that maintainers accept and triage security reports; it does not
mean every blueprint control has reached stable implementation.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Email
`khajaaijaz26@gmail.com` with:

- affected distribution, version, commit, and component;
- impact and the trust boundary crossed;
- minimal reproduction steps or a proof of concept;
- whether credentials, user data, or remote resources may be exposed;
- suggested mitigation, if known.

The maintainers aim to acknowledge a complete report within 72 hours. Timing
for validation, remediation, release, and coordinated disclosure depends on
severity and reproducibility. Do not include live secrets; use revoked test
credentials and synthetic data.

## Security invariants

- Human authority is explicit. Silence, timeout, `--yes`, or an agent's text is
  not approval for a gated operation.
- Approval bindings include actor, connector, action, resource, environment,
  artifact digest, and canonical operation hash. Consumption is atomic and
  single-use.
- Unknown connector operations are denied. A5 operations are denied by
  default, with hard denials for selected production/destructive cases.
- Remote connector mutations are planning-only in v0.7; provider probes and
  inventories are read-only.
- Coding-model credentials are supplied through explicit `env://` or supported
  secure-store references, resolved only by the controller, leased for the
  shortest scope, redacted, and never persisted in
  events, model prompts, artifacts, command lines, or generated reports.
- Interactive API setup masks raw input and moves it to Windows Credential
  Manager, macOS Keychain, or Linux Secret Service before controller IPC.
  Windows secret bytes travel over stdin; validated target identifiers are
  bound into an encoded PowerShell program, and native buffers are zeroed.
- Nova never opens the microphone until the operator presses `Ctrl+R` or runs
  `/voice`. Capture is bounded to two minutes, microphone PCM is held in
  process memory, and buffers are zeroed after transcription, cancellation,
  validation failure, or abort. The editable transcript requires a separate
  Enter before it becomes a controller command.
- Nova is the narrow exception to controller-side credential resolution: the
  local CLI resolves the configured OpenAI secret only for the bounded audio
  request and clear the lease afterward. Spoken output is generated audio,
  correlated to the exact committed task, stored only in a private random
  temporary WAV for playback, and removed immediately afterward.
- `--offline` rejects Nova before provider configuration, credential resolution,
  microphone access, or an audio network request.
- `software-agent voice doctor` lists input endpoint names without opening the
  microphone, resolving a provider credential, recording audio, or contacting
  the network. `voice test-speaker` uses a generated local tone and the same
  private temporary-WAV cleanup path as generated speech; it uses no API key or
  provider credits.
- Attachment content is untrusted data. Local ingestion does not authorize
  upload, execution, or instruction following.
- Artifacts are addressed by SHA-256 and verified on read. Runtime files are
  private where the operating system honors requested file modes.
- Event records are append-only through the application API. The local user
  still controls the underlying files, so local filesystem compromise is
  outside the integrity guarantee.
- Controller-backed CLI commands cross a bounded local socket/pipe protocol.
  Clients prove possession of a separate workspace/user-bound nonce with
  HMAC-SHA-256 before RPC; TCP fallback is forbidden.
- Step results must match the controller-issued attempt, lease, turn, task
  revision, and fencing epoch. Verification commands run without a shell in a
  reduced environment and bounded child process tree.

## Current limitations

- Authenticated IPC and detached controller discovery are active. Windows
  runtime/pipe ACLs and OS peer identity are not independently verified in
  v0.7; protect the account and runtime directory.
- Attempt/lease fencing and child-process boundaries for approved verification
  commands are implemented, but lease extension, automatic retries, OS
  sandboxing/network isolation, and complete orphan recovery are not.
- Cryptographic event signing and signed exports are not implemented.
- Native OpenAI Responses and Anthropic Messages adapters send selected prompt,
  tool, and repository context to the configured provider. Egress restrictions
  and data-governance review remain the operator's responsibility.
- Nova sends recorded speech to the configured OpenAI transcription endpoint
  and sends the selected committed reply to OpenAI speech generation. It is
  push-to-talk, not a local/offline speech recognizer or always-on wake word.
  OS microphone drivers and native playback tools remain trusted components.
- Python MCP HTTP transports need external TLS, authentication, authorization,
  rate limiting, and network policy before non-local exposure.
- Pattern scanners reduce accidental exposure but are not complete malware,
  DLP, or prompt-injection defenses.

See [the full threat model](docs/security/threat-model.md) for trust boundaries,
abuse cases, and residual risk.

## Secure deployment guidance

1. Keep the CLI and state on a trusted single-user workstation during v0.7.
2. Restrict project and platform data directories with OS permissions and disk
   encryption.
3. Never commit `.software-agent/`, `.agent-company/`, `.agentic_company/`, `.env`, provider
   credential stores, or raw diagnostic bundles.
4. Use least-privilege provider accounts and environment-scoped resources.
5. Review the exact operation hash, target, environment, and artifact before
   approving.
6. Back up SQLite with a supported snapshot/backup procedure; never delete live
   WAL files to clear a lock.
7. Run dependency audit, tests, and schema validation before releases.
8. Put a hardened authenticated proxy in front of any MCP HTTP transport.

## Security-sensitive code

- `packages/contracts/`: canonical JSON and operation binding.
- `packages/policy-engine/`: deterministic connector authorization.
- `packages/approval-service/`: approval lifecycle and consumption.
- `packages/tool-gateway/`: validation, deterministic guards, execution audit.
- `packages/attachments/` and `packages/artifact-store/`: untrusted input and
  stored content.
- `packages/secret-broker/`: secret-reference boundary.
- `packages/event-store-sqlite/`: durable audit source.
- `packages/ipc/` and `apps/controller-daemon/`: descriptor, nonce proof,
  framing, RPC validation, and controller lifecycle.
- `packages/worker-supervisor/` and `apps/worker-runtime/`: process boundary,
  lease/attempt binding, limits, and result validation.
- `packages/voice-input/` and `apps/cli/src/voice-assistant.ts`: bounded
  microphone capture, audio-provider calls, buffer erasure, and playback.
- `src/agentic_company/`: Python/MCP compatibility controls.

Security changes require tests, a threat-model update where applicable, and the
review level described in [GOVERNANCE.md](GOVERNANCE.md).
