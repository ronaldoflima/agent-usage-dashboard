const state = { range: '5h', custom: null, data: null, limits: null, profile: null, weeklyData: null };
state.selection = Object.fromEntries(['claude', 'codex'].map(provider => [provider, { sessions: new Set(), projects: new Set() }]));
state.compactRankings = false;
try { state.compactRankings = localStorage.getItem('compactRankings') === 'true'; } catch {}
function renderRankingMode() {
  document.body.classList.toggle('compact-rankings', state.compactRankings);
  for (const id of ['compactToggle', 'codexCompactToggle']) {
    const button = document.getElementById(id);
    button.setAttribute('aria-pressed', String(state.compactRankings));
    button.textContent = tr(state.compactRankings ? 'Listagem normal' : 'Listagem compacta');
  }
}
state.providerView = 'both';
try { const saved = localStorage.getItem('providerView'); if (['both', 'claude', 'codex'].includes(saved)) state.providerView = saved; } catch {}
state.collection = { claude: true, codex: true };
try { const saved = JSON.parse(localStorage.getItem('collectionProviders')); for (const provider of ['claude', 'codex']) if (typeof saved?.[provider] === 'boolean') state.collection[provider] = saved[provider]; } catch {}
const PACE_MODES = ['historical', 'blended', 'equal_weekdays'];
state.paceMode = 'historical';
try { const saved = localStorage.getItem('paceMode'); if (PACE_MODES.includes(saved)) state.paceMode = saved; } catch {}
function selectedProfileSlots(profile, startMs) { return alignedPaceSlots(profile, state.paceMode, startMs); }
function paceModeLabel() { return { equal_weekdays: tr('Seg–sex equilibrado'), blended: tr('Histórico + equilibrado') }[state.paceMode] || tr('Perfil histórico'); }
function renderPaceMode() {
  document.getElementById('paceMode').value = state.paceMode;
  const share = (state.providerView === 'codex' ? state.codex?.activity?.profile : state.profile)?.weekly?.business_days_share;
  document.getElementById('paceModeNote').textContent = state.paceMode === 'blended'
    ? tr('Média de 50% entre o perfil histórico e o Seg–sex equilibrado: reduz o ruído de poucas semanas sem ignorar que alguns dias pesam mais.')
    : state.paceMode === 'equal_weekdays'
    ? `${tr("Mesmo peso para cada dia útil")}${Number.isFinite(share) ? ` (${(share / 5).toFixed(2)}% ${tr("da semana")})` : ''}, ${tr("com a média por horário. Sábado e domingo preservados. É uma hipótese de planejamento, não uma correção do histórico.")}`
    : tr('Distribuição histórica por dia e horário, incluindo períodos em que você pode ter economizado cota.');
  document.getElementById('expectedCurveLabel').textContent = `${tr("Curva esperada")} · ${paceModeLabel()}`;
}
const COLORS = ['#d97757', '#7c9ec7', '#7dbb84', '#dfae57', '#a184c4', '#d7809e', '#79b7b1'];
const TOKEN_COMPONENTS = [
  { key: 'input_tokens', label: 'Input', color: '#7c9ec7' },
  { key: 'output_tokens', label: 'Output', color: '#7dbb84' },
  { key: 'cache_creation_tokens', label: tr('Escrita em cache'), color: '#d97757' },
  { key: 'cache_read_tokens', label: tr('Leitura de cache'), color: '#a184c4' },
];
const ACTIVITY_VIEWS = {
  claude: { data: () => state.data, timeline: 'timeline', legend: 'legend', summary: 'sessionSelectionSummary',
    clear: 'clearSessionSelection', sessions: 'sessionList', projects: 'projects' },
  codex: { data: () => state.codex?.activity, timeline: 'codexTimeline', legend: 'codexLegend', summary: 'codexSessionSelectionSummary',
    clear: 'codexClearSessionSelection', sessions: 'codexSessions', projects: 'codexProjects' },
};
function activityComponents(provider) { return provider === 'codex' ? TOKEN_COMPONENTS.filter(metric => metric.key !== 'cache_creation_tokens') : TOKEN_COMPONENTS; }
const DURATIONS = { '15m': 15 * 60e3, '30m': 30 * 60e3, '1h': 60 * 60e3, '5h': 5 * 60 * 60e3, '24h': 24 * 60 * 60e3, '7d': 7 * 24 * 60 * 60e3 };
let nf, exact;
function updateFormatters() { nf = new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }); exact = new Intl.NumberFormat(locale()); }
updateFormatters();

