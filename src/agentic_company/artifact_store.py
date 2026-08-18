"""Artifact store: versioned, hashed storage for generated files.

Artifacts are written under the configured root, content-addressed by sha256,
and recorded by reference. The store refuses to write outside the root to
enforce the least-privilege filesystem scope from the project policy.
"""

from __future__ import annotations

import hashlib
import hmac
import threading
from pathlib import Path


class ArtifactStoreError(Exception):
    """Raised when an artifact operation violates policy or I/O safety."""


class ArtifactStore:
    """Content-addressed file store rooted at ``root``."""

    def __init__(self, root: str | Path) -> None:
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        self._objects = self._root / "objects"
        self._refs = self._root / "refs"
        self._objects.mkdir(exist_ok=True)
        self._refs.mkdir(exist_ok=True)
        self._lock = threading.RLock()

    def _ref_path(self, rel_path: str) -> Path:
        relative = Path(rel_path)
        if not rel_path or relative.is_absolute() or ".." in relative.parts:
            raise ArtifactStoreError(f"path escapes artifact root: {rel_path}")
        target = (self._refs / relative).resolve()
        if self._refs not in target.parents:
            raise ArtifactStoreError(f"path escapes artifact root: {rel_path}")
        return target

    def _object_path(self, sha256: str) -> Path:
        return self._objects / sha256[:2] / sha256

    @staticmethod
    def _digest(content: bytes) -> str:
        return hashlib.sha256(content).hexdigest()

    def _write_object_once(self, target: Path, content: bytes, sha256: str) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open("xb") as handle:
                handle.write(content)
                handle.flush()
        except FileExistsError:
            existing = target.read_bytes()
            if not hmac.compare_digest(self._digest(existing), sha256):
                raise ArtifactStoreError(f"content-addressed object is corrupt: {sha256}") from None

    @staticmethod
    def _write_ref_once(target: Path, sha256: str) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open("x", encoding="ascii", newline="\n") as handle:
                handle.write(sha256 + "\n")
        except FileExistsError:
            existing = target.read_text(encoding="ascii").strip()
            if not hmac.compare_digest(existing, sha256):
                raise ArtifactStoreError(f"artifact reference is immutable: {target}") from None

    def store(self, rel_path: str, content: bytes) -> dict[str, str]:
        with self._lock:
            ref = self._ref_path(rel_path)
            sha = self._digest(content)
            target = self._object_path(sha)
            self._write_object_once(target, content, sha)
            self._write_ref_once(ref, sha)
            return {"path": str(target), "rel_path": rel_path, "sha256": sha}

    def store_text(self, rel_path: str, content: str) -> dict[str, str]:
        return self.store(rel_path, content.encode("utf-8"))

    def read(self, rel_path: str) -> bytes:
        with self._lock:
            ref = self._ref_path(rel_path)
            if not ref.is_file():
                raise ArtifactStoreError(f"artifact not found: {rel_path}")
            sha = ref.read_text(encoding="ascii").strip()
            if len(sha) != 64 or any(char not in "0123456789abcdef" for char in sha):
                raise ArtifactStoreError(f"invalid artifact reference: {rel_path}")
            target = self._object_path(sha)
            if not target.is_file():
                raise ArtifactStoreError(f"artifact object missing: {sha}")
            content = target.read_bytes()
            if not hmac.compare_digest(self._digest(content), sha):
                raise ArtifactStoreError(f"artifact object failed integrity check: {sha}")
            return content

    def read_text(self, rel_path: str) -> str:
        return self.read(rel_path).decode("utf-8")

    def exists(self, rel_path: str) -> bool:
        try:
            self.read(rel_path)
        except ArtifactStoreError:
            return False
        return True

    def verify(self, rel_path: str, expected_sha: str) -> bool:
        try:
            content = self.read(rel_path)
        except ArtifactStoreError:
            return False
        return hmac.compare_digest(self._digest(content), expected_sha)
