# Claude + Codex Usage Dashboard

A local dashboard for monitoring Claude and Codex plan limits and understanding
which sessions and models account for activity over a selected time range.
The **Overview / Claude / Codex** tabs separate quick decisions from detailed
analysis. Overview shows two compact cards: short-term and weekly quotas, resets,
weekly pace, and projection, with **View details** links. Missing limits are
explicitly marked; percentages are never added together. Detailed charts and
rankings appear only in the individual tabs. Claude retains its original
full-width layout and responsive limit-card grid.

The selected tab is remembered in this browser. Navigation performs no network
requests and does not affect collection. Both providers synchronize by default
on the selected interval while the page is open, regardless of the active tab.
The separate **Synchronization** menu lets you pause either provider without
deleting history. Paused providers can still display cached data; neither their
local logs nor official quotas are refreshed, even by **Sync now**. Enabling a
provider does not immediately sync. An in-flight request may finish; other open
tabs retain their own collection settings until reloaded.

## Install

Works on Ubuntu/Debian, Arch and macOS. One command clones the repository into
`~/.local/share/agent-usage-dashboard`, installs Python 3.10+ and git if they are
missing (apt/pacman with `sudo`, or Homebrew on macOS, asking first), and asks
how you want to run it:

```bash
curl -fsSL https://raw.githubusercontent.com/ronaldoflima/agent-usage-dashboard/main/install.sh | bash
```

From an existing checkout, `./install.sh` uses that checkout instead of cloning.
Pass options to skip the questions:

```bash
./install.sh --mode service --port 8787 --timezone America/Sao_Paulo --linger
curl -fsSL https://raw.githubusercontent.com/ronaldoflima/agent-usage-dashboard/main/install.sh | bash -s -- --mode launcher
```

| Mode | What it does | When to use |
|---|---|---|
| `service` (default) | Linux: systemd user service `agent-usage-dashboard` (`Restart=always`). macOS: launchd agent `io.github.agent-usage-dashboard` (`KeepAlive`, `RunAtLoad`). Starts at login | Desktops and servers; required for the in-app update button to restart the server automatically |
| `launcher` | Only installs the `agent-usage-dashboard` command in `~/.local/bin` | You prefer to start it yourself, in tmux, or with `nohup` |
| `foreground` | Installs the launcher and starts the server in the current terminal | Trying it out |

`systemd` and `launchd` are accepted as aliases of `service`. Other options:
`--host` (default `127.0.0.1`), `--dir` (checkout path), `--linger` (Linux only:
keep the systemd service running after logout and start it at boot, useful on
servers/VPS), `--pacebar` (link `scripts/pacebar` into `~/.local/bin`), `--yes`
(no package-install prompt) and `--uninstall` (removes service and launcher,
keeps the checkout and `.cache/`). The timezone defaults to the system's; the
`codex` binary found in `PATH` at install time is passed as `--codex-bin`, since
services do not inherit your shell `PATH`. Rerun the installer to change port,
timezone or mode, or to update: an existing checkout on `main` without local
changes is fast-forwarded to `origin/main` and the service restarted
(`--no-update` skips it).

```bash
# Linux (systemd)
systemctl --user status agent-usage-dashboard
journalctl --user -u agent-usage-dashboard -f

# macOS (launchd)
launchctl print gui/$(id -u)/io.github.agent-usage-dashboard
tail -f ~/Library/Logs/agent-usage-dashboard.log
launchctl kickstart -k gui/$(id -u)/io.github.agent-usage-dashboard
```

The in-app update restarts the server only when it runs under a supervisor that
brings it back: systemd (detected via `INVOCATION_ID`) or any process manager
that sets `USAGE_DASHBOARD_SUPERVISED=1` (the launchd agent does). Otherwise it
asks you to restart manually.

Without the installer, run it directly with Python (no dependencies to install):

```bash
git clone https://github.com/ronaldoflima/agent-usage-dashboard.git
cd agent-usage-dashboard
python3 app.py --port 8787 --timezone America/Sao_Paulo
nohup python3 app.py --port 8787 --timezone America/Sao_Paulo >/dev/null 2>&1 &
```

