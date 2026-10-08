#!/usr/bin/env python3
"""Local coding agent usage dashboard (Claude and Codex).

Only metadata and token counters are read from Claude Code JSONL logs. Prompt and
response content never enters the database or HTTP responses.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import parse_qs, urlparse

from remote_source import (RemoteError, fetch_remote, parse_remote_arg, parse_timestamp, safe_int, scan,
                           validate_host)


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DEFAULT_CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))

def _local_version() -> str | None:
    try:
        out = subprocess.run(["git", "describe", "--tags", "--abbrev=0"], cwd=ROOT, capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


VERSION = _local_version()
SEMVER_TAG = re.compile(r"^v\d+\.\d+\.\d+$")
UPDATE_LOCK = threading.Lock()


def _git(*args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout)


def _tag_key(tag: str) -> tuple[int, ...]:
    return tuple(int(part) for part in tag[1:].split("."))


def apply_update() -> tuple[int, dict[str, Any]]:
    if not UPDATE_LOCK.acquire(blocking=False):
        return 409, {"ok": False, "error": "update already running"}
    try:
        if _git("status", "--porcelain", "--untracked-files=no").stdout.strip():
            return 409, {"ok": False, "error": "checkout has local changes"}
        if _git("fetch", "--tags", "--force", "origin").returncode != 0:
            return 502, {"ok": False, "error": "git fetch failed"}
        tags = [tag for tag in _git("tag", "-l", "v*").stdout.split() if SEMVER_TAG.match(tag)]
        latest = max(tags, key=_tag_key, default=None)
        current = _local_version()
        if not latest or (current and SEMVER_TAG.match(current) and _tag_key(latest) <= _tag_key(current)):
            return 200, {"ok": True, "updated": False, "version": current}
        branch = _git("branch", "--show-current").stdout.strip()
        if branch == "main":
            command = ("merge", "--ff-only", latest)
        elif not branch:
            command = ("checkout", "--detach", latest)
        else:
            return 409, {"ok": False, "error": f"checkout is on branch {branch}; switch to main to update"}
        result = _git(*command)
        if result.returncode != 0:
            return 500, {"ok": False, "error": (result.stderr.strip().splitlines() or ["git failed"])[-1]}
        restart = bool(os.environ.get("INVOCATION_ID") or os.environ.get("USAGE_DASHBOARD_SUPERVISED"))
        if restart:
            threading.Timer(0.5, os._exit, [0]).start()
        return 200, {"ok": True, "updated": True, "version": latest, "restart": restart}
    except (OSError, subprocess.SubprocessError):
        return 500, {"ok": False, "error": "git unavailable"}
    finally:
        UPDATE_LOCK.release()
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
USAGE_BETA = "oauth-2025-04-20"
KEYCHAIN_SERVICE = "Claude Code-credentials"
PROFILE_PATH = ROOT / ".cache" / "usage-profile.json"
SETTINGS_PATH = ROOT / ".cache" / "settings.json"
LANGUAGES = ("en", "pt-BR", "es")
PROFILE_MAX_AGE_HOURS = 24
PROFILE_LOCK = threading.Lock()


def read_settings() -> dict[str, Any]:
    try:
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return settings if isinstance(settings, dict) else {}


def read_language() -> str:
    language = read_settings().get("language")
    return language if language in LANGUAGES else "en"


def load_remote_hosts(cli: Sequence[dict[str, str]] = ()) -> tuple[list[dict[str, str]], list[str]]:
    configured = read_settings().get("remote_hosts", [])
    if not isinstance(configured, list):
        return list(cli), ["remote_hosts must be a list"]
    hosts: dict[str, dict[str, str]] = {}
    errors = []
    for entry in configured:
        try:
            host = validate_host(entry)
        except ValueError as error:
            errors.append(str(error))
            continue
        hosts[host["name"]] = host
    for host in cli:
        hosts[host["name"]] = host
    return list(hosts.values()), errors


def refresh_profile(index: "UsageIndex", limits: dict[str, Any], default_timezone: str,
                    path: Path = PROFILE_PATH) -> bool:
    """Rebuild the Claude profile from already-indexed counters when missing or older than a day."""
    from build_usage_profile import account_reset, build_profile, save_profile
    if not PROFILE_LOCK.acquire(blocking=False):
        return False
    try:
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
            generated = datetime.fromisoformat(current["generated_at"].replace("Z", "+00:00"))
        except (OSError, KeyError, ValueError, TypeError, AttributeError):
            current = {}
        else:
            fresh = (datetime.now(timezone.utc) - generated).total_seconds() < PROFILE_MAX_AGE_HOURS * 3600
            if fresh and (current.get("weekly") or {}).get("raw_total", 1) > 0:
                return False
        timezone_name = (current.get("weekly") or {}).get("timezone") or default_timezone
        try:
            reset = account_reset(limits, timezone_name)
        except ValueError:
            return False
        with index.lock:
            profile = build_profile(
                index, lookback_days=current.get("lookback_days", 90), timezone_name=timezone_name,
                reset_weekday=reset.weekday(), reset_hour=reset.hour, reset_minute=reset.minute,
                half_life_days=current.get("half_life_days", 28), metric=current.get("metric", "fresh_tokens"),
            )
        save_profile(profile, path)
        return True
    finally:
        PROFILE_LOCK.release()


def project_root(cwd: str) -> str:
    """Resolve linked worktrees and repository subfolders without running Git."""
    if not cwd:
        return ''
    path = Path(cwd).expanduser()
    for folder in (path, *path.parents):
        git = folder / '.git'
        try:
            if git.is_dir():
                return str(folder.resolve())
            if git.is_file():
                text = git.read_text().strip()
                if text.startswith('gitdir:'):
                    git_dir = (folder / text.split(':', 1)[1].strip()).resolve()
                    common = git_dir / 'commondir'
                    if common.is_file():
                        return str((git_dir / common.read_text().strip()).resolve().parent)
                    return str(folder.resolve())
        except (OSError, RuntimeError):
            continue
    # Keep deleted conventional in-repository worktrees attached to their project.
    for marker in ('/.claude/worktrees/', '/.worktrees/', '/worktrees/'):
        if marker in str(path):
            return str(path).split(marker, 1)[0]
    return str(path)


class UsageIndex:
    """Incremental, content-free index over ~/.claude/projects JSONL files."""

    provider = "claude"

    def __init__(self, claude_dir: Path, db_path: Path):
        self.claude_dir = claude_dir
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(db_path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.remote_status: dict[str, dict[str, Any]] = {}
        self._create_schema()

    def _create_schema(self) -> None:
        self.connection.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS source_files (
                path TEXT PRIMARY KEY,
                offset INTEGER NOT NULL,
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_events (
                event_key TEXT PRIMARY KEY,
                source_path TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                model TEXT NOT NULL,
                cwd TEXT NOT NULL,
                project TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_creation_tokens INTEGER NOT NULL,
                thinking_tokens INTEGER NOT NULL,
                host TEXT NOT NULL DEFAULT 'local'
            );
            CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_events(timestamp_ms);
            CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id, timestamp_ms);
            CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model, timestamp_ms);
            CREATE INDEX IF NOT EXISTS idx_usage_source ON usage_events(source_path);
            """
        )
        columns = {row[1] for row in self.connection.execute("PRAGMA table_info(usage_events)")}
        if "host" not in columns:
            self.connection.execute("ALTER TABLE usage_events ADD COLUMN host TEXT NOT NULL DEFAULT 'local'")
        self.connection.commit()

    def refresh(self, remotes: Sequence[dict[str, str]] = (), command: list[str] | None = None) -> dict[str, Any]:
        started = time.monotonic()
        with self.lock, self.connection:
            totals = self._ingest(scan(self.provider, self.claude_dir, self._cursors("")), "", "local")
        statuses = [self._refresh_remote(host, command) for host in remotes]
        return {**totals, "remotes": statuses, "elapsed_ms": round((time.monotonic() - started) * 1000)}

    def _cursors(self, prefix: str) -> dict[str, list[int]]:
        rows = self.connection.execute("SELECT path, offset, size, mtime_ns FROM source_files")
        return {path[len(prefix):]: [offset, size, mtime] for path, offset, size, mtime in rows
                if path.startswith(prefix)}

    def _ingest(self, records: Iterable[dict[str, Any]], prefix: str, host: str) -> dict[str, int]:
        files = lines = events = 0
        for record in records:
            self._apply(record, prefix, host)
            files += 1
            lines += record["lines"]
            events += len(record["events"])
        return {"files": files, "lines": lines, "events": events}

    def _apply(self, record: dict[str, Any], prefix: str, host: str) -> None:
        path = prefix + record["path"]
        if record["reset"]:
            self.connection.execute("DELETE FROM usage_events WHERE source_path = ?", (path,))
        for event in record["events"]:
            self._upsert_event({**event, "source_path": path, "host": host})
        self.connection.execute(
            """INSERT INTO source_files(path, offset, size, mtime_ns) VALUES (?, ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET
                 offset=excluded.offset, size=excluded.size, mtime_ns=excluded.mtime_ns""",
            (path, record["offset"], record["size"], record["mtime_ns"]),
        )

    def _refresh_remote(self, host: dict[str, str], command: list[str] | None) -> dict[str, Any]:
        name = host["name"]
        with self.lock:
            cursors = self._cursors(f"{name}:")
        try:
            records = fetch_remote(host, self.provider, cursors, command)
        except RemoteError as error:
            status: dict[str, Any] = {"host": name, "ok": False, "error": str(error)}
        else:
            with self.lock, self.connection:
                status = {"host": name, "ok": True, **self._ingest(records, f"{name}:", name)}
        status["synced_at"] = datetime.now(timezone.utc).isoformat()
        self.remote_status[name] = status
        return status

    def _upsert_event(self, event: dict[str, Any]) -> None:
        columns = tuple(event.keys())
        placeholders = ",".join("?" for _ in columns)
        updates = ",".join(f"{column}=excluded.{column}" for column in columns if column != "event_key")
        self.connection.execute(
            f"""INSERT INTO usage_events ({','.join(columns)}) VALUES ({placeholders})
                ON CONFLICT(event_key) DO UPDATE SET {updates}
                WHERE excluded.timestamp_ms >= usage_events.timestamp_ms""",
            tuple(event[column] for column in columns),
        )

    def dashboard(self, start_ms: int, end_ms: int, bucket_ms: int) -> dict[str, Any]:
        where = "timestamp_ms >= ? AND timestamp_ms < ?"
        params = (start_ms, end_ms)
        sums = """COUNT(*) AS messages,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                  COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                  COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens"""
        with self.lock:
            totals = dict(self.connection.execute(
                f"SELECT {sums}, COUNT(DISTINCT session_id) AS sessions FROM usage_events WHERE {where}", params
            ).fetchone())
            models = [dict(row) for row in self.connection.execute(
                f"SELECT model, {sums} FROM usage_events WHERE {where} GROUP BY model ORDER BY "
                "SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) DESC",
                params,
            )]
            sessions = [dict(row) for row in self.connection.execute(
                f"""SELECT session_id, project, cwd, MIN(timestamp_ms) AS started_at,
                            MAX(timestamp_ms) AS last_active_at, {sums}
                     FROM usage_events WHERE {where}
                     GROUP BY session_id ORDER BY
                       SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) DESC
                     """,
                params,
            )]
            timeline = [dict(row) for row in self.connection.execute(
                f"""SELECT (timestamp_ms / ?) * ? AS bucket_ms, model, {sums}
                     FROM usage_events WHERE {where}
                     GROUP BY bucket_ms, model ORDER BY bucket_ms, model""",
                (bucket_ms, bucket_ms, start_ms, end_ms),
            )]
            session_timeline = [dict(row) for row in self.connection.execute(
                f"""SELECT (timestamp_ms / ?) * ? AS bucket_ms, session_id, cwd, {sums}
                     FROM usage_events WHERE {where}
                     GROUP BY bucket_ms, session_id, cwd ORDER BY bucket_ms, session_id, cwd""",
                (bucket_ms, bucket_ms, start_ms, end_ms),
            )]
            project_usage = [dict(row) for row in self.connection.execute(
                f"SELECT cwd, session_id, {sums} FROM usage_events WHERE {where} GROUP BY cwd, session_id", params
            )]
            first_event = self.connection.execute("SELECT MIN(timestamp_ms) FROM usage_events").fetchone()[0]
            last_event = self.connection.execute("SELECT MAX(timestamp_ms) FROM usage_events").fetchone()[0]

        for collection in (models, sessions, timeline, session_timeline):
            for item in collection:
                item["fresh_tokens"] = item["input_tokens"] + item["output_tokens"] + item["cache_creation_tokens"]
                item["total_tokens"] = item["fresh_tokens"] + item["cache_read_tokens"]
        projects_by_root = {}
        roots = {}
        keys = ('messages', 'input_tokens', 'output_tokens', 'cache_read_tokens',
                'cache_creation_tokens', 'thinking_tokens')
        for row in project_usage:
            cwd = row['cwd']
            if cwd not in roots:
                roots[cwd] = project_root(cwd)
            root = roots[cwd]
            item = projects_by_root.setdefault(root, {
                'project': Path(root).name if root else 'unknown', 'project_id': root,
                'cwd': root, '_sessions': set(), '_folders': set(), **dict.fromkeys(keys, 0),
            })
            item['_sessions'].add(row['session_id'])
            item['_folders'].add(cwd)
            for key in keys:
                item[key] += row[key]
        for row in session_timeline:
            row['project_id'] = roots[row['cwd']]
        projects = list(projects_by_root.values())
        for item in projects:
            item['sessions'] = len(item.pop('_sessions'))
            item['folders'] = sorted(item.pop('_folders'))
            item['fresh_tokens'] = item['input_tokens'] + item['output_tokens'] + item['cache_creation_tokens']
            item['total_tokens'] = item['fresh_tokens'] + item['cache_read_tokens']
        projects.sort(key=lambda item: (-item['total_tokens'], item['project_id']))
        totals["fresh_tokens"] = totals["input_tokens"] + totals["output_tokens"] + totals["cache_creation_tokens"]
        totals["total_tokens"] = totals["fresh_tokens"] + totals["cache_read_tokens"]
        return {
            "range": {"start_ms": start_ms, "end_ms": end_ms, "bucket_ms": bucket_ms},
            "coverage": {"first_event_ms": first_event, "last_event_ms": last_event},
            "totals": totals,
            "models": models,
            "projects": projects,
            "sessions": sessions,
            "timeline": timeline,
            "session_timeline": session_timeline,
        }


