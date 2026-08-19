# Runbook: local development

## Prerequisites

- Node.js 22.14+, npm, and Git.
- Python 3.10+ only when changing the compatibility runtime.
- A clean test workspace outside the repository for manual CLI exercises.

## TypeScript checks

From the repository root:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run check` runs the same required sequence. `npm pack --dry-run` verifies
the distribution file list and invokes the prepack checks.

For focused controller/worker verification:

```bash
npx vitest run tests/vnext/ipc.test.ts tests/vnext/ipc-v3.test.ts tests/vnext/platform.test.ts tests/vnext/agent-execution-v3.test.ts
```

These tests cover fragmented/coalesced and oversized frames, nonce-proof
authentication, typed RPC/correlation/timeouts/cleanup, and bound leased child
worker execution.

## Manual CLI smoke test

```bash
npm run dev -- version --json
npm run dev -- doctor --json
npm run dev -- init ../software-agent-smoke --name smoke
npm run dev -- --project ../software-agent-smoke run --json "verify the local slice"
```

With the deterministic provider, the final command should complete. A real
provider that requests process execution should exit `4` with a visible exact
approval. Then:

```bash
npm run dev -- --project ../software-agent-smoke approvals list --json
npm run dev -- --project ../software-agent-smoke approvals approve <approval-id>
npm run dev -- --project ../software-agent-smoke resume <run-id> --json
npm run dev -- --project ../software-agent-smoke state check --json
```

Expected final run state: `SUCCEEDED`. Remove only the test directory you
created; never point cleanup at a repository root, home directory, or unresolved
environment variable.

To exercise reuse of the standalone service, first build, then leave this
running in another terminal:

```bash
node dist/controller.js --workspace ../software-agent-smoke
```

Repeat `runs list`, `approvals list`, or `state check` from the first terminal,
then stop the controller with `Ctrl+C`. Its descriptor, nonce, and Unix socket
should be removed on clean shutdown.

## Python compatibility checks

```bash
python -m pip install -e ".[mcp]"
python -m unittest discover -s tests -v
python -m compileall -q src tests
```

## Before submitting a change

1. Run the relevant TypeScript and Python checks.
2. Parse all changed JSON and YAML.
3. Confirm `git diff --check` is clean.
4. Inspect `git status` for generated state, tokens, `.env`, databases, WAL
   files, or diagnostic bundles.
5. Update schemas, ABI, threat model, traceability, and changelog when their
   public behavior changes.