The dashboard binds to `127.0.0.1` by default. To reach it from another machine,
prefer an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 host`) over binding to a public
address: it exposes private project names and paths.

## Codex preview

Run this branch separately from your existing dashboard:

```bash
python3 app.py --port 8788 --timezone America/Sao_Paulo
```

Choose your own IANA timezone. The Codex profile defaults to UTC; the existing
Claude profile retains the timezone selected when it was generated.

The Codex collector reads `CODEX_HOME` (default `~/.codex`), including
`sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl`. It saves only usage
counters, timestamps, model identifiers, session identifiers, and project paths.
Conversation content is parsed as part of JSON records but never persisted or
returned to the browser. Project names and paths are still private metadata:
keep the server local and never commit its databases.

Official Codex limits are read through the installed, authenticated
`codex app-server` using `initialize`, `initialized`, and
`account/rateLimits/read`. No thread or model turn is started. The dashboard
does not open Codex credential files itself. This integration requires a CLI
version and account that support the documented method; API-key-only usage is
not a ChatGPT subscription quota. See the
[official App Server documentation](https://learn.chatgpt.com/docs/app-server).

```bash
python3 app.py --codex-dir /another/path/.codex --codex-bin /path/to/codex
```

Reloads and time-range changes only read cached data. **Sync now** and the
selected automatic interval refresh both providers independently. Each provider
has its own five-minute cache and error cooldown. Codex RPC reads have a bounded
timeout; failure leaves Claude available. Codex errors use a five-minute cooldown
because the RPC error does not expose HTTP `Retry-After` here.

If official Codex limits cannot be fetched, the latest snapshot in the indexed
local logs is shown with its original timestamp and an explicit local/stale
label. It is not a fresh account read. Expired windows have no pace projection.
Window durations and resets come from the data, not a hardcoded 5-hour/week pair.

### Codex counters and profile

- Codex `input_tokens` includes cached input. The dashboard displays uncached
  input as `input_tokens - cached_input_tokens`, with cache reads separately.
  Processed volume remains original input + output, without double counting.
- Reasoning tokens are a subset of output. Cache writes are not presented as an
  independently comparable Codex metric.
- Usage is derived from changes in cumulative counters. Repeated notifications
  are ignored; first observations and counter resets use `last_token_usage`
  when available. Without a reliable baseline, the event is skipped rather than
  inventing activity. Timestamped deltas are usage events, not necessarily one
  user response or one API request.
- Copied events older than a fork's creation time establish a baseline but do
  not count toward the new session. Archived copies are deduplicated. Changed
  files are reparsed; unchanged files are skipped.
- The Codex expected curve is computed independently from indexed counters over
  completed cycles: up to 90 days, 28-day half-life, fresh-token weights, and the
  same historical/balanced-weekday modes as Claude. No network read is required
  to calculate it. Missing training data falls back to a labeled linear estimate.
  The API returns this aggregate as JSON; it does not overwrite the Claude profile.
- Local history covers only the configured device/directory. It is not an
  account-wide breakdown, and different providers' token counts are not equal
  units of cost, quota, or productive work.

### Observed quota history

Successful official reads for both providers are recorded in the Git-ignored
`.cache/quota-snapshots.sqlite3`. Repeated cache reads do not create duplicate
samples. Failed reads and local-log fallbacks do not create official samples.

The Codex chart shows the expected curve, actual official samples from the
current reset cycle, and a separately styled projection. It does not reconstruct
quota history from tokens. Lines break across gaps longer than 30 minutes or
downward corrections. A new installation may have zero or one observed point;
the chart fills in as synchronization runs. Samples persist across restarts,
while the live quota cache remains in memory. The chart isolates limit buckets
and reset cycles; it never connects different cycles.

Claude retains its labeled token-based reconstruction and overlays official
sample points when available. Its reconstructed line is anchored to the last
official read time, not the page-load time. The personal expected profiles still
use tokens, **not learned quota weights**; snapshot-based profile training is a
future improvement requiring sufficiently complete cycles of observations.

Detail tabs share the time-range controls and show each provider's supported
counters without combining quota percentages or token volumes.

<img width="1506" height="834" alt="image" src="https://github.com/user-attachments/assets/08d407cd-bb01-4266-8cd0-636258c89f78" />


## What it reads

- `~/.claude/projects/**/*.jsonl`: metadata, timestamps, model names, and token
  counters only. Prompts, responses, and tool calls are neither persisted by
  the dashboard nor sent to the browser.
- `~/.claude/.credentials.json`: the OAuth token stays in the local server
  process and is used exclusively to request
  `https://api.anthropic.com/api/oauth/usage`. The token is never included in
  the dashboard's HTTP responses. On macOS, where Claude Code keeps the token
  in the Keychain instead of that file, the dashboard reads the
  `Claude Code-credentials` item with `security find-generic-password` on each
  quota sync. The first read may show a Keychain prompt; choose **Always Allow**
  so background syncs (including the launchd agent) do not stall.