class QuotaClient:
    def __init__(self, claude_dir: Path, ttl_seconds: int = 300):
        self.credentials_path = claude_dir / ".credentials.json"
        self.ttl_seconds = ttl_seconds
        self.cached: dict[str, Any] | None = None
        self.cached_at = 0.0
        self.retry_at = 0.0
        self.last_error = None
        self.lock = threading.Lock()

    def get(self, force: bool = False, cache_only: bool = False) -> dict[str, Any]:
        with self.lock:
            age = time.monotonic() - self.cached_at
            if cache_only or time.monotonic() < self.retry_at:
                result = {**self.cached, "cache_age_seconds": round(age)} if self.cached else {
                    "ok": False, "limits": [], "error": "No cached limits. Use Sync now."}
                if self.last_error:
                    result.update(stale=True, error=self.last_error,
                                  retry_after_seconds=max(0, round(self.retry_at - time.monotonic())))
                return result
            if self.cached is not None and not force and age < self.ttl_seconds:
                return {**self.cached, "cache_age_seconds": round(age)}
            try:
                raw = self._fetch()
                normalized = self._normalize(raw)
                self.cached = {"ok": True, "fetched_at": datetime.now(timezone.utc).isoformat(), **normalized}
                self.cached_at = time.monotonic()
                self.last_error = None
                self.retry_at = 0.0
            except (OSError, KeyError, ValueError, urllib.error.URLError) as error:
                self.last_error = str(error)
                delay = self.ttl_seconds
                if isinstance(error, urllib.error.HTTPError) and error.code == 429:
                    retry_after = error.headers.get("Retry-After", "") if error.headers else ""
                    if retry_after.isdigit():
                        delay = max(delay, int(retry_after))
                self.retry_at = time.monotonic() + delay
                if self.cached is not None:
                    return {**self.cached, "stale": True, "error": str(error), "cache_age_seconds": round(age), "retry_after_seconds": delay}
                return {"ok": False, "error": str(error), "limits": [], "retry_after_seconds": delay}
            return {**self.cached, "cache_age_seconds": 0}

    def _access_token(self) -> str:
        try:
            raw = self.credentials_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            if sys.platform != "darwin":
                raise
            try:
                result = subprocess.run(
                    ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                    capture_output=True, text=True, timeout=10,
                )
            except subprocess.SubprocessError as error:
                raise OSError(f"macOS Keychain read failed: {error}") from None
            if result.returncode != 0:
                raise OSError(
                    f"Claude credentials not found in {self.credentials_path} or the macOS Keychain "
                    f"item '{KEYCHAIN_SERVICE}'. Log in with Claude Code first."
                ) from None
            raw = result.stdout
        return json.loads(raw)["claudeAiOauth"]["accessToken"]

    def _fetch(self) -> dict[str, Any]:
        request = urllib.request.Request(USAGE_URL, headers={
            "Authorization": f"Bearer {self._access_token()}",
            "anthropic-beta": USAGE_BETA, "Content-Type": "application/json",
            "User-Agent": "claude-usage-local/1.0",
        })
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.load(response)

    @staticmethod
    def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
        limits: list[dict[str, Any]] = []
        structured = raw.get("limits")
        if isinstance(structured, list) and structured:
            for item in structured:
                if not isinstance(item, dict) or item.get("percent") is None:
                    continue
                scope = item.get("scope") or {}
                model = (scope.get("model") or {}).get("display_name")
                kind = str(item.get("kind") or "limit")
                label = {
                    "session": "Sessão",
                    "weekly_all": "Semanal",
                    "weekly_scoped": f"Semanal · {model or 'modelo'}",
                }.get(kind, model or kind.replace("_", " ").title())
                limits.append({
                    "key": f"{kind}:{model or 'all'}",
                    "kind": kind,
                    "label": label,
                    "utilization": float(item["percent"]),
                    "resets_at": item.get("resets_at"),
                    "model": model,
                })
        else:
            for key, label, kind in (
                ("five_hour", "Sessão · 5h", "session"),
                ("seven_day", "Semanal", "weekly_all"),
                ("seven_day_opus", "Semanal · Opus", "weekly_scoped"),
                ("seven_day_sonnet", "Semanal · Sonnet", "weekly_scoped"),
            ):
                item = raw.get(key)
                if isinstance(item, dict) and item.get("utilization") is not None:
                    limits.append({
                        "key": key,
                        "kind": kind,
                        "label": label,
                        "utilization": float(item["utilization"]),
                        "resets_at": item.get("resets_at"),
                    })
        return {"limits": limits, "extra_usage": raw.get("extra_usage"), "source": "anthropic_oauth"}


