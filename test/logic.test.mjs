import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const T = '2026-10-26';
// 指定の日に Oura の数値を入れた state を作る
function withDays(fill, n = 60, today = T) {
  const s = L.emptyState();
  for (let i = n - 1; i >= 0; i--) { const d = L.addDays(today, -i); s.days[d] = fill(i, d); }
  return s;
}
const wobble = i => [0, 1, -1, 2, -2, 1, -1][i % 7];

test('日付: 日本時間の暦日・月またぎ・表示', () => {
  assert.equal(L.jstDate(Date.parse('2026-10-25T14:59:00Z')), '2026-10-25');
  assert.equal(L.jstDate(Date.parse('2026-10-25T15:00:00Z')), '2026-10-26');
  assert.equal(L.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(L.daysBetween('2026-10-01', '2026-10-26'), 25);
  assert.equal(L.fmtDay('2026-10-26'), '10月26日（月）');
  assert.equal(L.fmtDur(7 * 3600 + 12 * 60), '7時間12分');
  assert.equal(L.fmtDur(45 * 60), '45分');
  assert.equal(L.fmtDur(null), '—');
  assert.equal(L.clockMin('2026-10-25T23:30:00+09:00'), 690);
  assert.equal(L.clockMin('2026-10-26T00:30:00+09:00'), 750);
  assert.equal(L.fmtClock(690), '23:30');
  assert.equal(L.fmtClock(750), '0:30');
  assert.equal(L.isDay('2026-02-30'), true, '形は合っていれば日付として扱う（Date が補正する）');
  assert.equal(L.isDay('2026/10/26'), false);
});

test('Oura の数値を整える: 夜の睡眠を選び、スコアを残し、変な値は捨てる', () => {
  const s = L.emptyState();
  L.mergeOura(s, {
    dailySleep: [{ day: T, score: 81, contributors: { total_sleep: 70, efficiency: 90, bogus: 5 } }],
    sleep: [
      { day: T, type: 'rest', total_sleep_duration: 1800 },
      { day: T, type: 'long_sleep', total_sleep_duration: 25200, efficiency: 91, average_hrv: 52, lowest_heart_rate: 51, bedtime_start: '2026-10-25T23:40:00+09:00', bedtime_end: '2026-10-26T07:10:00+09:00', average_breath: 999 },
    ],
    readiness: [{ day: T, score: 77, temperature_deviation: 0.234, contributors: { hrv_balance: 66 } }, { day: 'oops', score: 50 }],
    activity: [{ day: T, score: 80, steps: 6123, active_calories: 300 }],
    stress: [{ day: T, stress_high: 3600, recovery_high: 1800, day_summary: 'weird' }],
    spo2: [{ day: T, spo2_percentage: { average: 97.24 }, breathing_disturbance_index: 3.1 }],
  });
  const d = s.days[T];
  assert.equal(d.sleep.score, 81);
  assert.deepEqual(d.sleep.c, { total_sleep: 70, efficiency: 90 });
  assert.equal(d.sleep.total, 25200);
  assert.equal(d.sleep.hrv, 52);
  assert.equal(d.sleep.bed, 700);
  assert.equal(d.sleep.wake, 1150);
  assert.equal(L.fmtClock(d.sleep.wake), '7:10');
  assert.equal(d.sleep.br, undefined, '範囲外は捨てる');
  assert.equal(d.ready.temp, 0.23);
  assert.equal(d.act.steps, 6123);
  assert.equal(d.stress.sum, undefined);
  assert.equal(d.spo2.avg, 97.2);
  assert.equal(Object.keys(s.days).length, 1);
  // 後から一部だけ取れても、ほかは残る
  L.mergeOura(s, { activity: [{ day: T, steps: 9000 }] });
  assert.equal(s.days[T].act.steps, 9000);
  assert.equal(s.days[T].sleep.score, 81);
});

test('保存は直近2日（today.json）と過去（days.json）に分け、戻すと同じ', () => {
  const s = withDays(i => ({ act: { steps: 1000 + i } }), 5);
  s.logs[T] = { mood: 4, tags: [], weight: null, memo: '', at: 1 };
  s.logs['2026-10-01'] = { mood: 2, tags: [], weight: null, memo: '', at: 1 };
  s.oura.status = 'ok'; s.syncedAt = 5;
  const { hist, live } = L.splitState(s, T);
  assert.deepEqual(Object.keys(live.days).sort(), ['2026-10-25', '2026-10-26']);
  assert.equal(Object.keys(hist.days).length, 3);
  assert.ok(live.logs[T] && hist.logs['2026-10-01']);
  assert.equal(hist.oura, undefined, 'つながりの情報は直近側だけ');
  const back = L.joinState(hist, live);
  assert.deepEqual(back.days, s.days);
  assert.deepEqual(back.logs, s.logs);
  assert.equal(back.oura.status, 'ok');
  assert.equal(back.syncedAt, 5);
  assert.deepEqual(L.joinState(null, null).days, {});
});

test('古い数値は400日で片づけ、記録は残す', () => {
  const s = L.emptyState();
  s.days['2025-01-01'] = { act: { steps: 1 } };
  s.days[T] = { act: { steps: 2 } };
  s.logs['2025-01-01'] = { mood: 3, tags: [], weight: null, memo: '', at: 1 };
  assert.equal(L.pruneState(s, T), true);
  assert.deepEqual(Object.keys(s.days), [T]);
  assert.ok(s.logs['2025-01-01']);
});

test('記録: 整えてから入れる・空なら消す・同じものは二度当てない', () => {
  const s = L.emptyState();
  assert.equal(L.applyEvent(s, { id: 'a', t: 'log.set', day: T, log: { mood: 4, tags: ['alcohol', 'alcohol', 'evil'], weight: 62.46, memo: ' x'.repeat(400) } }, { today: T }), true);
  assert.deepEqual(s.logs[T].tags, ['alcohol']);
  assert.equal(s.logs[T].weight, 62.5);
  assert.equal(s.logs[T].memo.length <= 500, true);
  assert.equal(L.applyEvent(s, { id: 'a', t: 'log.set', day: T, log: { mood: 1 } }, { today: T }), false, '同じ id');
  L.applyEvent(s, { id: 'b', t: 'log.set', day: T, log: { mood: 9, weight: 1000 } }, { today: T });
  assert.equal(s.logs[T], undefined, '中身が無効なら消える');
  assert.equal(L.applyEvent(s, { id: 'c', t: 'log.set', day: '2026-12-31', log: { mood: 3 } }, { today: T }), false, '先の日付は入れない');
  L.applyEvent(s, { id: 'd', t: 'log.set', day: T, log: { memo: 'ok' } }, { today: T });
  L.applyEvent(s, { id: 'e', t: 'log.del', day: T }, { today: T });
  assert.equal(s.logs[T], undefined);
  assert.deepEqual(s.log.applied, ['a', 'b', 'c', 'd', 'e']);
});

test('Oura との接続: トークンの形を確かめ、切るとトークンを消す', () => {
  const s = L.emptyState();
  assert.equal(L.applyEvent(s, { id: '1', t: 'oura.token', token: 'bad token with spaces' }), false);
  assert.equal(L.applyEvent(s, { id: '2', t: 'oura.token', token: 'ABCDEFGHIJKLMNOP', exp: 123 }), true);
  assert.equal(s.oura.source, 'oauth');
  assert.equal(s.oura.status, 'pending');
  assert.equal(L.applyEvent(s, { id: '3', t: 'oura.client', clientId: '<script>' }), false);
  assert.equal(L.applyEvent(s, { id: '4', t: 'oura.client', clientId: 'ABC123_x' }), true);
  L.applyEvent(s, { id: '5', t: 'oura.forget' });
  assert.equal(s.oura.token, '');
  assert.equal(s.oura.status, 'none');
  assert.equal(s.oura.clientId, 'ABC123_x');
});

test('ふだんとの比べ: 言葉と色の意味（良い向き・悪い向き）', () => {
  assert.equal(L.compareWord(null, 'up').tone, 'neutral');
  assert.deepEqual(L.compareWord(0.2, 'up'), { word: 'いつもどおり', tone: 'neutral', arrow: '→' });
  assert.equal(L.compareWord(0.7, 'up').word, '少し高め');
  assert.deepEqual(L.compareWord(-1.4, 'up'), { word: 'いつもより低め', tone: 'warn', arrow: '↓' });
  assert.equal(L.compareWord(-1.4, 'down').tone, 'good');
  assert.equal(L.compareWord(2.5, 'mid').tone, 'warn');
  assert.equal(L.compareWord(2.5, '').tone, 'neutral');
  const base = L.stats([10, 12, 14]);
  assert.equal(L.zOf(20, base), null, '7日分そろうまでは比べない');
});

test('今日: 今朝の数値が無ければ前の日を出す・4段階', () => {
  const s = withDays((i, d) => (i === 0 ? { act: { steps: 100 } } : { ready: { score: 90 - (i % 3) }, sleep: { total: 7 * 3600 } }), 10);
  const sum = L.todaySummary(s, T);
  assert.equal(sum.day, '2026-10-25');
  assert.equal(sum.isToday, false);
  assert.equal(L.levelOf(85).key, 'optimal');
  assert.equal(L.levelOf(84).key, 'good');
  assert.equal(L.levelOf(60).key, 'fair');
  assert.equal(L.levelOf(59).key, 'low');
  assert.equal(L.todaySummary(L.emptyState(), T), null);
});

test('気づき: 体温・HRV・心拍・睡眠を、強いものから並べる', () => {
  const s = withDays(i => ({ ready: { score: 80, temp: 0.05 * wobble(i) }, sleep: { total: 7.4 * 3600, hrv: 50 + wobble(i) * 2, rhr: 54 + wobble(i), eff: 90, bed: 690 + wobble(i) * 10 } }));
  s.days[T] = { ready: { score: 62, temp: 1.1 }, sleep: { total: 5.5 * 3600, hrv: 38, rhr: 60, eff: 80, bed: 800 } };
  s.days['2026-10-25'].act = { steps: 3000 };
  const sig = L.signals(s, T, T);
  const keys = sig.map(x => x.key);
  assert.equal(sig[0].tone, 'bad');
  assert.equal(sig[0].key, 'temp');
  for (const k of ['hrv', 'rhr', 'short', 'eff', 'bed', 'steps']) assert.ok(keys.includes(k), k);
  assert.match(sig.find(x => x.key === 'hrv').detail, /ふだん 50ms/);
  const tones = sig.map(x => x.tone);
  assert.deepEqual(tones, [...tones].sort((a, b) => ['bad', 'warn', 'info', 'good'].indexOf(a) - ['bad', 'warn', 'info', 'good'].indexOf(b)));
});

test('気づき: 3日続く体温の高さ', () => {
  const s = withDays(i => ({ ready: { score: 70, temp: i < 3 ? 0.6 : 0 } }), 20);
  assert.ok(L.signals(s, T, T).some(x => x.key === 'temp3'));
});

test('期間: 歩数は今日を除き、ふだんは期間の前の45日', () => {
  assert.deepEqual(L.periodRange('steps', 7, T), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(L.periodRange('hrv', 7, T), { from: '2026-10-20', to: T });
  const s = withDays((i) => ({ sleep: { hrv: i < 7 ? 40 + wobble(i) : 50 + wobble(i) } }), 60);
  const p = L.periodSummary(s, 'hrv', 7, T);
  assert.equal(p.n, 7);
  assert.ok(Math.abs(p.mean - 40) < 1);
  assert.ok(Math.abs(p.base.mean - 50) < 1);
  assert.equal(p.cmp.tone, 'warn');
  assert.match(L.fmtDiff('hrv', -9.6), /^−10ms$/);
  assert.equal(L.fmtDiff('sleepTime', 0.5), '+30分');
});

test('記録との関係: お酒の翌朝に下がる・回数が少なければ出さない', () => {
  const s = withDays(i => ({ ready: { score: 80 + wobble(i) }, sleep: { hrv: 50 + wobble(i), score: 80, rhr: 54 } }), 90);
  const drinks = [3, 10, 17, 24, 31];
  for (const i of drinks) {
    const d = L.addDays(T, -i);
    s.logs[d] = { mood: 3, tags: ['alcohol'], weight: null, memo: '', at: 1 };
    const next = s.days[L.addDays(d, 1)];
    next.ready.score -= 10; next.sleep.hrv -= 9;
  }
  const rows = L.tagEffects(s, T);
  assert.equal(rows[0].tag, 'alcohol');
  assert.equal(rows[0].n, 5);
  const hrv = rows[0].effects.find(e => e.key === 'hrv');
  assert.ok(hrv.worse && hrv.diff < -7);
  for (const i of drinks.slice(2)) delete s.logs[L.addDays(T, -i)];
  assert.deepEqual(L.tagEffects(s, T), []);
});

test('つながりの状態: 期限切れ・期限が近い', () => {
  const now = Date.parse('2026-10-26T00:00:00Z');
  assert.equal(L.ouraState({ status: 'none' }, now).key, 'none');
  assert.equal(L.ouraState({ status: 'ok', source: 'pat' }, now).key, 'ok');
  assert.equal(L.ouraState({ status: 'ok', source: 'oauth', exp: now + 3 * 86400000 }, now).key, 'soon');
  assert.equal(L.ouraState({ status: 'ok', source: 'oauth', exp: now - 1 }, now).key, 'expired');
  assert.equal(L.ouraState({ status: 'forbidden' }, now).key, 'forbidden');
});
