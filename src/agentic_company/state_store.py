"""In-memory state store with an optional file-backed snapshot.

The state store keeps the canonical project/task records that the orchestrator
manages. It is deliberately small and synchronous: a production deployment
would swap this for a durable database, but the interface stays the same.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from .contracts import DomainEvent, ProjectRecord


class StateStore:
    """Thread-safe key/value state store keyed by record id."""

    def __init__(self, snapshot_path: str | Path | None = None) -> None:
        self._lock = threading.RLock()
        self._data: dict[str, dict[str, Any]] = {}
        self._snapshot_path = Path(snapshot_path) if snapshot_path else None
        if self._snapshot_path and self._snapshot_path.exists():
            self._load()

    def _load(self) -> None:
        raw = json.loads(self._snapshot_path.read_text(encoding="utf-8"))
        self._data = raw if isinstance(raw, dict) else {}

    def _save(self) -> None:
        if self._snapshot_path:
            self._snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            self._snapshot_path.write_text(
                json.dumps(self._data, indent=2, default=str), encoding="utf-8"
            )

    def set(self, key: str, value: dict[str, Any]) -> None:
        with self._lock:
            self._data[key] = value
            self._save()

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(key, default)

    def update(self, key: str, **changes: Any) -> dict[str, Any]:
        with self._lock:
            record = self._data.setdefault(key, {})
            record.update(changes)
            self._save()
            return record

    def keys(self) -> list[str]:
        with self._lock:
            return list(self._data.keys())

    def save_project(self, project: ProjectRecord) -> None:
        self.set(project.project_id, project.to_dict())

    def load_project(self, project_id: str) -> ProjectRecord | None:
        raw = self.get(project_id)
        return ProjectRecord.from_dict(raw) if raw else None
