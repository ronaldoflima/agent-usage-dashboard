import json
import sys
import tempfile
import unittest
from pathlib import Path

from app import UsageIndex
from codex_usage import CodexIndex
from remote_source import RemoteError, fetch_remote, parse_remote_arg, scan, validate_host


def claude_line(message_id, output=30, timestamp="2026-09-22T10:00:00Z", session="session-1"):
    return json.dumps({"type": "assistant", "timestamp": timestamp, "sessionId": session, "cwd": "/tmp/demo",
        "message": {"id": message_id, "model": "claude-test", "content": "SECRET_TEXT", "usage": {
            "input_tokens": 10, "output_tokens": output, "cache_read_input_tokens": 100,
            "cache_creation_input_tokens": 20}}}) + "\n"


def codex_lines():
    def row(kind, payload, timestamp="2026-09-24T12:00:00Z"):
        return json.dumps({"type": kind, "timestamp": timestamp, "payload": payload}) + "\n"
    counters = dict(zip(("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"),
                        (100, 80, 20, 10)))
    return (row("session_meta", {"id": "codex-session", "cwd": "/tmp/x", "timestamp": "2026-09-24T12:00:00Z",
                                 "base_instructions": "SECRET_TEXT"})
            + row("turn_context", {"model": "codex-test", "cwd": "/tmp/x"})
            + row("event_msg", {"type": "token_count", "info": {"total_token_usage": counters,
                                                                "last_token_usage": counters}},
                  "2026-09-24T12:01:00Z"))


class ScanTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.log = self.root / "projects" / "-tmp-demo" / "s.jsonl"
        self.log.parent.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def test_claude_incremental_cursor_and_truncate(self):
        self.log.write_text(claude_line("m1") + claude_line("m2")[:-5])
        [first] = scan("claude", self.root, {})
        self.assertEqual((first["path"], first["reset"], len(first["events"])), ("projects/-tmp-demo/s.jsonl", False, 1))
        cursors = {first["path"]: (first["offset"], first["size"], first["mtime_ns"])}
        self.log.write_text(claude_line("m1") + claude_line("m2"))
        [second] = scan("claude", self.root, cursors)
        self.assertEqual([event["event_key"] for event in second["events"]], ["session-1:m2"])
        self.assertFalse(second["reset"])
        self.log.write_text(claude_line("m3"))
        later = {second["path"]: (second["offset"], second["size"], second["mtime_ns"])}
        [third] = scan("claude", self.root, later)
        self.assertTrue(third["reset"])
        self.assertEqual(third["events"][0]["event_key"], "session-1:m3")

    def test_unchanged_files_are_skipped(self):
        self.log.write_text(claude_line("m1"))
        [record] = scan("claude", self.root, {})
        cursors = {record["path"]: (record["offset"], record["size"], record["mtime_ns"])}
        self.assertEqual(list(scan("claude", self.root, cursors)), [])

    def test_codex_reparses_whole_file_and_never_carries_content(self):
        (self.root / "sessions").mkdir()
        (self.root / "sessions" / "r.jsonl").write_text(codex_lines())
        [record] = scan("codex", self.root, {})
        self.assertTrue(record["reset"])
        self.assertEqual(record["offset"], record["size"])
        self.assertEqual(len(record["events"]), 1)
        self.assertNotIn("SECRET_TEXT", json.dumps(record))


