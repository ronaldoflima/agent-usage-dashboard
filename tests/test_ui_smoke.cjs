// Rendering smoke tests with a minimal DOM: not a substitute for visual review.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const initialView of ['both', 'claude', 'codex']) test(`${initialView}: saved view, rendering and provider-scoped sync`, async () => {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: id === 'syncInterval' ? '0' : '', innerHTML: '', textContent: '', dataset: {},
      listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; },
      setAttribute() {}, parentElement: { querySelector() { return null; } },
      insertAdjacentHTML() {}, classList: { toggle() {}, remove() {} },
    });
    return nodes.get(id);
  }
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) node(match[1]);
  const document = {
    getElementById(id) { assert.ok(nodes.has(id), `Missing HTML id ${id}`); return node(id); },
    createElement() { return { set textContent(s) { this.innerHTML = String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;'); } }; },
    createTreeWalker() { return { nextNode() { return false; } }; },
    querySelectorAll() { return []; }, documentElement: {}, body: { dataset: {}, classList: { toggle(name, active) { this[name] = active; } } },
  };
  const now = Date.now();
  const reset = new Date(now + 3 * 86400000).toISOString();
  const totals = { total_tokens: 120, fresh_tokens: 40, input_tokens: 20, output_tokens: 20,
    cache_read_tokens: 80, cache_creation_tokens: 0, thinking_tokens: 10, sessions: 1, messages: 1 };
  const row = { ...totals, model: 'test-model', session_id: 'test-session', project_id: '/tmp/demo', project: '<script>', cwd: '/tmp/demo', bucket_ms: now - 60000 };
  const profile = { ok: true, lookback_days: 90, sample_hours: 100,
    weekly: { slots: Array(168).fill(1 / 168), timezone: 'UTC', reset_weekday: 0, reset_hour: 0, business_days_share: 71.4 } };
  const usage = { ok: true, totals, timeline: [row], session_timeline: [row], models: [row], projects: [{...row, sessions: 1, project_id: '/tmp/demo', folders: ['/tmp/demo']}], sessions: [row], profile,
    range: { start_ms: now - 18000000, end_ms: now }, coverage: { last_event_ms: now } };
  const limits = { ok: true, source: 'codex_app_server', fetched_at: new Date(now).toISOString(),
    limits: [{ key: 'codex:secondary', label: 'codex', bucket: 'codex', kind: 'weekly_all',
      window_minutes: 10080, utilization: 40, resets_at: reset }] };
  const requests = [];
  const saved = new Map([['providerView', initialView]]);
  let gate = null;
  const context = vm.createContext({ document, NodeFilter: { SHOW_TEXT: 4 }, Intl, Date, console,
    localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); } }, setInterval() {}, clearInterval() {},
    fetch: async url => {
      requests.push(url);
      if (gate) await gate;
      const response = url.includes('limits') ? limits : url.includes('profile') ? profile
        : url.includes('snapshots') ? { ok: true, claude: [], codex: [] } : usage;
      return { json: async () => response };
    },
  });
  for (const name of ['i18n.js', 'pace-profile.js', 'providers.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static', name), 'utf8'), context, { filename: name });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.body.dataset.providerView, initialView);
  assert.ok(requests.some(url => url.includes('/api/codex/')));
  assert.ok(requests.some(url => url.includes('/api/dashboard')));
  assert.ok(requests.every(url => !url.includes('sync=1') && !url.includes('force=1')));
  node('viewBoth').listeners.click();
  assert.match(node('overview').innerHTML, /Claude/);
  assert.match(node('overview').innerHTML, /Codex/);
  assert.ok(!node('overview').innerHTML.includes('<svg'));
  node('viewClaude').listeners.click();
  assert.match(node('projects').innerHTML, /&lt;script>/);
  node('compactToggle').listeners.click();
  assert.equal(document.body.classList['compact-rankings'], true);
  assert.equal(saved.get('compactRankings'), 'true');
  assert.match(node('sessionList').innerHTML, /compact-session-id/);
  assert.match(node('sessionList').innerHTML, /test-ses/);
  node('codexCompactToggle').listeners.click();
  assert.equal(document.body.classList['compact-rankings'], false);
  assert.equal(saved.get('compactRankings'), 'false');
  // Selection retains the total chart scale and splits selected versus remaining tokens.
  vm.runInContext(`state.data = {...state.data,
    totals: {...state.data.totals, total_tokens: 240},
    timeline: [{...state.data.timeline[0], input_tokens: 40, output_tokens: 40, cache_read_tokens: 160}],
    sessions: [state.data.sessions[0], {...state.data.sessions[0], session_id: 'second-session'}],
    projects: [state.data.projects[0], {...state.data.projects[0], project_id: '/tmp/other', cwd: '/tmp/other'}],
    session_timeline: [state.data.session_timeline[0], {...state.data.session_timeline[0], session_id: 'second-session', project_id: '/tmp/other'}]}; renderClaude()`, context);
  const totalChart = node('timeline').innerHTML;
  vm.runInContext('toggleSession(0)', context);
  assert.match(node('sessionSelectionSummary').textContent, /50%/);
  assert.match(node('timeline').innerHTML, /segment-muted/);
  assert.match(node('sessionList').innerHTML, /checked/);
  vm.runInContext('toggleSession(1)', context);
  assert.match(node('sessionSelectionSummary').textContent, /100%/);
  vm.runInContext('toggleSession(0)', context);
  assert.match(node('sessionSelectionSummary').textContent, /50%/);
  node('clearSessionSelection').listeners.click();
  assert.equal(node('timeline').innerHTML, totalChart);
  // One session can span projects: scope both its metrics and chart to the selected project.
  vm.runInContext(`var originalSessionTimeline = state.data.session_timeline;
    state.data.session_timeline = [
      {...originalSessionTimeline[0], input_tokens: 15, output_tokens: 15, cache_read_tokens: 60, fresh_tokens: 30, total_tokens: 90},
      {...originalSessionTimeline[0], project_id: '/tmp/other', input_tokens: 5, output_tokens: 5, cache_read_tokens: 20, fresh_tokens: 10, total_tokens: 30},
      originalSessionTimeline[1]];
    toggleProject(0)`, context);
  assert.equal(vm.runInContext('visibleSessions()[0].total_tokens', context), 90);
  assert.match(node('sessionList').innerHTML, /title="90 processed"/);
  assert.match(node('sessionSelectionSummary').textContent, /37.5%/);
  vm.runInContext('toggleSession(0)', context);
  assert.match(node('sessionSelectionSummary').textContent, /37.5%/);
  vm.runInContext('toggleProject(1)', context);
  assert.equal(vm.runInContext('visibleSessions().find(row => row.session_id === "test-session").total_tokens', context), 120);
  assert.match(node('sessionSelectionSummary').textContent, /50%/);
  node('clearSessionSelection').listeners.click();
  assert.equal(vm.runInContext('visibleSessions()[0].total_tokens', context), 120);
  vm.runInContext('state.data.session_timeline = originalSessionTimeline; toggleProject(0)', context);
  assert.ok(!node('sessionList').innerHTML.includes('second-s'));
  assert.match(node('projects').innerHTML, /checked/);
  assert.match(node('sessionSelectionSummary').textContent, /50%/);
  // A project with two sessions narrows to just the selected session.
  vm.runInContext("state.data.session_timeline[1].project_id = '/tmp/demo'; renderActivitySelection()", context);
  assert.match(node('sessionSelectionSummary').textContent, /100%/);
  vm.runInContext('toggleSession(0)', context);
  assert.match(node('sessionSelectionSummary').textContent, /50%/);
  assert.ok(!node('sessionSelectionSummary').textContent.includes('selected projects'));
  vm.runInContext('toggleSession(0)', context);
  assert.match(node('sessionSelectionSummary').textContent, /100%/); // Falls back to project.
  vm.runInContext("state.data.session_timeline[1].project_id = '/tmp/other'; toggleSession(0); toggleProject(1)", context);
  assert.match(node('sessionSelectionSummary').textContent, /50%/); // Sessions override both projects.
  vm.runInContext('toggleSession(1)', context);
  assert.match(node('sessionSelectionSummary').textContent, /100%/);
  vm.runInContext('toggleSession(1)', context);
  assert.match(node('sessionSelectionSummary').textContent, /50%/);
  assert.match(node('sessionList').innerHTML, /second-s/);
  vm.runInContext('toggleProject(0)', context); // Only the second project remains selected.
  assert.ok(!node('sessionList').innerHTML.includes('test-ses'));
  assert.match(node('sessionList').innerHTML, /data-session-index="1"/);
  assert.equal(vm.runInContext('state.selection.claude.sessions.size', context), 0);
  node('sessionList').listeners.change({target: {matches: () => true, dataset: {sessionIndex: '1'}}});
  assert.equal(vm.runInContext("state.selection.claude.sessions.has('second-session')", context), true);
  node('compactToggle').listeners.click();
  assert.ok(!node('sessionList').innerHTML.includes('test-ses'));
  node('compactToggle').listeners.click();
  node('clearSessionSelection').listeners.click();
  assert.match(node('sessionList').innerHTML, /test-ses/);
  assert.match(node('sessionList').innerHTML, /second-s/);
  assert.equal(vm.runInContext('state.selection.claude.projects.size + state.selection.claude.sessions.size', context), 0);
  assert.equal(node('timeline').innerHTML, totalChart);
  vm.runInContext('toggleProject(1); state.data.projects = [state.data.projects[0]]; renderClaude()', context);
  assert.equal(vm.runInContext('state.selection.claude.projects.size', context), 0);
  vm.runInContext('toggleSession(1); state.data.sessions = [state.data.sessions[0]]; renderClaude()', context);
  assert.equal(vm.runInContext('state.selection.claude.sessions.size', context), 0);
  node('viewCodex').listeners.click();
  assert.match(node('codexProjects').innerHTML, /&lt;script>/);
  assert.match(node('codexLimits').innerHTML, /40.0%/);
  assert.match(node('limits').innerHTML, /40%/);
  assert.equal(vm.runInContext('paceFor({...state.codex.limits.limits[0], utilization: 0}, state.codex.activity.profile, state.codex.limits.fetched_at).projectedMs', context), null);
  assert.match(node('codexCurve').innerHTML, /<svg/);
  assert.ok(!node('codexSessions').innerHTML.includes('<script>'));
  // Codex selection is independent of Claude and splits its own timeline.
  vm.runInContext(`state.codex.activity = {...state.codex.activity,
    totals: {...state.codex.activity.totals, total_tokens: 240},
    sessions: [state.codex.activity.sessions[0], {...state.codex.activity.sessions[0], session_id: 'codex-second'}],
    session_timeline: [state.codex.activity.session_timeline[0], {...state.codex.activity.session_timeline[0], session_id: 'codex-second'}]}; renderProviders()`, context);
  const codexChart = node('codexTimeline').innerHTML;
  assert.match(codexChart, /segment/);
  assert.ok(!node('codexLegend').innerHTML.includes(vm.runInContext("tr('Escrita em cache')", context)));
  vm.runInContext("toggleSession(0, 'codex')", context);
  assert.match(node('codexSessionSelectionSummary').textContent, /50%/);
  assert.match(node('codexTimeline').innerHTML, /segment-muted/);
  assert.match(node('codexSessions').innerHTML, /checked/);
  assert.equal(vm.runInContext('state.selection.claude.sessions.size', context), 0);
  node('codexClearSessionSelection').listeners.click();
  assert.equal(node('codexTimeline').innerHTML, codexChart);
  node('codexProjects').listeners.change({target: {matches: () => true, dataset: {sessionIndex: '0'}}});
  assert.equal(vm.runInContext('state.selection.codex.projects.size', context), 1);
  assert.match(node('codexProjects').innerHTML, /checked/);
  node('codexClearSessionSelection').listeners.click();
  node('language').listeners.change({ target: { value: 'pt-BR' } });
  node('paceMode').listeners.change({ target: { value: 'equal_weekdays' } });
  assert.match(node('codexLimits').innerHTML, /Seg–sex equilibrado/);
  for (const [id, element] of nodes) assert.ok(!/NaN|undefined/.test(element.innerHTML), id);
  vm.runInContext('state.codex = { activity: {ok: false}, limits: {ok: false} }; renderProviders()', context);
  assert.match(node('codexLimits').innerHTML, /indisponível/);
  assert.match(node('limits').innerHTML, /40%/);
  for (const provider of ['claude', 'codex', 'both']) {
    requests.length = 0;
    node({both: 'viewBoth', claude: 'viewClaude', codex: 'viewCodex'}[provider]).listeners.click();
    assert.equal(saved.get('providerView'), provider);
    assert.equal(document.body.dataset.providerView, provider);
    assert.equal(requests.length, 0);
    requests.length = 0;
    await vm.runInContext('load(null, true, true)', context);
    if (provider === 'claude') {
      assert.equal(node('providerBrand').textContent, 'CLAUDE CODE · LOCAL');
      assert.equal(node('claudeCurveEyebrow').textContent, 'RITMO SEMANAL');
      assert.equal(node('claudeActivityEyebrow').textContent, 'ATIVIDADE LOCAL');
    }
    assert.ok(requests.includes('/api/codex/limits?force=1'));
    assert.ok(requests.includes('/api/limits?force=1'));
  }
  // Pausing collection is independent of navigation and persists separately.
  node('collectClaude').listeners.change({target: {checked: false}});
  assert.equal(JSON.parse(saved.get('collectionProviders')).claude, false);
  requests.length = 0;
  await vm.runInContext('load(null, true, true)', context);
  assert.ok(!requests.includes('/api/limits?force=1'));
  assert.ok(requests.includes('/api/limits'));
  assert.ok(requests.includes('/api/codex/limits?force=1'));
  node('collectCodex').listeners.change({target: {checked: false}});
  requests.length = 0;
  await vm.runInContext('load(null, true, true)', context);
  assert.ok(requests.every(url => !url.includes('sync=1') && !url.includes('force=1')));
  // Navigation during an in-flight update does not schedule extra work.
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const pending = vm.runInContext('load(null, true)', context);
  node('viewCodex').listeners.click();
  requests.length = 0;
  gate = null; release();
  await pending;
  assert.equal(document.body.dataset.providerView, 'codex');
  assert.ok(requests.every(url => !url.includes('sync=1') && !url.includes('force=1')));
  assert.equal(vm.runInContext('state.pendingLoad', context), undefined);
  // The chart and date inputs share the same range filter for both providers.
  requests.length = 0;
  const filterStart = now - 2 * 36e5, filterEnd = now - 36e5;
  await vm.runInContext(`applyTimeRange(${filterStart}, ${filterEnd})`, context);
  assert.equal(node('fromInput').value, vm.runInContext(`localInputValue(${filterStart})`, context));
  assert.equal(node('toInput').value, vm.runInContext(`localInputValue(${filterEnd})`, context));
  assert.ok(requests.includes(`/api/dashboard?from=${filterStart}&to=${filterEnd}`));
  assert.ok(requests.some(url => url.startsWith('/api/codex/') && url.includes(`from=${filterStart}&to=${filterEnd}`)));
});


