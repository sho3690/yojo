// 養生 YOJO — 画面。データは「保存済みのスナップショット」＋「中継に届いた記録」を合わせて表示する（土日 DONICHI と同じ作り）。
import * as L from './logic.js';
import { keysFrom, deriveMaster, seal, open, b64u } from './crypto.js';
import { publish, poll, MAX_BODY } from './relay.js';
import { mountCharts, disposeCharts } from './charts.js';

const $ = (s, el = document) => el.querySelector(s);
const K = { cache: 'yojo.cache', outbox: 'yojo.outbox', sent: 'yojo.sent', period: 'yojo.period', oauth: 'yojo.oauth' };
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動く */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
  json: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
};

// 鍵は「取り出せない形（non-extractable）」で IndexedDB に置き、親鍵そのものは保存しない。
// sho3690.github.io は他のアプリと同じ置き場なので、万一そちらに不正なスクリプトが入っても鍵を持ち出せないように
// （ただし、その場で鍵を使って読むことまでは防げない。根本策は独自ドメインへの移設）。
const keyStore = {
  db: null,
  async open() {
    if (!this.db) this.db = await new Promise((res, rej) => { const r = indexedDB.open('yojo', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return this.db;
  },
  async req(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => { const tx = db.transaction('kv', mode); const q = fn(tx.objectStore('kv')); tx.oncomplete = () => res(q?.result); tx.onerror = () => rej(tx.error); });
  },
  get: k => keyStore.req('readonly', st => st.get(k)).catch(() => undefined),
  set: (k, v) => keyStore.req('readwrite', st => st.put(v, k)).then(() => true, () => false),
  del: k => keyStore.req('readwrite', st => st.delete(k)).catch(() => {}),
};

// ---- 小さな道具 ----
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);   // style 属性は CSP で止まるので、CSSOM で入れる
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false && c !== '') el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function icon(name, cls = 'ic') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use'); u.setAttribute('href', `#i-${name}`);
  s.append(u); return s;
}
// 日本語入力の変換を確定する Enter でフォームが送られないようにする（Safari は確定の Enter を keyCode 229 で送る）
const imeGuard = e => { if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) e.preventDefault(); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : b64u.enc(crypto.getRandomValues(new Uint8Array(16))));
const hm = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const md = ts => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const extLink = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-secondary btn-sm' }, text, icon('out'));
const codeBox = text => h('div', { class: 'code' }, h('code', {}, text), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'コピー', 'data-action': 'copy', 'data-copy': text }, icon('copy')));

// ---- アプリの状態 ----
const app = {
  cfg: null, keys: null, snap: null, relay: new Map(), outbox: [], sent: [], st: null, sig: '',
  view: 'today', period: 30, sheet: null, lastSnap: 0, relayOk: true, snapOk: true, trigger: null, es: null,
  specs: [], chartsFirst: true, oauthReturn: null,
};
// daily: 睡眠・回復・活動 / spo2: 血中酸素 / stress: ストレス（2026年に daily から分かれた）。
// 睡眠の記録には心拍の並びも含まれるため、取れないことがないよう heartrate も求める
const SCOPE = 'daily heartrate spo2 stress';
const AUTHORIZE = 'https://cloud.ouraring.com/oauth/authorize';
const OURA_APPS = 'https://developer.ouraring.com/applications';
const redirectUri = () => `${location.origin}${location.pathname}`;
const repo = () => app.cfg?.repo || 'sho3690/yojo';

// ================= 起動 =================
async function boot() {
  // 招待リンク（#k=…）と、Oura から戻ってきたとき（#access_token=… / ?error=…）。
  // 何より先にアドレス欄から消す（読み込みに失敗して止まっても、トークンが残らないように）
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const linkKey = hash.get('k');
  const token = hash.get('access_token');
  const error = hash.get('error') || query.get('error');
  if (token || error) app.oauthReturn = { token, error, state: hash.get('state') || query.get('state'), expiresIn: Number(hash.get('expires_in')) };
  if (linkKey || token || error) history.replaceState(null, '', `${location.pathname}#/today`);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  try { app.cfg = await (await fetch('./config.json', { cache: 'no-store' })).json(); }
  catch { return fatal('設定を読み込めませんでした。電波の良い所で開き直してください。'); }

  if (linkKey) {
    if (!(await useKey(linkKey))) return showLock({ error: 'このリンクは使えなくなっています。新しいリンクを作ってください。' });
  } else {
    const saved = await keyStore.get('keys');
    if (saved && saved.check === app.cfg.check && saved.aes) app.keys = saved;
    else if (saved) { await keyStore.del('keys'); return showLock({ error: '合言葉が変わりました。新しい合言葉を入れてください。' }); }
  }
  if (!app.keys) return showLock();
  start();
}

async function useKey(master) {
  try {
    const keys = await keysFrom(typeof master === 'string' ? b64u.dec(master) : master);
    if (keys.check !== app.cfg.check) return false;
    app.keys = keys;
    await keyStore.set('keys', { aes: keys.aes, topic: keys.topic, check: keys.check });   // 保存できない環境では、この画面を開いている間だけ使う
    return true;
  } catch { return false; }
}

const brand = () => h('div', { class: 'brand' }, h('span', { class: 'brand-ja' }, '養生'), h('span', { class: 'brand-en' }, 'YOJO'));
function fatal(msg) {
  const root = $('#lock'); root.hidden = false; $('#shell').hidden = true;
  root.replaceChildren(h('div', { class: 'lock-card' }, brand(), h('h1', {}, '開けませんでした'), h('p', { class: 'lead' }, msg),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, '開き直す')));
}

// ---- 合言葉の画面 ----
function showLock({ error = '' } = {}) {
  const root = $('#lock');
  root.hidden = false; $('#shell').hidden = true;
  const err = h('p', { class: 'err', id: 'pw-err', hidden: !error }, error);
  const pw = h('input', { class: 'input', id: 'pw', name: 'password', type: 'password', autocomplete: 'current-password', autocapitalize: 'off', spellcheck: 'false', required: true, 'aria-describedby': 'pw-help pw-err', 'aria-invalid': error ? 'true' : null });
  const eye = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '合言葉を表示', 'aria-pressed': 'false', onclick: () => {
    const show = pw.type === 'password'; pw.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show)); eye.setAttribute('aria-label', show ? '合言葉を隠す' : '合言葉を表示');
  } }, icon('eye'));
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '開く');
  const form = h('form', { novalidate: true, onsubmit: async e => {
    e.preventDefault();
    if (!pw.value.trim()) { err.hidden = false; err.textContent = '合言葉を入れてください'; pw.setAttribute('aria-invalid', 'true'); pw.focus(); return; }
    submit.classList.add('loading'); submit.disabled = true;
    const ok = await useKey(await deriveMaster(pw.value, app.cfg.salt, app.cfg.iterations));
    submit.classList.remove('loading'); submit.disabled = false;
    if (!ok) { err.hidden = false; err.textContent = '合言葉が違います。5文字ずつ、ハイフンで区切った文字です。'; pw.setAttribute('aria-invalid', 'true'); pw.focus(); return; }
    start();
  } },
  h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'yojo', hidden: true, readonly: true }),
  h('div', { class: 'field' },
    h('label', { for: 'pw' }, '合言葉', h('span', { class: 'req', 'aria-hidden': 'true' }, '*')),
    h('div', { class: 'pw' }, pw, eye),
    h('p', { class: 'help', id: 'pw-help' }, 'はじめに作った合言葉です（例: abcde-fghjk-…）。設定で作ったリンクから開けば入力はいりません。'),
    err),
  submit);
  root.replaceChildren(h('div', { class: 'lock-card' }, brand(),
    h('h1', {}, '合言葉で開きます'),
    h('p', { class: 'lead' }, 'Oura の数値と毎日の記録から、体調を自分のふだんと比べて、やさしい言葉で伝える健康管理アプリです。'),
    form,
    h('p', { class: 'note' }, '健康のデータは合言葉で暗号化して保存しています。合言葉を知らない人には中身が見えません。')));
  pw.focus();
}