class FetchRemoteTest(unittest.TestCase):
    LOCAL_PYTHON = [sys.executable, "-"]

    def test_runs_extractor_through_stdin_and_returns_records(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "projects" / "p" / "s.jsonl"
            log.parent.mkdir(parents=True)
            log.write_text(claude_line("m1"))
            host = {"name": "box", "ssh_target": "user@example-host", "claude_dir": directory}
            records = fetch_remote(host, "claude", {}, command=self.LOCAL_PYTHON)
            self.assertEqual(records[0]["path"], "projects/p/s.jsonl")
            self.assertNotIn("SECRET_TEXT", json.dumps(records))
            cursors = {"projects/p/s.jsonl": [records[0]["offset"], records[0]["size"], records[0]["mtime_ns"]]}
            self.assertEqual(fetch_remote(host, "claude", cursors, command=self.LOCAL_PYTHON), [])

    def test_failures_become_remote_errors(self):
        host = {"name": "box", "ssh_target": "user@example-host"}
        with self.assertRaisesRegex(RemoteError, "boom"):
            fetch_remote(host, "claude", {}, command=[sys.executable, "-c", "import sys; sys.exit('boom')"])
        with self.assertRaisesRegex(RemoteError, "invalid response"):
            fetch_remote(host, "claude", {}, command=[sys.executable, "-c", "print('not json')"])
        with self.assertRaisesRegex(RemoteError, "timeout"):
            fetch_remote(host, "claude", {}, command=[sys.executable, "-c", "import time; time.sleep(5)"], timeout=1)


class ValidateHostTest(unittest.TestCase):
    def test_accepts_aliases_and_user_at_host(self):
        self.assertEqual(validate_host({"name": "vps", "ssh_target": "user@example-host", "extra": 1}),
                         {"name": "vps", "ssh_target": "user@example-host"})
        self.assertEqual(parse_remote_arg("box=example-alias"), {"name": "box", "ssh_target": "example-alias"})

    def test_rejects_option_injection_and_bad_names(self):
        for entry in ({"name": "vps", "ssh_target": "-oProxyCommand=x"}, {"name": "vps", "ssh_target": "a b"},
                      {"name": "local", "ssh_target": "h"}, {"name": "a:b", "ssh_target": "h"},
                      {"name": "vps", "ssh_target": "h", "claude_dir": ""}, "vps"):
            with self.assertRaises(ValueError):
                validate_host(entry)
        with self.assertRaises(ValueError):
            parse_remote_arg("no-equals")


class RemoteIndexTest(unittest.TestCase):
    LOCAL_PYTHON = [sys.executable, "-"]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.local, self.remote = base / "local", base / "remote"
        for root in (self.local, self.remote):
            (root / "projects" / "p").mkdir(parents=True)
        self.index = UsageIndex(self.local, base / "index.sqlite3")
        self.host = {"name": "box", "ssh_target": "user@example-host", "claude_dir": str(self.remote)}

    def tearDown(self):
        self.index.connection.close()
        self.temp.cleanup()

    def totals(self):
        return self.index.dashboard(0, 2_000_000_000_000, 60_000)["totals"]

    def test_aggregates_remote_and_dedups_shared_sessions(self):
        (self.local / "projects" / "p" / "a.jsonl").write_text(claude_line("m1", session="s-local"))
        (self.remote / "projects" / "p" / "b.jsonl").write_text(
            claude_line("m2", session="s-remote") + claude_line("m1", session="s-local"))
        result = self.index.refresh([self.host], command=self.LOCAL_PYTHON)
        self.assertEqual(result["remotes"][0]["host"], "box")
        self.assertTrue(result["remotes"][0]["ok"])
        self.assertEqual(self.totals()["messages"], 2)
        hosts = dict(self.index.connection.execute("SELECT event_key, host FROM usage_events"))
        self.assertEqual(hosts["s-remote:m2"], "box")
        paths = {row[0] for row in self.index.connection.execute("SELECT path FROM source_files")}
        self.assertEqual(paths, {"projects/p/a.jsonl", "box:projects/p/b.jsonl"})
        self.assertEqual(self.index.refresh([self.host], command=self.LOCAL_PYTHON)["remotes"][0]["files"], 0)

    def test_remote_failure_keeps_local_data_and_cursors(self):
        (self.local / "projects" / "p" / "a.jsonl").write_text(claude_line("m1"))
        failing = [sys.executable, "-c", "import sys; sys.exit('ssh: connect refused')"]
        result = self.index.refresh([self.host], command=failing)
        self.assertFalse(result["remotes"][0]["ok"])
        self.assertEqual(result["remotes"][0]["error"], "ssh: connect refused")
        self.assertEqual(self.totals()["messages"], 1)
        self.assertEqual(self.index.remote_status["box"]["ok"], False)

    def test_migrates_existing_database_without_host_column(self):
        path = Path(self.temp.name) / "old.sqlite3"
        import sqlite3
        connection = sqlite3.connect(path)
        connection.execute("""CREATE TABLE usage_events (event_key TEXT PRIMARY KEY, source_path TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL,
            project TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
            thinking_tokens INTEGER NOT NULL)""")
        connection.execute("INSERT INTO usage_events VALUES ('k','p',1,'s','m','','x',1,1,0,0,0)")
        connection.commit()
        connection.close()
        migrated = UsageIndex(self.local, path)
        self.assertEqual(migrated.connection.execute("SELECT host FROM usage_events").fetchone()[0], "local")
        migrated.connection.close()

    def test_codex_remote_observation_is_stored(self):
        (self.remote / "sessions").mkdir()
        (self.remote / "sessions" / "r.jsonl").write_text(codex_lines())
        codex = CodexIndex(self.local, Path(self.temp.name) / "codex.sqlite3")
        host = {"name": "box", "ssh_target": "user@example-host", "codex_dir": str(self.remote)}
        result = codex.refresh([host], command=self.LOCAL_PYTHON)
        self.assertTrue(result["remotes"][0]["ok"])
        self.assertEqual(codex.dashboard(0, 2_000_000_000_000, 60_000)["totals"]["messages"], 1)
        codex.connection.close()