Plan utilization and reset times are official values returned by Anthropic.
The local token counters are diagnostic activity measurements; they are not an
exact breakdown of plan utilization because Anthropic does not publish the
quota weighting formula.

## Run locally

The dashboard requires Python 3.10+ and has no third-party dependencies.

```bash
python3 app.py
```

Open <http://127.0.0.1:8787>. The first load may take a few seconds while the
history is indexed after clicking **Sync now**. Opening or reloading the page
only reads the existing index and in-memory quota cache, without contacting
Anthropic or scanning JSONL files. After a server restart, use **Sync now** to
populate the quota cache.

Automatic synchronization defaults to every 5 minutes while the page is open.
Choose 5, 10, 15, or 30 minutes, or manual-only mode; the browser remembers the
selection. Changing the interval does not immediately sync. **Sync now** bypasses
the normal five-minute quota cache, but respects the error cooldown. Failed
requests wait at least five minutes before retrying; numeric `Retry-After`
headers can extend this wait. Multiple tabs share the server quota cache.
The displayed official timestamp records the last successful quota fetch.

Options:

```bash
python3 app.py --port 9000
python3 app.py --claude-dir /another/path/.claude
```

For safety, the server binds to `127.0.0.1` by default. Do not expose it to a
network without adding authentication.

## Security and privacy

- The SQLite database, generated profile, caches, and environment files are
  ignored by Git.
- The OAuth token is read into memory and sent only to `api.anthropic.com`.
- The OAuth usage endpoint is internal and undocumented, so it may change
  without notice. The dashboard reports failures without exposing credentials.
- Review the code before changing the bind address to a network interface.

## Historical pace profile

The dashboard builds the personal usage curve on its own: when
`.cache/usage-profile.json` is missing, empty, or older than 24 hours, the next
profile read after a sync rebuilds it from the already-indexed counters and the
cached weekly reset, without extra network calls or log scans. A fresh install
therefore gets its profile after the first **Sync now**. Rebuilds keep the
existing file's timezone, lookback, half-life and metric; a new profile uses
the server's `--timezone` and the defaults below.

To generate it manually (for example with other parameters):

```bash
python3 build_usage_profile.py --timezone America/Sao_Paulo
```

Choose your own IANA timezone (the default is UTC). The script fetches the
account-wide weekly reset from the authenticated account; no weekday or hour
is hardcoded. If the reset cannot be retrieved, it fails with instructions for
an explicit manual override rather than assuming a schedule:

```bash
python3 build_usage_profile.py --timezone Europe/London --reset-weekday 2 --reset-hour 14 --reset-minute 30
```

Weekdays use 0=Monday through 6=Sunday. The override configures historical
training only; official reset times and utilization always come from the API.

The script aggregates up to 90 days of completed cycles into 168 hourly slots.
It excludes the
current cycle to avoid training on the period being evaluated. Recent weeks
receive more weight through a 28-day half-life.

The aggregate is written to `.cache/usage-profile.json`. It contains no
conversation content, project names, or session identifiers. The dashboard
uses this curve for the weekly pace calculation and falls back to a linear pace
when no profile exists. Refreshing the profile once a week is recommended.

The weekly pace selector offers two modes, saved in the browser:

- **Historical profile** (default): uses the original hourly weights.
- **Balanced Monday–Friday**: averages each clock hour across the five workdays
  and assigns that average to each workday. Each workday therefore receives
  one fifth of the combined workday share, while retaining the average intraday
  pattern. Every Saturday and Sunday slot remains unchanged, as does the weekly
  total. This is a planning assumption, not inferred unmet demand or automatic
  outlier detection.

The selected mode applies to the expected weekly curve, pace indicators, and
weekly projections. It does not change official utilization, the observed usage
curve, or the five-hour session calculation. No profile rebuild is needed to
switch modes.

