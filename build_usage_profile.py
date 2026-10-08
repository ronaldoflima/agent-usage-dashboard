#!/usr/bin/env python3
"""Build a privacy-safe historical usage profile for the dashboard.

The output contains only aggregate hourly weights. No prompts, responses, file
names, or session identifiers are exported.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from app import DEFAULT_CLAUDE_DIR, ROOT, QuotaClient, UsageIndex


WEEK_HOURS = 7 * 24
WEEKDAY_NAMES = ("segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo")


def account_reset(payload: dict, timezone_name: str) -> datetime:
    """Read the account-wide weekly reset, never a model-specific window."""
    if payload.get("ok") and not payload.get("stale"):
        for limit in payload.get("limits", []):
            if limit.get("kind") == "weekly_all" and limit.get("resets_at"):
                reset = datetime.fromisoformat(limit["resets_at"].replace("Z", "+00:00"))
                if reset.tzinfo is not None:
                    return reset.astimezone(ZoneInfo(timezone_name))
    raise ValueError("Account weekly reset unavailable; supply --reset-weekday and --reset-hour explicitly.")


def slot_index(local_dt: datetime, reset_weekday: int, reset_hour: int) -> int:
    """Return the hour slot since the configured weekly reset."""
    absolute_hour = local_dt.weekday() * 24 + local_dt.hour
    reset_absolute_hour = reset_weekday * 24 + reset_hour
    return (absolute_hour - reset_absolute_hour) % WEEK_HOURS


def normalize(values: list[float], smoothing_share: float = 0.02) -> list[float]:
    total = sum(values)
    if total <= 0:
        return [1 / WEEK_HOURS] * WEEK_HOURS
    floor = total * smoothing_share / WEEK_HOURS
    smoothed = [value + floor for value in values]
    smoothed_total = sum(smoothed)
    return [value / smoothed_total for value in smoothed]


def build_profile(
    index: UsageIndex,
    *,
    lookback_days: int,
    timezone_name: str,
    reset_weekday: int,
    reset_hour: int,
    half_life_days: float,
    metric: str,
    reset_minute: int = 0,
) -> dict:
    tz = ZoneInfo(timezone_name)
    local_now = datetime.now(tz)
    days_since_reset = (local_now.weekday() - reset_weekday) % 7
    training_end = (local_now - timedelta(days=days_since_reset)).replace(
        hour=reset_hour, minute=reset_minute, second=0, microsecond=0
    )
    if training_end > local_now:
        training_end -= timedelta(days=7)
    training_end_ms = int(training_end.timestamp() * 1000)
    start_ms = training_end_ms - lookback_days * 86_400_000
    metric_sql = {
        "fresh_tokens": "input_tokens + output_tokens + cache_creation_tokens",
        "total_tokens": "input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens",
        "output_tokens": "output_tokens",
    }[metric]

    rows = index.connection.execute(
        f"""SELECT (timestamp_ms / 3600000) * 3600000 AS hour_ms,
                   SUM({metric_sql}) AS amount
            FROM usage_events
            WHERE timestamp_ms >= ? AND timestamp_ms < ?
            GROUP BY hour_ms ORDER BY hour_ms""",
        (start_ms, training_end_ms),
    ).fetchall()

    slot_amounts = [0.0] * WEEK_HOURS
    raw_amounts = [0] * WEEK_HOURS
    for row in rows:
        hour_ms = int(row["hour_ms"])
        amount = max(0, int(row["amount"] or 0))
        local_dt = datetime.fromtimestamp(hour_ms / 1000, timezone.utc).astimezone(tz)
        age_days = max(0.0, (training_end_ms - hour_ms) / 86_400_000)
        recency_weight = math.pow(0.5, age_days / half_life_days)
        slot = slot_index(local_dt, reset_weekday, reset_hour)
        slot_amounts[slot] += amount * recency_weight
        raw_amounts[slot] += amount

    weights = normalize(slot_amounts)
    cumulative = []
    running = 0.0
    for weight in weights:
        running += weight
        cumulative.append(running)
    cumulative[-1] = 1.0

    weekday_totals = [0.0] * 7
    for slot, weight in enumerate(weights):
        absolute = (reset_weekday * 24 + reset_hour + slot) % WEEK_HOURS
        weekday_totals[absolute // 24] += weight

    active_weekday_share = sum(weekday_totals[:5])
    peak_slots = sorted(range(WEEK_HOURS), key=lambda item: weights[item], reverse=True)[:10]
    return {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "claude_jsonl_aggregates",
        "privacy": "hourly token aggregates only; no conversation content",
        "lookback_days": lookback_days,
        "half_life_days": half_life_days,
        "training_end": training_end.astimezone(timezone.utc).isoformat(),
        "training_excludes_current_cycle": True,
        "metric": metric,
        "sample_hours": len(rows),
        "weekly": {
            "timezone": timezone_name,
            "reset_weekday": reset_weekday,
            "reset_weekday_name": WEEKDAY_NAMES[reset_weekday],
            "reset_hour": reset_hour,
            "reset_minute": reset_minute,
            "slots": weights,
            "cumulative": cumulative,
            "weekday_shares": {
                WEEKDAY_NAMES[day]: round(share * 100, 2)
                for day, share in enumerate(weekday_totals)
            },
            "business_days_share": round(active_weekday_share * 100, 2),
            "weekend_share": round((1 - active_weekday_share) * 100, 2),
            "peak_slots": peak_slots,
            "raw_total": sum(raw_amounts),
        },
    }


def save_profile(profile: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a historical Claude usage profile")
    parser.add_argument("--claude-dir", type=Path, default=DEFAULT_CLAUDE_DIR)
    parser.add_argument("--db", type=Path, default=ROOT / ".cache" / "usage.sqlite3")
    parser.add_argument("--output", type=Path, default=ROOT / ".cache" / "usage-profile.json")
    parser.add_argument("--lookback-days", type=int, default=90)
    parser.add_argument("--half-life-days", type=float, default=28)
    parser.add_argument("--timezone", default="UTC", help="IANA timezone used for weekday patterns (default: UTC)")
    parser.add_argument("--reset-weekday", type=int, help="Manual override: 0=Monday ... 6=Sunday")
    parser.add_argument("--reset-hour", type=int, help="Manual override in the selected timezone")
    parser.add_argument("--reset-minute", type=int, default=None, help="Manual reset minute (default: 0)")
    parser.add_argument("--metric", choices=("fresh_tokens", "total_tokens", "output_tokens"), default="fresh_tokens")
    args = parser.parse_args()

    manual = args.reset_weekday is not None or args.reset_hour is not None or args.reset_minute is not None
    if manual:
        if args.reset_weekday is None or args.reset_hour is None:
            parser.error("--reset-weekday and --reset-hour must be supplied together")
        args.reset_minute = args.reset_minute or 0
        if not 0 <= args.reset_weekday <= 6 or not 0 <= args.reset_hour <= 23 or not 0 <= args.reset_minute <= 59:
            parser.error("invalid reset weekday/hour/minute")
    else:
        try:
            reset = account_reset(QuotaClient(args.claude_dir.expanduser()).get(), args.timezone)
        except ValueError as error:
            parser.error(str(error))
        args.reset_weekday, args.reset_hour, args.reset_minute = reset.weekday(), reset.hour, reset.minute
    if args.lookback_days < 14 or args.half_life_days <= 0:
        parser.error("lookback must be >= 14 days and half-life must be positive")

    index = UsageIndex(args.claude_dir.expanduser(), args.db)
    scan = index.refresh()
    profile = build_profile(
        index,
        lookback_days=args.lookback_days,
        timezone_name=args.timezone,
        reset_weekday=args.reset_weekday,
        reset_hour=args.reset_hour,
        reset_minute=args.reset_minute,
        half_life_days=args.half_life_days,
        metric=args.metric,
    )
    save_profile(profile, args.output)

    weekly = profile["weekly"]
    print(f"Perfil salvo em {args.output}")
    print(f"Janela: {args.lookback_days} dias · meia-vida: {args.half_life_days:g} dias · métrica: {args.metric}")
    print(f"Seg–sex: {weekly['business_days_share']:.1f}% · fim de semana: {weekly['weekend_share']:.1f}%")
    print(f"Indexação incremental: {scan['events']} eventos novos em {scan['elapsed_ms']} ms")


if __name__ == "__main__":
    main()
