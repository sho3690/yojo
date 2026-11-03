import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOura, OuraError, missingScope } from '../scripts/oura.mjs';
import { stable } from '../scripts/state-io.mjs';

test('Oura: ページをたどり、取れない任意の項目は空にする', async () => {
  const calls = [];
  const fetchJson = async u => {
    calls.push(u.pathname.split('/').pop() + (u.searchParams.get('next_token') ? '+' : ''));
    const ep = u.pathname.split('/').pop();
    if (ep === 'daily_stress') throw new OuraError(404);
    if (ep === 'daily_sleep' && !u.searchParams.get('next_token')) return { data: [{ day: 'a' }], next_token: 'n1' };
    return { data: [{ day: 'b' }], next_token: null };
  };
  const data = await fetchOura('t', '2026-10-01', '2026-10-27', { fetchJson });
  assert.equal(data.dailySleep.length, 2);
  assert.deepEqual(data.stress, []);
  assert.equal(data.spo2.length, 1);
  assert.ok(calls.includes('daily_sleep+'));
});

test('Oura: 鍵が無効（401）なら止めて知らせる', async () => {
  const fetchJson = async () => { throw new OuraError(401); };
  await assert.rejects(fetchOura('t', 'a', 'b', { fetchJson }), e => e.status === 401);
});

test('Oura: 401 の本文で「許可が足りない」と「鍵が使えない」を見分ける', () => {
  assert.equal(missingScope('{"detail":"Token is not authorized access daily scope."}'), 'daily');
  assert.equal(missingScope('{"detail":"Token is not authorized access stress scope."}'), 'stress');
  assert.equal(missingScope('{"detail":"The access token provided is expired, revoked, malformed, or invalid for other reasons."}'), '');
  assert.equal(missingScope(''), '');
});

test('Oura: 必要な許可（daily）が無ければ、どの許可かを付けて止める', async () => {
  const fetchJson = async () => { throw new OuraError(401, 'daily'); };
  await assert.rejects(fetchOura('t', 'a', 'b', { fetchJson }), e => e.status === 401 && e.scope === 'daily');
});

test('Oura: 任意の項目の許可（stress・spo2）が無いだけなら、空にして続ける', async () => {
  const fetchJson = async u => {
    const ep = u.pathname.split('/').pop();
    if (ep === 'daily_stress') throw new OuraError(401, 'stress');
    if (ep === 'daily_spo2') throw new OuraError(401, 'spo2');
    return { data: [{ day: 'b' }] };
  };
  const data = await fetchOura('t', 'a', 'b', { fetchJson });
  assert.equal(data.readiness.length, 1);
  assert.deepEqual(data.stress, []);
  assert.deepEqual(data.spo2, []);
});

test('Oura: 混み合い（429）は1回だけやり直す', async () => {
  let n = 0;
  const fetchJson = async () => { n++; if (n === 1) throw new OuraError(429); return { data: [] }; };
  const t0 = Date.now();
  await fetchOura('t', 'a', 'b', { fetchJson });
  assert.ok(Date.now() - t0 >= 3500);
});

test('比べ方はキーの並びに左右されない', () => {
  assert.equal(stable({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } }), stable({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }));
  assert.notEqual(stable({ a: 1 }), stable({ a: 2 }));
});