Weekly projections are deliberately conservative about thin evidence:

- A profile with fewer than 168 active hours (`sample_hours`) is blended with
  the linear curve in proportion to its sample size, so one busy hour in a short
  history cannot dominate the expected curve. Profiles with 168 or more active
  hours, or without `sample_hours`, are used as is.
- The displayed pressure is the raw ratio of official usage to expected usage.
  The projected date instead uses `(used + 10) / (expected + 10)`, which starts
  near the target pace and converges to the raw ratio as the cycle accumulates
  expected mass. A burst right after a reset therefore no longer extrapolates a
  4–5× multiplier to the rest of the week.
- While the expected mass is below 10 percentage points, or the profile is
  blended, the projection is labeled as preliminary.

The browser aligns the profile's calendar-hour weights to each official weekly
window, including model-specific windows and resets that change day or time.
Minute offsets are interpolated at the profile's hourly resolution. Reset dates
in the cards use the browser's timezone; workday patterns use the profile's
configured timezone. The fixed 168-hour model approximates weeks spanning a
daylight-saving transition.

## Terminal pace indicator

`scripts/pacebar` displays Claude's weekly usage relative to the expected pace
in one line, for example `pace 1.12x ▲ (expected 40%)`. It requires only Python's
standard library, like the dashboard.

For a ccstatusline custom-command widget, set `commandPath` to the absolute
path of `scripts/pacebar`. The command reads the statusline JSON from stdin
(`rate_limits.seven_day.used_percentage` and `resets_at`, in Unix seconds).
Running it directly in an interactive terminal instead reads the dashboard's
cached Claude limits:

```bash
./scripts/pacebar
```

The expected curve comes from `/api/profile` at `http://127.0.0.1:8787`.
Set `CLAUDE_USAGE_URL` to use another dashboard address. The profile is cached
for one hour; if unavailable, the command uses a linear curve and prefixes the
ratio with `~`. It uses the historical mode independently of the browser's
selected pace mode. The labels follow the dashboard language (English, Portuguese
or Spanish), saved server-side in `.cache/settings.json` when you change it in the
UI and picked up after the one-hour profile cache expires; without the dashboard
they are English. Ratios above `1.08x` show `▲`, below `0.82x` show `▽`, and
otherwise show `=`; exhausted quota shows `■`. Missing or expired quota windows
produce no output.

The direct-terminal mode does not refresh limits and currently compares the
cached utilization with the current time, rather than the snapshot timestamp.
Use **Sync now** in the dashboard to populate or refresh its quota cache.

To keep an existing personal command path, link it to the repository copy
(replace `/path/to/agent-usage-dashboard` with your checkout path):

```bash
mkdir -p "$HOME/pessoal/scripts"
ln -s /path/to/agent-usage-dashboard/scripts/pacebar "$HOME/pessoal/scripts/pacebar"
```

If that path already contains a script, back it up before creating the link.
The checkout must remain at the linked path. Personal ccstatusline setup scripts
can continue using that command path.

## Metrics

The interface deliberately separates two kinds of data:

- **Official plan utilization:** the percentage and reset time reported by the
  Anthropic OAuth usage endpoint. This is the source of truth for quota usage.
- **Local activity counters:** token fields recorded in Claude Code JSONL logs.
  They explain the shape and distribution of local activity, but cannot be
  converted exactly into plan percentage.

Local counters shown together in the dashboard:

- **Input:** uncached input tokens reported in `input_tokens`.
- **Output:** generated tokens reported in `output_tokens`.
- **Cache writes:** input tokens written to the prompt cache, reported in
  `cache_creation_input_tokens`.
- **Cache reads:** input tokens reused from the prompt cache, reported in
  `cache_read_input_tokens`.
- **Thinking:** reasoning tokens reported in
  `output_tokens_details.thinking_tokens`. This is a detail of output, not an
  additional value to add to the totals.
- **Profile basis:** input + output + cache writes. This derived value is used
  to reconstruct the current weekly curve and train the historical profile.
- **Processed volume:** profile basis + cache reads. This is useful as a measure
  of total context handled, but large cache reads can make it much larger than
  the amount of new work or the official quota percentage.

Repeated streaming log entries are deduplicated by session and `message.id`.
