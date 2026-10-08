# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Local dashboard (Python stdlib HTTP server + vanilla JS frontend, no build step, no third-party dependencies, Python 3.10+) that tracks Claude and Codex plan limits and local token activity. `README.md` documents behavior and metrics in depth; read it before changing quota, pace, or profile semantics.

## Commands

```bash
python3 app.py --port 8787 --timezone America/Sao_Paulo   # run dashboard (binds 127.0.0.1)
python3 build_usage_profile.py --timezone America/Sao_Paulo  # rebuild .cache/usage-profile.json

python3 -m unittest tests.test_app                        # one Python test module
python3 -m unittest tests.test_app.<Class>.<test_name>    # single Python test
node --test tests/test_pace_profile.cjs                   # one JS test file (node:test)
```

Per the global testing rule, run only the test files affected by the change, not the whole suite. Python tests: `tests/test_app.py`, `test_codex_usage.py`, `test_usage_profile.py`; JS tests: `test_pace_profile.cjs`, `test_providers.cjs`, `test_ui_smoke.cjs` (minimal-DOM rendering via `vm`, not a visual check).

## Architecture

- `app.py` — the whole backend. `UsageIndex` indexes `~/.claude/projects/**/*.jsonl` into SQLite (`.cache/usage.sqlite3`, dedup by session + `message.id`); `QuotaClient` calls Anthropic's undocumented OAuth usage endpoint with a cache and error cooldown; `DashboardHandler` serves `static/` plus JSON APIs (`/api/dashboard`, `/api/limits`, `/api/profile`, `/api/codex/*`, `/api/snapshots`, `/api/settings`, `/api/health`). Page loads and tab/range changes must only read cache; network/log scanning happens only on **Sync now** or the auto-sync interval.
- `codex_usage.py` — Codex counterpart: parses `$CODEX_HOME` session JSONL (usage derived from cumulative-counter deltas, fork/archive dedup) and reads official limits via `codex app-server` JSON-RPC (`account/rateLimits/read`), falling back to the latest local-log snapshot labeled stale.
- `build_usage_profile.py` — builds the 168-hourly-slot personal expected-pace curve (completed cycles only, 90 days, 28-day half-life) into `.cache/usage-profile.json`. Reset weekday/hour comes from the authenticated account, never hardcoded.
- `static/` — frontend. `pace-profile.js` (aligning profile slots to official reset windows, pace modes, projection) and `providers.js` are UMD-style modules also `require`d by the Node tests; `app.js` is the DOM/rendering layer; `i18n.js` holds `en`/`pt-BR`/`es` translations keyed by the Portuguese source string (`tr('...')`, pt-BR is the identity map).
- `scripts/pacebar` — standalone one-line terminal indicator (ccstatusline widget); fetches `/api/profile` from the dashboard (`CLAUDE_USAGE_URL`), caches it in the temp dir for 1h, falls back to a linear curve. Its labels follow the dashboard language stored in `.cache/settings.json` (via `read_language()` in `app.py`).

## Conventions to preserve

- Official quota percentages (API) and local token counters are separate concepts; never sum percentages across providers or convert tokens into quota percentages.
- Only counters, timestamps, model ids, session ids and project paths are persisted; conversation content must never be stored or sent to the browser. OAuth token stays in server memory and goes only to `api.anthropic.com`.
- `.cache/` (databases, profile, settings), `nohup.out` and env files are git-ignored; don't commit them.
- New UI strings: add keys to all three languages in `static/i18n.js`.