// ================= 起動後 =================
function start() {
  $('#lock').hidden = true; $('#shell').hidden = false;
  app.outbox = [];
  app.sent = ls.json(K.sent, []);
  app.period = [7, 30, 90].includes(Number(ls.get(K.period))) ? Number(ls.get(K.period)) : 30;
  wire();
  loadOutbox().then(() => { if (app.outbox.length) { recompute(); flushOutbox(); } });
  route();
  const cached = ls.json(K.cache, null);
  if (cached?.live) Promise.all([cached.hist ? open(app.keys, cached.hist) : null, open(app.keys, cached.live)])
    .then(([hist, live]) => { if (!app.snap) { app.snap = L.joinState(hist, live); recompute(); } }).catch(() => {});
  refresh().catch(() => {}).finally(handleOAuthReturn);
  listen();
  setInterval(tick, 30000);
}

let wired = false;
function wire() {
  if (wired) return; wired = true;
  document.addEventListener('click', onAction);
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });
  window.addEventListener('online', () => { flushOutbox(); tick(true); });
  const d = $('#sheet');
  d.addEventListener('close', () => { app.sheet = null; d.replaceChildren(); app.trigger?.focus?.({ preventScroll: true }); app.trigger = null; });
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (app.view === 'trends' && app.specs.length) mountCharts(app.specs); });
}

