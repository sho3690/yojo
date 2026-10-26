// Actions 用: 鍵の確認と、暗号化した data/days.json・data/today.json の読み書き。
import { readFile, writeFile } from 'node:fs/promises';
import { keysFrom, seal, open, b64u } from '../crypto.js';
import { joinState, splitState } from '../logic.js';

export const ROOT = new URL('..', import.meta.url);
const FILES = { hist: 'data/days.json', live: 'data/today.json' };
export const fail = s => { console.log(`::error::${s}`); process.exit(1); };

// キーの並びに左右されない比べ方（変わっていないファイルを書き直さない＝コミットを増やさない）
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export async function loadKeys() {
  const KEY = process.env.YOJO_KEY;
  if (!KEY) fail('YOJO_KEY が Secrets にありません');
  const cfg = JSON.parse(await readFile(new URL('config.json', ROOT), 'utf8'));
  const keys = await keysFrom(b64u.dec(KEY.trim()));
  if (keys.check !== cfg.check) fail('YOJO_KEY が config.json の合言葉と合いません');
  return { cfg, keys };
}
async function readPart(keys, file) {
  const raw = JSON.parse(await readFile(new URL(file, ROOT), 'utf8').catch(() => '{}'));
  return raw.sealed ? open(keys, raw.sealed) : null;
}
export async function loadState(keys) {
  const parts = { hist: await readPart(keys, FILES.hist), live: await readPart(keys, FILES.live) };
  return { state: joinState(parts.hist, parts.live), parts };
}
// 中身が変わったファイルだけ書く。戻り値: 書いたファイルの数
export async function saveState(keys, state, today, prev = {}) {
  const next = splitState(state, today);
  let wrote = 0;
  for (const k of ['hist', 'live']) {
    if (prev[k] && stable(prev[k]) === stable(next[k])) continue;
    await writeFile(new URL(FILES[k], ROOT), JSON.stringify({ v: 1, sealed: await seal(keys, next[k]) }) + '\n');
    wrote++;
  }
  return wrote;
}
