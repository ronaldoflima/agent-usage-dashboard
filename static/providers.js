/* Provider-specific data stays separate; quota percentages are never added. */
function providerEnabled(provider) { return state.collection[provider]; }

function renderProviderView() {
  document.body.dataset.providerView = state.providerView;
  for (const [view, id] of [['both', 'viewBoth'], ['claude', 'viewClaude'], ['codex', 'viewCodex']]) {
    document.getElementById(id).setAttribute('aria-pressed', String(state.providerView === view));
  }
  const brand = state.providerView === 'both' ? 'Claude + Codex' : state.providerView === 'claude' ? 'Claude' : 'Codex';
  document.title = `${brand} · ${tr('Ritmo de Uso')}`;
  document.getElementById('providerBrand').textContent = `${state.providerView === 'claude' ? 'CLAUDE CODE' : brand.toUpperCase()} · LOCAL`;
  document.getElementById('claudeCurveEyebrow').textContent = tr(state.providerView === 'claude' ? 'RITMO SEMANAL' : 'CLAUDE · RITMO SEMANAL');
  document.getElementById('claudeActivityEyebrow').textContent = state.providerView === 'claude' ? tr('ATIVIDADE LOCAL') : 'CLAUDE · LOCAL';
}

function renderOverview() {
  document.getElementById('overview').innerHTML = [
    ['claude', 'Claude', state.limits, state.profile],
    ['codex', 'Codex', state.codex?.limits, state.codex?.activity?.profile],
  ].map(([provider, name, payload, profile]) => {
    const limits = payload?.limits || [];
    const weekly = limits.find(limit => limit.kind === 'weekly_all' && (!limit.bucket || limit.bucket === 'codex'));
    const short = limits.find(limit => limit.kind === 'session' && (!limit.bucket || limit.bucket === 'codex'));
    const fresh = payload?.ok && !payload.stale && payload.source !== 'codex_local_snapshot';
    const pace = fresh && weekly ? paceFor(weekly, profile, payload.fetched_at) : null;
    const limitRow = (label, limit) => `<div class="overview-row"><span>${tr(label)}</span><div>${limit
      ? `<strong>${limit.utilization.toFixed(0)}%</strong><small>${tr('reset em')} ${countdown(limit.resets_at)} · ${esc(formatDate(limit.resets_at))}</small>`
      : `<span>—</span><small>${tr('Não informado')}</small>`}</div></div>`;
    return `<article class="overview-card panel ${provider === 'codex' ? 'codex-section' : ''}">
      <h2>${name}</h2><p class="provider-status">${esc(providerStatus(payload))}${providerEnabled(provider) ? '' : ` · ${tr('Coleta pausada')}`}</p>
      ${limitRow('Curto prazo', short)}${limitRow('Semanal', weekly)}
      <div class="overview-row"><span>${tr('Ritmo semanal')}</span><div>${pace ? `<span class="pace-badge ${pace.className}">${pace.label}</span><small>${pace.historical ? paceModeLabel() : tr('Estimativa linear')}</small>` : '—'}</div></div>
      <div class="overview-row"><span>${tr('Até o reset')}</span><div>${pace ? `<span>${pace.reachesBeforeReset ? tr('Pode atingir o limite') : tr('Dentro da cota')}</span><small>${tr('Estimativa na data do snapshot')}</small>` : `<span>${tr('Sem estimativa confiável')}</span>`}</div></div>
      <button type="button" data-detail="${provider}">${tr('Ver detalhes')} →</button>
    </article>`;
  }).join('');
}

function quotaSamples(samples, limit) {
  const reset = Date.parse(limit?.resets_at);
  const duration = (limit?.window_minutes || 10080) * 60000;
  return (samples || []).filter(sample => sample.key === limit?.key &&
    Date.parse(sample.resets_at) === reset && sample.observed_ms >= reset - duration &&
    sample.observed_ms < reset && Number.isFinite(sample.utilization))
    .sort((a, b) => a.observed_ms - b.observed_ms);
}

async function loadCodex(start, end, sync, force) {
  try {
    const results = await Promise.allSettled([
      fetch(`/api/codex/dashboard?from=${start}&to=${end}${sync ? '&sync=1' : ''}`).then(r => r.json()),
      fetch(`/api/codex/limits${force ? '?force=1' : sync ? '?sync=1' : ''}`).then(r => r.json()),
    ]);
    const [activity, limits] = results.map(result => result.status === 'fulfilled'
      ? result.value : { ok: false, error: tr('falha na atualização') });
    state.codex = { activity, limits };
    if (!limits.ok && activity.local_limits?.ok) {
      state.codex.limits = { ...activity.local_limits, stale: true, error: limits.error };
    }
  } catch {
    state.codex = { activity: { ok: false }, limits: { ok: false } };
  }
}