// ---- データの取得と合成 ----
async function fetchSealed(path) {
  const res = await fetch(`./data/${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('snapshot');
  return (await res.json()).sealed || '';
}
async function fetchSnapshot() {
  const [hist, live] = await Promise.all([fetchSealed('days.json'), fetchSealed('today.json')]);
  const [h1, l1] = await Promise.all([hist ? open(app.keys, hist) : null, live ? open(app.keys, live) : null]);
  app.snap = L.joinState(h1, l1);
  app.lastSnap = Date.now(); app.snapOk = true;
  ls.set(K.cache, JSON.stringify({ hist, live, at: Date.now() }));
}

async function pollRelay() {
  const last = app.snap?.log?.lastTime || 0;
  const msgs = await poll(app.cfg.relay, app.keys.topic, last ? Math.max(0, last - 900) : 'all');
  for (const m of msgs) await addRelayMessage(m);
  app.relayOk = true;
}
async function addRelayMessage(m) {
  try {
    const ev = await open(app.keys, m.message);
    if (typeof ev?.id !== 'string') return false;
    ev.time = m.time;
    if (!app.relay.has(ev.id)) { app.relay.set(ev.id, ev); return true; }
  } catch { /* 他の鍵のメッセージや壊れたものは無視 */ }
  return false;
}

async function refresh() {
  try { await fetchSnapshot(); } catch { app.snapOk = false; }
  try { await pollRelay(); } catch { app.relayOk = false; }
  if (!app.snap) { render(); return; }
  const applied = new Set(app.snap.log.applied);   // 保存済みに入った変更は中継の控えから外す
  for (const id of [...app.relay.keys()]) if (applied.has(id)) app.relay.delete(id);
  resendLost(applied);
  recompute();
  flushOutbox();
}

// 中継に送ったのに、保存にも中継にも見当たらないもの（中継の預かり期限切れなど）を送り直す
function resendLost(applied) {
  const now = Date.now();
  app.sent = app.sent.filter(s => !applied.has(s.id) && now - s.first < 3 * 86400000);
  for (const s of app.sent) {
    if (app.relay.has(s.id) || now - s.at < 30 * 60000) continue;
    s.at = now;
    publish(app.cfg.relay, app.keys.topic, s.body).catch(() => {});
  }
  ls.set(K.sent, JSON.stringify(app.sent));
}

let lastTick = 0;
async function tick(force = false) {
  if (document.hidden || !app.keys) return;
  const now = Date.now();
  if (!force && now - lastTick < 25000) return;
  lastTick = now;
  if (now - app.lastSnap > 180000) return refresh();
  try { await pollRelay(); recompute(); } catch { app.relayOk = false; renderBanner(); }
  if (app.outbox.length) flushOutbox();
}

// 別の端末で書いた記録をすぐ受け取る（つながらなければ定期の確認だけで動く）
function listen() {
  try {
    app.es?.close();
    const es = new EventSource(`${app.cfg.relay}/${app.keys.topic}/sse`);
    es.addEventListener('message', async e => {
      try { if (await addRelayMessage(JSON.parse(e.data))) scheduleRecompute(); } catch { /* 無視 */ }
    });
    app.es = es;
  } catch { /* 定期の確認で補う */ }
}
let rcTimer = 0;
function scheduleRecompute() { clearTimeout(rcTimer); rcTimer = setTimeout(recompute, 150); }

function recompute() {
  if (!app.snap) return;
  const st = structuredClone(app.snap);
  const evs = [...app.relay.values()].sort((a, b) => (a.time - b.time) || ((a.at || 0) - (b.at || 0)));
  for (const ev of [...evs, ...app.outbox]) { try { L.applyEvent(st, ev, { today: L.jstDate(Number(ev.at) || Date.now()) }); } catch { /* おかしなイベントは飛ばす */ } }
  // 中身が変わったときだけ描き直す（入力中のフォーカスや削除の確認を消さない）
  const sig = JSON.stringify(st);
  if (sig === app.sig) return;
  app.sig = sig; app.st = st;
  render();
}

// ---- 変更を送る ----
function send(t, payload = {}) {
  const ev = { id: uid(), t, at: Date.now(), ...payload };
  app.outbox.push(ev);
  saveOutbox();
  recompute();
  flushOutbox();
  return ev;
}
// 未送信の変更も、端末の中では封をして置く
let outboxSaving = Promise.resolve();
function saveOutbox() {
  const snapshot = [...app.outbox];
  outboxSaving = outboxSaving.then(async () => { try { ls.set(K.outbox, snapshot.length ? await seal(app.keys, snapshot) : ''); } catch { /* 保存できなくても送信は続ける */ } });
  return outboxSaving;
}
async function loadOutbox() {
  const raw = ls.get(K.outbox);
  if (!raw) return;
  try { const list = await open(app.keys, raw); if (Array.isArray(list)) app.outbox = [...list, ...app.outbox]; } catch { /* 読めなければ捨てる */ }
}

let flushing = null;
function flushOutbox() {
  if (flushing || !app.outbox.length) return flushing || Promise.resolve();
  flushing = (async () => {
    try {
      while (app.outbox.length) {
        const ev = app.outbox[0];
        const body = await seal(app.keys, ev);
        if (body.length > MAX_BODY) { app.outbox.shift(); saveOutbox(); recompute(); toast('長すぎて送れない記録を1件取り消しました'); continue; }
        const res = await publish(app.cfg.relay, app.keys.topic, body);
        app.outbox.shift();
        ev.time = res.time;
        app.relay.set(ev.id, ev);
        app.sent.push({ id: ev.id, body, at: Date.now(), first: Date.now() });
        if (app.sent.length > 80) app.sent.splice(0, app.sent.length - 80);
        saveOutbox(); ls.set(K.sent, JSON.stringify(app.sent));
        app.relayOk = true;
      }
    } catch { app.relayOk = false; }
    finally { flushing = null; renderBanner(); }
  })();
  return flushing;
}

// ---- Oura の連携（OAuth の client-side flow。トークンは URL の # 以降で戻ってくる＝サーバーには送られない） ----
async function startOAuth(clientId) {
  const state = b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
  ls.set(K.oauth, JSON.stringify({ state, at: Date.now() }));
  if (clientId !== app.st?.oura?.clientId) send('oura.client', { clientId });
  await Promise.race([flushOutbox(), new Promise(r => setTimeout(r, 4000))]);
  await outboxSaving;
  const u = new URL(AUTHORIZE);
  u.search = new URLSearchParams({ response_type: 'token', client_id: clientId, redirect_uri: redirectUri(), scope: SCOPE, state }).toString();
  location.assign(u.href);
}
function handleOAuthReturn() {
  const r = app.oauthReturn;
  if (!r) return;
  app.oauthReturn = null;
  const saved = ls.json(K.oauth, null);
  ls.del(K.oauth);
  if (r.error) { toast(r.error === 'access_denied' ? 'Oura とのつなぎをやめました' : 'Oura とつなげませんでした。もう一度お試しください'); return openSheet('settings'); }
  if (!saved || saved.state !== r.state || Date.now() - saved.at > 30 * 60000 || !r.token) {
    toast('つなぐ手続きを確かめられませんでした。設定からもう一度お試しください');
    return openSheet('settings');
  }
  const exp = Date.now() + (Number.isFinite(r.expiresIn) && r.expiresIn > 0 ? r.expiresIn * 1000 : 30 * 86400000);
  send('oura.token', { token: r.token, exp });
  toast('Oura とつなぎました。15分ほどで数値が届きます');
}

// ================= 画面の切り替え =================
function route() {
  const v = (location.hash.match(/^#\/(today|trends|log)/) || [])[1] || 'today';
  const changed = v !== app.view;
  app.view = v;
  if (changed) app.chartsFirst = true;
  render();
  if (changed) { window.scrollTo(0, 0); $('#view').focus({ preventScroll: true }); }
}

function render() {
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.view === app.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  renderBanner();
  const view = $('#view');
  const st = app.st;
  app.specs = [];
  if (!st) {
    disposeCharts();
    view.replaceChildren(app.snapOk ? loadingView() : h('section', { class: 'empty', role: 'alert' }, h('h2', {}, '読み込めませんでした'),
      h('p', {}, '電波の良い所で、もう一度お試しください。'), h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'reload' }, '読み込み直す')));
    return;
  }
  const parts = app.view === 'trends' ? viewTrends(st) : app.view === 'log' ? viewLog(st) : viewToday(st);
  disposeCharts();
  view.replaceChildren(...parts);
  if (app.specs.length) { mountCharts(app.specs, { first: app.chartsFirst }); app.chartsFirst = false; }
  if (app.sheet && !app.sheet.draft && (app.sheet.kind === 'day' || app.sheet.kind === 'settings')) renderSheet();   // 入力中のシートは書き換えない
}

function renderBanner() {
  const el = $('#banner');
  if (!el) return;
  let msg = null, action = null;
  const os = app.st ? L.ouraState(app.st.oura) : null;
  if (app.outbox.length && !app.relayOk) { msg = `送れていない記録が${app.outbox.length}件あります。つながったら自動で送り直します。`; action = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'retry' }, '今すぐ送る'); }
  else if (!app.snapOk && !app.snap) { msg = 'データを読み込めませんでした。電波の良い所でもう一度お試しください。'; action = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'reload' }, '読み込み直す'); }
  else if (os && ['soon', 'expired', 'invalid', 'forbidden'].includes(os.key)) {
    msg = os.key === 'soon' ? `${os.text}（${md(app.st.oura.exp)}まで）。つなぎ直すと30日延びます。` : `${os.text}。`;
    action = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'settings' }, os.key === 'forbidden' ? '確かめる' : 'つなぎ直す');
  }
  el.hidden = !msg;
  if (msg) el.replaceChildren(h('span', {}, msg), action);
}

function loadingView() {
  const card = () => h('li', {}, h('div', { class: 'tile', 'aria-hidden': 'true' }, h('span', { class: 'tile-ic skeleton' }),
    h('span', {}, h('span', { class: 'skeleton sk-line' }), h('span', { class: 'skeleton sk-line short' }))));
  return h('section', { 'aria-busy': 'true', 'aria-label': '読み込み中' },
    h('div', { class: 'page-head' }, h('span', { class: 'skeleton sk-line', 'aria-hidden': 'true' })),
    h('div', { class: 'hero-card', 'aria-hidden': 'true' }, h('span', { class: 'skeleton sk-line short' }), h('span', { class: 'skeleton sk-line' }), h('span', { class: 'skeleton sk-line' })),
    h('ul', { class: 'tiles' }, card(), card(), card()));
}

// ================= 今日 =================
const TONE = { bad: ['alert', '注意'], warn: ['warn', '気をつけたい'], info: ['info', 'メモ'], good: ['ok', 'よい点'] };
const LEVEL_TONE = { optimal: 'good', good: 'info', fair: 'warn', low: 'bad' };
function viewToday(st) {
  const today = L.jstDate();
  const sum = L.todaySummary(st, today);
  const os = L.ouraState(st.oura);
  const parts = [h('div', { class: 'page-head' }, h('h1', {}, '今日の体調'), h('p', { class: 'sub' }, L.fmtDay(today)))];
  if (!sum) {
    const waiting = ['ok', 'soon', 'pending', 'error'].includes(os.key);
    parts.push(h('section', { class: 'empty' }, h('span', { class: 'ic-wrap' }, icon('ring')),
      h('h2', {}, waiting ? '数値が届くのを待っています' : 'Oura とつなぐと、毎朝の体調がここに出ます'),
      h('p', {}, waiting ? 'Oura のアプリを開いて同期すると、15分ほどでここに出ます。' : '睡眠・回復・活動の数値を、自分のふだんと比べて、やさしい言葉で伝えます。つなぐ前でも体調の記録は使えます。'),
      !waiting && h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'settings' }, 'つなぎ方を見る')));
  } else {
    if (!sum.isToday) parts.push(h('p', { class: 'inline-alert info', style: { marginTop: 0, marginBottom: '1rem' } }, '今朝の数値はまだ届いていません。Oura のアプリを開くと同期され、15分ほどで出ます。いまは前の日の数値です。'));
    parts.push(hero(sum), tiles(st, sum, today), signalSection(sum.signals));
  }
  parts.push(todayLog(st, today), disclaimer());
  return parts;
}

function hero(sum) {
  const lv = sum.level;
  const kind = sum.scoreKind === 'sleep' ? '睡眠スコア' : 'コンディション';
  const lvIcon = lv?.key === 'low' ? 'alert' : lv?.key === 'fair' ? 'warn' : 'ok';
  return h('section', { class: `hero-card tone-${LEVEL_TONE[lv?.key] || 'neutral'}`, 'aria-labelledby': 'hero-k' },
    h('span', { class: 'hero-kicker', id: 'hero-k' }, `${kind}（100点満点）`),
    h('div', { class: 'hero-top' },
      h('p', { class: 'score' }, sum.score ?? '—', h('small', {}, '/100')),
      lv && h('span', { class: 'level' }, icon(lvIcon), lv.label)),
    lv && h('p', { class: 'hero-line' }, lv.line),
    sum.score != null && h('div', { 'aria-hidden': 'true' },
      h('div', { class: 'meter' }, h('i', { style: { width: `${sum.score}%` } })),
      h('div', { class: 'meter-scale' }, ['0', '60', '70', '85'].map(v => h('span', { style: { left: `${v}%` } }, v)))),
    !sum.isToday && h('p', { class: 'hero-day' }, `${L.fmtDay(sum.day)} の数値です`));
}

function tiles(st, sum, today) {
  const d = st.days[sum.day] || {};
  const s = d.sleep || {}, r = d.ready || {};
  const actDay = st.days[today]?.act ? today : sum.day;
  const a = st.days[actDay]?.act || {};
  const tile = (ic, label, val, unit, sub, day) => h('li', {}, h('button', { class: 'tile', type: 'button', 'data-action': 'day', 'data-day': day },
    h('span', { class: 'tile-ic' }, icon(ic)),
    h('span', { class: 'tile-text' }, h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-sub' }, sub), h('span', { class: 'visually-hidden' }, '。くわしく見る')),
    h('span', { class: 'tile-val' }, val, unit && h('small', {}, unit))));
  const join = xs => xs.filter(Boolean).join(' · ');
  return h('ul', { class: 'tiles', 'aria-label': '主な数値' },
    tile('moon', '睡眠', L.fmtDur(s.total), '', join([s.score != null && `スコア ${s.score}`, s.bed != null && `${L.fmtClock(s.bed)}〜${L.fmtClock(s.wake)}`]) || '数値なし', sum.day),
    tile('pulse', 'HRV（回復）', s.hrv != null ? String(s.hrv) : '—', s.hrv != null ? 'ms' : '', join([s.rhr != null && `最低心拍 ${s.rhr}bpm`, r.temp != null && `体温 ${L.METRICS.temp.fmt(r.temp)}`]) || '数値なし', sum.day),
    tile('walk', actDay === today ? '歩数（きょう）' : '歩数', a.steps != null ? L.fmtNum(a.steps) : '—', a.steps != null ? '歩' : '', join([actDay === today && '途中の数', a.score != null && `活動スコア ${a.score}`]) || '数値なし', actDay));
}

function signalSection(sigs) {
  return h('section', { class: 'section', 'aria-labelledby': 'sig-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'sig-h' }, '気づき')),
    sigs.length ? h('ul', { class: 'signals' }, sigs.map(s => h('li', { class: `signal tone-${s.tone}` }, icon(TONE[s.tone][0]),
      h('div', {}, h('span', { class: 'tone-word' }, TONE[s.tone][1]), h('b', {}, s.title), s.detail && h('p', {}, s.detail)))))
      : h('p', { class: 'cta' }, '目立った変化はありません。いつもどおりです。'));
}

function logBody(l) {
  return h('div', { class: 'body' },
    l.mood ? h('p', { class: 'mood' }, `体調 ${L.MOODS[l.mood]}`, h('small', {}, `${l.mood} / 5`)) : null,
    l.tags?.length ? h('ul', { class: 'tags', 'aria-label': '気になったこと' }, l.tags.map(t => h('li', { class: 'tag' }, L.TAGS[t]))) : null,
    l.weight != null && h('p', { class: 'memo' }, `体重 ${L.fmtNum(l.weight, 1)}kg`),
    l.memo && h('p', { class: 'memo' }, l.memo));
}
function todayLog(st, today) {
  const l = st.logs[today];
  return h('section', { class: 'section', 'aria-labelledby': 'log-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'log-h' }, 'きょうの記録'),
      l && h('button', { class: 'btn btn-tertiary btn-sm', type: 'button', 'data-action': 'log', 'data-day': today }, icon('edit'), '直す')),
    l ? h('div', { class: 'log-card' }, logBody(l))
      : h('div', { class: 'cta' }, h('span', {}, '体調やお酒・運動などを記録すると、数値との関係が見えてきます。'),
        h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'log', 'data-day': today }, icon('plus'), '体調を記録する')));
}
const disclaimer = () => h('div', { class: 'disclaimer' },
  h('p', {}, '医療の診断ではありません。数値は Oura の推定です。気になる症状があるときは、数値にかかわらず医療機関に相談してください。'),
  h('button', { class: 'btn btn-tertiary btn-sm', type: 'button', 'data-action': 'about' }, '受診の目安を見る'));

// ================= 推移 =================
const CMP_KEYS = ['sleepTime', 'ready', 'hrv', 'rhr', 'temp', 'steps'];
const CHART_KEYS = ['sleepTime', 'sleepScore', 'ready', 'hrv', 'rhr', 'temp', 'steps', 'bed'];
function viewTrends(st) {
  const today = L.jstDate();
  const days = app.period;
  const seg = h('div', { class: 'seg period', role: 'radiogroup', 'aria-label': '期間' },
    [7, 30, 90].map(v => h('label', {}, h('input', { type: 'radio', name: 'period', value: String(v), checked: v === days, onchange: () => {
      app.period = v; ls.set(K.period, String(v)); app.chartsFirst = true; render();
      $(`#view input[name=period][value="${v}"]`)?.focus();
    } }), `${v}日`)));
  const parts = [h('div', { class: 'page-head' }, h('h1', {}, '推移'), h('p', { class: 'sub' }, `直近${days}日を、その前の45日（ふだん）と比べています`)), seg];
  if (!Object.keys(st.days).length && !Object.keys(st.logs).length) {
    parts.push(h('section', { class: 'empty' }, h('span', { class: 'ic-wrap' }, icon('trend')), h('h2', {}, 'まだ数値がありません'),
      h('p', {}, 'Oura とつなぐと、睡眠・HRV・心拍・体温・歩数の移り変わりがここに出ます。'),
      h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'settings' }, 'つなぎ方を見る')));
    return parts;
  }
  const rows = CMP_KEYS.map(k => [k, L.periodSummary(st, k, days, today)]).filter(([, s]) => s.n);
  if (rows.length) parts.push(h('section', { 'aria-labelledby': 'cmp-h' }, h('h2', { class: 'visually-hidden', id: 'cmp-h' }, 'ふだんとの比べ'),
    h('ul', { class: 'cmp' }, rows.map(([k, s]) => {
      const m = L.METRICS[k];
      return h('li', {}, h('span', { class: 'k' }, m.label), h('span', { class: 'v' }, m.fmt(s.mean)),
        h('span', { class: 'b' }, s.base.n >= 7 ? `ふだん ${m.fmt(s.base.mean)}` : 'ふだんの値はまだ足りません'),
        h('span', { class: `w tone-${s.cmp.tone}` }, s.base.n >= 7 ? `${s.cmp.arrow} ${s.cmp.word}` : ''));
    }))));
  const cards = CHART_KEYS.map(k => chartCard(st, k, days, today));
  for (const k of ['weight', 'mood']) if (L.periodSummary(st, k, days, today).n) cards.push(chartCard(st, k, days, today));
  parts.push(h('section', { class: 'section', 'aria-labelledby': 'ch-h' }, h('div', { class: 'section-head' }, h('h2', { id: 'ch-h' }, 'グラフ')),
    h('p', { class: 'legend', 'aria-hidden': 'true' }, h('span', {}, h('i'), 'その日の値'), h('span', {}, h('i', { class: 'base' }), 'ふだんの範囲（直前45日の平均 ± ばらつき）')),
    h('div', { class: 'charts' }, cards)));
  const eff = L.tagEffects(st, today);
  parts.push(h('section', { class: 'section', 'aria-labelledby': 'eff-h' },
    h('div', { class: 'section-head' }, h('h2', { id: 'eff-h' }, '記録との関係')),
    eff.length ? [h('p', { class: 'help', style: { marginBottom: '.75rem' } }, '記録したことがあった日の翌朝と、それ以外の朝の平均の差です。因果関係とは限りません。'),
      h('ul', { class: 'effects' }, eff.map(r => h('li', {}, h('b', {}, `${r.label}の翌朝`, h('small', {}, `${r.n}回の平均`)),
        h('ul', {}, r.effects.map(e => h('li', { class: `eff tone-${e.worse ? 'warn' : 'good'}` }, icon(e.worse ? 'warn' : 'ok'),
          `${L.METRICS[e.key].short || L.METRICS[e.key].label} ${L.fmtDiff(e.key, e.diff)}`, h('span', { class: 'visually-hidden' }, e.worse ? '（よくない方向）' : '（よい方向）')))))))]
      : h('p', { class: 'cta' }, 'お酒・運動などを記録した日が3回以上たまると、翌朝の数値との関係がここに出ます。')));
  return parts;
}