function formatTokens(value) { return nf.format(value || 0); }
function formatDate(value) { return new Intl.DateTimeFormat(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function countdown(value) {
  if (!value) return tr('reset não informado');
  let seconds = Math.max(0, (new Date(value).getTime() - Date.now()) / 1000);
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}min` : `${minutes}min`;
}
function tone(pct) { return pct >= 90 ? '#db6b64' : pct >= 70 ? '#dfae57' : '#7dbb84'; }
function esc(value) { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; }
function paceFor(limit, profile = state.profile, observedAt = state.limits?.fetched_at) {
  const durationMs = limit.window_minutes ? limit.window_minutes * 60e3 : limit.kind === 'session' ? 5 * 60 * 60e3 : 7 * 24 * 60 * 60e3;
  const resetMs = new Date(limit.resets_at).getTime();
  if (!Number.isFinite(resetMs)) return null;
  const now = new Date(observedAt).getTime(); const startMs = resetMs - durationMs;
  if (!Number.isFinite(now) || now < startMs || now >= resetMs || Date.now() >= resetMs) return null;
  const elapsedMs = Math.max(60e3, Math.min(durationMs, now - startMs));
  const remainingMs = Math.max(0, resetMs - now);
  const weekly = durationMs === 168 * 36e5;
  const profileSlots = weekly && profile?.ok ? selectedProfileSlots(profile, startMs) : null;
  const historical = Array.isArray(profileSlots) && profileSlots.length === 168;
  const actualRate = limit.utilization / (elapsedMs / 36e5);
  const sustainableRate = remainingMs > 0 ? (100 - limit.utilization) / (remainingMs / 36e5) : 0;
  const projection = weekly
    ? weeklyPaceProjection(historical ? profileSlots : Array(168).fill(1 / 168), limit.utilization, elapsedMs / 36e5, startMs) : null;
  const expected = projection?.expected ?? Math.max(0, Math.min(100, elapsedMs / durationMs * 100));
  const ratio = expected > 0 ? limit.utilization / expected : 0;
  const projectedMs = projection ? projection.projectedMs
    : actualRate > 0 ? startMs + (100 / actualRate) * 36e5 : null;
  const margin = expected - limit.utilization;
  let label = tr('No ritmo'); let className = 'steady';
  if (limit.utilization >= 100) { label = tr('Limite atingido'); className = 'hot'; }
  else if (ratio > 1.08) { label = tr('Ritmo acelerado'); className = 'hot'; }
  else if (ratio < .82) { label = tr('Ritmo tranquilo'); className = 'cool'; }
  return {
    expected, actualRate, sustainableRate, projectedMs, margin, label, className, historical,
    pressure: ratio, projectionRatio: projection?.projectionRatio ?? ratio,
    preliminary: Boolean(projection?.preliminary || (historical && profileReliability(profile) < 1)),
    futureBudgetRatio: expected < 100 ? (100 - limit.utilization) / (100 - expected) : 0,
    reachesBeforeReset: projectedMs && projectedMs < resetMs,
  };
}
function clock(value) { return new Intl.DateTimeFormat(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }

async function loadWeeklyData() {
  const weekly = state.limits?.limits?.find(limit => limit.kind === 'weekly_all');
  if (!weekly?.resets_at) return null;
  const resetMs = new Date(weekly.resets_at).getTime();
  const startMs = resetMs - 7 * 24 * 36e5;
  const observedMs = Date.parse(state.limits.fetched_at);
  if (!Number.isFinite(observedMs) || observedMs < startMs || Date.now() >= resetMs) return null;
  const endMs = Math.min(observedMs, resetMs);
  if (endMs <= startMs) return null;
  const response = await fetch(`/api/dashboard?from=${startMs}&to=${endMs}&bucket=3600000`);
  const data = await response.json();
  return data.ok ? { ...data, resetMs, startMs, observedMs, limit: weekly, official: weekly.utilization } : null;
}

async function load(custom, sync = false, force = false) {
  if (custom) state.custom = custom;
  if (state.loading) { state.pendingLoad = true; return; }
  state.loading = true;
  document.getElementById('syncNow').disabled = true;
  document.getElementById('syncNow').setAttribute('aria-busy', String(sync));
  const selected = state.custom;
  const end = selected?.end ?? Date.now();
  const start = selected?.start ?? end - DURATIONS[state.range];
  try {
    const jobs = [];
    jobs.push((async () => {
      const claudeSync = sync && providerEnabled('claude'), claudeForce = force && providerEnabled('claude');
      const [usageResponse, limitsResponse] = await Promise.all([
        fetch(`/api/dashboard?from=${start}&to=${end}${claudeSync ? '&sync=1' : ''}`),
        fetch(`/api/limits${claudeForce ? '?force=1' : claudeSync ? '?sync=1' : ''}`)
      ]);
      const profileResponse = await fetch('/api/profile');
      state.data = await usageResponse.json(); state.limits = await limitsResponse.json(); state.profile = await profileResponse.json();
      if (!state.data.ok) throw new Error(state.data.error);
      state.weeklyData = await loadWeeklyData();
    })().catch(error => {
      state.limits = { ...state.limits, ok: false, stale: true, error: error.message };
    }));
    jobs.push(loadCodex(start, end, sync && providerEnabled('codex'), force && providerEnabled('codex')));
    const completed = await Promise.allSettled(jobs);
    const failed = completed.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    try { state.snapshots = await (await fetch('/api/snapshots')).json(); } catch { state.snapshots = {}; }
    render();
    renderSyncTimestamp();
    document.getElementById('syncStatus').textContent = [
      ...[['claude', state.limits], ['codex', state.codex?.limits]]
        .filter(([provider, payload]) => providerEnabled(provider) && payload?.error)
        .map(([provider, payload]) => `${provider}: ${tr('Sync pendente:')} ${payload.error}${payload.retry_after_seconds ? ` · ${Math.ceil(payload.retry_after_seconds / 60)} min` : ''}`),
      ...remoteSyncSummary([['claude', state.data?.scan], ['codex', state.codex?.activity?.scan]], tr,
        at => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })),
    ].join(' · ');
  } catch (error) {
    document.getElementById('updated').textContent = tr('falha na atualização');
    document.getElementById('limits').innerHTML = `<div class="panel error">${esc(error.message)}</div>`;
  } finally {
    state.loading = false;
    document.getElementById('syncNow').disabled = false;
    document.getElementById('syncNow').setAttribute('aria-busy', 'false');
    if (state.pendingLoad) { state.pendingLoad = false; return load(); }
  }
}

function render() {
  renderRankingMode(); renderProviderView(); renderPaceMode();
  if (state.providerView === 'claude') {
    if (state.data?.ok) renderClaude();
    else renderLimits();
  }
  if (state.providerView === 'both') renderOverview();
  renderProviders();
  const coverage = state.providerView === 'codex' ? state.codex?.activity?.coverage : state.data?.coverage;
  document.getElementById('coverage').textContent = coverage?.last_event_ms ? `${tr('último evento')} ${formatDate(coverage.last_event_ms)}` : tr('sem eventos');
}

function renderClaude() {
  const d = state.data, t = d.totals;
  pruneSelection('claude');
  document.getElementById('totalTokens').textContent = formatTokens(t.total_tokens);
  document.getElementById('freshTokens').textContent = formatTokens(t.fresh_tokens);
  document.getElementById('inputTokens').textContent = formatTokens(t.input_tokens);
  document.getElementById('outputTokens').textContent = formatTokens(t.output_tokens);
  document.getElementById('cacheCreationTokens').textContent = formatTokens(t.cache_creation_tokens);
  document.getElementById('cacheReadTokens').textContent = formatTokens(t.cache_read_tokens);
  document.getElementById('thinkingTokens').textContent = formatTokens(t.thinking_tokens);
  document.getElementById('sessions').textContent = exact.format(t.sessions || 0);
  document.getElementById('messages').textContent = exact.format(t.messages || 0);
  document.getElementById('coverage').textContent = d.coverage.last_event_ms ? `${tr("último evento")} ${formatDate(d.coverage.last_event_ms)}` : tr('sem eventos');
  renderPaceMode(); renderLimits(); renderWeeklyCurve(); renderTimeline(); renderRanking('projects', d.projects || [], 'project'); renderRanking('models', d.models, 'model'); renderRanking('sessionList', d.sessions, 'session');
}

function renderSyncTimestamp() {
  const reads = [providerEnabled('claude') ? state.limits : null, providerEnabled('codex') ? state.codex?.limits : null]
    .filter(payload => payload?.source !== 'codex_local_snapshot' && payload?.fetched_at)
    .map(payload => Date.parse(payload.fetched_at)).filter(Number.isFinite);
  document.getElementById('updated').textContent = reads.length
    ? `${tr('Último sync oficial:')} ${new Date(Math.max(...reads)).toLocaleString(locale())}`
    : tr('Sem sync oficial');
}

function renderLimits() {
  const root = document.getElementById('limits');
  if (!state.limits?.ok) {
    root.innerHTML = `<article class="panel error">${tr("Limites oficiais indisponíveis:")} ${esc(state.limits?.error || tr('erro desconhecido'))}</article>`;
    return;
  }
  const primary = state.limits.limits.filter(x => x.kind === 'session' || x.kind === 'weekly_all');
  const scoped = state.limits.limits.filter(x => x.kind !== 'session' && x.kind !== 'weekly_all');
  const ordered = [...primary, ...scoped];
  root.innerHTML = ordered.map(limit => {
    const pct = Math.max(0, Math.min(100, limit.utilization)); const color = tone(pct);
    const pace = paceFor(limit);
    const paceMarkup = pace ? `<div class="pace-head"><span class="pace-badge ${pace.className}">${pace.label}</span><span>${pace.historical ? tr('ideal do modo') : tr('ideal agora')}: ${pace.expected.toFixed(0)}%</span></div>
      <div class="bar pace-bar" style="--bar-color:${color}"><i style="--value:${pct}%"></i><b style="--target:${pace.expected}%" title="${tr('ritmo ideal')}"></b></div>
      <div class="pace-grid"><span><small>${pace.historical ? tr('Pressão vs padrão') : tr('Ritmo médio')}</small><strong>${pace.historical ? pace.pressure.toFixed(2) + 'x' : pace.actualRate.toFixed(1) + '%/h'}</strong></span><span><small>${pace.historical ? tr('Folga futura') : tr('Pode gastar')}</small><strong>${pace.historical ? pace.futureBudgetRatio.toFixed(2) + 'x' : pace.sustainableRate.toFixed(1) + '%/h'}</strong></span><span><small>${tr('Margem')}</small><strong>${pace.margin >= 0 ? '+' : ''}${pace.margin.toFixed(0)} pp</strong></span></div>
      <p class="projection ${pace.reachesBeforeReset ? 'warning' : ''}">${pace.reachesBeforeReset ? `${tr("Mantendo seu padrão, chega a 100%")} ${clock(pace.projectedMs)}` : tr('Mantendo seu padrão, não chega a 100% antes do reset')}${pace.preliminary ? ` · ${tr('estimativa preliminar')}` : ''}</p>
      ${pace.historical ? `<p class="profile-source">${paceModeLabel()} · ${tr("janela de até")} ${state.profile.lookback_days} ${tr("dias")} · ${state.profile.weekly.business_days_share.toFixed(0)}% ${tr("seg–sex")}</p>` : ''}` : '';
    return `<article class="limit panel" style="--ring-color:${color}">
      <div class="limit-title"><strong>${esc(limit.kind === 'session' ? tr('Sessão') + (limit.label.includes('5h') ? ' · 5h' : '') : limit.kind.startsWith('weekly') ? tr('Semanal') + (limit.model ? ' · ' + limit.model : limit.label.includes(' · ') ? ' · ' + limit.label.split(' · ').slice(1).join(' · ') : '') : limit.label)}</strong><span>${tr('plano oficial')}</span></div>
      <div class="limit-value"><strong>${limit.utilization.toFixed(limit.utilization % 1 ? 1 : 0)}%</strong><span>${tr('utilizado')}</span></div>
      <div class="limit-meta"><span>${tr('restam')} ${(100 - pct).toFixed(0)}%</span><span>${tr('reset em')} ${countdown(limit.resets_at)}${limit.resets_at ? ` · ${formatDate(limit.resets_at)}` : ''}</span></div>
      ${paceMarkup}
    </article>`;
  }).join('') || `<article class="panel error">${tr('A API não retornou janelas de limite ativas.')}</article>`;
}

function renderWeeklyCurve() {
  const root = document.getElementById('weeklyCurve');
  const summary = document.getElementById('weeklyCurveSummary');
  root.onpointermove = root.onpointerdown = root.onpointerup = root.onpointerleave = root.onpointercancel = root.onlostpointercapture = null;
  const data = state.weeklyData; const slots = selectedProfileSlots(state.profile, data?.startMs);
  if (!data || !Array.isArray(slots) || slots.length !== 168) {
    root.innerHTML = `<div class="empty">${tr('Gere o perfil histórico para visualizar a curva.')}</div>`;
    summary.textContent = '';
    return;
  }

  const elapsedHours = Math.max(0, Math.min(168, (data.observedMs - data.startMs) / 36e5));
  const expectedNow = slotProgress(slots, elapsedHours);
  const hourly = Array(168).fill(0);
  for (const row of data.timeline) {
    const slot = Math.floor((row.bucket_ms - data.startMs) / 36e5);
    if (slot >= 0 && slot < 168) hourly[slot] += row.fresh_tokens || 0;
  }
  const elapsedSlots = Math.min(168, Math.ceil(elapsedHours));
  const observedTotal = hourly.slice(0, elapsedSlots).reduce((sum, value) => sum + value, 0);

  const expectedPoints = expectedCurvePoints(slots);
  const actualPoints = [{ slot: 0, value: 0 }];
  let actualSum = 0;
  for (let slot = 0; slot < elapsedSlots; slot++) {
    actualSum += hourly[slot];
    actualPoints.push({
      slot: Math.min(slot + 1, elapsedHours),
      value: observedTotal > 0 ? actualSum / observedTotal * data.official : 0,
    });
  }
  if (actualPoints.at(-1).slot !== elapsedHours) actualPoints.push({ slot: elapsedHours, value: data.official });
  else actualPoints[actualPoints.length - 1] = { slot: elapsedHours, value: data.official };

  const { top, height, bottom } = CURVE;
  const x = curveX, y = curveY;
  const actualPath = curvePath(actualPoints);
  const areaPath = `${actualPath} L ${x(elapsedHours).toFixed(1)} ${y(0).toFixed(1)} L ${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;
  const currentX = x(elapsedHours), currentY = y(data.official);
  const selection = curveSelection(data.startMs);
  root.innerHTML = `<svg viewBox="0 0 ${CURVE.width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="actualArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7dbb84" stop-opacity=".28"/><stop offset="100%" stop-color="#7dbb84" stop-opacity="0"/></linearGradient></defs>
    ${curveFrame(data.startMs, selection)}
    <path d="${areaPath}" fill="url(#actualArea)"/>
    <path d="${curvePath(expectedPoints)}" class="curve-expected-line"/>
    <path d="${actualPath}" class="curve-actual-line"/>
    <line x1="${currentX}" y1="${top}" x2="${currentX}" y2="${height - bottom}" class="curve-now-line"/>
    <circle cx="${currentX}" cy="${currentY}" r="6" class="curve-now-point"/>
    <circle cx="${currentX}" cy="${y(expectedNow)}" r="4" class="curve-expected-point"/>
    ${quotaSamples(state.snapshots?.claude, data.limit).map(sample => `<circle cx="${x((sample.observed_ms - data.startMs) / 36e5)}" cy="${y(sample.utilization)}" r="3" class="curve-now-point"><title>${esc(formatDate(sample.observed_ms))} · ${sample.utilization}%</title></circle>`).join('')}
    ${CURVE_HOVER}
  </svg><div class="curve-tooltip" role="tooltip" hidden></div>`;

  const { date, percent } = curveFormatters();
  bindCurveInteraction(root, data.startMs, selection, raw => {
    // Snap to hourly points, including the latest observation at its exact time.
    let slot = Math.max(0, Math.min(168, Math.round(raw)));
    if (Math.abs(raw - elapsedHours) < .5) slot = elapsedHours;
    const expected = curveInterpolate(expectedPoints, slot);
    const actual = slot <= elapsedHours ? curveInterpolate(actualPoints, slot) : null;
    return { slot, expected, actual, html: `<strong>${esc(date.format(new Date(data.startMs + slot * 36e5)))}</strong>
      <span>${tr('Curva esperada')}: <b>${percent.format(expected)}%</b></span>
      ${actual === null ? '' : `<span>${tr(slot === elapsedHours ? 'Percentual oficial agora' : 'Uso estimado da semana')}: <b>${percent.format(actual)}%</b></span>
      <span>${tr('Diferença')}: <b>${actual > expected ? '+' : ''}${percent.format(actual - expected)} pp</b></span>`}` };
  });

  const delta = data.official - expectedNow;
  summary.innerHTML = `<strong>${data.official.toFixed(0)}%</strong> ${tr("usado")} · ${tr("ideal")} <strong>${expectedNow.toFixed(0)}%</strong> · <span class="${delta > 0 ? 'negative' : 'positive'}">${delta > 0 ? '+' : ''}${delta.toFixed(0)} pp</span>`;
}

const CURVE = { width: 1000, height: 290, left: 48, right: 18, top: 16, bottom: 36 };
CURVE.plotWidth = CURVE.width - CURVE.left - CURVE.right;
CURVE.plotHeight = CURVE.height - CURVE.top - CURVE.bottom;
const CURVE_HOVER = `<g class="curve-hover" visibility="hidden">
      <line y1="${CURVE.top}" y2="${CURVE.height - CURVE.bottom}" class="curve-hover-line"/>
      <circle r="5" class="curve-expected-point"/>
      <circle r="5" class="curve-now-point"/>
    </g>`;
function curveX(slot) { return CURVE.left + slot / 168 * CURVE.plotWidth; }
function curveY(value) { return CURVE.top + (100 - Math.max(0, Math.min(100, value))) / 100 * CURVE.plotHeight; }
function curvePath(points) { return points.map((point, index) => `${index ? 'L' : 'M'} ${curveX(point.slot).toFixed(1)} ${curveY(point.value).toFixed(1)}`).join(' '); }
function curveInterpolate(points, slot) {
  const next = points.findIndex(point => point.slot >= slot);
  if (next < 0) return points.at(-1).value;
  if (next === 0) return points[0].value;
  const a = points[next - 1], b = points[next];
  return a.value + (b.value - a.value) * (slot - a.slot) / (b.slot - a.slot);
}
function expectedCurvePoints(slots) {
  const points = [{ slot: 0, value: 0 }];
  let sum = 0;
  slots.forEach((weight, slot) => { sum += weight * 100; points.push({ slot: slot + 1, value: sum }); });
  return points;
}
function curveSelection(startMs) {
  const start = Math.max(0, (state.custom?.start - startMs) / 36e5);
  const end = Math.min(168, (state.custom?.end - startMs) / 36e5);
  return Number.isFinite(start) && start < end ? { start, end } : null;
}
function curveFrame(startMs, selection) {
  const { left, right, top, bottom, width, height } = CURVE;
  const horizontal = [0, 25, 50, 75, 100].map(value =>
    `<g><line x1="${left}" y1="${curveY(value)}" x2="${width - right}" y2="${curveY(value)}" class="curve-grid-line"/><text x="${left - 9}" y="${curveY(value) + 4}" class="curve-axis-label" text-anchor="end">${value}%</text></g>`
  ).join('');
  const dayFormatter = new Intl.DateTimeFormat(locale(), { weekday: 'short' });
  const vertical = Array.from({ length: 8 }, (_, day) => {
    const slot = day * 24; const date = new Date(startMs + slot * 36e5);
    return `<g><line x1="${curveX(slot)}" y1="${top}" x2="${curveX(slot)}" y2="${height - bottom}" class="curve-day-line"/><text x="${curveX(slot)}" y="${height - 13}" class="curve-axis-label" text-anchor="${day === 0 ? 'start' : day === 7 ? 'end' : 'middle'}">${dayFormatter.format(date)}</text></g>`;
  }).join('');
  return `${horizontal}${vertical}
    <rect class="curve-selection" x="${selection ? curveX(selection.start) : left}" y="${top}" width="${selection ? curveX(selection.end) - curveX(selection.start) : 0}" height="${CURVE.plotHeight}" visibility="${selection ? 'visible' : 'hidden'}"/>`;
}
function curveFormatters() {
  return {
    date: new Intl.DateTimeFormat(locale(), { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    percent: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
  };
}
function bindCurveInteraction(root, startMs, selection, describe) {
  const { width, height, left, right, top, bottom, plotWidth } = CURVE;
  const hideTooltip = () => {
    root.querySelector('.curve-tooltip').hidden = true;
    root.querySelector('.curve-hover').setAttribute('visibility', 'hidden');
  };
  const showTooltip = event => {
    const svg = root.querySelector('svg'), bounds = svg.getBoundingClientRect();
    const plotX = (event.clientX - bounds.left) / bounds.width * width;
    const plotY = (event.clientY - bounds.top) / bounds.height * height;
    if (plotX < left || plotX > width - right || plotY < top || plotY > height - bottom) {
      hideTooltip();
      return;
    }
    const point = describe((plotX - left) / plotWidth * 168);
    const tooltip = root.querySelector('.curve-tooltip');
    tooltip.innerHTML = point.html;
    tooltip.hidden = false;
    const hover = root.querySelector('.curve-hover');
    hover.setAttribute('visibility', 'visible');
    const line = hover.querySelector('line');
    line.setAttribute('x1', curveX(point.slot)); line.setAttribute('x2', curveX(point.slot));
    const dots = hover.querySelectorAll('circle');
    dots[0].setAttribute('cx', curveX(point.slot)); dots[0].setAttribute('cy', curveY(point.expected));
    dots[1].setAttribute('visibility', point.actual === null ? 'hidden' : 'visible');
    dots[1].setAttribute('cx', curveX(point.slot)); dots[1].setAttribute('cy', curveY(point.actual ?? 0));
    const anchor = curveX(point.slot) / width * bounds.width;
    tooltip.style.left = `${Math.max(0, Math.min(bounds.width - tooltip.offsetWidth, anchor + 12))}px`;
    tooltip.style.top = `${Math.max(0, Math.min(bounds.height - tooltip.offsetHeight, event.clientY - bounds.top - tooltip.offsetHeight - 12))}px`;
  };
  let drag = null;
  const pointerSlot = (event, clamp = false) => {
    const bounds = root.querySelector('svg').getBoundingClientRect();
    const px = (event.clientX - bounds.left) / bounds.width * width;
    const py = (event.clientY - bounds.top) / bounds.height * height;
    if (!clamp && (px < left || px > width - right || py < top || py > height - bottom)) return null;
    return Math.max(0, Math.min(168, Math.round((px - left) / plotWidth * 168)));
  };
  const showSelection = (start, end) => {
    const rect = root.querySelector('.curve-selection');
    rect.setAttribute('x', curveX(start));
    rect.setAttribute('width', Math.max(0, curveX(end) - curveX(start)));
    rect.setAttribute('visibility', end > start ? 'visible' : 'hidden');
  };
  const restoreSelection = () => showSelection(selection?.start ?? 0, selection?.end ?? 0);
  const cancelDrag = () => {
    const previous = drag;
    drag = null;
    if (previous && root.hasPointerCapture(previous.id)) root.releasePointerCapture(previous.id);
    restoreSelection();
    hideTooltip();
  };
  root.onpointerdown = event => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    const slot = pointerSlot(event);
    if (slot === null) return;
    drag = { id: event.pointerId, start: slot, clientX: event.clientX };
    root.setPointerCapture(event.pointerId);
    showTooltip(event);
  };
  root.onpointermove = event => {
    if (drag && event.pointerId !== drag.id) return;
    showTooltip(event);
    if (drag) {
      const slot = pointerSlot(event, true);
      showSelection(Math.min(drag.start, slot), Math.max(drag.start, slot));
    }
  };
  root.onpointerup = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const previous = drag, slot = pointerSlot(event, true);
    drag = null;
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    if (Math.abs(event.clientX - previous.clientX) < 5 || slot === previous.start) {
      restoreSelection();
      return;
    }
    showSelection(Math.min(previous.start, slot), Math.max(previous.start, slot));
    hideTooltip();
    applyTimeRange(startMs + Math.min(previous.start, slot) * 36e5, startMs + Math.max(previous.start, slot) * 36e5);
  };
  root.onpointerleave = () => { if (!drag) hideTooltip(); };
  root.onpointercancel = cancelDrag;
  root.onlostpointercapture = () => { if (drag) cancelDrag(); };
}

function renderTimeline(provider = 'claude') {
  const view = ACTIVITY_VIEWS[provider], data = view.data(), { sessions, projects } = state.selection[provider];
  const components = activityComponents(provider);
  const timeline = document.getElementById(view.timeline); const legend = document.getElementById(view.legend);
  const rows = data?.timeline || [];
  const sessionsSelected = sessions.size > 0;
  const filtering = sessionsSelected || projects.size > 0;
  const selectedRows = projectActivityRows(provider).filter(row => sessionsSelected
    ? sessions.has(row.session_id)
    : projects.has(row.project_id));
  const selectedBuckets = new Map();
  for (const row of selectedRows) {
    if (!selectedBuckets.has(row.bucket_ms)) selectedBuckets.set(row.bucket_ms, {});
    const values = selectedBuckets.get(row.bucket_ms);
    for (const metric of components) values[metric.key] = (values[metric.key] || 0) + (row[metric.key] || 0);
  }
  const selectedTotal = selectedRows.reduce((sum, row) => sum + components.reduce((n, metric) => n + (row[metric.key] || 0), 0), 0);
  const total = data?.totals?.total_tokens || 0;
  document.getElementById(view.summary).textContent = filtering
    ? `${sessionsSelected ? `${sessions.size} ${tr('sessões selecionadas')}` : `${projects.size} ${tr('projetos selecionados')}`} · ${formatTokens(selectedTotal)} / ${formatTokens(total)} ${tr('processados')} · ${new Intl.NumberFormat(locale(), {style: 'percent', maximumFractionDigits: 1}).format(total ? selectedTotal / total : 0)} ${tr('do total no intervalo')} · ${tr('Restante esmaecido')}`
    : tr('Todas as sessões · selecione projetos ou sessões abaixo para comparar com o total.');
  document.getElementById(view.clear).hidden = !filtering;
  const oldAxis = timeline.parentElement.querySelector('.axis'); if (oldAxis) oldAxis.remove();
  if (!rows.length) { timeline.innerHTML = `<div class="empty">${tr('Sem atividade neste intervalo.')}</div>`; legend.innerHTML = ''; return; }
  legend.innerHTML = components.map(metric => `<span><i style="background:${metric.color}"></i>${metric.label}</span>`).join('');
  const byBucket = new Map();
  for (const row of rows) {
    if (!byBucket.has(row.bucket_ms)) byBucket.set(row.bucket_ms, Object.fromEntries(components.map(metric => [metric.key, 0])));
    const bucket = byBucket.get(row.bucket_ms);
    for (const metric of components) bucket[metric.key] += row[metric.key] || 0;
  }
  const buckets = [...byBucket.entries()];
  const bucketTotal = values => components.reduce((sum, metric) => sum + values[metric.key], 0);
  const max = Math.max(...buckets.map(([, values]) => bucketTotal(values)), 1);
  timeline.innerHTML = buckets.map(([bucket, values]) => `<div class="column" title="${formatDate(bucket)} · ${formatTokens(bucketTotal(values))} ${tr("processados")}">
    ${components.map(metric => {
      const selected = filtering ? Math.min(values[metric.key], selectedBuckets.get(bucket)?.[metric.key] || 0) : values[metric.key];
      const segment = (value, muted) => `<i class="segment${muted ? ' segment-muted' : ''}" style="height:${value / max * 100}%;background:${metric.color}" title="${metric.label} · ${tr(muted ? 'Outras sessões' : filtering ? 'Seleção' : 'Todas as sessões')}: ${exact.format(value)} / ${exact.format(values[metric.key])}"></i>`;
      return segment(selected, false) + (filtering ? segment(values[metric.key] - selected, true) : '');
    }).join('')}
  </div>`).join('');
  timeline.insertAdjacentHTML('afterend', `<div class="axis"><span>${formatDate(buckets[0][0])}</span><span>${formatDate(buckets.at(-1)[0])}</span></div>`);
}

function projectActivityRows(provider = 'claude') {
  const rows = ACTIVITY_VIEWS[provider].data()?.session_timeline || [];
  const { projects } = state.selection[provider];
  return projects.size ? rows.filter(row => projects.has(row.project_id)) : rows;
}
function visibleSessions(provider = 'claude', rows = ACTIVITY_VIEWS[provider].data()?.sessions || []) {
  if (!state.selection[provider].projects.size) return rows;
  const scoped = new Map();
  const keys = ['messages', 'input_tokens', 'output_tokens', 'cache_creation_tokens',
    'cache_read_tokens', 'thinking_tokens', 'fresh_tokens', 'total_tokens'];
  for (const row of projectActivityRows(provider)) {
    if (!scoped.has(row.session_id)) scoped.set(row.session_id, Object.fromEntries(keys.map(key => [key, 0])));
    const totals = scoped.get(row.session_id);
    for (const key of keys) totals[key] += row[key] || 0;
  }
  return rows.filter(row => scoped.has(row.session_id))
    .map(row => ({...row, ...scoped.get(row.session_id)}))
    .sort((a, b) => b.total_tokens - a.total_tokens);
}
function pruneHiddenSessionSelection(provider = 'claude') {
  const { sessions, projects } = state.selection[provider];
  if (!projects.size) return;
  const visible = new Set(visibleSessions(provider).map(row => row.session_id));
  for (const id of sessions) if (!visible.has(id)) sessions.delete(id);
}
function pruneSelection(provider) {
  const data = ACTIVITY_VIEWS[provider].data(), { sessions, projects } = state.selection[provider];
  const available = new Set((data?.sessions || []).map(row => row.session_id));
  for (const id of sessions) if (!available.has(id)) sessions.delete(id);
  const availableProjects = new Set((data?.projects || []).map(row => row.project_id));
  for (const id of projects) if (!availableProjects.has(id)) projects.delete(id);
  pruneHiddenSessionSelection(provider);
}

function renderRanking(id, rows, type, codex = false) {
  const provider = codex ? 'codex' : 'claude', { sessions, projects } = state.selection[provider];
  const sourceRows = rows;
  if (type === 'session') rows = visibleSessions(provider, rows);
  const root = document.getElementById(id); const max = Math.max(...rows.map(x => x.total_tokens), 1);
  const selectable = type !== 'model';
  root.innerHTML = (type === 'model' ? rows.slice(0, 8) : rows).map((row, i) => {
    const name = type === 'model' ? shortModel(row.model) : row.project;
    const countLabel = codex ? tr('eventos de uso') : tr('respostas');
    const detail = type === 'model' ? `${exact.format(row.messages)} ${countLabel}` : type === 'project' ? `${exact.format(row.sessions)} ${tr('sessões')} · ${exact.format(row.messages)} ${countLabel}` : `${row.session_id.slice(0, 8)} · ${exact.format(row.messages)} ${countLabel}`;
    const values = [
      [tr('Base perfil'), row.fresh_tokens], ['Input', row.input_tokens], ['Output', row.output_tokens],
      [tr('Cache escrito'), row.cache_creation_tokens], [tr('Cache lido'), row.cache_read_tokens], ['Thinking', row.thinking_tokens],
    ].filter(([label]) => !codex || label !== tr('Cache escrito'));
    const selected = selectable && (type === 'project' ? projects.has(row.project_id) : sessions.has(row.session_id));
    const selectionLabel = tr('Destacar no gráfico') + ' · ' + name + ' · ' + (type === 'project' ? row.cwd : row.session_id?.slice(0, 8));
    return `<div class="rank-row${selectable ? ' selectable-session' : ''}${selected ? ' selected-session' : ''}">
      ${selectable ? `<label class="session-toggle" title="${esc(selectionLabel)}"><input type="checkbox" aria-label="${esc(selectionLabel)}" data-session-index="${sourceRows.findIndex(source => type === 'session' ? source.session_id === row.session_id : source.project_id === row.project_id)}" ${selected ? 'checked' : ''}><span> ${tr('Destacar no gráfico')} · ${esc(name)} · ${esc(type === 'project' ? row.cwd : row.session_id.slice(0, 8))}</span></label>` : ''}
      <div class="rank-summary"><div class="rank-name"><strong title="${esc(type === 'model' ? row.model : row.cwd)}">${i + 1}. ${esc(name)}${type === 'session' ? `<span class="compact-session-id"> · ${esc(row.session_id.slice(0, 8))}</span>` : ''}</strong><small title="${esc(type === 'model' ? row.model : row.cwd)}">${esc(detail)}</small></div><div class="rank-value" title="${exact.format(row.total_tokens)} ${tr('processados')}">${formatTokens(row.total_tokens)}<small>${tr('processados')}</small></div></div>
      <div class="mini-bar"><i style="--value:${row.total_tokens / max * 100}%;background:${COLORS[i % COLORS.length]}"></i></div>
      <div class="metric-breakdown">${values.map(([label, value]) => `<span title="${label}: ${exact.format(value || 0)}"><small>${label}</small><strong>${formatTokens(value)}</strong></span>`).join('')}</div>
    </div>`;
  }).join('') || `<div class="empty">${tr('Sem dados.')}</div>`;
}

function shortModel(model) { return model.replace(/^claude-/, '').replace(/-\d{8}$/, ''); }
function applyTimeRange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return;
  document.getElementById('fromInput').value = localInputValue(start);
  document.getElementById('toInput').value = localInputValue(end);
  document.querySelectorAll('[data-range]').forEach(button => button.classList.remove('active'));
  return load({ start, end });
}
function localInputValue(timestamp) { const d = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }

for (const id of ['compactToggle', 'codexCompactToggle']) document.getElementById(id).addEventListener('click', () => {
  state.compactRankings = !state.compactRankings;
  try { localStorage.setItem('compactRankings', String(state.compactRankings)); } catch {}
  renderRankingMode();
});
renderRankingMode();

for (const [provider, view] of Object.entries(ACTIVITY_VIEWS)) {
  for (const [list, toggle] of [[view.sessions, toggleSession], [view.projects, toggleProject]]) {
    document.getElementById(list).addEventListener('click', event => {
      const row = event.target.closest('.selectable-session');
      if (!row || event.target.closest('label')) return;
      const checkbox = row.querySelector('input');
      toggle(Number(checkbox.dataset.sessionIndex), provider);
    });
    document.getElementById(list).addEventListener('change', event => {
      if (event.target.matches('input[data-session-index]')) toggle(Number(event.target.dataset.sessionIndex), provider);
    });
  }
  document.getElementById(view.clear).addEventListener('click', () => {
    state.selection[provider].sessions.clear(); state.selection[provider].projects.clear();
    renderActivitySelection(provider);
  });
}
function renderActivitySelection(provider = 'claude') {
  const view = ACTIVITY_VIEWS[provider], data = view.data();
  pruneHiddenSessionSelection(provider);
  renderTimeline(provider);
  renderRanking(view.sessions, data?.sessions || [], 'session', provider === 'codex');
  renderRanking(view.projects, data?.projects || [], 'project', provider === 'codex');
}
function toggleSelection(kind, id, provider) {
  const selected = state.selection[provider][kind];
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderActivitySelection(provider);
}
function toggleSession(index, provider = 'claude') {
  const id = ACTIVITY_VIEWS[provider].data()?.sessions?.[index]?.session_id;
  if (id) toggleSelection('sessions', id, provider);
}
function toggleProject(index, provider = 'claude') {
  const id = ACTIVITY_VIEWS[provider].data()?.projects?.[index]?.project_id;
  if (id !== undefined) toggleSelection('projects', id, provider);
}

function saveLanguage() {
  try { fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language }) }).catch(() => {}); } catch {}
}
document.getElementById('language').value = language;
saveLanguage();
document.getElementById('language').addEventListener('change', event => {
  language = event.target.value;
  try { localStorage.setItem('language', language); } catch {}
  saveLanguage();
  updateFormatters(); translateStatic();
  TOKEN_COMPONENTS[2].label = tr('Escrita em cache'); TOKEN_COMPONENTS[3].label = tr('Leitura de cache');
  render(); renderSyncTimestamp();
});
document.getElementById('paceMode').addEventListener('change', event => {
  state.paceMode = PACE_MODES.includes(event.target.value) ? event.target.value : 'historical';
  try { localStorage.setItem('paceMode', state.paceMode); } catch {}
  render();
});
renderProviderView(); renderPaceMode();
function selectView(view) {
  state.providerView = ['both', 'claude', 'codex'].includes(view) ? view : 'both';
  try { localStorage.setItem('providerView', state.providerView); } catch {}
  render(); renderSyncTimestamp();
  // Navigation uses already-loaded state and does not change collection.
}
for (const [view, id] of [['both', 'viewBoth'], ['claude', 'viewClaude'], ['codex', 'viewCodex']]) {
  document.getElementById(id).addEventListener('click', () => selectView(view));
}
document.getElementById('overview').addEventListener('click', event => {
  const button = event.target.closest('[data-detail]');
  if (button) selectView(button.dataset.detail);
});
for (const [provider, id] of [['claude', 'collectClaude'], ['codex', 'collectCodex']]) {
  document.getElementById(id).checked = providerEnabled(provider);
  document.getElementById(id).addEventListener('change', event => {
    state.collection[provider] = event.target.checked;
    try { localStorage.setItem('collectionProviders', JSON.stringify(state.collection)); } catch {}
    render(); renderSyncTimestamp();
  });
}
document.getElementById('presets').addEventListener('click', event => {
  const button = event.target.closest('[data-range]'); if (!button) return;
  state.range = button.dataset.range; state.custom = null; document.querySelectorAll('[data-range]').forEach(x => x.classList.toggle('active', x === button)); load();
});
document.getElementById('applyCustom').addEventListener('click', () => {
  const start = new Date(document.getElementById('fromInput').value).getTime(); const end = new Date(document.getElementById('toInput').value).getTime();
  applyTimeRange(start, end);
});
document.getElementById('fromInput').value = localInputValue(Date.now() - DURATIONS['5h']);
document.getElementById('toInput').value = localInputValue(Date.now());
let syncTimer;
function scheduleSync() {
  clearInterval(syncTimer);
  const minutes = Number(document.getElementById('syncInterval').value);
  if (minutes > 0) syncTimer = setInterval(() => load(null, true), minutes * 60_000);
}
try {
  const saved = localStorage.getItem('syncInterval');
  if (['0', '5', '10', '15', '30'].includes(saved)) document.getElementById('syncInterval').value = saved;
} catch {}
document.getElementById('syncInterval').addEventListener('change', event => {
  try { localStorage.setItem('syncInterval', event.target.value); } catch {}
  scheduleSync();
});
document.getElementById('syncNow').addEventListener('click', () => load(null, true, true));
load(); scheduleSync();
setInterval(() => { render(); renderSyncTimestamp(); }, 60_000);

