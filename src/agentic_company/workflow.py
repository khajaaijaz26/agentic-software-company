"""Workflow engine: dependency-aware execution of WorkItems with run budget.

A workflow is a list of WorkItems that may depend on each other. The engine
schedules ready items (all dependencies complete), dispatches each to its
owner via a pluggable executor, and honours the project budget. Failure of a
dependency blocks its dependents.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .contracts import Budget, WorkItem

Executor = Callable[[WorkItem], Any]


@dataclass
class RunStats:
    started: int = 0
    completed: int = 0
    failed: int = 0
    blocked: int = 0


class WorkflowError(Exception):
    """Raised for workflow-level failures (cycles, budget exhaustion, unowned items)."""


class Workflow:
    """Runs a dependency graph of work items with a shared budget."""

    def __init__(self, budget: Budget | None = None, clock: Callable[[], float] | None = None) -> None:
        self._lock = threading.RLock()
        self._budget = budget or Budget()
        self._clock = clock or time.monotonic
        self._results: dict[str, Any] = {}

    def _ready_items(self, items: list[WorkItem], completed: set[str]) -> list[WorkItem]:
        ready: list[WorkItem] = []
        for item in items:
            if item.status in ("queued", "ready") and all(d in completed for d in item.depends_on):
                ready.append(item)
        return ready

    def run(self, items: list[WorkItem], executor: Executor) -> RunStats:
        stats = RunStats()
        started_at = self._clock()
        pending = [item for item in items if item.status in ("queued", "ready")]
        completed: set[str] = set()
        failed: set[str] = set()

        item_ids = [item.item_id for item in items]
        if len(item_ids) != len(set(item_ids)):
            raise WorkflowError("workflow item ids must be unique")
        known_ids = set(item_ids)
        missing = sorted({dependency for item in items for dependency in item.depends_on if dependency not in known_ids})
        if missing:
            raise WorkflowError(f"unknown workflow dependencies: {', '.join(missing)}")

        def check_time_budget() -> None:
            if self._budget.max_time_seconds <= 0:
                return
            elapsed = self._clock() - started_at
            if elapsed > self._budget.max_time_seconds:
                raise WorkflowError("workflow exceeded time budget")

        # Detect cycles.
        visited: dict[str, int] = {}

        def visit(item_id: str, stack: set[str]) -> None:
            if item_id in stack:
                raise WorkflowError(f"dependency cycle involving {item_id}")
            if item_id in visited:
                return
            stack.add(item_id)
            visited[item_id] = 1
            for d in next((i.depends_on for i in items if i.item_id == item_id), ()):
                visit(d, stack)
            stack.remove(item_id)

        for item in items:
            visit(item.item_id, set())

        while pending:
            ready = self._ready_items(pending, completed)
            if not ready:
                # Only dependents of failed items may remain.
                remaining = [i for i in pending if not all(d in completed for d in i.depends_on)]
                if remaining and all(any(d in failed for d in i.depends_on) for i in remaining):
                    stats.blocked += len(remaining)
                else:
                    raise WorkflowError("workflow stalled: no ready items and no failed dependency")
                break

            for item in ready:
                check_time_budget()
                stats.started += 1
                try:
                    result = executor(item)
                    check_time_budget()
                    self._results[item.item_id] = result
                    completed.add(item.item_id)
                    stats.completed += 1
                except WorkflowError:
                    raise
                except Exception:  # noqa: BLE001 - executor failures are workflow results
                    failed.add(item.item_id)
                    stats.failed += 1
                pending.remove(item)

        return stats
