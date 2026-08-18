"""Append-only, in-memory event store with optional file-backed persistence.

The event store is the audit system of record. Events are immutable once
written; the sequence numbers are strictly monotonic per store.
"""

from __future__ import annotations

import json
import threading
from copy import deepcopy
from pathlib import Path

from .contracts import Actor, DomainEvent


class EventStoreError(Exception):
    """Raised when an append-only event-store invariant is violated."""


class EventStore:
    """Thread-safe append-only event store."""

    def __init__(self, path: str | Path | None = None) -> None:
        self._lock = threading.RLock()
        self._events: list[DomainEvent] = []
        self._event_ids: set[str] = set()
        self._path = Path(path) if path else None
        if self._path and self._path.exists():
            self._load()

    def _load(self) -> None:
        for line in self._path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            raw = json.loads(line)
            event = DomainEvent(
                event_type=raw["event_type"],
                actor=Actor(type=raw["actor"]["type"], id=raw["actor"]["id"]),
                data=deepcopy(raw.get("data", {})),
                event_id=raw.get("event_id", ""),
                version=raw.get("version", 1),
                project_id=raw.get("project_id", ""),
                correlation_id=raw.get("correlation_id", ""),
                occurred_at=raw.get("occurred_at", ""),
            )
            self._remember(event)

    def _remember(self, event: DomainEvent) -> None:
        if not event.event_id:
            raise EventStoreError("event_id is required")
        if event.event_id in self._event_ids:
            raise EventStoreError(f"duplicate event_id: {event.event_id}")
        self._events.append(event)
        self._event_ids.add(event.event_id)

    def _append_line(self, event: DomainEvent) -> None:
        if self._path:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._path.open("a", encoding="utf-8") as fh:
                fh.write(event.to_json() + "\n")

    def append(self, event: DomainEvent) -> DomainEvent:
        with self._lock:
            stored = deepcopy(event)
            if not stored.event_id or stored.event_id in self._event_ids:
                raise EventStoreError(f"duplicate or empty event_id: {stored.event_id}")
            self._append_line(stored)
            self._remember(stored)
            return deepcopy(stored)

    def events_for(self, project_id: str | None = None, event_type: str | None = None) -> list[DomainEvent]:
        with self._lock:
            result = self._events
            if project_id:
                result = [e for e in result if e.project_id == project_id]
            if event_type:
                result = [e for e in result if e.event_type == event_type]
            return deepcopy(result)

    @property
    def sequence(self) -> int:
        with self._lock:
            return len(self._events)

    def clear(self) -> None:
        raise EventStoreError("event stores are append-only and cannot be cleared")
