# Security policy

## Supported versions

| Distribution | Version | Security fixes |
| --- | --- | --- |
| npm `@agent-company/cli` | 0.2.x preview | Yes |
| Python `agentic-company` | 1.x compatibility | Yes |
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
- Remote connector mutations are planning-only in v0.2; provider probes and
  inventories are read-only.
- Provider credentials remain in provider-owned CLI stores. Secrets should be
  referenced, leased for the shortest scope, redacted, and never persisted in
  events, model prompts, artifacts, command lines, or generated reports.
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
- Worker results must match the controller-issued attempt, lease, and task and
  are produced in a separate child process with reduced environment and
  wall-time/output bounds.

## Current limitations

- Authenticated IPC is active, but the ordinary CLI fallback hosts a one-shot
  service in the CLI process rather than a detached background daemon. Windows
  runtime/pipe ACLs and OS peer identity are not independently verified in
  v0.2; protect the account and runtime directory.
- Worker attempt/lease manifests and process separation are implemented, but
  lease heartbeats/extensions, automatic retries, OS sandboxing/network
  isolation, and complete orphan recovery are not.
- Cryptographic event signing and signed exports are not implemented.
- The OpenAI-compatible model adapter is an integration surface; safe
  production configuration, egress restrictions, and data-governance review
  remain the operator's responsibility.
- Python MCP HTTP transports need external TLS, authentication, authorization,
  rate limiting, and network policy before non-local exposure.
- Pattern scanners reduce accidental exposure but are not complete malware,
  DLP, or prompt-injection defenses.

See [the full threat model](docs/security/threat-model.md) for trust boundaries,
abuse cases, and residual risk.

## Secure deployment guidance

1. Keep the CLI and state on a trusted single-user workstation during v0.2.
2. Restrict project and platform data directories with OS permissions and disk
   encryption.
3. Never commit `.agent-company/`, `.agentic_company/`, `.env`, provider
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
- `src/agentic_company/`: Python/MCP compatibility controls.

Security changes require tests, a threat-model update where applicable, and the
review level described in [GOVERNANCE.md](GOVERNANCE.md).
