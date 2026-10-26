// 画面の確認用に、それらしい架空のデータを作る（本番の鍵・データには触らない）。
// 使い方: node scripts/demo.mjs <アプリを写したフォルダ> [日数]
//   そのフォルダの config.json と data/*.json を、合言葉「demo」の鍵で作り直す。リンク用の鍵を表示する。
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { b64u, deriveMaster, keysFrom, seal } from '../crypto.js';
import { emptyState, mergeOura, splitState, jstDate, addDays, applyEvent } from '../logic.js';

const dir = process.argv[2];
if (!dir) { console.error('使い方: node scripts/demo.mjs <フォルダ> [日数]'); process.exit(1); }
const N = Number(process.argv[3]) || 120;

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const iso = (day, min) => { const t = ((min % 1440) + 1440) % 1440; const d = min >= 1440 ? addDays(day, 1) : min < 0 ? addDays(day, -1) : day; return `${d}T${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00+09:00`; };

const today = jstDate();
const data = { readiness: [], dailySleep: [], sleep: [], activity: [], stress: [], spo2: [] };
const logs = {};
for (let i = N - 1; i >= 0; i--) {
  const day = addDays(today, -i);
  const prev = addDays(day, -1);
  const drank = i === 1 || (i > 2 && rnd() < 0.14);
  const ran = !drank && rnd() < 0.22;
  if (drank || ran || rnd() < 0.45) {
    const tags = [drank && 'alcohol', ran && 'exercise', rnd() < 0.08 && 'lateMeal', rnd() < 0.06 && 'stress'].filter(Boolean);
    logs[prev] = { mood: clamp(Math.round(3.4 + gauss() * 0.8 - (drank ? 0.3 : 0)), 1, 5), tags, weight: Math.round((64.2 - i * 0.008 + gauss() * 0.35) * 10) / 10, memo: drank && rnd() < 0.5 ? '会食' : '' };
  }
  const after = drank;   // 前の日にお酒 → 今朝の数値が下がる
  const total = Math.round(clamp(6.9 + gauss() * 0.6 - (after ? 0.4 : 0), 4.2, 9.2) * 3600 / 60) * 60;
  const hrv = Math.round(clamp(48 + gauss() * 5 - (after ? 11 : 0) + (i < 1 ? -4 : 0), 18, 110));
  const rhr = Math.round(clamp(54 + gauss() * 2 + (after ? 4 : 0), 42, 80));
  const eff = Math.round(clamp(88 + gauss() * 3 - (after ? 4 : 0), 70, 98));
  const temp = Math.round(clamp(gauss() * 0.15 + (after ? 0.25 : 0) + (i === 0 ? 0.15 : 0), -1, 1.5) * 100) / 100;
  const bed = Math.round(1410 + gauss() * 30 + (after ? 50 : 0));   // 23:30 ごろ
  const inBed = Math.round(total / (eff / 100));
  const deep = Math.round(total * clamp(0.17 + gauss() * 0.03, 0.08, 0.3)), rem = Math.round(total * clamp(0.22 + gauss() * 0.03, 0.12, 0.32));
  const sleepScore = Math.round(clamp(78 + (total / 3600 - 7) * 9 + (eff - 88) * 0.8 + gauss() * 3, 40, 98));
  const ready = Math.round(clamp(80 + (hrv - 48) * 0.6 - (rhr - 54) * 1.2 - Math.abs(temp) * 10 + (sleepScore - 78) * 0.35 + gauss() * 3, 35, 98));
  const c = v => Math.round(clamp(v, 1, 100));
  data.readiness.push({ day, score: ready, temperature_deviation: temp, contributors: {
    previous_night: c(sleepScore + 4), sleep_balance: c(80 + gauss() * 8), hrv_balance: c(78 + (hrv - 48) * 1.5), recovery_index: c(84 - (after ? 30 : 0) + gauss() * 6),
    resting_heart_rate: c(88 - (rhr - 54) * 5), body_temperature: c(98 - Math.abs(temp) * 60), previous_day_activity: c(80 + gauss() * 8), activity_balance: c(82 + gauss() * 6) } });
  data.dailySleep.push({ day, score: sleepScore, contributors: { total_sleep: c(70 + (total / 3600 - 7) * 15), efficiency: c(eff), restfulness: c(72 + gauss() * 8), deep_sleep: c(85 + gauss() * 8), rem_sleep: c(80 + gauss() * 8), latency: c(80 + gauss() * 10), timing: c(80 - (after ? 25 : 0) + gauss() * 6) } });
  data.sleep.push({ day, type: 'long_sleep', total_sleep_duration: total, time_in_bed: inBed, efficiency: eff, latency: Math.round(clamp(600 + gauss() * 300, 60, 3000)), awake_time: inBed - total,
    deep_sleep_duration: deep, rem_sleep_duration: rem, light_sleep_duration: total - deep - rem, average_hrv: hrv, lowest_heart_rate: rhr, average_heart_rate: rhr + 5.4, average_breath: 14.2 + gauss() * 0.4,
    bedtime_start: iso(prev, bed), bedtime_end: iso(prev, bed + Math.round(inBed / 60)) });
  data.sleep.push({ day, type: 'rest', total_sleep_duration: 1200 });   // 昼寝などは使わない
  const part = i === 0 ? 0.42 : 1;   // 今日はまだ途中
  const steps = Math.round(clamp(7600 + gauss() * 2600 + (ran ? 4000 : 0), 900, 24000) * part);
  data.activity.push({ day, score: Math.round(clamp(78 + gauss() * 8 + (ran ? 6 : 0), 30, 100)), steps, active_calories: Math.round(steps * 0.045), high_activity_time: ran ? 1800 : 120, medium_activity_time: Math.round(2400 * part), low_activity_time: Math.round(14000 * part), sedentary_time: Math.round(30000 * part) });
  data.stress.push({ day, stress_high: Math.round(clamp(5400 + gauss() * 2400, 0, 20000)), recovery_high: Math.round(clamp(3600 + gauss() * 1800, 0, 20000)), day_summary: ['restored', 'normal', 'stressful'][clamp(Math.round(1 + gauss() * 0.7), 0, 2)] });
  data.spo2.push({ day, spo2_percentage: { average: Math.round((96.8 + gauss() * 0.6) * 10) / 10 }, breathing_disturbance_index: Math.round(clamp(4 + gauss() * 2, 0, 30) * 10) / 10 });
}

const state = emptyState();
mergeOura(state, data);
let k = 0;
for (const [day, log] of Object.entries(logs)) applyEvent(state, { id: `demo-${k++}`, t: 'log.set', day, log, at: Date.now() }, { today });
state.log.applied = [];
state.oura = { ...state.oura, status: 'ok', source: 'pat', fullAt: Date.now() };
state.syncedAt = Date.now() - 6 * 60000;

const salt = b64u.enc(new Uint8Array(16).fill(3));
const master = await deriveMaster('demo', salt, 1000);
const keys = await keysFrom(master);
const parts = splitState(state, today);
await mkdir(join(dir, 'data'), { recursive: true });
await writeFile(join(dir, 'config.json'), JSON.stringify({ v: 1, salt, iterations: 1000, check: keys.check, relay: 'http://127.0.0.1:9', repo: 'sho3690/yojo' }, null, 2) + '\n');
await writeFile(join(dir, 'data/days.json'), JSON.stringify({ v: 1, sealed: await seal(keys, parts.hist) }) + '\n');
await writeFile(join(dir, 'data/today.json'), JSON.stringify({ v: 1, sealed: await seal(keys, parts.live) }) + '\n');
console.log(b64u.enc(master));
