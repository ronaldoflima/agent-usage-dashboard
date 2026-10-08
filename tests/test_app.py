import json
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
from pathlib import Path
from datetime import datetime, timedelta, timezone

import threading
import urllib.request
from http.server import ThreadingHTTPServer

import app
from app import DashboardHandler, QuotaClient, UsageIndex


class QuotaCacheTest(unittest.TestCase):
    def test_reload_never_fetches_even_with_empty_or_expired_cache(self):
        client = QuotaClient(Path('/unused'))
        with patch('app.urllib.request.urlopen') as request:
            self.assertFalse(client.get(cache_only=True)['ok'])
            client.cached = {'ok': True, 'limits': [], 'fetched_at': 'previous'}
            client.cached_at = -1000
            self.assertEqual(client.get(cache_only=True)['fetched_at'], 'previous')
            request.assert_not_called()

    def test_force_respects_429_cooldown_and_preserves_previous_data(self):
        client = QuotaClient(Path('/unused'))
        client.cached = {'ok': True, 'limits': [], 'fetched_at': 'previous'}
        error = urllib.error.HTTPError('https://example.test', 429, 'Too Many Requests', {'Retry-After': '900'}, None)
        credentials = '{"claudeAiOauth":{"accessToken":"test-token"}}'
        with patch('pathlib.Path.read_text', return_value=credentials), patch('app.urllib.request.urlopen', side_effect=error) as request:
            result = client.get(force=True)
            self.assertTrue(result['stale'])
            self.assertEqual(result['retry_after_seconds'], 900)
            self.assertEqual(client.get(force=True)['fetched_at'], 'previous')
            client.get()
            self.assertEqual(request.call_count, 1)


class QuotaCredentialsTest(unittest.TestCase):
    def test_reads_credentials_file_when_present(self):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, '.credentials.json').write_text('{"claudeAiOauth":{"accessToken":"file-token"}}')
            with patch('app.subprocess.run') as run:
                self.assertEqual(QuotaClient(Path(temp))._access_token(), 'file-token')
                run.assert_not_called()

    def test_falls_back_to_macos_keychain_without_credentials_file(self):
        keychain = app.subprocess.CompletedProcess([], 0, stdout='{"claudeAiOauth":{"accessToken":"keychain-token"}}\n')
        with tempfile.TemporaryDirectory() as temp, patch('app.sys.platform', 'darwin'), \
                patch('app.subprocess.run', return_value=keychain) as run:
            self.assertEqual(QuotaClient(Path(temp))._access_token(), 'keychain-token')
            self.assertIn('Claude Code-credentials', run.call_args.args[0])

    def test_missing_keychain_item_reports_both_locations(self):
        missing = app.subprocess.CompletedProcess([], 44, stdout='', stderr='not found')
        with tempfile.TemporaryDirectory() as temp, patch('app.sys.platform', 'darwin'), \
                patch('app.subprocess.run', return_value=missing):
            with self.assertRaisesRegex(OSError, 'Keychain'):
                QuotaClient(Path(temp))._access_token()

    def test_missing_file_off_macos_does_not_touch_keychain(self):
        with tempfile.TemporaryDirectory() as temp, patch('app.sys.platform', 'linux'), \
                patch('app.subprocess.run') as run:
            with self.assertRaises(OSError):
                QuotaClient(Path(temp))._access_token()
            run.assert_not_called()


class UsageIndexTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / "projects" / "-tmp-demo"
        self.project.mkdir(parents=True)
        self.log = self.project / "session.jsonl"
        self.index = UsageIndex(self.root, self.root / "index.sqlite3")

    def tearDown(self):
        self.index.connection.close()
        self.temp.cleanup()

    def write(self, message_id="msg_1", output=30, timestamp="2026-09-22T10:00:00Z"):
        event = {
            "type": "assistant", "timestamp": timestamp, "sessionId": "session-1", "cwd": "/tmp/demo",
            "message": {"id": message_id, "model": "claude-opus-5", "usage": {
                "input_tokens": 10, "output_tokens": output, "cache_read_input_tokens": 100,
                "cache_creation_input_tokens": 20, "output_tokens_details": {"thinking_tokens": 5}
            }}
        }
        with self.log.open("a") as handle:
            handle.write(json.dumps(event) + "\n")

    def test_indexes_and_deduplicates_stream_events(self):
        self.write(output=20)
        self.write(output=30, timestamp="2026-09-22T10:00:01Z")
        self.index.refresh()
        result = self.index.dashboard(0, 2_000_000_000_000, 60_000)
        self.assertEqual(result["totals"]["messages"], 1)
        self.assertEqual(result["totals"]["output_tokens"], 30)
        self.assertEqual(result["totals"]["thinking_tokens"], 5)
        self.assertEqual(result["totals"]["fresh_tokens"], 60)
        self.assertEqual(result["totals"]["total_tokens"], 160)

    def test_session_breakdown_preserves_totals_and_range(self):
        self.write()
        event = json.loads(self.log.read_text().splitlines()[0])
        event['sessionId'] = 'session-2'
        event['message']['id'] = 'msg_2'
        event['message']['usage']['output_tokens'] = 70
        with self.log.open('a') as handle:
            handle.write(json.dumps(event) + '\n')
        self.write(message_id='outside', timestamp='2026-09-23T10:00:00Z')
        self.index.refresh()
        from datetime import datetime
        start = int(datetime.fromisoformat('2026-09-22T10:00:00+00:00').timestamp() * 1000)
        result = self.index.dashboard(start, start + 60_000, 60_000)
        self.assertEqual(len(result['session_timeline']), 2)
        self.assertEqual({r['session_id'] for r in result['session_timeline']}, {'session-1', 'session-2'})
        for key in ('input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'total_tokens'):
            self.assertEqual(sum(r[key] for r in result['session_timeline']), result['totals'][key])
            self.assertEqual(sum(r[key] for r in result['timeline']), result['totals'][key])
        self.assertEqual(result['totals']['messages'], 2)

    def test_projects_group_worktrees_subfolders_and_separate_same_names(self):
        repo = self.root / 'main' / 'demo'
        git = repo / '.git'
        git.mkdir(parents=True)
        metadata = git / 'worktrees' / 'feature'
        metadata.mkdir(parents=True)
        (metadata / 'commondir').write_text('../..')
        worktree = self.root / 'other' / 'feature'
        worktree.mkdir(parents=True)
        (worktree / '.git').write_text(f'gitdir: {metadata}')
        separate = self.root / 'separate' / 'demo'
        (separate / '.git').mkdir(parents=True)
        self.write()
        template = json.loads(self.log.read_text().splitlines()[0])
        self.log.write_text('')
        for i, cwd in enumerate((repo, worktree, worktree / 'src', separate)):
            event = json.loads(json.dumps(template))
            event['cwd'] = str(cwd)
            event['sessionId'] = f'session-{i}'
            event['message']['id'] = f'msg-{i}'
            with self.log.open('a') as handle:
                handle.write(json.dumps(event) + '\n')
        self.index.refresh()
        data = self.index.dashboard(0, 2_000_000_000_000, 60_000)
        self.assertEqual(len(data['projects']), 2)
        self.assertEqual(data['projects'][0]['project_id'], str(repo))
        self.assertEqual(data['projects'][0]['sessions'], 3)
        self.assertEqual(len(data['projects'][0]['folders']), 3)
        self.assertEqual(data['projects'][1]['project_id'], str(separate))
        self.assertEqual(sum(row['total_tokens'] for row in data['session_timeline'] if row['project_id'] == str(repo)), data['projects'][0]['total_tokens'])
        self.assertEqual({row['project_id'] for row in data['session_timeline']}, {str(repo), str(separate)})
        for key in ('messages', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'total_tokens'):
            self.assertEqual(sum(row[key] for row in data['projects']), data['totals'][key])

    def test_incremental_refresh(self):
        self.write()
        first = self.index.refresh()
        second = self.index.refresh()
        self.write(message_id="msg_2", timestamp="2026-09-22T10:01:00Z")
        third = self.index.refresh()
        self.assertEqual(first["events"], 1)
        self.assertEqual(second["events"], 0)
        self.assertEqual(third["events"], 1)

    def test_normalizes_structured_limits(self):
        normalized = QuotaClient._normalize({"limits": [
            {"kind": "session", "percent": 42, "resets_at": "2026-09-22T15:00:00Z"},
            {"kind": "weekly_scoped", "percent": 18, "resets_at": "2026-09-26T22:00:00Z", "scope": {"model": {"display_name": "Opus"}}}
        ]})
        self.assertEqual(normalized["limits"][0]["label"], "Sessão")
        self.assertEqual(normalized["limits"][1]["label"], "Semanal · Opus")


class ProfileRefreshTest(unittest.TestCase):
    LIMITS = {'ok': True, 'limits': [{'kind': 'weekly_all', 'resets_at': '2026-09-23T17:30:00Z'}]}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'usage-profile.json'
        self.index = UsageIndex(self.root, self.root / 'index.sqlite3')

    def tearDown(self):
        self.index.connection.close()
        self.temp.cleanup()

    def write_profile(self, hours_old, **extra):
        generated = datetime.now(timezone.utc) - timedelta(hours=hours_old)
        profile = {'generated_at': generated.isoformat(), 'lookback_days': 60, 'half_life_days': 14,
                   'metric': 'output_tokens', 'weekly': {'timezone': 'Europe/London'}, **extra}
        self.path.write_text(json.dumps(profile))

    def test_builds_missing_profile_from_cached_limits(self):
        self.assertTrue(app.refresh_profile(self.index, self.LIMITS, 'America/Sao_Paulo', self.path))
        profile = json.loads(self.path.read_text())
        self.assertEqual(profile['weekly']['timezone'], 'America/Sao_Paulo')
        self.assertEqual((profile['weekly']['reset_weekday'], profile['weekly']['reset_hour']), (2, 14))

    def test_keeps_recent_profile(self):
        self.write_profile(hours_old=2)
        before = self.path.read_text()
        self.assertFalse(app.refresh_profile(self.index, self.LIMITS, 'UTC', self.path))
        self.assertEqual(self.path.read_text(), before)

    def test_rebuilds_old_profile_with_its_own_settings(self):
        self.write_profile(hours_old=30)
        self.assertTrue(app.refresh_profile(self.index, self.LIMITS, 'UTC', self.path))
        profile = json.loads(self.path.read_text())
        self.assertEqual((profile['lookback_days'], profile['half_life_days'], profile['metric']), (60, 14, 'output_tokens'))
        self.assertEqual(profile['weekly']['timezone'], 'Europe/London')

    def test_rebuilds_recent_but_empty_profile(self):
        self.write_profile(hours_old=1, weekly={'timezone': 'UTC', 'raw_total': 0})
        self.assertTrue(app.refresh_profile(self.index, self.LIMITS, 'UTC', self.path))

    def test_without_limits_does_nothing(self):
        for limits in ({'ok': False}, {'ok': True, 'limits': []}):
            self.assertFalse(app.refresh_profile(self.index, limits, 'UTC', self.path))
        self.assertFalse(self.path.exists())


class LanguageSettingTest(unittest.TestCase):
    def post(self, port, payload):
        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/settings", json.dumps(payload).encode(),
                                         {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    def test_language_is_saved_validated_and_defaults_to_english(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache" / "settings.json"
            server = ThreadingHTTPServer(("127.0.0.1", 0), DashboardHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            with patch.object(app, "SETTINGS_PATH", path):
                thread.start()
                try:
                    self.assertEqual(app.read_language(), "en")
                    self.assertEqual(self.post(server.server_port, {"language": "pt-BR"}), 200)
                    self.assertEqual(app.read_language(), "pt-BR")
                    self.assertEqual(self.post(server.server_port, {"language": "fr"}), 400)
                    self.assertEqual(app.read_language(), "pt-BR")
                finally:
                    server.shutdown()
                    server.server_close()


if __name__ == "__main__":
    unittest.main()
