# 養生 YOJO

Oura リングの数値（睡眠・回復・活動）と毎日の体調の記録を、**自分のふだん（直前45日）と比べて、やさしい言葉で伝える**健康管理アプリです。
作り方は [土日 DONICHI](https://github.com/sho3690/donichi) と同じです（GitHub Pages ＋ 暗号化したデータ ＋ GitHub Actions）。

- 公開先: https://sho3690.github.io/yojo/
- 使えるのは、合言葉かリンクを持っている人だけです。医療の診断はしません。

## 画面

| タブ | 中身 |
|---|---|
| 今日 | コンディション（100点満点）と4段階の言葉、睡眠・HRV・歩数、気づき（体温が高め・HRVが低め・睡眠が短い など）、きょうの記録 |
| 推移 | 7日 / 30日 / 90日。ふだんとの比べ、グラフ（ふだんの範囲を帯で表示）、記録との関係（お酒の翌朝はHRVが下がる など） |
| 記録 | 体調（5段階）・気になったこと（お酒・運動など）・体重・メモ。Oura の数値と並べて表示 |

数字の基準: 睡眠7〜9時間（米国睡眠財団 2015）、歩数8,000歩前後（Paluch ほか 2022）、眠りの効率85%以上（Ohayon ほか 2004）、
コンディションの4段階は Oura の区分（85・70・60）。HRV・心拍・体温は人による差が大きいので、自分のふだん（平均±ばらつき）との差で判断します。

## しくみ

```
[スマホ/PC のブラウザ]
   │ 体調の記録・Oura との接続（合言葉で暗号化してから送る）
   ▼
[中継 ntfy.sh]  ← 登録不要。暗号文だけを約12時間あずかる。ほかの端末にもすぐ届く
   │ 15分ごとに取り込む
   ▼
[GitHub Actions  scripts/sync.mjs]
   ・記録を取り込む
   ・Oura API v2 から日ごとの数値を取る（最初は180日分、ふだんは直近3日、1日1回30日分を見直し）
   ・暗号化して data/days.json（過去）・data/today.json（直近2日）に保存 → GitHub Pages で配信
```

- **暗号化**: 合言葉 → PBKDF2(SHA-256, 21万回) → AES-256-GCM。リポジトリは公開ですが、`data/*.json` と中継のメッセージは暗号文なので、合言葉が無いと中身は読めません。
  GitHub の無料プランでは非公開リポジトリから Pages を出せないため、この形にしています。
- 保存を2つのファイルに分けているのは、1日に何度も変わる歩数の更新で、公開リポジトリに積もる暗号文を増やしすぎないためです。中身が変わったファイルだけ書き直します。
- **端末の中の鍵**: 開いたあとは「取り出せない形（non-extractable）」の鍵だけを IndexedDB に置き、親鍵そのものは保存しません。
  sho3690.github.io は他のアプリと同じ置き場なので、万一そちらに不正なスクリプトが入っても鍵を持ち出されないようにするためです（その場で使われることまでは防げません。根本策は独自ドメインへの移設）。
- **Actions のログは公開**されるので、件数と状態以外（数値・メモ・トークン・エラー文）は出力しません。外部の Action はコミットの番号で固定し、書き込み権限は push の手順だけで使います。
  ただし、**いつ記録したか・いつ指輪が同期したか（≒起きた時刻）・つながっているか**は、コミットの時刻とログの件数から外の人にも分かります（数値の中身は分かりません）。
- 中継から届いたメッセージは、7日より古いもの（昔の暗号文の送り直し）と、時刻が先すぎるものを捨てます。日付の判定はサーバーの「今日」で行います。
- Oura の連携を切る・つなぎ直すと、前のトークンを Oura 側でも取り消します（`/oauth/revoke`）。
- **15分ごとに動かすしくみ**: 新しいリポジトリでは GitHub の定時実行が一度も起動しないことがあるため、各回が「15分待ってから次の回を予約する」ようにしています（環境 `interval` の待ち時間。待つ間はマシンを使いません）。定時実行は途切れたときの予備（1時間ごと）です。
  止めるとき: `gh workflow disable sync.yml -R sho3690/yojo`
  / 再開するとき: `gh workflow enable sync.yml -R sho3690/yojo && gh workflow run sync.yml -R sho3690/yojo`

## Oura とつなぐ（どちらか1つ）

アプリの「設定 → Oura とのつながり」にも同じ手順があります。

**A. 個人用トークン（手順が少ない）**
1. https://cloud.ouraring.com/personal-access-tokens で新しいトークンを作ってコピー
2. ターミナルで次の1行を実行し、聞かれたら貼り付けて Enter（画面には出ません）
   ```
   gh secret set OURA_TOKEN -R sho3690/yojo
   ```
3. 15分ほどで数値が届きます

Oura は個人用トークンを「廃止予定（Deprecated）」としています。作れないときは B で。

**B. Oura の連携（OAuth。30日ごとにつなぎ直し）**
1. https://cloud.ouraring.com/oauth/applications で自分用のアプリを登録。Redirect URI に `https://sho3690.github.io/yojo/` を入れる
2. アプリの設定で Client ID を貼り、「Oura でつなぐ」→ Oura の画面で許可（Client Secret は使いません）
3. トークン（30日有効）は暗号化して中継経由で Actions に渡り、保存データの中に暗号化して置かれます。期限の7日前から画面にお知らせが出ます

## 合言葉を変える

```
node scripts/setup.mjs --keep-state       # データはそのまま、新しい合言葉で封し直す
gh secret set YOJO_KEY -R sho3690/yojo < .secrets/master.b64
git add config.json data/days.json data/today.json && git commit -m "合言葉を変更" && git push
```

新しい合言葉・リンクは `.secrets/owner.txt` に出ます（コミットされません）。古いリンクでは開けなくなります。
切り替える間は `gh workflow disable sync.yml -R sho3690/yojo` で止めておき、push のあとで再開してください。

## 開発

```
npm test                                   # 計算・暗号・Oura の取り込みのテスト（node --test）
node scripts/demo.mjs <写したフォルダ>       # 画面確認用の架空データ（合言葉 demo の鍵で作る。本番には触らない）
python3 -m http.server 8793 --bind 127.0.0.1
```

ファイル: `index.html` / `style.css` / `app.js`（画面） · `logic.js`（日付・数値の整理・ふだんとの比べ・気づき・記録の反映。副作用なし）
· `charts.js`（グラフ。evilcharts の作法で ECharts を使う。`vendor/echarts.min.js` は v6.1.0） · `crypto.js`（暗号） · `relay.js`（中継）
· `scripts/sync.mjs`（取り込み） · `scripts/oura.mjs`（Oura API） · `scripts/state-io.mjs`（暗号化した保存） · `scripts/setup.mjs`（合言葉の作成・変更）
