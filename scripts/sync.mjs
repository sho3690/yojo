// GitHub Actions から15分ごとに実行する。
// 1) 中継に届いた記録・Oura との接続を取り込む 2) Oura から数値を取る 3) 古い数値を片づける
// 4) 変わったファイルだけ暗号化して data/ に保存
// 公開リポジトリのログは誰でも読めるので、件数と状態以外（数値・メモ・トークン・エラー文）は出力しない。

import { appendFile } from 'node:fs/promises';
import { poll } from '../relay.js';
import { open } from '../crypto.js';
import { applyEvent, jstDate, addDays, mergeOura, pruneState, splitState } from '../logic.js';
import { fetchOura, revokeOura } from './oura.mjs';
import { loadKeys, loadState, saveState, stable } from './state-io.mjs';

const log = [];
const say = s => { log.push(s); console.log(s); };
const HOUR = 3600000;

async function main() {
  const { cfg, keys } = await loadKeys();
  const { state, parts } = await loadState(keys);
  const now = Number(process.env.YOJO_NOW) || Date.now();   // 試運転用に時刻を差し替えられる
  const today = jstDate(now);

  // 1) 中継
  const prevToken = state.oura.token;
  let applied = 0, broken = 0, msgs = [];
  try {
    const since = state.log.lastTime ? Math.max(0, state.log.lastTime - 900) : 'all';
    msgs = await poll(cfg.relay, keys.topic, since);
  } catch (e) { say(`中継に届きませんでした（次の回で取り込みます）: ${e.name}`); }
  for (const m of msgs) {
    try {
      // 中継の時刻が先すぎるもの（次からの取り込みを飛ばしてしまう）は使わない
      if (!(m.time > 0) || m.time * 1000 > now + 5 * 60000) { broken++; continue; }
      const ev = await open(keys, m.message);
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { broken++; continue; }
      // 端末は届かなかった記録を3日まで送り直す。それより古いものは昔の暗号文の送り直し（リプレイ）とみなして捨てる
      const at = Number(ev.at);
      if (!Number.isFinite(at) || at < now - 7 * 86400000) { broken++; continue; }
      ev.at = Math.min(at, now);   // 端末の時計が進んでいても、日付の判定はこちらの今日で行う
      ev.time = m.time;
      if (applyEvent(state, ev, { today })) applied++;
    } catch { broken++; }   // おかしなメッセージ1件で全体を止めない
  }
  // 切った・つなぎ直したときは、前のトークンを Oura 側でも取り消す（失敗しても続ける）
  if (prevToken && prevToken !== state.oura.token) {
    console.log(`::add-mask::${prevToken}`);
    say(`Oura: 前のつながりを取り消し${(await revokeOura(prevToken)) ? 'ました' : 'できませんでした（Oura の画面から外してください）'}`);
  }
  say(`中継: ${msgs.length}件を確認、${applied}件を反映${broken ? `、読めないもの${broken}件` : ''}`);

  // 2) Oura。Oura の連携（画面からつないだトークン）を優先し、無ければ Secrets の個人用トークン
  const o = state.oura;
  const pat = (process.env.OURA_TOKEN || '').trim();
  const oauthOk = o.source === 'oauth' && !!o.token && (!o.exp || o.exp > now + 10 * 60000);
  const token = oauthOk ? o.token : pat;
  if (oauthOk) console.log(`::add-mask::${o.token}`);   // Secrets ではないので、万一ログに出ても伏せ字になるように
  const source = oauthOk ? 'oauth' : pat ? 'pat' : '';
  if (!token) {
    if (o.source === 'oauth' && o.token) o.status = 'expired';
    else if (o.source !== 'oauth') { o.status = 'none'; o.source = ''; }
    say('Oura: つながっていません');
  } else {
    const few = Object.keys(state.days).length < 30;
    const full = few || !o.fullAt || now - o.fullAt > 20 * HOUR || o.source !== source || o.status !== 'ok';
    const start = addDays(today, few ? -180 : full ? -30 : -3);
    try {
      const data = await fetchOura(token, start, addDays(today, 1));
      mergeOura(state, data);
      Object.assign(o, { status: 'ok', source, err: '' });
      if (full) o.fullAt = now;
      say(`Oura: ${start} から取りました（${few ? '最初の取り込み' : full ? '30日分の見直し' : '直近3日'}）`);
    } catch (e) {
      const st = e?.status;
      o.source = source;
      o.status = st === 401 ? (source === 'oauth' ? 'expired' : 'invalid') : st === 403 ? 'forbidden' : 'error';
      o.err = st ? String(st) : 'network';
      if (st === 401 && source === 'oauth') { o.token = ''; o.exp = 0; }   // 使えないトークンは消す（個人用トークンがあれば次の回からそちらで取る）
      say(`Oura: 取れませんでした（${o.err}）`);
    }
  }

  // 3) 片づけ
  if (pruneState(state, today)) say('片づけ: 古い数値を整理');

  // 4) 保存（中身が変わったときだけ。最終保存の時刻だけでは書かない）
  const before = { hist: parts.hist, live: parts.live };
  const draft = splitState(state, today);
  const changed = stable(draft.hist) !== stable(before.hist || {}) || stable(draft.live) !== stable(before.live || {});
  if (changed) {
    state.syncedAt = now;
    const n = await saveState(keys, state, today, before);
    say(`保存しました（${n}ファイル）`);
  } else say('変更なし');
}

try { await main(); }
catch (e) { say(`同期に失敗しました: ${e?.name || 'Error'}`); process.exitCode = 1; }   // エラー文には中身が混ざりうるので種類だけ
finally { if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, log.map(l => `- ${l}`).join('\n') + '\n'); }
