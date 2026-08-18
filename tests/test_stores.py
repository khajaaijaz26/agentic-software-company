"""Tests for stores: state, event, artifact."""

import tempfile
import unittest
from pathlib import Path

from agentic_company.artifact_store import ArtifactStore, ArtifactStoreError
from agentic_company.contracts import Actor, DomainEvent
from agentic_company.event_store import EventStore, EventStoreError
from agentic_company.state_store import StateStore


class TestStateStore(unittest.TestCase):
    def test_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            store = StateStore(path)
            store.set("k", {"a": 1})
            store.update("k", b=2)
            self.assertEqual(store.get("k"), {"a": 1, "b": 2})

            reloaded = StateStore(path)
            self.assertEqual(reloaded.get("k"), {"a": 1, "b": 2})

    def test_get_default(self) -> None:
        store = StateStore()
        self.assertIsNone(store.get("missing"))
        self.assertEqual(store.get("missing", 42), 42)


class TestEventStore(unittest.TestCase):
    def test_append_and_query(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.jsonl"
            store = EventStore(path)
            store.append(DomainEvent(event_type="project.created", actor=Actor.system(), data={"x": 1}, project_id="p1"))
            store.append(DomainEvent(event_type="task.dispatch", actor=Actor.agent("tl"), data={}, project_id="p2"))
            store.append(DomainEvent(event_type="task.dispatch", actor=Actor.agent("tl"), data={}, project_id="p1"))

            self.assertEqual(store.sequence, 3)
            self.assertEqual(len(store.events_for(project_id="p1")), 2)
            self.assertEqual(len(store.events_for(event_type="task.dispatch")), 2)
            self.assertEqual(len(store.events_for(project_id="p1", event_type="task.dispatch")), 1)

            reloaded = EventStore(path)
            self.assertEqual(reloaded.sequence, 3)
            self.assertEqual(reloaded.events_for(project_id="p1")[0].event_type, "project.created")

    def test_append_only_no_mutation(self) -> None:
        store = EventStore()
        payload = {"nested": {"v": 1}}
        event = DomainEvent(event_type="a", actor=Actor.system(), data=payload)
        store.append(event)
        store.append(DomainEvent(event_type="b", actor=Actor.system(), data={"v": 2}))
        payload["nested"]["v"] = 99
        self.assertEqual(store.sequence, 2)
        first = store.events_for()[0]
        self.assertEqual(first.event_type, "a")
        self.assertEqual(first.data["nested"]["v"], 1)
        first.data["nested"]["v"] = 50
        self.assertEqual(store.events_for()[0].data["nested"]["v"], 1)
        with self.assertRaises(EventStoreError):
            store.append(event)
        with self.assertRaises(EventStoreError):
            store.clear()


class TestArtifactStore(unittest.TestCase):
    def test_store_and_read(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = ArtifactStore(tmp)
            meta = store.store_text("docs/spec.md", "# Spec")
            self.assertEqual(len(meta["sha256"]), 64)
            self.assertTrue(all(c in "0123456789abcdef" for c in meta["sha256"]))
            self.assertEqual(store.read_text("docs/spec.md"), "# Spec")
            self.assertTrue(store.verify("docs/spec.md", meta["sha256"]))

    def test_path_traversal_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = ArtifactStore(tmp)
            with self.assertRaises(ArtifactStoreError):
                store.store("../escape.txt", b"x")

    def test_read_missing_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = ArtifactStore(tmp)
            with self.assertRaises(ArtifactStoreError):
                store.read("nope.txt")

    def test_content_addressing_deduplicates_and_refs_are_immutable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = ArtifactStore(tmp)
            first = store.store_text("docs/a.md", "same")
            second = store.store_text("docs/b.md", "same")
            self.assertEqual(first["path"], second["path"])
            self.assertEqual(first["sha256"], second["sha256"])
            self.assertEqual(store.store_text("docs/a.md", "same")["sha256"], first["sha256"])
            with self.assertRaises(ArtifactStoreError):
                store.store_text("docs/a.md", "different")

    def test_corrupt_content_addressed_object_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = ArtifactStore(tmp)
            meta = store.store_text("docs/spec.md", "original")
            Path(meta["path"]).write_text("tampered", encoding="utf-8")
            with self.assertRaises(ArtifactStoreError):
                store.read("docs/spec.md")


if __name__ == "__main__":
    unittest.main()
