# 稽古管理システム（本番実装・土台）

Next.js + Firebase（Authentication・Firestore・Cloud Functions）+ Vercel構成。
モックアップ（HTML版）で固めた業務フローを、実際に使えるシステムとして作り直す最初の土台です。

セットアップは [SETUP.md](./SETUP.md) を参照してください。

## 今回できていること

- Firebase Authentication + Firestore を使った、実際に安全な認証・権限制御の土台
  - `firestore.rules` で、本部・世話人・講師・会員それぞれのアクセス範囲をサーバー側で強制
  - 会員番号＋メールアドレスでのログイン（Cloud Functions `verifyMemberLogin` 経由でカスタムトークンを発行）
  - 本部はメール＋パスワードでログイン
- 3つの画面（管理画面・スタッフ画面・マイページ）を1つのNext.jsアプリに統合
- Firestoreとリアルタイム連携する主要機能
  - 管理画面：名簿閲覧・ステータス変更、許状申請の一覧・ステータス進行
  - スタッフ画面：担当する会の名簿閲覧、講師のみ「お渡し済にする」操作
  - マイページ：本人情報の閲覧、連絡先変更、休会・退会・復会申請
- 承認・完了時の自動反映をCloud Functionsで実装
  - 退会等の申請が承認されたら会員ステータスを自動更新（`onLeaveRequestApproved`）
  - 許状が「発行済」になったら会員の許状段階を自動更新（`onLicenseIssued`）
- Square Webhook受信の雛形（`squareWebhook`。署名検証は未実装、要追加）

## まだ実装していないこと（モックアップにはあった機能）

- 出席簿（月ごとのマトリクス表示・記録）
- 入金確認のマトリクス表示
- 出欠（RSVP）確認画面
- スタッフ管理画面（本部が世話人・講師を登録するUI）
- 過去の許状管理台帳の一覧表示
- 通知ログの表示UI（Cloud Functions側では記録している）
- UCI（侘び数寄道）関連
- Googleカレンダー連携、hacomono API連携（技術仕様書のフェーズ4で検討）

これらは、すでにあるパターン（Firestoreのコレクションを `onSnapshot` で購読し、フォームやテーブルに表示する）をそのまま踏襲すれば追加できます。`src/app/admin/page.tsx` を参考にしてください。

## ディレクトリ構成

```
src/
  app/
    login/    ログイン画面
    admin/    本部の管理画面
    staff/    世話人・講師のスタッフ画面
    mypage/   会員のマイページ
  lib/
    firebase.ts      Firebase初期化
    AuthContext.tsx  ログイン状態・役割の共有
  types/
    index.ts         データモデルの型定義
functions/
  src/index.ts       Cloud Functions（ログイン確認・自動反映・Webhook）
firestore.rules       権限ルール
scripts/
  setAdminClaim.js    最初の本部アカウントに権限を付与
  seedDummyData.js     ダミーデータの投入
```