async function checkForUpdate() {
  const button = document.getElementById('updateButton');
  const parse = tag => (String(tag).match(/^v?(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
  try {
    const { version } = await (await fetch('/api/health')).json();
    const local = parse(version);
    if (!button || local.length !== 3) return;
    const tags = await (await fetch('https://api.github.com/repos/ronaldoflima/agent-usage-dashboard/tags?per_page=30')).json();
    const latest = tags.map(t => t.name).filter(n => parse(n).length === 3).sort((a, b) => newer(parse(a), parse(b)) ? -1 : 1)[0];
    if (!latest || !newer(parse(latest), local)) return;
    button.textContent = `${tr('Atualizar para')} ${latest}`;
    button.title = `${version} → ${latest}`;
    button.hidden = false;
    button.onclick = () => runUpdate(button, latest);
  } catch {}
}

async function runUpdate(button, latest) {
  if (!confirm(tr('Atualizar o dashboard e reiniciar o servidor?'))) return;
  const status = document.getElementById('syncStatus');
  button.disabled = true;
  button.textContent = tr('Atualizando…');
  try {
    const response = await fetch('/api/update', { method: 'POST', headers: { 'X-Requested-With': 'dashboard' } });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || response.status);
    if (!result.restart) { status.textContent = tr('Atualizado. Reinicie o servidor manualmente.'); button.hidden = true; return; }
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      try {
        const health = await (await fetch('/api/health', { cache: 'no-store' })).json();
        if (health.version === result.version) {
          try { sessionStorage.setItem('syncAfterUpdate', '1'); } catch {}
          location.reload();
          return;
        }
      } catch {}
    }
    throw new Error('timeout');
  } catch (error) {
    status.textContent = `${tr('Falha ao atualizar:')} ${error.message}`;
    button.disabled = false;
    button.textContent = `${tr('Atualizar para')} ${latest}`;
  }
}

checkForUpdate();
try {
  if (sessionStorage.getItem('syncAfterUpdate')) {
    sessionStorage.removeItem('syncAfterUpdate');
    document.getElementById('syncNow').click();
  }
} catch {}
