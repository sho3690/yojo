// Oura API v2 から日ごとの数値を取る（GitHub Actions の中だけで動く。トークンはログに出さない）
const BASE = 'https://api.ouraring.com/v2/usercollection';

export class OuraError extends Error {
  constructor(status, scope = '') { super(`Oura ${status}`); this.name = 'OuraError'; this.status = status; this.scope = scope; }
}

// Oura は「許可（scope）が足りない」も「鍵が使えない（期限切れ・取り消し）」も同じ 401 で返し、本文だけが違う。
//   許可が足りない: {"detail":"Token is not authorized access daily scope."}
//   鍵が使えない:   {"detail":"The access token provided is expired, revoked, malformed, or invalid for other reasons."}
// 足りない許可の名前（daily など）を返す。鍵が使えないときは ''
export function missingScope(body) {
  const m = /not authorized (?:to )?access (?:to )?(?:extapi:)?([a-z0-9_]{1,32}) scope/i.exec(String(body || ''));
  return m ? m[1].toLowerCase() : '';
}

async function getOnce(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'YOJO/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new OuraError(res.status, res.status === 401 ? missingScope((await res.text().catch(() => '')).slice(0, 1000)) : '');
  return res.json();
}
async function getAll(endpoint, token, start, end, { fetchJson = getOnce } = {}) {
  const out = [];
  let next = '';
  for (let page = 0; page < 30; page++) {
    const u = new URL(`${BASE}/${endpoint}`);
    u.searchParams.set('start_date', start);
    u.searchParams.set('end_date', end);
    if (next) u.searchParams.set('next_token', next);
    let j;
    try { j = await fetchJson(u, token); }
    catch (e) {   // 混み合い・一時的な不調は1回だけ待ってやり直す
      if (!(e instanceof OuraError) || !(e.status === 429 || e.status >= 500)) throw e;
      await new Promise(r => setTimeout(r, 4000));
      j = await fetchJson(u, token);
    }
    if (Array.isArray(j?.data)) out.push(...j.data);
    next = typeof j?.next_token === 'string' ? j.next_token : '';
    if (!next) break;
  }
  return out;
}

// つながりの取り消し（Oura の説明では GET。ダメなら POST も試す）。成功したら true
export async function revokeOura(token) {
  const u = `https://api.ouraring.com/oauth/revoke?access_token=${encodeURIComponent(token)}`;
  for (const method of ['GET', 'POST']) {
    try {
      const res = await fetch(u, { method, headers: { 'User-Agent': 'YOJO/1.0' }, signal: AbortSignal.timeout(15000) });
      if (res.ok) return true;
    } catch { /* 次の方法へ */ }
  }
  return false;
}

const REQUIRED = { readiness: 'daily_readiness', dailySleep: 'daily_sleep', sleep: 'sleep', activity: 'daily_activity' };
const OPTIONAL = { stress: 'daily_stress', spo2: 'daily_spo2' };   // 指輪の世代や許可の範囲で取れないことがある

export async function fetchOura(token, start, end, opts) {
  const data = {};
  for (const [k, ep] of Object.entries(REQUIRED)) data[k] = await getAll(ep, token, start, end, opts);
  for (const [k, ep] of Object.entries(OPTIONAL)) {
    try { data[k] = await getAll(ep, token, start, end, opts); }
    catch (e) { if (e?.status === 401 && !e.scope) throw e; data[k] = []; }   // 許可が無いだけなら、その項目は空にして続ける
  }
  return data;
}
