// 養生 YOJO — 計算の部品（画面と GitHub Actions の両方で使う、副作用のない関数だけ）
// Oura の数値を「自分のふだん（直前45日）」と比べて、やさしい言葉にする。医療の診断はしない。

export const has = (o, k) => typeof k === 'string' && o != null && Object.hasOwn(o, k);
const DAY = 86400000;
const BASE_DAYS = 45;          // ふだん（個人の基準）を作る日数
export const KEEP_DAYS = 400;  // Oura の数値を残す日数（記録は消さない）

// ================= 日付 =================
// Oura の「日」は日本時間の暦日。睡眠は「起きた日」の日付で届く
const ymd = d => d.toISOString().slice(0, 10);
export const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const jstDate = (now = Date.now()) => ymd(new Date(now + 9 * 3600000));
export function addDays(day, n) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
export const weekday = day => '日月火水木金土'[new Date(`${day}T00:00:00Z`).getUTCDay()];
export function fmtDay(day, { year = false } = {}) {
  const [y, m, d] = day.split('-').map(Number);
  return `${year ? `${y}年` : ''}${m}月${d}日（${weekday(day)}）`;
}
export const fmtShort = day => { const [, m, d] = day.split('-').map(Number); return `${m}/${d}`; };
export function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分` : `${m}分`;
}
// 正午からの分（23:30 → 690、0:30 → 750）を時刻に戻す
export function fmtClock(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  const t = ((Math.round(min) + 720) % 1440 + 1440) % 1440;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
export const fmtNum = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));

// ================= データの形 =================
export function emptyState() {
  return {
    v: 1,
    days: {},   // 'YYYY-MM-DD': { sleep, ready, act, stress, spo2 }  … Oura の数値
    logs: {},   // 'YYYY-MM-DD': { mood, tags, weight, memo, at }     … 自分の記録
    oura: { status: 'none', source: '', token: '', exp: 0, clientId: '', lastOk: 0, lastTry: 0, fullAt: 0, err: '' },
    log: { lastTime: 0, applied: [] },
    syncedAt: 0,
  };
}

// 保存は2つのファイルに分ける。毎日のように変わる直近2日分（today.json）と、ほぼ変わらない過去（days.json）。
// 公開リポジトリに積もる暗号文の量を抑えるため（歩数は1日に何度も変わる）。
export function splitState(state, today) {
  const cut = addDays(today, -1);
  const pick = (o, recent) => Object.fromEntries(Object.entries(o || {}).filter(([d]) => (d >= cut) === recent));
  return {
    hist: { v: 1, days: pick(state.days, false), logs: pick(state.logs, false) },
    live: { v: 1, days: pick(state.days, true), logs: pick(state.logs, true), oura: state.oura, log: state.log, syncedAt: state.syncedAt },
  };
}
export function joinState(hist, live) {
  const s = emptyState();
  for (const part of [hist, live]) {
    if (!part || typeof part !== 'object') continue;
    Object.assign(s.days, part.days || {});
    Object.assign(s.logs, part.logs || {});
  }
  if (live?.oura) s.oura = { ...s.oura, ...live.oura };
  if (live?.log) s.log = { lastTime: Number(live.log.lastTime) || 0, applied: Array.isArray(live.log.applied) ? live.log.applied : [] };
  s.syncedAt = Number(live?.syncedAt) || 0;
  return s;
}
export function pruneState(state, today) {
  const oldest = addDays(today, -KEEP_DAYS);
  let changed = false;
  for (const d of Object.keys(state.days)) if (d < oldest) { delete state.days[d]; changed = true; }
  return changed;
}

// ================= Oura の数値を整える =================
const num = (v, lo, hi, digits = 0) => {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n) || n < lo || n > hi) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(typeof v === 'object' && !Object.keys(v).length)));
function contributors(c, keys) {
  const out = {};
  for (const k of keys) { const v = num(c?.[k], 0, 100); if (v != null) out[k] = v; }
  return out;
}
export const READY_PARTS = {
  previous_night: '前の晩の睡眠', sleep_balance: '睡眠の貯金', hrv_balance: 'HRVのバランス', recovery_index: '回復の早さ',
  resting_heart_rate: '安静時の心拍', body_temperature: '体温', previous_day_activity: '前日の活動', activity_balance: '活動のバランス',
};
export const SLEEP_PARTS = {
  total_sleep: '睡眠時間', efficiency: '眠りの効率', restfulness: '眠りの静かさ', deep_sleep: '深い睡眠',
  rem_sleep: 'レム睡眠', latency: '寝つき', timing: '寝る時間帯',
};
// "2026-10-25T23:41:00+09:00" → その土地の時刻を「正午からの分」に（日付をまたいでも平均できるように）
export function clockMin(iso) {
  const m = typeof iso === 'string' && iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const t = Number(m[1]) * 60 + Number(m[2]);
  return t >= 720 ? t - 720 : t + 720;
}

export const normReadiness = r => compact({
  score: num(r?.score, 0, 100),
  temp: num(r?.temperature_deviation, -5, 5, 2),
  c: contributors(r?.contributors, Object.keys(READY_PARTS)),
});
export const normDailySleep = r => compact({ score: num(r?.score, 0, 100), c: contributors(r?.contributors, Object.keys(SLEEP_PARTS)) });
export const normSleep = p => compact({
  total: num(p?.total_sleep_duration, 0, 86400),
  inBed: num(p?.time_in_bed, 0, 86400),
  eff: num(p?.efficiency, 0, 100),
  lat: num(p?.latency, 0, 86400),
  awake: num(p?.awake_time, 0, 86400),
  deep: num(p?.deep_sleep_duration, 0, 86400),
  rem: num(p?.rem_sleep_duration, 0, 86400),
  light: num(p?.light_sleep_duration, 0, 86400),
  hrv: num(p?.average_hrv, 1, 400),
  rhr: num(p?.lowest_heart_rate, 20, 200),
  hr: num(p?.average_heart_rate, 20, 200, 1),
  br: num(p?.average_breath, 3, 60, 1),
  bed: clockMin(p?.bedtime_start),
  wake: clockMin(p?.bedtime_end),
});
export const normActivity = a => compact({
  score: num(a?.score, 0, 100),
  steps: num(a?.steps, 0, 200000),
  cal: num(a?.active_calories, 0, 20000),
  high: num(a?.high_activity_time, 0, 86400),
  mid: num(a?.medium_activity_time, 0, 86400),
  low: num(a?.low_activity_time, 0, 86400),
  sed: num(a?.sedentary_time, 0, 86400),
});
const SUMMARIES = ['restored', 'normal', 'stressful'];
export const normStress = s => compact({
  high: num(s?.stress_high, 0, 86400),
  rec: num(s?.recovery_high, 0, 86400),
  sum: SUMMARIES.includes(s?.day_summary) ? s.day_summary : null,
});
export const normSpo2 = s => compact({ avg: num(s?.spo2_percentage?.average, 50, 100, 1), bdi: num(s?.breathing_disturbance_index, 0, 100, 1) });

// その日の主な睡眠（夜の睡眠。無ければいちばん長いもの）
export function mainSleep(periods) {
  const list = (periods || []).filter(p => p && typeof p === 'object' && (p.total_sleep_duration || 0) > 0);
  const longs = list.filter(p => p.type === 'long_sleep');
  const pool = longs.length ? longs : list;
  return pool.reduce((best, p) => (!best || p.total_sleep_duration > best.total_sleep_duration ? p : best), null);
}

// Oura から取った一覧を state.days に混ぜる。取れた部分だけ上書きし、取れなかった部分は前のまま残す
export function mergeOura(state, data) {
  const touch = d => { if (!isDay(d)) return null; return (state.days[d] ||= {}); };
  const byDay = (list, fn) => { for (const r of list || []) { const day = touch(r?.day); if (day) fn(day, r); } };
  byDay(data.readiness, (day, r) => { const v = normReadiness(r); if (Object.keys(v).length) day.ready = v; });
  byDay(data.dailySleep, (day, r) => { const v = normDailySleep(r); if (Object.keys(v).length) day.sleep = { ...(day.sleep || {}), ...v }; });
  const periods = {};
  for (const p of data.sleep || []) if (isDay(p?.day)) (periods[p.day] ||= []).push(p);
  for (const [d, list] of Object.entries(periods)) {
    const p = mainSleep(list);
    if (!p) continue;
    const day = touch(d);
    const keep = day.sleep ? { score: day.sleep.score, c: day.sleep.c } : {};
    day.sleep = compact({ ...keep, ...normSleep(p) });
  }
  byDay(data.activity, (day, r) => { const v = normActivity(r); if (Object.keys(v).length) day.act = v; });
  byDay(data.stress, (day, r) => { const v = normStress(r); if (Object.keys(v).length) day.stress = v; });
  byDay(data.spo2, (day, r) => { const v = normSpo2(r); if (Object.keys(v).length) day.spo2 = v; });
  for (const [d, v] of Object.entries(state.days)) if (!Object.keys(v).length) delete state.days[d];
}

// ================= 自分の記録 =================
export const MOODS = ['', 'つらい', 'いまいち', 'ふつう', 'よい', 'とてもよい'];
export const TAGS = {
  alcohol: 'お酒', lateMeal: '遅い夕食', caffeine: '午後のカフェイン', exercise: '運動',
  nap: '昼寝', stress: 'ストレス', sick: '体調不良', meds: '薬',
};
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
export function sanitizeLog(x) {
  const mood = Number.isInteger(x?.mood) && x.mood >= 1 && x.mood <= 5 ? x.mood : 0;
  const tags = Array.isArray(x?.tags) ? [...new Set(x.tags.filter(t => has(TAGS, t)))] : [];
  const w = typeof x?.weight === 'number' ? x.weight : Number.NaN;
  const weight = Number.isFinite(w) && w >= 20 && w <= 300 ? Math.round(w * 10) / 10 : null;
  const memo = str(x?.memo, 500).trim();
  return { mood, tags, weight, memo };
}
const logEmpty = l => !l.mood && !l.tags.length && l.weight == null && !l.memo;

// 中継から届いた変更を当てる。戻り値: 何か変わったか
const MAX_APPLIED = 600;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
export function applyEvent(state, ev, { today = jstDate() } = {}) {
  if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || ev.id.length > 64) return false;
  if (state.log.applied.includes(ev.id)) return false;
  const at = Number(ev.at) || Date.now();
  let ok = false;
  switch (ev.t) {
    case 'log.set': {
      if (!isDay(ev.day) || ev.day > addDays(today, 1) || ev.day < addDays(today, -800)) break;
      const l = sanitizeLog(ev.log);
      if (logEmpty(l)) delete state.logs[ev.day];
      else state.logs[ev.day] = { ...l, at };
      ok = true;
      break;
    }
    case 'log.del':
      if (!isDay(ev.day)) break;
      delete state.logs[ev.day]; ok = true;
      break;
    case 'oura.token': {
      if (typeof ev.token !== 'string' || !TOKEN_RE.test(ev.token)) break;
      const exp = Number(ev.exp);
      state.oura = { ...state.oura, token: ev.token, exp: Number.isFinite(exp) && exp > 0 ? exp : 0, source: 'oauth', status: 'pending', err: '' };
      ok = true;
      break;
    }
    case 'oura.client':
      if (typeof ev.clientId !== 'string' || !/^[A-Za-z0-9_.-]{4,128}$/.test(ev.clientId)) break;
      state.oura = { ...state.oura, clientId: ev.clientId }; ok = true;
      break;
    case 'oura.forget':
      state.oura = { ...state.oura, token: '', exp: 0, source: state.oura.source === 'oauth' ? '' : state.oura.source, status: state.oura.source === 'oauth' ? 'none' : state.oura.status };
      ok = true;
      break;
    default: break;
  }
  state.log.applied.push(ev.id);
  if (state.log.applied.length > MAX_APPLIED) state.log.applied.splice(0, state.log.applied.length - MAX_APPLIED);
  if (ev.time && ev.time > state.log.lastTime) state.log.lastTime = ev.time;
  return ok;
}

// ================= 指標 =================
// better: 'up' 高いほど良い / 'down' 低いほど良い / 'mid' 0 に近いほど良い / '' 良し悪しを言わない
export const METRICS = {
  ready: { label: 'コンディション', unit: '', better: 'up', get: d => d.ready?.score, fmt: v => fmtNum(v) },
  sleepScore: { label: '睡眠スコア', unit: '', better: 'up', get: d => d.sleep?.score, fmt: v => fmtNum(v) },
  sleepTime: { label: '睡眠時間', unit: '時間', better: 'up', get: d => (d.sleep?.total != null ? d.sleep.total / 3600 : null), fmt: v => fmtDur(v * 3600), axis: v => `${v}h` },
  eff: { label: '眠りの効率', unit: '%', better: 'up', get: d => d.sleep?.eff, fmt: v => `${fmtNum(v)}%` },
  bed: { label: '寝た時刻', unit: '', better: '', get: d => d.sleep?.bed, fmt: v => fmtClock(v), axis: v => fmtClock(v) },
  hrv: { label: 'HRV', unit: 'ms', better: 'up', get: d => d.sleep?.hrv, fmt: v => `${fmtNum(v)}ms`, note: '自律神経のゆとり。高いほど回復しています' },
  rhr: { label: '寝ている間の最低心拍', short: '最低心拍', unit: 'bpm', better: 'down', get: d => d.sleep?.rhr, fmt: v => `${fmtNum(v)}bpm` },
  temp: { label: '体温のずれ', unit: '℃', better: 'mid', get: d => d.ready?.temp, fmt: v => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmtNum(Math.abs(v), 2)}℃`, axis: v => `${v > 0 ? '+' : ''}${v}` },
  steps: { label: '歩数', unit: '歩', better: 'up', get: d => d.act?.steps, fmt: v => `${fmtNum(v)}歩`, partialToday: true },
  actScore: { label: '活動スコア', unit: '', better: 'up', get: d => d.act?.score, fmt: v => fmtNum(v), partialToday: true },
};
export const LOG_METRICS = {
  weight: { label: '体重', unit: 'kg', better: '', get: l => l.weight, fmt: v => `${fmtNum(v, 1)}kg` },
  mood: { label: '体調（自分の記録）', unit: '', better: 'up', get: l => l.mood || null, fmt: v => (Number.isInteger(v) ? MOODS[v] : fmtNum(v, 1)) },
};
export function valueOf(state, key, day) {
  if (has(METRICS, key)) { const d = state.days[day]; const v = d ? METRICS[key].get(d) : null; return Number.isFinite(v) ? v : null; }
  if (has(LOG_METRICS, key)) { const l = state.logs[day]; const v = l ? LOG_METRICS[key].get(l) : null; return Number.isFinite(v) ? v : null; }
  return null;
}
const metricOf = key => METRICS[key] || LOG_METRICS[key];
export function series(state, key, from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ day: d, v: valueOf(state, key, d) });
  return out;
}
export function stats(vals) {
  const xs = vals.filter(v => v != null && Number.isFinite(v));
  const n = xs.length;
  if (!n) return { n: 0, mean: null, sd: null, min: null, max: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  return { n, mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}
// ふだん = end の前日までの45日
export const baseline = (state, key, end, days = BASE_DAYS) => stats(series(state, key, addDays(end, -days), addDays(end, -1)).map(p => p.v));
export const zOf = (v, base) => (v != null && base.n >= 7 && base.sd > 0 ? (v - base.mean) / base.sd : null);

// ふだんとの違いを言葉に（色だけに頼らない）
export function compareWord(z, better) {
  if (z == null) return { word: 'ふだんの値がまだ足りません', tone: 'neutral', arrow: '' };
  const az = Math.abs(z);
  const dir = z > 0 ? '高め' : '低め';
  const arrow = az < 0.5 ? '→' : z > 0 ? '↑' : '↓';
  const word = az < 0.5 ? 'いつもどおり' : az < 1 ? `少し${dir}` : az < 2 ? `いつもより${dir}` : `いつもよりかなり${dir}`;
  let tone = 'neutral';
  if (az >= 1 && better) {
    const good = better === 'up' ? z > 0 : better === 'down' ? z < 0 : false;
    tone = good ? 'good' : 'warn';
  }
  return { word, tone, arrow };
}

// ================= 今日 =================
export const LEVELS = [
  { min: 85, key: 'optimal', label: 'とてもよい', line: '回復はじゅうぶんです。しっかり動いても大丈夫な日です。' },
  { min: 70, key: 'good', label: 'よい', line: 'よく回復しています。いつもどおり過ごせそうです。' },
  { min: 60, key: 'fair', label: 'まずまず', line: '少し疲れが残っています。無理をせず、今夜は早めに休みましょう。' },
  { min: 0, key: 'low', label: '低め', line: '回復が追いついていません。今日は休むことを優先しましょう。' },
];
export const levelOf = score => (score == null ? null : LEVELS.find(l => score >= l.min));

// 今日の画面に出す日: 今日の睡眠かコンディションが届いていれば今日、まだなら届いている最新の日
export function latestDay(state, today) {
  const hasMorning = d => !!(state.days[d]?.ready || state.days[d]?.sleep);
  for (let i = 0; i < 14; i++) { const d = addDays(today, -i); if (hasMorning(d)) return d; }
  return null;
}

// 気づき（強い順）。bad > warn > info > good
const ORDER = { bad: 0, warn: 1, info: 2, good: 3 };
export function signals(state, day, today = day) {
  const d = state.days[day] || {};
  const out = [];
  const add = (tone, key, title, detail) => out.push({ tone, key, title, detail });
  const base = key => baseline(state, key, day);

  const temp = d.ready?.temp;
  if (temp != null && temp >= 1) add('bad', 'temp', `体温がいつもよりかなり高め（${METRICS.temp.fmt(temp)}）`, '発熱や体調の変化に気をつけて、無理をしないでください。');
  else if (temp != null && temp >= 0.5) add('warn', 'temp', `体温がいつもより高め（${METRICS.temp.fmt(temp)}）`, '体調の変化・お酒・寝室の暖かさなどで上がります。');

  const streak = (test, n = 3) => { for (let i = 0; i < n; i++) { const x = state.days[addDays(day, -i)]; if (!x || !test(x, addDays(day, -i))) return false; } return true; };
  if (streak(x => (x.ready?.temp ?? -9) >= 0.5)) add('bad', 'temp3', '体温の高い日が3日続いています', 'だるさや熱っぽさがあれば、早めに医療機関に相談してください。');

  const hrv = d.sleep?.hrv, hb = base('hrv'), hz = zOf(hrv, hb);
  if (hz != null && hz <= -1) add('warn', 'hrv', 'HRV（自律神経のゆとり）がいつもより低め', `${fmtNum(hrv)}ms（ふだん ${fmtNum(hb.mean)}ms）。疲れ・睡眠不足・お酒のあとに下がりやすい値です。`);
  else if (hz != null && hz >= 1) add('good', 'hrv', 'HRVがいつもより高め', `${fmtNum(hrv)}ms（ふだん ${fmtNum(hb.mean)}ms）。よく回復しています。`);
  if (streak((x, dd) => { const z = zOf(x.sleep?.hrv, baseline(state, 'hrv', dd)); return z != null && z <= -1; })) add('warn', 'hrv3', 'HRVの低い日が3日続いています', '疲れがたまっているサインかもしれません。休む時間を多めにとりましょう。');

  const rhr = d.sleep?.rhr, rb = base('rhr'), rz = zOf(rhr, rb);
  if (rz != null && rz >= 1) add('warn', 'rhr', '寝ている間の心拍がいつもより高め', `${fmtNum(rhr)}bpm（ふだん ${fmtNum(rb.mean)}bpm）。疲れ・お酒・遅い食事・体調の変化で上がります。`);

  const total = d.sleep?.total;
  if (total != null) {
    if (total < 6 * 3600) add('warn', 'short', `睡眠が6時間未満でした（${fmtDur(total)}）`, '大人は7〜9時間が目安です。今夜は早めに布団へ。');
    else if (total < 7 * 3600) add('info', 'short', `睡眠はやや短め（${fmtDur(total)}）`, '大人は7〜9時間が目安です。');
    else add('good', 'short', `睡眠時間はじゅうぶん（${fmtDur(total)}）`, '');
  }
  const eff = d.sleep?.eff;
  if (eff != null && eff < 85) add('info', 'eff', `眠りの効率がやや低め（${eff}%）`, '布団にいた時間のうち、眠れていた割合です。85%以上が目安です。');

  const bed = d.sleep?.bed, bb = base('bed');
  if (bed != null && bb.n >= 7 && bed - bb.mean >= 90) add('info', 'bed', `いつもより寝るのが遅め（${fmtClock(bed)}）`, `ふだんは ${fmtClock(bb.mean)} ごろです。寝る時刻をそろえると眠りが安定します。`);

  if (day === today) {
    const steps = state.days[addDays(day, -1)]?.act?.steps;
    if (steps != null && steps < 5000) add('info', 'steps', `昨日の歩数は少なめ（${fmtNum(steps)}歩）`, '8,000歩前後が健康の目安です。');
    else if (steps != null && steps >= 8000) add('good', 'steps', `昨日はよく歩きました（${fmtNum(steps)}歩）`, '');
  }
  return out.sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
}

export function todaySummary(state, today) {
  const day = latestDay(state, today);
  if (!day) return null;
  const d = state.days[day];
  const score = d.ready?.score ?? d.sleep?.score ?? null;
  const level = levelOf(score);
  return {
    day, isToday: day === today,
    scoreKind: d.ready?.score != null ? 'ready' : d.sleep?.score != null ? 'sleep' : null,
    score, level,
    signals: signals(state, day, today),
    activity: state.days[today]?.act || null,
  };
}

// ================= 期間のまとめ =================
// 歩数など一日の途中で増えていくものは、今日を除いて「昨日まで」で数える
export function periodRange(key, days, today) {
  const end = metricOf(key)?.partialToday ? addDays(today, -1) : today;
  return { from: addDays(end, -(days - 1)), to: end };
}
export function periodSummary(state, key, days, today) {
  const { from, to } = periodRange(key, days, today);
  const s = stats(series(state, key, from, to).map(p => p.v));
  const base = baseline(state, key, from);
  const z = s.n ? zOf(s.mean, base) : null;
  return { from, to, ...s, base, diff: s.n && base.n ? s.mean - base.mean : null, cmp: compareWord(z, metricOf(key)?.better) };
}

// ================= 記録と数値の関係 =================
// その日に記録したこと（お酒など）と、翌朝の数値の関係。回数が少ないうちは出さない。因果関係とは限らない。
const MIN_DIFF = { ready: 3, hrv: 3, sleepScore: 3, rhr: 2 };
export function tagEffects(state, today, { minN = 3, window = 180 } = {}) {
  const from = addDays(today, -window);
  const keys = ['ready', 'hrv', 'sleepScore', 'rhr'];
  const rows = [];
  for (const tag of Object.keys(TAGS)) {
    const withTag = [], without = [];
    for (let d = from; d < today; d = addDays(d, 1)) {
      const next = addDays(d, 1);
      if (!state.days[next]) continue;
      (state.logs[d]?.tags?.includes(tag) ? withTag : without).push(next);
    }
    if (withTag.length < minN || without.length < minN) continue;
    const effects = [];
    for (const key of keys) {
      const a = stats(withTag.map(n => valueOf(state, key, n)));
      const b = stats(without.map(n => valueOf(state, key, n)));
      if (a.n < minN || b.n < minN || !b.sd) continue;
      const diff = a.mean - b.mean;
      if (Math.abs(diff) / b.sd < 0.3 || Math.abs(diff) < MIN_DIFF[key]) continue;   // 誤差のような小さな差は出さない
      const better = METRICS[key].better;
      effects.push({ key, diff, worse: better === 'up' ? diff < 0 : diff > 0, size: Math.abs(diff) / b.sd });
    }
    if (effects.length) rows.push({ tag, label: TAGS[tag], n: withTag.length, effects: effects.sort((x, y) => y.size - x.size).slice(0, 3) });
  }
  return rows.sort((x, y) => y.effects[0].size - x.effects[0].size);
}
export function fmtDiff(key, diff) {
  const sign = diff > 0 ? '+' : '−';
  const a = Math.abs(diff);
  if (key === 'sleepTime') return `${sign}${fmtDur(a * 3600)}`;
  if (key === 'temp') return `${sign}${fmtNum(a, 2)}℃`;
  const m = metricOf(key);
  return `${sign}${fmtNum(a, key === 'weight' ? 1 : 0)}${m?.unit || ''}`;
}

// ================= 接続の状態 =================
export function ouraState(o, now = Date.now()) {
  const soon = o.source === 'oauth' && o.exp && o.exp - now < 7 * DAY;
  if (o.source === 'oauth' && o.exp && o.exp <= now) return { key: 'expired', dot: 'off', text: 'Oura とのつながりの期限が切れました' };
  switch (o.status) {
    case 'ok': return { key: soon ? 'soon' : 'ok', dot: soon ? 'wait' : '', text: soon ? 'もうすぐ Oura とのつながりの期限です' : 'Oura とつながっています' };
    case 'pending': return { key: 'pending', dot: 'wait', text: 'Oura とつないでいます（15分ほどで反映）' };
    case 'invalid': return { key: 'invalid', dot: 'off', text: 'Oura に受け付けてもらえませんでした（トークンを確かめてください）' };
    case 'expired': return { key: 'expired', dot: 'off', text: 'Oura とのつながりの期限が切れました' };
    case 'forbidden': return { key: 'forbidden', dot: 'off', text: 'Oura のメンバーシップが無いと数値を取れません' };
    case 'error': return { key: 'error', dot: 'wait', text: 'Oura から取れませんでした（次の回にやり直します）' };
    default: return { key: 'none', dot: 'off', text: 'まだ Oura とつながっていません' };
  }
}
