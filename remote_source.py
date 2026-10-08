"""Content-free token usage extraction from Claude Code and Codex session logs.

Self-contained (stdlib only, no project imports): the whole file is piped to
`python3 -` on remote hosts, so local and remote scans share one parser.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

DEFAULT_REMOTE_DIRS = {"claude": "~/.claude", "codex": "~/.codex"}
HOST_NAME = re.compile(r"[A-Za-z0-9_-]{1,32}")
SSH_TARGET = re.compile(r"[^\s\x00-\x1f\x7f-][^\s\x00-\x1f\x7f]*")
CODEX_KEYS = ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens")


def parse_timestamp(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def safe_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def normalize_limits(raw):
    """Accept both the documented RPC format and rollout snake_case snapshots."""
    if not isinstance(raw, dict):
        raise ValueError("Invalid Codex limits response.")
    buckets = raw.get("rateLimitsByLimitId")
    if not isinstance(buckets, dict) or not buckets:
        bucket = raw.get("rateLimits", raw)
        if not isinstance(bucket, dict):
            return {"limits": [], "source": "codex_app_server"}
        buckets = {bucket.get("limitId", bucket.get("limit_id", "codex")): bucket}
    limits = []
    for bucket_id, bucket in buckets.items():
        if not isinstance(bucket, dict):
            continue
        for window in ("primary", "secondary"):
            item = bucket.get(window)
            if not isinstance(item, dict):
                continue
            pct = item.get("usedPercent", item.get("used_percent"))
            minutes = item.get("windowDurationMins", item.get("window_minutes"))
            reset = item.get("resetsAt", item.get("resets_at"))
            try:
                pct, minutes, reset = float(pct), int(minutes), float(reset)
                if not math.isfinite(pct) or not 0 <= pct <= 100 or minutes <= 0:
                    continue
                resets_at = datetime.fromtimestamp(reset, timezone.utc).isoformat()
            except (TypeError, ValueError, OverflowError, OSError):
                continue
            limits.append({
                "key": f"{bucket_id}:{window}", "bucket": str(bucket_id),
                "kind": "weekly_all" if minutes == 10080 else "session",
                "label": str(bucket.get("limitName") or bucket.get("limit_name") or bucket_id),
                "window_minutes": minutes, "utilization": pct, "resets_at": resets_at,
            })
    return {"limits": limits, "source": "codex_app_server"}


def claude_event(raw: bytes, source_path: str) -> dict[str, Any] | None:
    try:
        row = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if row.get("type") != "assistant" or not isinstance(row.get("message"), dict):
        return None
    message = row["message"]
    usage = message.get("usage")
    timestamp_ms = parse_timestamp(row.get("timestamp"))
    if not isinstance(usage, dict) or timestamp_ms is None:
        return None

    session_id = str(row.get("sessionId") or row.get("session_id") or "unknown")
    message_id = str(message.get("id") or row.get("uuid") or "")
    if not message_id:
        message_id = hashlib.sha256(raw).hexdigest()
    cwd = str(row.get("cwd") or "")
    project = Path(cwd).name if cwd else "unknown"
    details = usage.get("output_tokens_details") or {}
    return {
        "event_key": f"{session_id}:{message_id}",
        "source_path": source_path,
        "timestamp_ms": timestamp_ms,
        "session_id": session_id,
        "model": str(message.get("model") or "unknown"),
        "cwd": cwd,
        "project": project,
        "input_tokens": safe_int(usage.get("input_tokens")),
        "output_tokens": safe_int(usage.get("output_tokens")),
        "cache_read_tokens": safe_int(usage.get("cache_read_input_tokens")),
        "cache_creation_tokens": safe_int(usage.get("cache_creation_input_tokens")),
        "thinking_tokens": safe_int(details.get("thinking_tokens")),
    }


def codex_records(handle, relative):
    session = relative
    model, cwd = "unknown", ""
    created = None
    previous = None
    records = []
    observation = None
    keys = CODEX_KEYS
    for number, raw in enumerate(handle):
        if not raw.endswith(b"\n"):
            break
        try:
            row = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(row, dict) or not isinstance(row.get("payload"), dict):
            continue
        payload = row["payload"]
        if row.get("type") == "session_meta":
            session = str(payload.get("id") or payload.get("session_id") or relative)
            cwd = str(payload.get("cwd") or "")
            created = parse_timestamp(payload.get("timestamp"))
            continue
        if row.get("type") == "turn_context":
            model = str(payload.get("model") or "unknown")
            cwd = str(payload.get("cwd") or cwd)
            continue
        if row.get("type") != "event_msg" or payload.get("type") != "token_count":
            continue
        timestamp = parse_timestamp(row.get("timestamp"))
        if timestamp is None:
            continue
        inherited = created is not None and timestamp < created
        rate_limits = payload.get("rate_limits")
        if not inherited and isinstance(rate_limits, dict):
            normalized = normalize_limits(rate_limits)
            if normalized["limits"]:
                observation = {"ok": True, **normalized, "source": "codex_local_snapshot",
                               "fetched_at": datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat()}
        info = payload.get("info")
        if not isinstance(info, dict) or not isinstance(info.get("total_token_usage"), dict):
            continue
        current = {key: safe_int(info["total_token_usage"].get(key)) for key in keys}
        if inherited:
            previous = current
            continue
        if previous == current:
            continue  # repeated notifications are not additional responses
        if previous is None or any(current[k] < previous[k] for k in keys):
            # First observation and counter resets: last request, not lifetime usage.
            last = info.get("last_token_usage")
            delta = {key: safe_int(last.get(key)) for key in keys} if isinstance(last, dict) else None
        else:
            delta = {key: current[key] - previous[key] for key in keys}
        previous = current
        if not delta or not (delta["input_tokens"] + delta["output_tokens"]):
            continue
        cached = min(delta["cached_input_tokens"], delta["input_tokens"])
        records.append({
            "event_key": f"{session}:{timestamp}:{number}", "source_path": relative,
            "timestamp_ms": timestamp, "session_id": session, "model": model,
            "cwd": cwd, "project": Path(cwd).name if cwd else "unknown",
            "input_tokens": delta["input_tokens"] - cached,
            "cache_read_tokens": cached, "cache_creation_tokens": 0,
            "output_tokens": delta["output_tokens"],
            "thinking_tokens": min(delta["reasoning_output_tokens"], delta["output_tokens"]),
        })
    return records, observation


def _source_files(provider: str, root: Path):
    if provider == "claude":
        return (root / "projects").rglob("*.jsonl")
    return (path for folder in ("sessions", "archived_sessions") for path in (root / folder).rglob("*.jsonl"))


def _claude_record(path: Path, relative: str, stat, previous) -> dict[str, Any]:
    offset = int(previous[0]) if previous and stat.st_size >= previous[0] else 0
    committed, lines, events = offset, 0, []
    with path.open("rb") as handle:
        handle.seek(offset)
        while True:
            line_start = handle.tell()
            raw = handle.readline()
            if not raw:
                break
            if not raw.endswith(b"\n"):
                committed = line_start
                break
            committed = handle.tell()
            lines += 1
            event = claude_event(raw, relative)
            if event is not None:
                events.append(event)
    return {"offset": committed, "reset": bool(previous) and offset == 0, "lines": lines,
            "events": events, "observation": None}


def _codex_record(path: Path, relative: str, stat) -> dict[str, Any]:
    with path.open("rb") as handle:
        events, observation = codex_records(handle, relative)
    return {"offset": stat.st_size, "reset": True, "lines": 0, "events": events, "observation": observation}


def scan(provider: str, root, cursors) -> Iterator[dict[str, Any]]:
    root = Path(root).expanduser()
    for path in _source_files(provider, root):
        try:
            stat = path.stat()
            relative = str(path.relative_to(root))
            previous = cursors.get(relative)
            if previous and previous[1] == stat.st_size and previous[2] == stat.st_mtime_ns:
                continue
            body = (_claude_record(path, relative, stat, previous) if provider == "claude"
                    else _codex_record(path, relative, stat))
        except OSError:
            continue
        yield {"path": relative, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns, **body}


def _emit(provider: str, root: str, cursors: dict) -> None:
    for record in scan(provider, root, cursors):
        sys.stdout.write(json.dumps(record, separators=(",", ":")) + "\n")


class RemoteError(Exception):
    pass


def ssh_command(target: str) -> list[str]:
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target, "python3", "-"]


def _run(command: list[str], payload: bytes, timeout: int) -> bytes:
    try:
        result = subprocess.run(command, input=payload, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RemoteError(f"timeout after {timeout}s") from None
    except OSError as error:
        raise RemoteError(str(error)) from None
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip().splitlines()
        raise RemoteError((detail[-1] if detail else f"exit {result.returncode}")[:200])
    return result.stdout


def fetch_remote(host, provider, cursors, command=None, timeout=60):
    root = host.get(f"{provider}_dir") or DEFAULT_REMOTE_DIRS[provider]
    script = (Path(__file__).read_text(encoding="utf-8")
              + f"\n_emit({provider!r}, {root!r}, json.loads({json.dumps(cursors)!r}))\n")
    stdout = _run(command or ssh_command(host["ssh_target"]), script.encode(), timeout)
    try:
        return [json.loads(line) for line in stdout.splitlines() if line.strip()]
    except ValueError:
        raise RemoteError("invalid response") from None


def _shell_path(path: str) -> str:
    if path == "~" or path.startswith("~/"):
        return "~/" + shlex.quote(path[2:]) if path[2:] else "~"
    return shlex.quote(path)


def ingest_command(host, args: list[str]) -> list[str]:
    app = host["push"]["dir"].rstrip("/") + "/app.py"
    return [*ssh_command(host["ssh_target"])[:-2],
            " ".join(["python3", _shell_path(app), "ingest", *map(shlex.quote, args)])]


def push_remote(host, provider, root, command=None, timeout=300) -> dict[str, int]:
    args = ["--as", host["push"]["as"], "--provider", provider]

    def call(extra, payload, seconds):
        argv = [*command, *args, *extra] if command else ingest_command(host, [*args, *extra])
        try:
            return json.loads(_run(argv, payload, seconds))
        except ValueError:
            raise RemoteError("invalid response") from None

    cursors = call(["--cursors"], b"", 60)
    if not isinstance(cursors, dict):
        raise RemoteError("invalid response")
    payload = "".join(json.dumps(record, separators=(",", ":")) + "\n" for record in scan(provider, root, cursors))
    if not payload:
        return {"files": 0, "lines": 0, "events": 0}
    totals = call([], payload.encode(), timeout)
    if not isinstance(totals, dict):
        raise RemoteError("invalid response")
    return {key: safe_int(totals.get(key)) for key in ("files", "lines", "events")}


def valid_name(name) -> bool:
    return isinstance(name, str) and bool(HOST_NAME.fullmatch(name)) and name != "local"


def validate_host(entry) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise ValueError("remote host must be an object")
    name, target = entry.get("name"), entry.get("ssh_target")
    if not valid_name(name):
        raise ValueError(f"invalid remote host name: {name!r}")
    if not isinstance(target, str) or not SSH_TARGET.fullmatch(target):
        raise ValueError(f"invalid ssh_target for {name}")
    host = {"name": name, "ssh_target": target}
    for key in ("claude_dir", "codex_dir"):
        if key in entry:
            if not isinstance(entry[key], str) or not entry[key].strip():
                raise ValueError(f"invalid {key} for {name}")
            host[key] = entry[key]
    if "push" in entry:
        push = entry["push"]
        if not isinstance(push, dict) or not isinstance(push.get("dir"), str) or not push["dir"].strip():
            raise ValueError(f"invalid push.dir for {name}")
        if not valid_name(push.get("as")):
            raise ValueError(f"invalid push.as for {name}")
        host["push"] = {"dir": push["dir"], "as": push["as"]}
    return host


def parse_remote_arg(value: str) -> dict[str, str]:
    name, separator, target = value.partition("=")
    if not separator:
        raise ValueError("expected name=ssh_target")
    return validate_host({"name": name, "ssh_target": target})