class DashboardHandler(BaseHTTPRequestHandler):
    index: UsageIndex
    quota: QuotaClient
    cli_remotes: list[dict[str, str]] = []

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/settings":
            self._settings()
        elif path == "/api/update":
            self._update()
        else:
            self.send_error(404)

    def _settings(self) -> None:
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 4096)) or b"{}")
            language = body.get("language")
            if language not in LANGUAGES:
                raise ValueError("unsupported language")
        except (ValueError, AttributeError) as error:
            self._json({"ok": False, "error": str(error)}, status=400)
            return
        settings = read_settings()
        settings["language"] = language
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")
        self._json({"ok": True, "language": language})

    def _update(self) -> None:
        origin = self.headers.get("Origin")
        local = self.client_address[0] in ("127.0.0.1", "::1")
        same_origin = origin is None or urlparse(origin).netloc == self.headers.get("Host")
        if not (local and same_origin and self.headers.get("X-Requested-With") == "dashboard"):
            self._json({"ok": False, "error": "forbidden"}, 403)
            return
        status, payload = apply_update()
        self._json(payload, status)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/codex/dashboard":
            self._dashboard(parse_qs(parsed.query), codex=True)
            return
        if parsed.path in ("/api/codex/limits", "/api/snapshots"):
            query = parse_qs(parsed.query)
            if parsed.path == "/api/snapshots":
                self._json({"ok": True, "claude": self.snapshots.read("claude"),
                            "codex": self.snapshots.read("codex")})
                return
            force = query.get("force") == ["1"]
            result = self.codex_quota.get(force=force, cache_only=not force and query.get("sync") != ["1"])
            self.snapshots.record("codex", result)
            if not result.get("ok"):
                local = self.codex_index.local_limits()
                if local.get("ok"):
                    result = {**local, "stale": True, "error": result.get("error")}
            self._json(result)
            return
        if parsed.path == "/api/dashboard":
            self._dashboard(parse_qs(parsed.query))
            return
        if parsed.path == "/api/limits":
            query = parse_qs(parsed.query)
            force = query.get("force") == ["1"]
            result = self.quota.get(force=force, cache_only=not force and query.get("sync") != ["1"])
            self.snapshots.record("claude", result)
            self._json(result)
            return
        if parsed.path == "/api/profile":
            self._profile()
            return
        if parsed.path == "/api/health":
            self._json({"ok": True, "version": VERSION, "remotes": {
                "claude": list(self.index.remote_status.values()),
                "codex": list(self.codex_index.remote_status.values())}})
            return
        self._static(parsed.path)

    def _profile(self) -> None:
        refresh_profile(self.index, self.quota.get(cache_only=True), self.profile_timezone)
        try:
            profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
            generated = datetime.fromisoformat(profile["generated_at"].replace("Z", "+00:00"))
            age_hours = (datetime.now(timezone.utc) - generated).total_seconds() / 3600
            self._json({"ok": True, "stale": age_hours > 7 * 24, "age_hours": round(age_hours, 1), **profile,
                        "language": read_language()})
        except (OSError, KeyError, ValueError, json.JSONDecodeError) as error:
            self._json({
                "ok": False,
                "error": str(error),
                "hint": "execute: python3 build_usage_profile.py",
            })

    def _dashboard(self, query: dict[str, list[str]], codex: bool = False) -> None:
        now_ms = int(time.time() * 1000)
        try:
            end_ms = int(query.get("to", [now_ms])[0])
            start_ms = int(query.get("from", [end_ms - 5 * 60 * 60 * 1000])[0])
            bucket_ms = int(query.get("bucket", [self._auto_bucket(end_ms - start_ms)])[0])
            if start_ms >= end_ms or bucket_ms < 60_000:
                raise ValueError("invalid time range")
        except ValueError as error:
            self._json({"ok": False, "error": str(error)}, status=400)
            return
        index = self.codex_index if codex else self.index
        scan = None
        if query.get("sync") == ["1"]:
            hosts, errors = load_remote_hosts(self.cli_remotes)
            scan = index.refresh(hosts)
            scan["remotes"] += [{"host": "settings", "ok": False, "error": error} for error in errors]
        result = index.dashboard(start_ms, end_ms, bucket_ms)
        if codex:
            # Building from the already-indexed counters requires no network access.
            from build_usage_profile import account_reset, build_profile
            limits = self.codex_quota.get(cache_only=True)
            if not limits.get("ok") or limits.get("stale"):
                limits = index.local_limits()
            try:
                reset = account_reset(limits, self.profile_timezone)
                with index.lock:
                    profile = build_profile(index, lookback_days=90, timezone_name=self.profile_timezone,
                        reset_weekday=reset.weekday(), reset_hour=reset.hour, reset_minute=reset.minute,
                        half_life_days=28, metric="fresh_tokens")
                result["profile"] = {**profile, "source": "codex_jsonl_aggregates",
                                     "ok": profile["weekly"]["raw_total"] > 0}
            except ValueError:
                result["profile"] = {"ok": False}
            result["local_limits"] = index.local_limits()
        self._json({"ok": True, "scan": scan, **result})

    @staticmethod
    def _auto_bucket(duration_ms: int) -> int:
        if duration_ms <= 60 * 60 * 1000:
            return 60_000
        if duration_ms <= 6 * 60 * 60 * 1000:
            return 5 * 60_000
        if duration_ms <= 2 * 24 * 60 * 60 * 1000:
            return 15 * 60_000
        return 60 * 60_000

    def _static(self, path: str) -> None:
        names = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/i18n.js": "i18n.js", "/pace-profile.js": "pace-profile.js", "/styles.css": "styles.css", "/providers.js": "providers.js"}
        name = names.get(path)
        if not name:
            self.send_error(404)
            return
        file_path = STATIC_DIR / name
        content_types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_types[file_path.suffix])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, payload: dict[str, Any], status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def main() -> None:
    from codex_usage import CodexIndex, CodexQuotaClient, SnapshotStore, DEFAULT_CODEX_DIR
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    parser = argparse.ArgumentParser(description="Local Claude and Codex usage dashboard")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8787, help="port (default: 8787)")
    parser.add_argument("--claude-dir", type=Path, default=DEFAULT_CLAUDE_DIR)
    parser.add_argument("--db", type=Path, default=ROOT / ".cache" / "usage.sqlite3")
    parser.add_argument("--codex-dir", type=Path, default=DEFAULT_CODEX_DIR)
    parser.add_argument("--codex-bin", default="codex", help="Codex CLI executable for official limit reads")
    parser.add_argument("--remote", action="append", default=[], type=parse_remote_arg, metavar="NAME=SSH_TARGET",
                        help="pull usage logs from a remote host over SSH (repeatable; also .cache/settings.json remote_hosts)")
    parser.add_argument("--codex-db", type=Path, default=ROOT / ".cache" / "codex-usage.sqlite3")
    parser.add_argument("--snapshots-db", type=Path, default=ROOT / ".cache" / "quota-snapshots.sqlite3")
    parser.add_argument("--timezone", default="UTC", help="IANA timezone for the Codex historical profile")
    args = parser.parse_args()
    try:
        ZoneInfo(args.timezone)
    except ZoneInfoNotFoundError:
        parser.error("Unknown IANA timezone")

    DashboardHandler.index = UsageIndex(args.claude_dir.expanduser(), args.db)
    DashboardHandler.quota = QuotaClient(args.claude_dir.expanduser())
    DashboardHandler.codex_index = CodexIndex(args.codex_dir.expanduser(), args.codex_db)
    DashboardHandler.codex_quota = CodexQuotaClient(args.codex_dir.expanduser(), args.codex_bin)
    DashboardHandler.cli_remotes = args.remote
    DashboardHandler.snapshots = SnapshotStore(args.snapshots_db)
    DashboardHandler.profile_timezone = args.timezone
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"Usage Dashboard available at http://{args.host}:{args.port}")
    print("Conversation content is not stored or sent to the browser.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