function chartCard(st, key, days, today) {
  const m = L.METRICS[key] || L.LOG_METRICS[key];
  const { from, to } = L.periodRange(key, days, today);
  const s = L.periodSummary(st, key, days, today);
  const el = h('div', { class: 'chart', role: 'img', 'aria-label': `${m.label}の${days}日間の推移。平均 ${s.n ? m.fmt(s.mean) : 'なし'}、ふだん ${s.base.n >= 7 ? m.fmt(s.base.mean) : 'なし'}` });
  if (s.n) app.specs.push({
    el, kind: key === 'steps' ? 'bar' : 'line', points: L.series(st, key, from, to), label: m.label, fmt: m.fmt, axis: m.axis,
    base: s.base, labelOf: L.fmtShort, tipDay: L.fmtDay, interval: key === 'bed' ? 60 : undefined,
    min: key === 'mood' ? 1 : undefined, max: key === 'mood' ? 5 : undefined, sparse: !L.METRICS[key], area: key !== 'bed' && !!L.METRICS[key],
  });
  return h('article', { class: 'chart-card' },
    h('div', { class: 'chart-head' }, h('h3', {}, m.label), h('span', { class: 'v' }, s.n ? m.fmt(s.mean) : '—')),
    h('p', { class: 'chart-sub' }, s.n ? `${days}日の平均${s.base.n >= 7 ? ` · ふだん ${m.fmt(s.base.mean)}` : ''}${m.partialToday ? ' · きのうまで' : ''}` : 'この期間の数値はありません'),
    s.n ? el : h('p', { class: 'chart-empty' }, '数値がありません'));
}