test('weekly curve: hover shows hourly values, latest official value and future target', () => {
  const element = () => ({ attrs: {}, style: {}, setAttribute(key, value) { this.attrs[key] = value; } });
  const line = element(), dots = [element(), element()];
  const hover = { ...element(), querySelector: () => line, querySelectorAll: () => dots };
  const tooltip = { hidden: true, offsetWidth: 200, offsetHeight: 100, style: {} };
  const svg = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 290 }) };
  const selection = element(), applied = [];
  let captured = null;
  const root = {
    querySelector: selector => ({ svg, '.curve-tooltip': tooltip, '.curve-hover': hover, '.curve-selection': selection })[selector],
    setPointerCapture(id) { captured = id; },
    hasPointerCapture(id) { return captured === id; },
    releasePointerCapture() { captured = null; },
  };
  const summary = {};
  const startMs = new Date(2026, 9, 5).getTime();
  const state = { weeklyData: { startMs, observedMs: startMs + 48.25 * 36e5, official: 40,
    timeline: [{ bucket_ms: startMs, fresh_tokens: 100 }] } };
  const context = vm.createContext({ state, Intl, Date,
    document: { getElementById: id => id === 'weeklyCurve' ? root : summary },
    selectedProfileSlots: () => Array(168).fill(1 / 168),
    slotProgress: (_, hours) => hours / 168 * 100,
    locale: () => 'pt-BR', tr: value => value, esc: value => value,
    quotaSamples: () => [],
    applyTimeRange(start, end) { applied.push({ start, end }); state.custom = { start, end }; },
  });
  const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function renderWeeklyCurve()'), source.indexOf('function renderTimeline(')), context);
  vm.runInContext('renderWeeklyCurve()', context);
  const move = slot => root.onpointermove({ clientX: 10 + (48 + slot / 168 * 934) / 2, clientY: 140 });
  move(24);
  assert.equal(tooltip.hidden, false);
  assert.match(tooltip.innerHTML, /06\/10\/2026/);
  assert.match(tooltip.innerHTML, /14,3%/);
  assert.match(tooltip.innerHTML, /Uso estimado da semana/);
  assert.match(tooltip.innerHTML, /40,0%/);
  assert.match(tooltip.innerHTML, /Diferença/);
  move(48.25);
  assert.match(tooltip.innerHTML, /Percentual oficial agora/);
  assert.match(tooltip.innerHTML, /00:15/);
  move(120);
  assert.match(tooltip.innerHTML, /71,4%/);
  assert.doesNotMatch(tooltip.innerHTML, /Uso estimado|Percentual oficial|Diferença/);
  assert.equal(dots[1].attrs.visibility, 'hidden');
  assert.ok(parseFloat(tooltip.style.left) <= 300);
  root.onpointerleave();
  assert.equal(tooltip.hidden, true);
  assert.equal(hover.attrs.visibility, 'hidden');
  const pointer = slot => ({ clientX: 10 + (48 + slot / 168 * 934) / 2,
    clientY: 140, pointerId: 1, button: 0, isPrimary: true });
  root.onpointerdown(pointer(12));
  root.onpointermove(pointer(24));
  assert.equal(selection.attrs.visibility, 'visible');
  assert.equal(applied.length, 0);
  root.onpointerup(pointer(24));
  assert.deepEqual(applied[0], { start: startMs + 12 * 36e5, end: startMs + 24 * 36e5 });
  assert.equal(captured, null);
  // Reverse dragging produces the same chronological range.
  root.onpointerdown(pointer(24));
  root.onpointerup(pointer(12));
  assert.deepEqual(applied[1], applied[0]);
  root.onpointerdown(pointer(24));
  root.onpointerup(pointer(24));
  assert.equal(applied.length, 2);
  root.onpointerdown(pointer(0));
  root.onpointermove(pointer(48));
  root.onpointercancel();
  assert.equal(applied.length, 2);
  assert.equal(captured, null);
  // Restore the active filter when a drag is cancelled after re-rendering.
  vm.runInContext('renderWeeklyCurve()', context);
  root.onpointerdown(pointer(0));
  root.onpointermove(pointer(48));
  root.onlostpointercapture();
  assert.equal(selection.attrs.visibility, 'visible');
  assert.equal(selection.attrs.width, 12 / 168 * 934);
  // Dragging outside the plot clamps to the weekly boundary.
  root.onpointerdown(pointer(12));
  root.onpointerup(pointer(-100));
  assert.deepEqual(applied[2], { start: startMs, end: startMs + 12 * 36e5 });
  state.weeklyData = null;
  vm.runInContext('renderWeeklyCurve()', context);
  assert.equal(root.onpointermove, null);
});

