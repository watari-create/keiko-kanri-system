# セットアップ手順

Firebaseプロジェクトがまだない前提の、ゼロからの手順です。

## 1. Firebaseプロジェクトを作る

1. https://console.firebase.google.com/ を開き、Googleアカウントでログイン
2. 「プロジェクトを追加」→ プロジェクト名（例：`sohenryu-keiko`）を入力 → 作成
3. 左メニュー「構築」→「Authentication」→「始める」
   - 「Sign-in method」タブで「メール/パスワード」を有効化（本部用）
   - 「カスタムトークン」は追加設定不要（Cloud Functionsから発行するため）
4. 左メニュー「構築」→「Firestore Database」→「データベースの作成」
   - ロケーションは `asia-northeast1`（東京）を推奨
   - 本番モードで開始（ルールは後で `firestore.rules` をデプロイする）
5. 左メニュー「プロジェクトの設定」（歯車アイコン）→「全般」→ 下の方の「マイアプリ」→ ウェブアプリを追加
   - アプリ名は何でもよい（例：`keiko-web`）
   - 表示される `firebaseConfig` の値を控えておく（次のステップで使う）

## 2. ローカルに環境変数を設定する

```bash
cp .env.local.example .env.local
```

`.env.local` を開き、手順1で控えた値を入力する。

## 3. 依存パッケージのインストール

```bash
npm install
cd functions && npm install && cd ..
```

## 4. Firebase CLIのセットアップ

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # 手順1で作ったプロジェクトを選ぶ
```

## 5. Firestoreセキュリティルールのデプロイ

```bash
firebase deploy --only firestore:rules
```

`firestore.rules` の内容がそのまま本番に反映される。編集した場合は再度このコマンドを実行する。

## 6. Cloud Functionsのデプロイ

Cloud Functionsの利用には、Firebaseの料金プランを「Blaze（従量課金）」にアップグレードする必要があります（無料枠の範囲内であれば課金は発生しません）。

```bash
cd functions
npm run build
firebase deploy --only functions
```

## 7. 最初の本部アカウントを作る

1. Firebaseコンソール →「Authentication」→「Users」→「ユーザーを追加」
   - 本部で使うメールアドレスとパスワードを設定
2. 追加されたユーザーの「UID」をコピー
3. サービスアカウントキーを発行する
   - 「プロジェクトの設定」→「サービスアカウント」→「新しい秘密鍵の生成」
   - ダウンロードしたJSONファイルをプロジェクトのルート直下に `serviceAccountKey.json` として保存
   - **このファイルは絶対にGitにコミットしない**（`.gitignore` に登録済み）
4. 以下を実行して、そのユーザーに本部権限を付与する

```bash
node scripts/setAdminClaim.js <控えたUID>
```

## 8. （任意）ダミーデータの投入

実在する会員の個人情報を使わず、テスト用のダミーデータでまず動作確認することを推奨します。

```bash
node scripts/seedDummyData.js
```

## 9. ローカルで動作確認

```bash
npm run dev
```

http://localhost:3000 を開き、`/login` で本部アカウント（メール＋パスワード）、
またはダミーデータの会員番号（`30000001` など）＋そのメールアドレスでログインできるか確認する。

## 10. Vercelへのデプロイ

1. このプロジェクトをGitHubリポジトリにpushする
2. https://vercel.com/ で「New Project」→ そのGitHubリポジトリを選択
3. 環境変数（Settings → Environment Variables）に `.env.local` と同じ内容を登録する
   - `functions/` フォルダはVercelにはデプロイされない（Cloud Functionsは手順6の `firebase deploy` で別途デプロイ済みのため、これで問題ない）
4. デプロイ完了後、発行されたURLで本番動作を確認する

## 実データを入れる前に、必ず確認すること

- Firestoreルールがデプロイ済みで、ログインなしでは何も読めない状態になっているか
- `serviceAccountKey.json` がGitにコミットされていないか
- 実在する会員の個人情報を、テスト段階で使っていないか