// ================= 記録 =================
function viewLog(st) {
  const days = Object.keys(st.logs).sort().reverse();
  const parts = [h('div', { class: 'page-head' }, h('h1', {}, '記録', h('span', { class: 'count' }, days.length ? `${days.length}日` : '')),
    h('p', { class: 'sub' }, '体調・体重・メモを、Oura の数値と並べて見られます。'))];
  if (!days.length) {
    parts.push(h('section', { class: 'empty' }, h('span', { class: 'ic-wrap' }, icon('note')), h('h2', {}, 'まだ記録がありません'),
      h('p', {}, 'その日の体調や、お酒・運動・ストレスなどを記録しておくと、翌朝の数値との関係が見えてきます。'),
      h('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'log', 'data-day': L.jstDate() }, icon('plus'), 'きょうの体調を記録する')));
    return parts;
  }
  const months = new Map();
  for (const d of days) { const k = d.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(d); }
  for (const [k, list] of months) {
    const [y, m] = k.split('-').map(Number);
    parts.push(h('h2', { class: 'group-title' }, `${y}年${m}月`), h('ul', { class: 'log-list' }, list.map(d => {
      const l = st.logs[d], o = st.days[d] || {};
      return h('li', {}, h('button', { class: 'log-row', type: 'button', 'data-action': 'day', 'data-day': d },
        h('span', { class: `date-block${L.weekday(d) === '日' ? ' sun' : ''}` }, h('b', {}, Number(d.slice(8))), h('span', {}, L.weekday(d)), h('span', { class: 'visually-hidden' }, L.fmtDay(d))),
        h('span', { class: 'body' }, logBody(l),
          (o.ready?.score != null || o.sleep?.score != null) && h('span', { class: 'side' }, [o.ready?.score != null && ['コンディション ', h('b', {}, o.ready.score)], o.sleep?.score != null && ['睡眠 ', h('b', {}, o.sleep.score)]]
            .filter(Boolean).flatMap((x, i) => (i ? [' · ', ...x] : x))))));
    })));
  }
  return parts;
}

// ================= シート =================
function openSheet(kind, opts = {}) {
  if (!app.sheet) app.trigger = document.activeElement;
  app.sheet = { kind, ...opts };
  renderSheet();
  const d = $('#sheet');
  if (!d.open) d.showModal();
  (d.querySelector('[autofocus]') || d.querySelector('.sheet-head .icon-btn'))?.focus();
}
const closeSheet = () => $('#sheet').open && $('#sheet').close();

function renderSheet() {
  const s = app.sheet;
  if (!s || !app.st) return;
  const d = $('#sheet');
  const parts = s.kind === 'log' ? sheetLog(s) : s.kind === 'day' ? sheetDay(s) : s.kind === 'settings' ? sheetSettings(s) : s.kind === 'about' ? sheetAbout() : null;
  if (!parts) { closeSheet(); return; }
  const scroll = d.querySelector('.sheet-body')?.scrollTop || 0;
  d.replaceChildren(...parts);
  const body = d.querySelector('.sheet-body');
  if (body) body.scrollTop = scroll;
}
function sheetHead(title, kicker) {
  return h('div', { class: 'sheet-head' }, h('span', { class: 'grab', 'aria-hidden': 'true' }),
    h('h2', { id: 'sheet-title' }, kicker && h('span', { class: 'kicker' }, kicker), title),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '閉じる', 'data-action': 'close' }, icon('x')));
}

// ---- 記録する ----
function sheetLog(s) {
  const st = app.st;
  const today = L.jstDate();
  const fill = day => { const c = st.logs[day] || {}; return { day, mood: c.mood || 0, tags: [...(c.tags || [])], weight: c.weight != null ? String(c.weight) : '', memo: c.memo || '' }; };
  s.form ||= fill(L.isDay(s.day) && s.day <= today ? s.day : today);
  const f = s.form;
  const exists = L.has(st.logs, f.day);
  const errW = h('p', { class: 'err', id: 'lg-w-err', hidden: true });
  const errAll = h('p', { class: 'err', role: 'alert', hidden: true });
  const date = h('input', { class: 'input', id: 'lg-day', type: 'date', value: f.day, max: today, min: L.addDays(today, -800), style: { maxWidth: '14rem' }, onchange: e => {
    if (!L.isDay(e.target.value) || e.target.value > today) { e.target.value = f.day; return; }
    s.form = fill(e.target.value); s.draft = true; renderSheet(); $('#lg-day')?.focus();
  } });
  const mood = h('div', { class: 'seg five', role: 'radiogroup', 'aria-labelledby': 'lg-mood' }, [1, 2, 3, 4, 5].map(v => h('label', {},
    h('input', { type: 'radio', name: 'mood', value: String(v), checked: f.mood === v, onchange: () => { f.mood = v; s.draft = true; } }), h('b', {}, v), L.MOODS[v])));
  const tags = h('div', { class: 'chips wrap', role: 'group', 'aria-labelledby': 'lg-tags' }, Object.entries(L.TAGS).map(([k, label]) =>
    h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f.tags.includes(k)), onclick: e => {
      const on = !f.tags.includes(k);
      f.tags = on ? [...f.tags, k] : f.tags.filter(t => t !== k);
      e.currentTarget.setAttribute('aria-pressed', String(on)); s.draft = true;
    } }, label)));
  const weight = h('input', { class: 'input', id: 'lg-w', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: f.weight, placeholder: '例: 62.5', 'aria-describedby': 'lg-w-err', oninput: e => { f.weight = e.target.value; s.draft = true; }, onkeydown: imeGuard });
  const memo = h('textarea', { class: 'textarea', id: 'lg-memo', maxlength: '500', 'aria-describedby': 'lg-memo-help', oninput: e => { f.memo = e.target.value; s.draft = true; } });
  memo.value = f.memo;

  const form = h('form', { id: 'lg-form', novalidate: true, onsubmit: e => {
    e.preventDefault();
    errW.hidden = true; errAll.hidden = true; weight.setAttribute('aria-invalid', 'false');
    const raw = f.weight.trim().normalize('NFKC').replace(/kg$/i, '').trim();
    const w = raw ? Number(raw) : null;
    if (raw && (!Number.isFinite(w) || w < 20 || w > 300)) {
      errW.hidden = false; errW.textContent = '体重は 20〜300 の数字で入れてください（例: 62.5）';
      weight.setAttribute('aria-invalid', 'true'); weight.focus(); return;
    }
    const log = L.sanitizeLog({ mood: f.mood, tags: f.tags, weight: w, memo: f.memo });
    if (!log.mood && !log.tags.length && log.weight == null && !log.memo) {
      if (exists) { errAll.hidden = false; errAll.textContent = '空にするときは「記録を消す」を押してください'; return; }
      errAll.hidden = false; errAll.textContent = '体調・気になったこと・体重・メモのどれかを入れてください'; return;
    }
    send('log.set', { day: f.day, log });
    closeSheet();
    toast(exists ? '記録を直しました' : '記録しました');
  } },
  h('div', { class: 'field' }, h('label', { for: 'lg-day' }, '日付'), date),
  h('div', { class: 'field' }, h('span', { class: 'label', id: 'lg-mood' }, '体調', h('span', { class: 'opt' }, '1 つらい 〜 5 とてもよい')), mood),
  h('div', { class: 'field' }, h('span', { class: 'label', id: 'lg-tags' }, '気になったこと', h('span', { class: 'opt' }, 'いくつでも')), tags,
    h('p', { class: 'help' }, '翌朝の数値との関係を「推移」で見られます。')),
  h('div', { class: 'field' }, h('label', { for: 'lg-w' }, '体重', h('span', { class: 'opt' }, '任意')), h('div', { class: 'unit-input' }, weight, h('span', {}, 'kg')), errW),
  h('div', { class: 'field' }, h('label', { for: 'lg-memo' }, 'メモ', h('span', { class: 'opt' }, '任意・500字まで')), memo,
    h('p', { class: 'help', id: 'lg-memo-help' }, '頭痛・飲み会・旅行など、あとで見返したいこと。')),
  errAll);
  return [sheetHead(exists ? '記録を直す' : '体調を記録する', L.fmtDay(f.day)), h('div', { class: 'sheet-body' }, form),
    h('div', { class: 'sheet-foot' },
      exists && h('button', { class: 'btn btn-danger', type: 'button', 'data-action': 'log-del', 'data-day': f.day }, icon('trash'), '記録を消す'),
      h('button', { class: 'btn btn-primary', type: 'submit', form: 'lg-form' }, '保存する'))];
}