test('codex curve: hover shows snapshots and projection, drag filters the range', () => {
  const element = () => ({ attrs: {}, style: {}, setAttribute(key, value) { this.attrs[key] = value; } });
  const line = element(), dots = [element(), element()];
  const hover = { ...element(), querySelector: () => line, querySelectorAll: () => dots };
  const tooltip = { hidden: true, offsetWidth: 200, offsetHeight: 100, style: {} };
  const svg = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 290 }) };
  const selection = element(), applied = [];
  let captured = null;
  const root = {
    querySelector: selector => ({ svg, '.curve-tooltip': tooltip, '.curve-hover': hover, '.curve-selection': selection })[selector],
    setPointerCapture(id) { captured = id; },
    hasPointerCapture(id) { return captured === id; },
    releasePointerCapture() { captured = null; },
  };
  const note = {};
  const now = Date.now(), reset = now + 72 * 36e5, startMs = reset - 168 * 36e5;
  const limit = { key: 'codex:secondary', label: 'codex', bucket: 'codex', window_minutes: 10080, utilization: 40, resets_at: new Date(reset).toISOString() };
  const sample = (slot, utilization) => ({ key: limit.key, resets_at: limit.resets_at, observed_ms: startMs + slot * 36e5, utilization });
  const state = { codex: { activity: { ok: true }, limits: { ok: true, fetched_at: new Date(now).toISOString(), limits: [limit] } },
    snapshots: { codex: [sample(48, 20), sample(96, 40)] } };
  const context = vm.createContext({ state, Intl, Date,
    document: { getElementById: id => id === 'codexCurve' ? root : note },
    selectedProfileSlots: () => Array(168).fill(1 / 168),
    paceFor: () => ({ expected: 30, projectionRatio: 1 }),
    locale: () => 'pt-BR', tr: value => value, esc: value => value, formatDate: value => String(value), paceModeLabel: () => '',
    applyTimeRange(start, end) { applied.push({ start, end }); state.custom = { start, end }; },
  });
  const app = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('const CURVE ='), app.indexOf('function renderTimeline(')), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/providers.js'), 'utf8'), context);
  vm.runInContext('renderCodexCurve()', context);
  assert.match(root.innerHTML, /curve-selection/);
  const pointer = slot => ({ clientX: 10 + (48 + slot / 168 * 934) / 2, clientY: 140, pointerId: 1, button: 0, isPrimary: true });
  root.onpointermove(pointer(48.2));
  assert.match(tooltip.innerHTML, /Snapshot oficial: <b>20,0%/);
  assert.equal(dots[1].attrs.visibility, 'visible');
  root.onpointermove(pointer(120));
  assert.match(tooltip.innerHTML, /Projeção: <b>81,4%/);
  root.onpointermove(pointer(10));
  assert.doesNotMatch(tooltip.innerHTML, /Snapshot oficial|Projeção|Diferença/);
  assert.equal(dots[1].attrs.visibility, 'hidden');
  root.onpointerdown(pointer(12));
  root.onpointermove(pointer(24));
  assert.equal(selection.attrs.visibility, 'visible');
  root.onpointerup(pointer(24));
  assert.deepEqual(applied[0], { start: startMs + 12 * 36e5, end: startMs + 24 * 36e5 });
  assert.equal(captured, null);
  vm.runInContext('renderCodexCurve()', context);
  assert.match(root.innerHTML, /visibility="visible"/);
  state.codex.limits.limits = [];
  vm.runInContext('renderCodexCurve()', context);
  assert.equal(root.onpointermove, null);
});
