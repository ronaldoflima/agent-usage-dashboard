import io
import json
import shutil
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from codex_usage import CodexIndex, CodexQuotaClient, SnapshotStore, normalize_limits
from remote_source import codex_records


def line(kind, payload, timestamp="2026-09-24T12:00:00Z"):
    return (json.dumps({"type": kind, "timestamp": timestamp, "payload": payload}) + "\n").encode()


def usage(total, last=None, timestamp="2026-09-24T12:01:00Z"):
    def counters(values):
        return dict(zip(("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"), values))
    info = {"total_token_usage": counters(total)}
    if last is not None:
        info["last_token_usage"] = counters(last)
    return line("event_msg", {"type": "token_count", "info": info}, timestamp)


class CodexIndexTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.log = self.root / "sessions" / "test.jsonl"
        self.log.parent.mkdir()
        self.index = CodexIndex(self.root, self.root / "index.sqlite3")
        self.header = line("session_meta", {"id": "synthetic-session", "cwd": "/tmp/example",
            "timestamp": "2026-09-24T12:00:00Z", "base_instructions": "SECRET_PROMPT"})
        self.context = line("turn_context", {"model": "test-model", "cwd": "/tmp/example"})

    def tearDown(self):
        self.index.connection.close()
        self.temp.cleanup()

    def totals(self):
        return self.index.dashboard(0, 2_000_000_000_000, 60000)["totals"]

    def test_deltas_dedup_cache_and_reasoning(self):
        event = usage((100, 80, 20, 10), (100, 80, 20, 10))
        self.log.write_bytes(self.header + self.context + event + event + usage((150, 110, 30, 15)))
        self.index.refresh()
        totals = self.totals()
        self.assertEqual(totals["messages"], 2)
        self.assertEqual(totals["input_tokens"], 40)
        self.assertEqual(totals["cache_read_tokens"], 110)
        self.assertEqual(totals["output_tokens"], 30)
        self.assertEqual(totals["thinking_tokens"], 15)
        self.assertEqual(totals["total_tokens"], 180)
        self.assertEqual(totals["fresh_tokens"], 70)
        self.assertNotIn("SECRET_PROMPT", "".join(self.index.connection.iterdump()))
        self.assertEqual(self.index.refresh()["files"], 0)

    def test_append_partial_and_truncate(self):
        initial = self.header + self.context + usage((100, 80, 20, 10), (100, 80, 20, 10))
        next_event = usage((150, 110, 30, 15), timestamp="2026-09-24T12:02:00Z")
        self.log.write_bytes(initial + next_event[:-8])
        self.index.refresh()
        self.assertEqual(self.totals()["total_tokens"], 120)
        self.log.write_bytes(initial + next_event)
        self.index.refresh()
        self.assertEqual(self.totals()["total_tokens"], 180)
        self.log.write_bytes(initial)
        self.index.refresh()
        self.assertEqual(self.totals()["total_tokens"], 120)

    def test_inherited_history_and_counter_reset(self):
        inherited = usage((1000, 800, 100, 50), (1000, 800, 100, 50), "2026-09-24T11:00:00Z")
        current = usage((1100, 850, 120, 60))
        reset = usage((200, 100, 30, 20), (50, 30, 10, 5), "2026-09-24T12:02:00Z")
        records, _ = codex_records(io.BytesIO(self.header + self.context + inherited + current + reset), "x")
        self.assertEqual(len(records), 2)
        self.assertEqual(sum(r["input_tokens"] + r["cache_read_tokens"] + r["output_tokens"] for r in records), 180)

    def test_unknown_baseline_is_not_invented(self):
        records, _ = codex_records(io.BytesIO(self.header + usage((10000, 8000, 100, 50))), "x")
        self.assertEqual(records, [])

    def test_archive_does_not_duplicate(self):
        self.log.write_bytes(self.header + usage((100, 80, 20, 10), (100, 80, 20, 10)))
        self.index.refresh()
        archived = self.root / "archived_sessions"
        archived.mkdir()
        self.log.rename(archived / self.log.name)
        self.index.refresh()
        self.assertEqual(self.totals()["total_tokens"], 120)

    def test_local_limits_allow_info_null_without_tokens(self):
        self.log.write_bytes(self.header + line("event_msg", {"type": "token_count", "info": None,
            "rate_limits": {"primary": {"used_percent": 22, "window_minutes": 10080, "resets_at": 2_000_000_000}}}))
        self.index.refresh()
        snapshot = self.index.local_limits()
        self.assertEqual(snapshot["source"], "codex_local_snapshot")
        self.assertEqual(snapshot["limits"][0]["utilization"], 22)
        self.assertEqual(self.totals()["total_tokens"], 0)


class CodexQuotaTest(unittest.TestCase):
    def test_normalize_multiple_buckets_and_arbitrary_windows(self):
        data = {"rateLimitsByLimitId": {
            "codex": {"primary": {"usedPercent": 42, "windowDurationMins": 300, "resetsAt": 2_000_000_000},
                      "secondary": {"usedPercent": 10, "windowDurationMins": 10080, "resetsAt": 2_000_100_000}},
            "other": {"primary": {"usedPercent": 3, "windowDurationMins": 15, "resetsAt": 2_000_000_000}}}}
        result = normalize_limits(data)["limits"]
        self.assertEqual([r["window_minutes"] for r in result], [300, 10080, 15])
        self.assertEqual(result[1]["kind"], "weekly_all")
        self.assertNotEqual(result[0]["key"], result[2]["key"])

    def test_cache_only_and_force_cooldown(self):
        client = CodexQuotaClient(Path("/unused"))
        with patch.object(client, "_fetch", side_effect=ValueError("unavailable")) as fetch:
            client.get(cache_only=True)
            fetch.assert_not_called()
            client.get(force=True)
            client.get(force=True)
            self.assertEqual(fetch.call_count, 1)

    def test_real_stdio_handshake_with_fake_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "codex"
            shutil.copyfile(Path(__file__).parent / "fixtures" / "fake_codex.py", binary)
            binary.chmod(0o700)
            client = CodexQuotaClient(Path(directory), str(binary))
            result = client.get(force=True)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["source"], "codex_app_server")
            self.assertEqual(result["limits"][0]["utilization"], 25)

    def test_snapshot_idempotence_sources_and_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SnapshotStore(Path(directory) / "snapshots.sqlite3")
            payload = {"ok": True, "source": "codex_app_server",
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "limits": normalize_limits({"primary": {"used_percent": 10, "window_minutes": 300,
                            "resets_at": time.time() + 5000}})["limits"]}
            store.record("codex", payload)
            store.record("codex", payload)
            store.record("claude", {**payload, "stale": True})
            store.record("claude", {**payload, "source": "codex_local_snapshot"})
            self.assertEqual(len(store.read("codex")), 1)
            self.assertEqual(store.read("claude"), [])
            store.db.close()
