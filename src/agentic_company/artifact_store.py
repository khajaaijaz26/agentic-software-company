"""Artifact store: versioned, hashed storage for generated files.

Artifacts are written under the configured root, content-addressed by sha256,
and recorded by reference. The store refuses to write outside the root to
enforce the least-privilege filesystem scope from the project policy.
"""

from __future__ import annotations

import hashlib
import threading
from pathlib import Path


class ArtifactStoreError(Exception):
    """Raised when an artifact operation violates policy or I/O safety."""


class ArtifactStore:
    """Content-addressed file store rooted at ``root``."""

    def __init__(self, root: str | Path) -> None:
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _safe_target(self, rel_path: str) -> Path:
        target = (self._root / rel_path).resolve()
        if self._root not in target.parents and target != self._root:
            raise ArtifactStoreError(f"path escapes artifact root: {rel_path}")
        return target

    def store(self, rel_path: str, content: bytes) -> dict[str, str]:
        with self._lock:
            target = self._safe_target(rel_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            sha = hashlib.sha256(content).hexdigest()
            return {"path": str(target), "rel_path": rel_path, "sha256": sha}

    def store_text(self, rel_path: str, content: str) -> dict[str, str]:
        return self.store(rel_path, content.encode("utf-8"))

    def read(self, rel_path: str) -> bytes:
        with self._lock:
            target = self._safe_target(rel_path)
            if not target.exists():
                raise ArtifactStoreError(f"artifact not found: {rel_path}")
            return target.read_bytes()

    def read_text(self, rel_path: str) -> str:
        return self.read(rel_path).decode("utf-8")

    def exists(self, rel_path: str) -> bool:
        with self._lock:
            try:
                return self._safe_target(rel_path).exists()
            except ArtifactStoreError:
                return False

    def verify(self, rel_path: str, expected_sha: str) -> bool:
        try:
            content = self.read(rel_path)
        except ArtifactStoreError:
            return False
        return hashlib.sha256(content).hexdigest() == expected_sha