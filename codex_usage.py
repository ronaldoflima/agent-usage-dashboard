"""Codex adapters. Persist counters only; never credentials or conversation text."""
from __future__ import annotations

import json
import os
import selectors
import subprocess
import time
from pathlib import Path

from app import QuotaClient, UsageIndex
from remote_source import normalize_limits, parse_timestamp

DEFAULT_CODEX_DIR = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))


class CodexQuotaClient(QuotaClient):
    def __init__(self, codex_dir: Path, binary: str = "codex"):
        super().__init__(codex_dir)
        self.codex_dir, self.binary = codex_dir, binary

    _normalize = staticmethod(normalize_limits)

    def _fetch(self):
        """Only initialize + read account limits. Never start a thread or turn."""
        env = {**os.environ, "CODEX_HOME": str(self.codex_dir)}
        try:
            with subprocess.Popen([self.binary, "app-server"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  env=env) as process:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    buffer = b""
                    deadline = time.monotonic() + 12

                    def send(message):
                        process.stdin.write(json.dumps(message).encode() + b"\n")
                        process.stdin.flush()

                    try:
                        send({"id": 1, "method": "initialize", "params": {
                            "clientInfo": {"name": "local_usage_dashboard", "version": "1.0"}}})
                        while time.monotonic() < deadline:
                            if not selector.select(max(0, deadline - time.monotonic())):
                                break
                            chunk = os.read(process.stdout.fileno(), 65536)
                            if not chunk:
                                break
                            buffer += chunk
                            if len(buffer) > 2_000_000:
                                raise ValueError("Codex response exceeded the size limit.")
                            while b"\n" in buffer:
                                line, buffer = buffer.split(b"\n", 1)
                                try:
                                    message = json.loads(line)
                                except ValueError:
                                    continue
                                if message.get("id") not in (1, 2):
                                    continue
                                if "error" in message:
                                    # Never echo remote errors that might include account data.
                                    raise ValueError("Codex account read failed. Check CLI login and version.")
                                if message["id"] == 1:
                                    send({"method": "initialized", "params": {}})
                                    send({"id": 2, "method": "account/rateLimits/read", "params": {}})
                                elif isinstance(message.get("result"), dict):
                                    return message["result"]
                        raise ValueError("Codex account read timed out or the process exited.")
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            try:
                                process.wait(timeout=2)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait()
        except OSError:
            raise ValueError("Codex CLI unavailable. Install it or configure --codex-bin.") from None


class CodexIndex(UsageIndex):
    """Reparse changed rollouts to preserve cumulative baselines across appends.

    Unchanged files are skipped. Forked history before session creation is ignored;
    cumulative counters establish a baseline but never count as new activity.
    """
    provider = "codex"

    def __init__(self, codex_dir: Path, db_path: Path):
        super().__init__(codex_dir, db_path)
        self.codex_dir = codex_dir
        self.connection.execute("""CREATE TABLE IF NOT EXISTS limit_observations (
            source_path TEXT PRIMARY KEY, observed_at TEXT NOT NULL, payload TEXT NOT NULL)""")
        self.connection.commit()

    def _apply(self, record, prefix, host):
        super()._apply(record, prefix, host)
        path = prefix + record["path"]
        self.connection.execute("DELETE FROM limit_observations WHERE source_path=?", (path,))
        if record["observation"]:
            self.connection.execute("INSERT INTO limit_observations VALUES (?, ?, ?)",
                (path, record["observation"]["fetched_at"], json.dumps(record["observation"])))

    def local_limits(self):
        with self.lock:
            row = self.connection.execute(
                "SELECT payload FROM limit_observations ORDER BY observed_at DESC LIMIT 1").fetchone()
        return json.loads(row[0]) if row else {"ok": False, "limits": [], "error": "No local Codex limit snapshot."}


class SnapshotStore:
    """Keep official samples separate from inferred activity and local snapshots."""
    def __init__(self, path):
        import sqlite3
        import threading
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS quota_snapshots (
            provider TEXT, key TEXT, observed_ms INTEGER, resets_at TEXT,
            utilization REAL, window_minutes INTEGER,
            PRIMARY KEY (provider, key, observed_ms))""")
        self.db.commit()

    def record(self, provider, payload):
        observed = parse_timestamp(payload.get("fetched_at"))
        if not payload.get("ok") or payload.get("stale") or observed is None:
            return
        if payload.get("source") not in ("anthropic_oauth", "codex_app_server"):
            return
        with self.lock, self.db:
            for limit in payload.get("limits", []):
                self.db.execute("INSERT OR IGNORE INTO quota_snapshots VALUES (?, ?, ?, ?, ?, ?)",
                    (provider, limit["key"], observed, limit.get("resets_at"), limit["utilization"],
                     limit.get("window_minutes", 300 if limit["kind"] == "session" else 10080)))

    def read(self, provider):
        cutoff = int((time.time() - 90 * 86400) * 1000)
        with self.lock:
            return [dict(row) for row in self.db.execute(
                "SELECT * FROM quota_snapshots WHERE provider=? AND observed_ms>=? ORDER BY observed_ms",
                (provider, cutoff))]
