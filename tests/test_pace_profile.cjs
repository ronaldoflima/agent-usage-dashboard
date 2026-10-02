const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paceProfileSlots, alignedPaceSlots, profileReliability, weeklyPaceProjection } = require('../static/pace-profile.js');

test('aligns old profiles to a personal reset with timezone and minutes', () => {
  const slots = Array(168).fill(0);
  // Wednesday 14:00 and 15:00 in a profile starting Saturday 19:00.
  slots[91] = 0.6; slots[92] = 0.4;
  const profile = { weekly: { slots, reset_weekday: 5, reset_hour: 19, timezone: 'America/Sao_Paulo' } };
  const aligned = alignedPaceSlots(profile, 'historical', Date.parse('2026-09-23T17:30:00Z'));
  assert.equal(aligned[0], 0.5);
  assert.equal(aligned[1], 0.2);
  assert.equal(aligned[167], 0.3);
  assert.ok(Math.abs(aligned.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.deepEqual(alignedPaceSlots(profile, 'historical', Date.parse('2026-09-19T22:00:00Z')), slots);
});

test('balanced workdays preserve weekends and total, including reset-day split', () => {
  for (const [reset_weekday, reset_hour] of [[5, 19], [0, 0], [2, 12]]) {
    const raw = Array.from({ length: 168 }, (_, i) => (i + 1) ** 2);
    const total = raw.reduce((a, b) => a + b, 0);
    const slots = raw.map(value => value / total);
    const original = [...slots];
    const profile = { weekly: { slots, reset_weekday, reset_hour } };
    assert.deepEqual(paceProfileSlots(profile, 'historical'), original);
    const result = paceProfileSlots(profile, 'equal_weekdays');
    const days = Array(7).fill(0);
    const hours = Array.from({ length: 7 }, () => Array(24));
    result.forEach((value, slot) => {
      const absolute = (reset_weekday * 24 + reset_hour + slot) % 168;
      const day = Math.floor(absolute / 24);
      days[day] += value;
      hours[day][absolute % 24] = value;
      if (day >= 5) assert.equal(value, original[slot]);
    });
    assert.ok(Math.abs(result.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    for (let day = 1; day < 5; day++) {
      assert.ok(Math.abs(days[day] - days[0]) < 1e-12);
      assert.deepEqual(hours[day], hours[0]);
    }
    assert.deepEqual(slots, original);
  }
});

test('blended mode is the midpoint of historical and balanced, preserving total and weekends', () => {
  const raw = Array.from({ length: 168 }, (_, i) => (i % 24 + 1) * (1 + Math.floor((i + 19) % 168 / 24)));
  const total = raw.reduce((a, b) => a + b, 0);
  const profile = { weekly: { slots: raw.map(value => value / total), reset_weekday: 5, reset_hour: 19 } };
  const historical = paceProfileSlots(profile, 'historical');
  const balanced = paceProfileSlots(profile, 'equal_weekdays');
  const blended = paceProfileSlots(profile, 'blended');
  blended.forEach((value, slot) => assert.ok(Math.abs(value - (historical[slot] + balanced[slot]) / 2) < 1e-12));
  assert.ok(Math.abs(blended.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test('missing profile falls back and zero activity stays zero', () => {
  assert.equal(paceProfileSlots(null, 'equal_weekdays'), null);
  assert.equal(paceProfileSlots({ weekly: { slots: [] } }, 'equal_weekdays'), null);
  const slots = Array(168).fill(0);
  assert.deepEqual(paceProfileSlots({ weekly: { slots, reset_weekday: 5, reset_hour: 19 } }, 'equal_weekdays'), slots);
});

const START = Date.parse('2026-09-27T16:00:00Z');
const hoursAfterStart = ms => (ms - START) / 36e5;
const normalized = raw => { const total = raw.reduce((a, b) => a + b, 0); return raw.map(value => value / total); };
// Quiet first 18 hours (2%), one isolated 9.25% hour on Tuesday, the rest on weekday hours.
function quietStartSlots() {
  const raw = Array(168).fill(0);
  for (let slot = 0; slot < 18; slot++) raw[slot] = 2 / 18;
  const busy = Array.from({ length: 85 }, (_, i) => 42 + i).filter(slot => slot !== 45);
  for (const slot of busy) raw[slot] = 88.75 / busy.length;
  raw[45] = 9.25;
  return normalized(raw);
}
const profileOf = (slots, sample_hours) => ({ sample_hours, weekly: { slots, reset_weekday: 6, reset_hour: 16, timezone: 'UTC' } });

test('cycle start: a small expected mass does not extrapolate raw pressure to the whole week', () => {
  const slots = paceProfileSlots(profileOf(quietStartSlots(), 400), 'historical');
  const pace = weeklyPaceProjection(slots, 10, 18, START);
  assert.ok(Math.abs(pace.expected - 2) < 1e-9);
  assert.ok(Math.abs(pace.pressure - 5) < 1e-9);
  assert.ok(Math.abs(pace.projectionRatio - 20 / 12) < 1e-9);
  assert.ok(pace.preliminary);
  assert.ok(hoursAfterStart(pace.projectedMs) > 72, `projected at ${hoursAfterStart(pace.projectedMs)}h`);
  const late = weeklyPaceProjection(slots, 90, slots.findIndex((_, i) => slots.slice(0, i).reduce((a, b) => a + b, 0) >= 0.6), START);
  assert.ok(!late.preliminary);
  assert.ok(Math.abs(late.projectionRatio / late.pressure - 1) < 0.06);
  assert.equal(weeklyPaceProjection(slots, 0, 18, START).projectedMs, null);
});

test('small sample: profiles under one week of active hours blend toward the linear curve', () => {
  const slots = quietStartSlots();
  assert.equal(profileReliability(profileOf(slots, 70)), 70 / 168);
  assert.equal(profileReliability(profileOf(slots, 400)), 1);
  assert.equal(profileReliability({ weekly: { slots } }), 1);
  assert.deepEqual(paceProfileSlots(profileOf(slots, 168), 'historical'), slots);
  const blended = paceProfileSlots(profileOf(slots, 70), 'historical');
  const c = 70 / 168;
  blended.forEach((value, i) => assert.ok(Math.abs(value - (c * slots[i] + (1 - c) / 168)) < 1e-15));
  assert.ok(Math.abs(blended.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const balanced = paceProfileSlots(profileOf(slots, 70), 'equal_weekdays');
  assert.ok(Math.abs(balanced.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const pace = weeklyPaceProjection(blended, 10, 18, START);
  assert.ok(pace.expected > 7 && pace.expected < 7.2, `expected ${pace.expected}`);
  assert.ok(pace.pressure < 1.5);
  assert.ok(hoursAfterStart(pace.projectedMs) > 96, `projected at ${hoursAfterStart(pace.projectedMs)}h`);
});

test('isolated peak: one historical hour or one early burst does not set the projected date', () => {
  const spike = normalized(Array.from({ length: 168 }, (_, i) => i === 45 ? 84 : 0.5));
  assert.equal(paceProfileSlots(profileOf(spike, 400), 'historical')[45], spike[45]);
  const thin = paceProfileSlots(profileOf(spike, 24), 'historical');
  assert.ok(Math.max(...thin) < 0.1, `peak ${Math.max(...thin)}`);
  const uniform = Array(168).fill(1 / 168);
  const burst = weeklyPaceProjection(uniform, 10, 1, START);
  assert.ok(burst.pressure > 16);
  assert.ok(burst.preliminary);
  const ratio = 20 / (100 / 168 + 10);
  assert.ok(Math.abs(hoursAfterStart(burst.projectedMs) - (100 / 168 + 90 / ratio) * 1.68) < 1e-6);
  assert.ok(hoursAfterStart(burst.projectedMs) > 80);
});