function providerStatus(payload) {
  const local = payload?.source === 'codex_local_snapshot';
  const label = local ? tr('Snapshot local') : tr('Último sync oficial:');
  const timestamp = payload?.fetched_at ? new Date(payload.fetched_at).toLocaleString(locale()) : tr('Sem sync oficial');
  return `${label} ${timestamp}${payload?.stale ? ` · ${tr('Dados desatualizados')}` : ''}${payload?.error ? ` · ${payload.error}` : ''}`;
}

function renderProviders() {
  document.getElementById('claudeSync').textContent = providerStatus(state.limits);
  if (state.providerView !== 'codex') return;
  const { activity, limits } = state.codex || {};
  document.getElementById('codexSync').textContent = providerStatus(limits);
  const root = document.getElementById('codexLimits');
  root.innerHTML = (limits?.limits || []).map(limit => {
    const pct = limit.utilization;
    const pace = paceFor(limit, activity?.profile, limits.fetched_at);
    const weekly = limit.window_minutes === 10080;
    const duration = weekly ? tr('Semanal') : `${limit.window_minutes / 60}h`;
    const live = limits.source === 'codex_app_server';
    return `<article class="limit panel" style="--ring-color:${tone(pct)}">
      <div class="limit-title"><strong>${esc(limit.label)} · ${duration}</strong><span>${live ? tr('plano oficial') : tr('Snapshot local')}</span></div>
      <div class="limit-value"><strong>${pct.toFixed(1)}%</strong><span>${tr('utilizado')}</span></div>
      <div class="bar" style="--bar-color:${tone(pct)}"><i style="--value:${pct}%"></i></div>
      <div class="limit-meta"><span>${tr('restam')} ${(100 - pct).toFixed(0)}%</span><span>${tr('reset em')} ${countdown(limit.resets_at)} · ${formatDate(limit.resets_at)}</span></div>
      ${pace ? `<div class="pace-head"><span class="pace-badge ${pace.className}">${pace.label}</span><span>${tr('ideal do modo')}: ${pace.expected.toFixed(0)}%</span></div>
        <div class="pace-grid"><span><small>${tr('Pressão vs padrão')}</small><strong>${pace.pressure.toFixed(2)}×</strong></span><span><small>${tr('Pode gastar')}</small><strong>${pace.sustainableRate.toFixed(1)}%/h</strong></span><span><small>${tr('Margem')}</small><strong>${pace.margin.toFixed(0)} pp</strong></span></div>
        <p class="projection ${pace.reachesBeforeReset ? 'warning' : ''}">${pace.reachesBeforeReset ? `${tr('Mantendo seu padrão, chega a 100%')} ${clock(pace.projectedMs)}` : tr('Mantendo seu padrão, não chega a 100% antes do reset')}${pace.preliminary ? ` · ${tr('estimativa preliminar')}` : ''}</p>
        <p class="profile-source">${pace.historical ? paceModeLabel() : tr('Estimativa linear')} · ${tr('Estimativa na data do snapshot')}</p>`
        : `<p class="projection">${tr('Janela encerrada ou dados insuficientes. Sincronize para atualizar.')}</p>`}
    </article>`;
  }).join('') || `<div class="panel empty">${tr('Codex indisponível. Use Sync ou verifique o login do CLI.')}</div>`;
  renderCodexCurve();
  const totals = activity?.totals || {};
  const metrics = [[tr('Volume processado'), 'total_tokens'], [tr('Input sem cache'), 'input_tokens'],
    ['Output', 'output_tokens'], [tr('Leitura de cache'), 'cache_read_tokens'], ['Thinking', 'thinking_tokens']];
  document.getElementById('codexMetrics').innerHTML = metrics.map(([label, key]) =>
    `<article class="metric panel"><span>${label}</span><strong>${activity?.ok ? formatTokens(totals[key]) : '—'}</strong><small>${key === 'thinking_tokens' ? tr('parte do output; não somar novamente') : tr('no intervalo selecionado')}</small></article>`).join('');
  pruneSelection('codex');
  renderTimeline('codex');
  renderRanking('codexProjects', activity?.projects || [], 'project', true);
  renderRanking('codexModels', activity?.models || [], 'model', true);
  renderRanking('codexSessions', activity?.sessions || [], 'session', true);
}

