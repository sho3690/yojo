// 合言葉と鍵を作り、config.json と空の data/*.json を書く（最初の1回と、合言葉を変えるとき）。
// 使い方: node scripts/setup.mjs [--keep-state]
//   --keep-state  いまの .secrets/master.b64 で開けるデータを、新しい鍵で封し直す（合言葉の変更）
// 生成した合言葉・鍵は .secrets/ に置く（.gitignore 済み。コミットしない）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomPassphrase, randomBytes, b64u, deriveMaster, keysFrom, seal, open } from '../crypto.js';
import { emptyState, joinState, splitState, jstDate } from '../logic.js';

const ROOT = new URL('..', import.meta.url);
const REPO = 'sho3690/yojo';
const SITE = 'https://sho3690.github.io/yojo/';
const ITER = 210000;
const keep = process.argv.includes('--keep-state');

let state = emptyState();
if (keep) {
  const oldKeys = await keysFrom(b64u.dec((await readFile(new URL('.secrets/master.b64', ROOT), 'utf8')).trim()));
  const read = async f => { const j = JSON.parse(await readFile(new URL(f, ROOT), 'utf8')); return j.sealed ? open(oldKeys, j.sealed) : null; };
  state = joinState(await read('data/days.json'), await read('data/today.json'));
  state.log.lastTime = 0; state.log.applied = [];   // 新しい宛先の中継は空から始まる
}

const passphrase = randomPassphrase();
const salt = b64u.enc(randomBytes(16));
const master = await deriveMaster(passphrase, salt, ITER);
const keys = await keysFrom(master);
const parts = splitState(state, jstDate());

await mkdir(new URL('.secrets/', ROOT), { recursive: true });
await mkdir(new URL('data/', ROOT), { recursive: true });
await writeFile(new URL('config.json', ROOT), JSON.stringify({ v: 1, salt, iterations: ITER, check: keys.check, relay: 'https://ntfy.sh', repo: REPO }, null, 2) + '\n');
await writeFile(new URL('data/days.json', ROOT), JSON.stringify({ v: 1, sealed: await seal(keys, parts.hist) }) + '\n');
await writeFile(new URL('data/today.json', ROOT), JSON.stringify({ v: 1, sealed: await seal(keys, parts.live) }) + '\n');
await writeFile(new URL('.secrets/master.b64', ROOT), b64u.enc(master) + '\n', { mode: 0o600 });
await writeFile(new URL('.secrets/owner.txt', ROOT), [
  '養生 YOJO の合言葉（だれにも見せないでください）',
  '',
  `アプリ: ${SITE}`,
  `合言葉: ${passphrase}`,
  `開くだけで入れるリンク（自分の端末だけで開く）: ${SITE}#k=${b64u.enc(master)}`,
  '',
  `GitHub の Secrets「YOJO_KEY」に .secrets/master.b64 の中身を登録すること:`,
  `  gh secret set YOJO_KEY -R ${REPO} < .secrets/master.b64`,
].join('\n') + '\n', { mode: 0o600 });
console.log('config.json と data/ を作りました。合言葉とリンクは .secrets/owner.txt にあります。');
