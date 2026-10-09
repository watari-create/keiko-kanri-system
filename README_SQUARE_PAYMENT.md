# お月謝のカード自動払い（Square）設定手順

対象：茶道教室・名月会・G1マダム（Gマダムの茶の湯講座）の月謝払いの会員
お引き落とし：前払い。毎月25日に翌月分。参加開始月の分は前月25日、それが過ぎていればカード登録時にすぐ
  - 例）10/9申込み・10月から参加 → 10/9に10月分、10/25に11月分、以降毎月25日に翌月分
  - 例）10/9申込み・11月から参加 → 10/25に11月分（登録時の引き落としなし）
  - 例）10/27申込み・10月から参加 → 10/27に10月分（単発決済）＋11月分、11/25に12月分
  - 参加開始月は会員が決済画面で「今月から／来月から」を選ぶ。新規募集クラスは開講月に固定
カード変更：会員がマイページ「お月謝のお支払い」→「お支払いカードを変更する」から自分で行う

## しくみ
- マイページ `/mypage/payment` で、Squareのカード入力欄（Web Payments SDK）にカードを入力
  → 3Dセキュア（本人認証）を通ったトークンだけがこのシステムに届く（カード番号は届かない・保存しない）
- Cloud Functions（functions/src/square.ts）が Square に 顧客 → カード → サブスクリプション を作成
- 金額ごとのプラン（「お月謝 月額¥15,000」など、毎月25日・日割りなし）は初回申込み時に自動作成
- 契約状況は Firestore `memberSubscriptions/{会員番号}`、入金・失敗の履歴は その下の `payments`
- Squareからの通知（Webhook）で、入金 → 会員の paymentStatus を「済」、引き落とし失敗 → 「未納」＋Slack（本部稽古bo）に通知
- 管理画面の会員詳細に「カード自動払いの状況」と「申込みボタンの表示」設定

## テストで必ず確認すること
- 「今月から」で申し込んだとき、申込み当日にSquareで1回目が引き落とされること（プランは日割りなし・25日締め。Squareの仕様上、開始日が当日なら当日に全額が請求される）
- 25日以降に「今月から」で申し込んだとき、単発決済（今月分）とサブスク初回（翌月分）の2件が立つこと

## 既存会員（Square決済リンクでお支払い中）の扱い
- そのまま。マイページの申込みボタンは表示されず、従来どおりの案内文が出る
- 申込みボタンが出るのは：入会日が `SQUARE_BILLING_FROM` 以降の会員、または管理画面で「マイページに表示する」にした会員
- テスト環境（sandbox）の間は、「マイページに表示する」にした会員にだけ表示される

---

## 1. Square開発者アカウントとアプリの作成
1. https://developer.squareup.com/ に、いつものSquareアカウントでサインイン
2. 「Applications」→「＋」で新しいアプリを作成（名前例：お稽古管理システム）
3. アプリを開き、上部の切り替えを **Sandbox** にして次をメモ
   - Credentials：**Sandbox Application ID**（sandbox-sq0idb-…）、**Sandbox Access Token**（EAAA…）
   - Locations：**Location ID**（テスト用の店舗のID）

## 2. Firebaseに設定（Macのターミナル、keiko-app フォルダで）
```
npx -y firebase-tools@latest functions:secrets:set SQUARE_ACCESS_TOKEN --project sohenryu-okeiko-management
npx -y firebase-tools@latest functions:secrets:set SQUARE_WEBHOOK_SIGNATURE_KEY --project sohenryu-okeiko-management
```
（署名キーは手順4で取得。先に仮の値 `temp` を入れておき、取得後にもう一度setしてデプロイし直してもOK）

`functions/.env.sohenryu-okeiko-management` に追記：
```
SQUARE_ENVIRONMENT=sandbox
SQUARE_APPLICATION_ID=sandbox-sq0idb-xxxxxxxx
SQUARE_LOCATION_ID=Lxxxxxxxx
SQUARE_WEBHOOK_URL=https://squarewebhook-azyyg5u2jq-uc.a.run.app
SQUARE_BILLING_FROM=2026-11-01
```
- `SQUARE_WEBHOOK_URL` は手順3のデプロイ後に表示される squareWebhook のURLと完全に同じにする
- `SQUARE_BILLING_FROM`：この日以降に入会した会員に申込みボタンを表示（本番開始日にする）

## 3. デプロイ
```
npx -y firebase-tools@latest deploy --only functions,firestore:rules --project sohenryu-okeiko-management
git add -A src functions/src firestore.rules README_SQUARE_PAYMENT.md .env.local.example
git commit -m "お月謝のカード自動払い（Square サブスク）とカード変更を追加"
git push
```

## 4. Webhookの登録（Square開発者ダッシュボード → アプリ → Webhooks → Subscriptions）
- URL：手順2の `SQUARE_WEBHOOK_URL`
- イベント：`invoice.payment_made` / `invoice.scheduled_charge_failed` / `subscription.created` / `subscription.updated` / `payment.updated`
- 保存後に表示される **Signature Key** を `SQUARE_WEBHOOK_SIGNATURE_KEY` にset → functionsを再デプロイ

## 5. テスト（sandbox）
1. 管理画面でテスト会員（茶道教室など）を開き「カード自動払い（Square）の申込みボタン」を「マイページに表示する」に
2. その会員でマイページにログイン →「お月謝のお支払い」→「カード自動払いを申し込む」
3. テストカード `4111 1111 1111 1111`、有効期限は未来の日付、CVV `111`
4. 完了画面 → Squareのsandboxダッシュボードに顧客・サブスクリプションができているか確認
5. マイページ →「お支払いカードを変更する」で別のテストカード（例：5105 1051 0510 5100）に変更できるか確認
6. 管理画面の会員詳細「カード自動払いの状況」に反映されているか確認

## 6. 本番への切り替え
1. Square開発者ダッシュボードを **Production** に切り替え、本番の Application ID・Access Token・Location ID を取得
2. `SQUARE_ACCESS_TOKEN` を本番のトークンで set し直す
3. `functions/.env.sohenryu-okeiko-management` を `SQUARE_ENVIRONMENT=production` と本番のID に変更
4. Webhookを本番側にも登録し、本番の Signature Key を set
5. functions を再デプロイ
6. Vercel の環境変数に `NEXT_PUBLIC_SQUARE_BILLING_ENABLED=1` を追加して再デプロイ
   → 入会完了画面の支払い案内が「ログインしてカードを登録する」に切り替わる
7. sandboxで作ったテスト会員の `memberSubscriptions/{会員番号}` は Firestore コンソールで削除しておく

## 運用メモ
- 解約・金額変更：Squareのダッシュボード（顧客 → サブスクリプション）で行う。状態は Webhook で自動反映
- お月謝の額を変えた会員：既存の契約は自動では変わらない（Squareでプラン変更が必要）
- 引き落とし失敗時：Squareからご本人に請求書メールが届き、Slackにも通知。マイページでカード変更をご案内
- 入会金は従来どおり経理がSquare請求書で発行
