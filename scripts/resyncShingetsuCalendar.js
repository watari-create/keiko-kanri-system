// 新月会の開催日のうち、まだGoogleカレンダーに予定が入っていないもの（calendarEventId なし）を、
// カレンダーへ入れ直すスクリプト。カレンダーの権限が通る前に開催日を登録した場合に使う。
// 各ドキュメントに calendarSyncRequestedAt を書き込むと、Cloud Functions（syncShingetsuSessionToCalendar）が動いて予定を作る。
//
// 使い方： node scripts/resyncShingetsuCalendar.js         … 対象の確認のみ
//         node scripts/resyncShingetsuCalendar.js --apply … 入れ直す

const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const os = require("os");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
// Firebase CLI（npx firebase-tools login）のログイン情報。組織ポリシーで秘密鍵を作れないため、これを使う。
const firebaseCliConfig = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
if (fs.existsSync(keyPath)) {
  initializeApp({ credential: cert(require(keyPath)) });
} else if (fs.existsSync(firebaseCliConfig) && require(firebaseCliConfig).tokens?.refresh_token) {
  // Firestoreは「アプリケーションのデフォルト認証情報（ADC）」形式しか受け付けないため、
  // Firebase CLIのログイン情報をADC形式の一時ファイルに書き出して使う。
  const adcPath = path.join(os.tmpdir(), "keiko-app-adc.json");
  fs.writeFileSync(
    adcPath,
    JSON.stringify({
      type: "authorized_user",
      // Firebase CLI の公開OAuthクライアント（firebase-tools に同梱の値）
      client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
      refresh_token: require(firebaseCliConfig).tokens.refresh_token,
      quota_project_id: "sohenryu-okeiko-management",
    }),
    { mode: 0o600 }
  );
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
  initializeApp({
    credential: applicationDefault(),
    projectId: "sohenryu-okeiko-management",
  });
} else {
  initializeApp({
    credential: applicationDefault(),
    projectId: "sohenryu-okeiko-management",
  });
}
const db = getFirestore();

async function run() {
  const apply = process.argv.includes("--apply");
  const snap = await db.collection("shingetsuSessions").get();
  const targets = snap.docs.filter((d) => !d.data().calendarEventId);
  console.log(`開催日 ${snap.size}件のうち、カレンダー未反映：${targets.length}件`);
  for (const d of targets) {
    console.log(`  ${d.id} ${d.data().place || ""}${apply ? " … 入れ直し" : ""}`);
    if (apply) await d.ref.update({ calendarSyncRequestedAt: new Date().toISOString() });
  }
  if (!apply && targets.length > 0) console.log("\n入れ直すには --apply を付けて実行してください。");
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
