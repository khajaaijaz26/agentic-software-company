# Runbook: local development

## Purpose

Verify the reference implementation runs cleanly on a fresh checkout with no
external dependencies.

## Prerequisites

- Python 3.10+ on PATH
- Git

## Steps

1. Clone and enter the repository.
2. Run the test suite:

   ```bash
   PYTHONPATH=src python -m unittest discover -s tests -v
   ```

3. Exercise the CLI (state persists under `.agentic_company/`):

   ```bash
   PYTHONPATH=src python -m agentic_company init-project "DemoApp" "carol" --goal "ship v1"
   PYTHONPATH=src python -m agentic_company dispatch technical-lead "design the architecture"
   PYTHONPATH=src python -m agentic_company audit <project_id>
   ```

4. Run the delivery scenario:

   ```bash
   PYTHONPATH=src python evals/scenarios/delivery_cli.py
   ```

## Expected results

- 43 tests pass.
- `init-project` prints a `proj_...` id.
- `dispatch` prints `<task_id> COMPLETE`.
- `audit` prints one event per line (project.created, task.dispatch, task.complete).
- The scenario prints `SCENARIO PASSED` and asserts 6 dispatches, an approved
  G4 release, and a resolved approval event.