// ---- 1日の詳しい数値 ----
const facts = rows => {
  const list = rows.filter(([, v]) => v != null && v !== '' && v !== '—');
  return list.length ? h('dl', { class: 'facts', style: { marginTop: '.25rem' } }, list.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'num' }, v)])) : h('p', { class: 'help' }, '数値はありません');
};
const partBars = (c, labels) => {
  const keys = Object.keys(labels).filter(k => c?.[k] != null);
  return keys.length ? h('ul', { class: 'parts' }, keys.map(k => h('li', { class: c[k] < 60 ? 'low' : '' }, h('span', {}, labels[k]),
    h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${c[k]}%` } })),
    h('span', { class: 'pv' }, c[k], c[k] < 60 && h('small', {}, '低め'))))) : null;
};
const SUM_WORD = { restored: 'よく回復できた日', normal: 'ふつうの日', stressful: 'ストレスの多い日' };
function sheetDay(s) {
  const st = app.st;
  const today = L.jstDate();
  const day = s.day;
  if (!L.isDay(day)) return null;
  const d = st.days[day] || {};
  const sl = d.sleep || {}, r = d.ready || {}, a = d.act || {}, x = d.stress || {}, o2 = d.spo2 || {};
  const l = st.logs[day];
  const score = (label, v) => { const lv = L.levelOf(v); return v != null && h('div', { class: `tone-${LEVEL_TONE[lv.key]}` }, h('span', {}, label), h('b', {}, v), h('small', {}, lv.label)); };
  const stages = [['deep', '深い睡眠', sl.deep], ['rem', 'レム睡眠', sl.rem], ['light', '浅い睡眠', sl.light], ['awake', '目覚め', sl.awake]].filter(([, , v]) => v != null);
  const stTotal = stages.reduce((n, [, , v]) => n + v, 0);
  const sigs = st.days[day] ? L.signals(st, day, today) : [];
  const body = [
    !st.days[day] && h('p', { class: 'inline-alert info', style: { marginTop: 0 } }, 'この日の Oura の数値はありません。'),
    st.days[day] && h('div', { class: 'day-score' }, score('コンディション', r.score), score('睡眠スコア', sl.score), score('活動スコア', a.score)),
    sigs.length > 0 && h('ul', { class: 'signals' }, sigs.map(g => h('li', { class: `signal tone-${g.tone}` }, icon(TONE[g.tone][0]), h('div', {}, h('span', { class: 'tone-word' }, TONE[g.tone][1]), h('b', {}, g.title), g.detail && h('p', {}, g.detail))))),
    (sl.total != null || sl.score != null) && [
      h('h3', { class: 'sub-title' }, icon('moon'), '睡眠'),
      stTotal > 0 && h('div', { class: 'stage-bar', 'aria-hidden': 'true' }, stages.map(([k, , v]) => h('i', { class: `st-${k}`, style: { width: `${(v / stTotal) * 100}%` } }))),
      stTotal > 0 && h('ul', { class: 'stages' }, stages.map(([k, label, v]) => h('li', {}, h('i', { class: `st-${k}`, 'aria-hidden': 'true' }), label, h('b', {}, `${L.fmtDur(v)}（${Math.round((v / stTotal) * 100)}%）`)))),
      facts([
        ['睡眠時間', L.fmtDur(sl.total)], ['布団にいた時間', sl.inBed != null ? L.fmtDur(sl.inBed) : null],
        ['寝た〜起きた', sl.bed != null ? `${L.fmtClock(sl.bed)} 〜 ${L.fmtClock(sl.wake)}` : null],
        ['眠りの効率', sl.eff != null ? `${sl.eff}%` : null], ['寝つき', sl.lat != null ? L.fmtDur(sl.lat) : null],
        ['HRV', sl.hrv != null ? `${sl.hrv}ms` : null], ['最低心拍', sl.rhr != null ? `${sl.rhr}bpm` : null],
        ['平均心拍', sl.hr != null ? `${L.fmtNum(sl.hr, 1)}bpm` : null], ['呼吸', sl.br != null ? `${L.fmtNum(sl.br, 1)}回/分` : null],
      ]),
      sl.c && h('h4', { class: 'group-title', style: { margin: '1.25rem 0 .5rem' } }, '睡眠スコアの内訳'), partBars(sl.c, L.SLEEP_PARTS),
    ],
    r.score != null && [h('h3', { class: 'sub-title' }, icon('pulse'), 'コンディションの内訳'), partBars(r.c, L.READY_PARTS),
      h('p', { class: 'help mt' }, '60未満のものは「低め」と表示しています。')],
    (a.steps != null || a.score != null) && [h('h3', { class: 'sub-title' }, icon('walk'), day === today ? '活動（途中の数）' : '活動'), facts([
      ['歩数', a.steps != null ? `${L.fmtNum(a.steps)}歩` : null], ['活動で使った量', a.cal != null ? `${L.fmtNum(a.cal)}kcal` : null],
      ['中〜高強度の運動', a.mid != null || a.high != null ? L.fmtDur((a.mid || 0) + (a.high || 0)) : null],
      ['軽い活動', a.low != null ? L.fmtDur(a.low) : null], ['座っていた時間', a.sed != null ? L.fmtDur(a.sed) : null],
    ])],
    (r.temp != null || x.sum || o2.avg != null) && [h('h3', { class: 'sub-title' }, icon('thermo'), '体温・ストレス・呼吸'), facts([
      ['体温のずれ', r.temp != null ? `${L.METRICS.temp.fmt(r.temp)}（ふだんとの差）` : null],
      ['一日のまとめ', x.sum ? SUM_WORD[x.sum] : null], ['ストレスの高い時間', x.high != null ? L.fmtDur(x.high) : null], ['回復できた時間', x.rec != null ? L.fmtDur(x.rec) : null],
      ['血中酸素（睡眠中）', o2.avg != null ? `${L.fmtNum(o2.avg, 1)}%` : null], ['呼吸の乱れの目安', o2.bdi != null ? L.fmtNum(o2.bdi, 1) : null],
    ])],
    h('h3', { class: 'sub-title' }, icon('note'), '記録'),
    l ? h('div', { class: 'log-card' }, logBody(l)) : h('p', { class: 'help' }, 'この日の記録はありません。'),
    h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-secondary', type: 'button', 'data-action': 'log', 'data-day': day }, icon(l ? 'edit' : 'plus'), l ? '記録を直す' : 'この日の体調を記録する')),
  ];
  return [sheetHead(L.fmtDay(day, { year: true }), day === today ? 'きょう' : day === L.addDays(today, -1) ? 'きのう' : ''), h('div', { class: 'sheet-body' }, body)];
}

// ---- 設定 ----
function sheetSettings(s) {
  const st = app.st;
  const status = app.outbox.length ? ['wait', `送信待ち ${app.outbox.length}件`] : app.relayOk && app.snapOk ? ['', '最新です'] : ['off', 'つながっていません'];
  const draft = () => { s.draft = true; };
  return [sheetHead('設定'), h('div', { class: 'sheet-body', oninput: draft },
    ouraGroup(st),
    h('section', { class: 'settings-group' }, h('h3', {}, 'ほかの端末で開く'),
      h('p', {}, 'スマホなど別の端末で開くためのリンクを作ります。リンクを開くと合言葉なしで入れるので、自分の端末にだけ送ってください。'),
      inviteForm()),
    h('section', { class: 'settings-group' }, h('h3', {}, '同期'),
      h('p', { class: 'status' }, h('span', { class: `dot ${status[0]}`, 'aria-hidden': 'true' }), status[1], st.syncedAt ? ` · 最終保存 ${hm(st.syncedAt)}` : ''),
      h('p', { class: 'mt' }, '記録はすぐ送られ、Oura の数値と合わせて15分ごとに暗号化して保存されます。'),
      h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'reload' }, icon('refresh'), '今すぐ読み込み直す'))),
    h('section', { class: 'settings-group' }, h('h3', {}, 'この端末'),
      h('p', {}, 'この端末から合言葉を消します。もう一度使うときは合言葉かリンクが必要です。'),
      h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'data-action': 'logout' }, 'この端末から外す'))))];
}

function ouraGroup(st) {
  const o = st.oura;
  const os = L.ouraState(o);
  const connected = ['ok', 'soon', 'pending'].includes(os.key);
  const meta = [o.source === 'oauth' ? 'つなぎ方: Oura の連携' : o.source === 'pat' ? 'つなぎ方: 個人用トークン' : '',
    o.source === 'oauth' && o.exp ? `期限: ${md(o.exp)}` : '', st.syncedAt ? `最終保存: ${hm(st.syncedAt)}` : ''].filter(Boolean).join(' · ');
  const cid = h('input', { class: 'input', id: 's-cid', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: o.clientId || '', 'aria-describedby': 's-cid-err' });
  const cidErr = h('p', { class: 'err', id: 's-cid-err', hidden: true });
  const connect = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
    const v = cid.value.trim();
    cidErr.hidden = true; cid.setAttribute('aria-invalid', 'false');
    if (!/^[A-Za-z0-9_.-]{4,128}$/.test(v)) { cidErr.hidden = false; cidErr.textContent = v ? 'Client ID は英数字です。Oura の画面からもう一度コピーしてください' : 'Client ID を貼り付けてください'; cid.setAttribute('aria-invalid', 'true'); cid.focus(); return; }
    connect.classList.add('loading'); connect.disabled = true;
    startOAuth(v);
  } }, icon('ring'), o.source === 'oauth' ? 'Oura でつなぎ直す' : 'Oura でつなぐ');
  return h('section', { class: 'settings-group' }, h('h3', {}, 'Oura とのつながり'),
    h('p', { class: 'status' }, h('span', { class: `dot ${os.dot}`, 'aria-hidden': 'true' }), os.text),
    meta && h('p', { class: 'help mt' }, meta),
    o.source === 'oauth' && h('div', { class: 'actions-row' },
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-action': 'oauth-again' }, icon('refresh'), 'つなぎ直す（30日延びます）'),
      h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'data-action': 'oura-forget' }, 'つながりを切る')),
    o.source === 'pat' && h('p', { class: 'help mt' }, '個人用トークン（GitHub の OURA_TOKEN）でつながっています。Oura は個人用トークンを近く止めるので、下の手順で切り替えてください。'),
    !connected && h('p', { class: 'mt' }, '自分用の「連携アプリ」を Oura に登録して（無料・最初の1回だけ）、それでつなぎます。'),
    h('details', { class: 'fold fold-sm', open: !connected || o.source === 'pat' },
      h('summary', {}, 'Oura とつなぐ手順'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Oura の開発者ページを開き、右上の「Create New」を押します。', h('div', { class: 'mt' }, extLink(OURA_APPS, 'Oura の開発者ページ'))),
        h('li', {}, '次のとおりに入れます。', fillList()),
        h('li', {}, 'いちばん下の「I agree to the Oura API Agreement」にチェックを入れ、「Create Application」を押します。'),
        h('li', {}, '出てきた「Client ID」をコピーして、ここに貼り付けます。「Client Secret」はいりません（どこにも入れないでください）。',
          h('div', { class: 'field mt', style: { marginBottom: 0 } }, h('label', { for: 's-cid' }, 'Client ID'), cid, cidErr)),
        h('li', {}, '「Oura でつなぐ」を押し、Oura の画面で許可します。数値は15分ほどで届きます。', h('div', { class: 'mt' }, connect))),
      h('p', { class: 'help mt' }, 'つながりは30日で切れます。期限が近づくと上にお知らせが出るので、そのときにもう一度つないでください。「つながりを切る」を押すと、15分ほどで Oura 側の許可も取り消します。')));
}

// Oura の「New Application」の入力欄と、そこに入れる値（項目名は Oura の画面の表記のまま）
function fillList() {
  const site = redirectUri();
  const policy = new URL('policy.html', site).href;
  const row = (name, ...val) => [h('dt', {}, name), h('dd', {}, ...val)];
  return h('dl', { class: 'fill' },
    row('Display Name', codeBox('養生 YOJO')),
    row('Description', codeBox('自分用の健康管理アプリ')),
    row('Contact Email', '自分のメールアドレス'),
    row('Website', codeBox(site)),
    row('Privacy Policy', codeBox(`${policy}#privacy`)),
    row('Terms of Service', codeBox(`${policy}#terms`)),
    row('Redirect URIs', codeBox(site), h('span', { class: 'help' }, '最後の「/」まで、そのまま入れます')),
    row('Scopes', 'Daily・Heartrate・SpO2・Stress の4つにチェック'));
}

// リンクを作る（合言葉から親鍵を作り直す。親鍵は端末に保存しない）
function inviteForm() {
  const err = h('p', { class: 'err', id: 's-pass-err', hidden: true });
  const pass = h('input', { class: 'input', id: 's-pass', type: 'password', autocomplete: 'current-password', autocapitalize: 'off', spellcheck: 'false', placeholder: '合言葉', 'aria-describedby': 's-pass-err' });
  const btn = h('button', { class: 'btn btn-secondary', type: 'submit' }, icon('link'), 'リンクを作る');
  const linkField = h('input', { class: 'input', id: 's-link', type: 'text', readonly: true, onfocus: e => e.target.select() });
  const out = h('div', { class: 'field mt', hidden: true }, h('label', { for: 's-link' }, 'この端末用のリンク'), linkField, h('p', { class: 'help' }, 'このリンクを開いた端末は合言葉なしで入れます。'));
  return h('form', { class: 'mt', novalidate: true, onsubmit: async e => {
    e.preventDefault();
    err.hidden = true; pass.setAttribute('aria-invalid', 'false');
    if (!pass.value.trim()) { err.hidden = false; err.textContent = '合言葉を入れてください'; pass.setAttribute('aria-invalid', 'true'); pass.focus(); return; }
    btn.classList.add('loading'); btn.disabled = true;
    const master = await deriveMaster(pass.value, app.cfg.salt, app.cfg.iterations);
    const keys = await keysFrom(master);
    btn.classList.remove('loading'); btn.disabled = false;
    if (keys.check !== app.cfg.check) { err.hidden = false; err.textContent = '合言葉が違います'; pass.setAttribute('aria-invalid', 'true'); pass.focus(); return; }
    pass.value = '';
    const link = `${location.origin}${location.pathname}#k=${b64u.enc(master)}`;
    out.hidden = false; linkField.value = link;
    const copy = () => navigator.clipboard?.writeText(link).then(() => toast('リンクをコピーしました'), () => { linkField.focus(); linkField.select(); toast('下のリンクを長押ししてコピーしてください'); });
    if (navigator.share) navigator.share({ title: '養生 YOJO', url: link }).catch(e2 => { if (e2?.name !== 'AbortError') copy(); });
    else if (navigator.clipboard) copy();
    else { linkField.focus(); linkField.select(); }
  } },
  h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'yojo', hidden: true, readonly: true }),
  h('div', { class: 'with-btn' }, h('label', { class: 'visually-hidden', for: 's-pass' }, '合言葉'), pass, btn), err, out);
}

