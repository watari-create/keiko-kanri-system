// 新月会の開催日（出欠表の24回分：2026年10月〜2027年9月）を shingetsuSessions に登録し、
// 出欠表の10月の回答（10/12 鎌倉 か 10/22 代官山 のどちらに出席するか）を members.shingetsuChoice に入れるスクリプト。
// 2026-10-09、新月会出欠表.xlsx をもとに作成。表示は日付と場所のみ（11/3・11/28 は「鎌倉」で確定）。
//
// 使い方： node scripts/seedShingetsuSessions202610.js         … 確認のみ（dry-run）
//         node scripts/seedShingetsuSessions202610.js --apply … 実際に書き込む
//
// ・すでに登録済みの開催日は上書きしない（管理画面で場所を変えていても消えない）。
// ・10月の回答は、管理画面・マイページで回答済みの会員には上書きしない。
// ・#12 立石修也さん・#20 愛甲千笑美さんはシステム未登録のため対象外。

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

const sessions = [
  ["2026-10-12", "鎌倉"], ["2026-10-22", "代官山"], ["2026-11-03", "鎌倉"], ["2026-11-28", "鎌倉"],
  ["2026-12-12", "日本橋"], ["2026-12-19", "日本橋"], ["2027-01-23", "鎌倉"], ["2027-01-31", "日本橋"],
  ["2027-02-11", "護国寺"], ["2027-02-23", "日本橋"], ["2027-03-13", "日本橋"], ["2027-03-27", "鎌倉"],
  ["2027-04-24", "日本橋"], ["2027-04-25", "日本橋"], ["2027-05-22", "鎌倉"], ["2027-05-29", "鎌倉"],
  ["2027-06-19", "鎌倉"], ["2027-06-26", "鎌倉"], ["2027-07-17", "日本橋"], ["2027-07-24", "日本橋"],
  ["2027-08-07", "日本橋"], ["2027-08-08", "日本橋"], ["2027-09-11", "日本橋"], ["2027-09-18", "日本橋"],
];

// 10月の回答：[氏名, 出席する開催日 or "欠席"]
const october = [
  ["吉田翔貴", "2026-10-12"], ["山田崇元", "2026-10-12"], ["加藤千華", "2026-10-22"], ["安藤大河", "2026-10-22"],
  ["安藤祥子", "2026-10-22"], ["橋谷拓", "2026-10-22"], ["安田光希", "2026-10-12"], ["伊藤和真", "2026-10-22"],
  ["久保駿貴", "欠席"], ["寺田彩人", "2026-10-22"], ["柳川武則", "2026-10-12"], ["野島隆太郎", "2026-10-22"],
  ["田本英輔", "2026-10-12"], ["寺田悠太", "2026-10-12"], ["白崎龍弥", "2026-10-22"], ["渡部由理佳", "2026-10-22"],
  ["吉岡洸輝", "2026-10-12"], ["吉岡ちか", "2026-10-12"],
];
const norm = (s) => String(s || "").replace(/[\s　]/g, "");

async function run() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "本番書き込みモード" : "確認のみ（dry-run）。実際に書き込むには --apply を付けて実行してください。");

  console.log("\n■ 開催日");
  let added = 0;
  for (const [date, place] of sessions) {
    const ref = db.collection("shingetsuSessions").doc(date);
    if ((await ref.get()).exists) { console.log(`  ${date} ${place} … 登録済み（変更しない）`); continue; }
    console.log(`  ${date} ${place}${apply ? " … 登録" : " … 登録予定"}`);
    if (apply) await ref.set({ date, place });
    added++;
  }

  console.log("\n■ 10月の回答");
  const snap = await db.collection("members").where("group", "==", "新月会").get();
  const byName = new Map();
  snap.forEach((d) => byName.set(norm(d.data().name), d));
  let set = 0;
  for (const [name, choice] of october) {
    const d = byName.get(norm(name));
    if (!d) { console.log(`  [見つかりません] ${name}`); continue; }
    const cur = (d.data().shingetsuChoice || {})["2026-10"];
    if (cur) { console.log(`  ${d.id} ${d.data().name} … 回答済み（${cur}）のため変更しない`); continue; }
    const label = choice === "欠席" ? "欠席" : `${choice} ${sessions.find((s) => s[0] === choice)[1]}に出席`;
    console.log(`  ${d.id} ${d.data().name} → ${label}${apply ? "" : "（予定）"}`);
    if (apply) {
      await d.ref.update({
        "shingetsuChoice.2026-10": choice,
        "attendance.2026-10": choice === "欠席" ? "欠席" : "出席",
      });
    }
    set++;
  }
  console.log(`\n開催日：${added}件／10月の回答：${set}名 ${apply ? "書き込み完了" : "（dry-run）"}`);
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
