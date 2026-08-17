# Contributing

Thanks for your interest in the Open-Source Agentic Software Company.

## Ground rules

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Work in small, reversible steps on feature branches.
- Never commit secrets. Never place raw credentials in prompts, logs, or tests.
- Prefer evidence-backed changes: add or update tests and run the suite.
- The author of a material change is not its only reviewer.

## Development setup

Requires Python 3.10+. No third-party dependencies are needed to run or test.

```bash
git clone https://github.com/khajaaijaz26/agentic-software-company
cd agentic-software-company
PYTHONPATH=src python -m unittest discover -s tests -v
```

## What to work on

- **Prompts** — refinements to the constitution, role prompts, policies, or templates. Each prompt is a versioned file under `prompts/`; document prompt-version changes.
- **Reference implementation** — the stdlib-only package under `src/agentic_company/` and its tests under `tests/`.
- **Schemas & workflows** — JSON schemas under `schemas/` and YAML workflows under `workflows/`.
- **Docs & evals** — architecture docs, ADRs, and evaluation scenarios under `docs/` and `evals/`.

## Process

1. Open an issue describing the change and its motivation.
2. Create a branch named `<issue>-<short-description>`.
3. Make focused commits with clear messages.
4. Add or update tests; ensure `python -m unittest discover -s tests` passes.
5. Open a pull request referencing the issue. Maintainers review and approve per [GOVERNANCE.md](GOVERNANCE.md).

## Commit message style

Use conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Definition of done

- Tests pass locally.
- Change is scoped and documented.
- Prompt-version changes are noted where relevant.
- No secrets, no unrelated edits, no generated cruft.