// ---- 受診の目安 ----
function sheetAbout() {
  return [sheetHead('受診の目安', 'このアプリについて'), h('div', { class: 'sheet-body' },
    h('p', { class: 'summary-box' }, h('span', { class: 'label' }, 'たいせつなこと'), 'このアプリは医療の診断をしません。数値は指輪型の機器による推定です。体調に不安があるときは、数値にかかわらず医療機関に相談してください。'),
    h('h3', { class: 'sub-title' }, icon('alert'), 'こんなときは相談を'),
    h('ul', { class: 'redflags' },
      h('li', {}, '昼間の強い眠気や居眠りが続く、大きないびき・寝ている間の呼吸の止まりを指摘された（睡眠時無呼吸の可能性）'),
      h('li', {}, '寝ている間や安静時の心拍が何日も高いままで、動悸・胸の痛み・息切れがある'),
      h('li', {}, '体温の高い日が続き、だるさや熱っぽさがある'),
      h('li', {}, '眠れない・朝早く目が覚める・気分の落ち込みが2週間以上続く'),
      h('li', {}, '数値の急な悪化が続く、または上のことがいくつも重なる')),
    h('h3', { class: 'sub-title' }, icon('info'), '数値の見方'),
    h('p', { class: 'help', style: { fontSize: '.875rem', color: 'var(--text-2)' } },
      'HRV・心拍・体温は人によって大きく違うため、自分の「ふだん」（直前45日の平均とばらつき）との差で見ています。睡眠時間の目安は大人で7〜9時間（米国睡眠財団 2015）、歩数は8,000歩前後（Paluch ほか 2022, Lancet Public Health）、眠りの効率は85%以上（Ohayon ほか 2004）です。コンディションの4段階（85以上・70以上・60以上・60未満）は Oura の区分に合わせています。'),
    h('h3', { class: 'sub-title' }, icon('ring'), 'データの置き場所'),
    h('p', { class: 'help', style: { fontSize: '.875rem', color: 'var(--text-2)' } },
      'Oura の数値と記録は、合言葉で暗号化してから GitHub に保存しています。合言葉を知らない人には中身が見えません。Oura から数値を取るのは GitHub Actions（GitHub のサーバー）で、15分ごとです。'))];
}

