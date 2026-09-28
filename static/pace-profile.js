// A profile needs about one week of active hours before its shape is trusted;
// until then it is blended with the linear curve used when no profile exists.
const MIN_PROFILE_HOURS = 168;
// Expected-percentage mass that anchors projections to the target pace (ratio 1)
// until the current cycle has accumulated comparable evidence.
const PRIOR_PACE_MASS = 10;

function profileReliability(profile) {
  const hours = profile?.sample_hours;
  return Number.isFinite(hours) ? Math.max(0, Math.min(1, hours / MIN_PROFILE_HOURS)) : 1;
}

/* Average matching workday hours, preserving weekend slots and weekly mass. */
function paceProfileSlots(profile, mode) {
  const weekly = profile?.weekly;
  const raw = weekly?.slots;
  if (!Array.isArray(raw) || raw.length !== 168) return null;
  const reliability = profileReliability(profile);
  const slots = reliability < 1 ? raw.map(value => reliability * value + (1 - reliability) / 168) : raw;
  if (mode !== 'equal_weekdays') return slots;
  const resetHour = weekly.reset_weekday * 24 + weekly.reset_hour;
  const hourlyMeans = Array(24).fill(0);
  slots.forEach((value, slot) => {
    const hour = (resetHour + slot) % 168;
    if (Math.floor(hour / 24) < 5) hourlyMeans[hour % 24] += value / 5;
  });
  return slots.map((value, slot) => {
    const hour = (resetHour + slot) % 168;
    return Math.floor(hour / 24) < 5 ? hourlyMeans[hour % 24] : value;
  });
}

// Rotate calendar-hour weights to the actual account window, interpolating
// fractional hours at the hourly resolution of the historical profile.
function alignedPaceSlots(profile, mode, startMs) {
  const slots = paceProfileSlots(profile, mode);
  if (!slots || !Number.isFinite(startMs)) return slots;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: profile.weekly.timezone, weekday: 'short', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(startMs)).map(part => [part.type, part.value]));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  const offset = (day * 24 + Number(parts.hour) + Number(parts.minute) / 60
    + Number(parts.second) / 3600 - profile.weekly.reset_weekday * 24
    - profile.weekly.reset_hour + 168) % 168;
  const whole = Math.floor(offset), fraction = offset - whole;
  return slots.map((_, index) => slots[(index + whole) % 168] * (1 - fraction)
    + slots[(index + whole + 1) % 168] * fraction);
}

function slotProgress(slots, elapsedHours) {
  if (!Array.isArray(slots) || slots.length !== 168) return null;
  const position = Math.max(0, Math.min(168, elapsedHours));
  const whole = Math.floor(position); const fraction = position - whole;
  const completed = slots.slice(0, whole).reduce((sum, value) => sum + value, 0);
  return Math.min(100, (completed + (whole < 168 ? slots[whole] * fraction : 0)) * 100);
}

function slotProjection(slots, targetPercent, startMs) {
  if (!Array.isArray(slots) || targetPercent > 100) return null;
  let cumulative = 0;
  for (let slot = 0; slot < slots.length; slot++) {
    const next = cumulative + slots[slot] * 100;
    if (next >= targetPercent) {
      const fraction = slots[slot] > 0 ? (targetPercent - cumulative) / (slots[slot] * 100) : 0;
      return startMs + (slot + fraction) * 36e5;
    }
    cumulative = next;
  }
  return null;
}

// The displayed pressure stays the raw observed/expected ratio; only the
// projection shrinks it toward 1 while the expected mass is still small.
function weeklyPaceProjection(slots, utilization, elapsedHours, startMs) {
  const expected = slotProgress(slots, elapsedHours);
  if (expected === null) return null;
  const pressure = expected > 0 ? utilization / expected : 0;
  const projectionRatio = utilization > 0 ? (utilization + PRIOR_PACE_MASS) / (expected + PRIOR_PACE_MASS) : 0;
  const projectedMs = projectionRatio > 0
    ? slotProjection(slots, expected + (100 - utilization) / projectionRatio, startMs) : null;
  return { expected, pressure, projectionRatio, projectedMs, preliminary: expected < PRIOR_PACE_MASS };
}

if (typeof module !== 'undefined') module.exports = {
  paceProfileSlots, alignedPaceSlots, profileReliability, slotProgress, slotProjection, weeklyPaceProjection,
};
