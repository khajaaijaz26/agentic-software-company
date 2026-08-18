# Contributing

Thanks for your interest in the Open-Source Agentic Software Company.

## Ground rules

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Work in small, reversible steps on feature branches.
- Never commit secrets. Never place raw credentials in prompts, logs, or tests.
- Prefer evidence-backed changes: add or update tests and run the suite.
- The author of a material change is not its only reviewer.

## Development setup

The primary terminal platform requires Node.js 22.13+ and npm. The preserved
compatibility runtime requires Python 3.10+; its MCP extra is needed to execute
the complete compatibility test suite.

```bash
git clone https://github.com/khajaaijaz26/agentic-software-company
cd agentic-software-company
npm ci
npm run check

python -m pip install -e ".[mcp]"
python -m unittest discover -s tests -v
```

## What to work on

- **Prompts** — refinements to the constitution, role prompts, policies, or templates. Each prompt is a versioned file under `prompts/`; document prompt-version changes.
- **Terminal platform** — strict TypeScript under `apps/`, `packages/`, and
  `adapters/`, with tests under `tests/vnext/`.
- **Compatibility runtime** — the Python package under `src/agentic_company/`
  and its tests under `tests/`.
- **Schemas & workflows** — compatibility contracts under `schemas/`, v0.2
  contracts under `schemas/vnext/`, and YAML workflows under `workflows/`.
- **Docs & evals** — architecture docs, ADRs, and evaluation scenarios under `docs/` and `evals/`.

## Process

1. Open an issue describing the change and its motivation.
2. Create a branch named `<issue>-<short-description>`.
3. Make focused commits with clear messages.
4. Add or update tests; run `npm run check` and the Python suite for affected
   compatibility code.
5. Open a pull request referencing the issue. Maintainers review and approve per [GOVERNANCE.md](GOVERNANCE.md).

## Commit message style

Use conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Definition of done

- Typecheck, lint, tests, and builds pass for the affected runtime.
- Change is scoped and documented.
- Prompt-version changes are noted where relevant.
- No secrets, no unrelated edits, no generated cruft.