function renderCodexCurve() {
  const root = document.getElementById('codexCurve');
  const note = document.getElementById('codexCurveNote');
  root.onpointermove = root.onpointerdown = root.onpointerup = root.onpointerleave = root.onpointercancel = root.onlostpointercapture = null;
  const { activity, limits } = state.codex || {};
  const limit = limits?.limits?.find(item => item.window_minutes === 10080 && item.bucket === 'codex')
    || limits?.limits?.find(item => item.window_minutes === 10080);
  if (!limit || Date.parse(limit.resets_at) <= Date.now()) {
    root.innerHTML = `<div class="empty">${tr('Janela encerrada ou dados insuficientes. Sincronize para atualizar.')}</div>`;
    note.textContent = '';
    return;
  }
  const reset = Date.parse(limit.resets_at), start = reset - 168 * 36e5;
  const slotOf = ms => (ms - start) / 36e5;
  const profile = activity?.profile?.ok ? activity.profile : null;
  const slots = profile ? selectedProfileSlots(profile, start) : Array(168).fill(1 / 168);
  const samples = quotaSamples(state.snapshots?.codex, limit).map(sample => ({ ...sample, slot: slotOf(sample.observed_ms), value: sample.utilization }));
  const expected = expectedCurvePoints(slots);
  // Break observed lines at long gaps and downward corrections; no invented history.
  const observedPath = samples.map((sample, i) => {
    const prev = samples[i - 1];
    const connected = prev && sample.observed_ms - prev.observed_ms <= 30 * 60000 && sample.utilization >= prev.utilization;
    return `${connected ? 'L' : 'M'} ${curveX(sample.slot).toFixed(1)} ${curveY(sample.value).toFixed(1)}`;
  }).join(' ');
  const pace = paceFor(limit, profile, limits.fetched_at);
  const observedSlot = slotOf(Date.parse(limits.fetched_at));
  const projection = pace && observedSlot >= 0 && observedSlot < 168
    ? [{ slot: observedSlot, value: limit.utilization }, ...expected.filter(p => p.slot > observedSlot).map(p => ({ slot: p.slot, value: limit.utilization + (p.value - pace.expected) * pace.projectionRatio }))] : [];
  const selection = curveSelection(start);
  root.innerHTML = `<svg viewBox="0 0 ${CURVE.width} ${CURVE.height}" preserveAspectRatio="none" aria-hidden="true">
    ${curveFrame(start, selection)}
    <path d="${curvePath(expected)}" class="curve-expected-line"/>
    <path d="${observedPath}" class="curve-actual-line"/>
    <path d="${curvePath(projection)}" class="curve-projection-line"/>
    ${samples.map(s => `<circle cx="${curveX(s.slot)}" cy="${curveY(s.value)}" r="3" class="curve-now-point"><title>${esc(formatDate(s.observed_ms))} · ${s.utilization}%</title></circle>`).join('')}
    ${CURVE_HOVER}
  </svg><div class="curve-tooltip" role="tooltip" hidden></div>`;
  const { date, percent } = curveFormatters();
  bindCurveInteraction(root, start, selection, raw => {
    const nearest = samples.reduce((best, sample) => !best || Math.abs(sample.slot - raw) < Math.abs(best.slot - raw) ? sample : best, null);
    const snapshot = nearest && Math.abs(nearest.slot - raw) < .5 ? nearest : null;
    const slot = snapshot ? snapshot.slot : Math.max(0, Math.min(168, Math.round(raw)));
    const projected = !snapshot && projection.length && slot > observedSlot;
    const actual = snapshot ? snapshot.value : projected ? curveInterpolate(projection, slot) : null;
    const value = curveInterpolate(expected, slot);
    return { slot, expected: value, actual, html: `<strong>${esc(date.format(new Date(start + slot * 36e5)))}</strong>
      <span>${tr('Curva esperada')}: <b>${percent.format(value)}%</b></span>
      ${actual === null ? '' : `<span>${tr(snapshot ? 'Snapshot oficial' : 'Projeção')}: <b>${percent.format(actual)}%</b></span>
      <span>${tr('Diferença')}: <b>${actual > value ? '+' : ''}${percent.format(actual - value)} pp</b></span>`}` };
  });
  note.textContent = `${limit.label} · ${profile ? `${paceModeLabel()} · ${profile.sample_hours} ${tr('horas com dados')}` : tr('Estimativa linear')} · ${samples.length} ${tr('snapshots neste ciclo')}. ${tr('Sem interpolação em lacunas maiores que 30 min. Projeção não é medição.')}`;
}

function remoteSyncSummary(scans, translate, formatTime) {
  const failures = [], failed = new Set(), synced = new Map();
  for (const [provider, scan] of scans) {
    for (const status of scan?.remotes || []) {
      const label = status.push ? `${status.host} ↑` : status.host;
      if (status.ok) { synced.set(label, status.synced_at); continue; }
      failed.add(label);
      failures.push(`${label} (${provider}): ${translate('falha no host remoto:')} ${status.error}`);
    }
  }
  return [...failures, ...[...synced].filter(([host]) => !failed.has(host))
    .map(([host, at]) => `${host}: ${translate('sincronizado às')} ${formatTime(at)}`)];
}

if (typeof module !== 'undefined') module.exports = { quotaSamples, remoteSyncSummary };
