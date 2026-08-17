"""Agent registry: records which roles exist, their capabilities, and the
prompt-template version they run with.

Capabilities are enforced downstream by the policy engine; the registry is the
declarative source that keeps role → operation mappings consistent.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .contracts import Actor


@dataclass(frozen=True)
class AgentSpec:
    role: str
    prompt_file: str
    prompt_sha: str
    capabilities: tuple[str, ...] = ()
    description: str = ""
    registered_at: str = ""


class AgentRegistry:
    """Thread-safe registry of specialist agent roles."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._agents: dict[str, AgentSpec] = {}
        self._active_actors: set[str] = set()

    def register(self, spec: AgentSpec) -> None:
        with self._lock:
            self._agents[spec.role] = spec

    def unregister(self, role: str) -> None:
        with self._lock:
            self._agents.pop(role, None)

    def get(self, role: str) -> AgentSpec | None:
        with self._lock:
            return self._agents.get(role)

    def roles(self) -> list[str]:
        with self._lock:
            return sorted(self._agents.keys())

    def capabilities(self, role: str) -> tuple[str, ...]:
        spec = self.get(role)
        return spec.capabilities if spec else ()

    def activate(self, role: str) -> Actor:
        if self.get(role) is None:
            raise KeyError(f"unregistered agent role: {role}")
        with self._lock:
            self._active_actors.add(role)
        return Actor.agent(role)

    def deactivate(self, role: str) -> None:
        with self._lock:
            self._active_actors.discard(role)

    def active(self) -> list[str]:
        with self._lock:
            return sorted(self._active_actors)