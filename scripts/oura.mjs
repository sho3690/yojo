// Oura API v2 から日ごとの数値を取る（GitHub Actions の中だけで動く。トークンはログに出さない）
const BASE = 'https://api.ouraring.com/v2/usercollection';

export class OuraError extends Error {
  constructor(status) { super(`Oura ${status}`); this.name = 'OuraError'; this.status = status; }
}

async function getOnce(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'YOJO/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new OuraError(res.status);
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
    catch (e) { if (e?.status === 401) throw e; data[k] = []; }
  }
  return data;
}