// ================= 操作 =================
const confirmArm = new WeakMap();
function twoStep(btn, label) {
  if (confirmArm.get(btn)) return true;
  const orig = [...btn.childNodes].map(n => n.cloneNode(true));
  btn.classList.add('confirm'); btn.textContent = label;
  confirmArm.set(btn, true);
  setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirm'); btn.replaceChildren(...orig); confirmArm.delete(btn); } }, 4000);
  return false;
}

function onAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const day = el.dataset.day;
  switch (a) {
    case 'close': closeSheet(); break;
    case 'settings': openSheet('settings'); break;
    case 'about': openSheet('about'); break;
    case 'log-today': openSheet('log', { day: L.jstDate() }); break;
    case 'log': openSheet('log', { day }); break;
    case 'day': openSheet('day', { day }); break;
    case 'retry': flushOutbox(); break;
    case 'reload': refresh().then(() => toast('最新にしました')); break;
    case 'copy': {
      const text = el.dataset.copy || '';
      navigator.clipboard?.writeText(text).then(() => toast('コピーしました'), () => toast('長押ししてコピーしてください'));
      break;
    }
    case 'oauth-again': {
      const id = app.st?.oura?.clientId;
      if (id) { el.classList.add('loading'); el.disabled = true; startOAuth(id); } else openSheet('settings');
      break;
    }
    case 'oura-forget':
      if (!twoStep(el, 'もう一度押すと切ります')) break;
      send('oura.forget'); toast('Oura とのつながりを切りました');
      break;
    case 'log-del':
      if (!twoStep(el, 'もう一度押すと消します')) break;
      send('log.del', { day }); closeSheet(); toast('記録を消しました');
      break;
    case 'logout':
      if (!twoStep(el, 'もう一度押すと外します')) break;
      keyStore.del('keys').then(() => { for (const k of [K.cache, K.outbox, K.sent, K.oauth]) ls.del(k); location.reload(); });
      break;
    default: break;
  }
}

// ---- トースト ----
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  clearTimeout(toastTimer);
  t.replaceChildren(h('span', {}, msg));
  t.hidden = false;
  const hide = () => { toastTimer = setTimeout(() => { t.hidden = true; }, 3500); };
  t.onmouseenter = t.onfocusin = () => clearTimeout(toastTimer);
  t.onmouseleave = t.onfocusout = hide;
  hide();
}

boot();
