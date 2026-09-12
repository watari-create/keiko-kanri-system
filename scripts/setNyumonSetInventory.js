// meta/nyumonSetInventory（名月会 入門セット在庫）を、実際の現在の在庫数で上書きするスクリプト。
// 既存のドキュメントがあれば上書きしてしまうため、通常は在庫を仕切り直すときのみ実行する。
// 使い方： node scripts/setNyumonSetInventory.js         … 書き込む内容の確認のみ（dry-run）
//         node scripts/setNyumonSetInventory.js --apply … 実際に書き込む

const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
if (fs.existsSync(keyPath)) {
  initializeApp({ credential: cert(require(keyPath)) });
} else {
  initializeApp({
    credential: applicationDefault(),
    projectId: "sohenryu-okeiko-management",
  });
}

const db = getFirestore();

// 名月会 入門セット（年齢・性別に応じて自動減算される品目）の在庫。
const items = {
  "子供用服紗（3歳から8歳まで）": 6,
  "服紗（9歳以上）": 6,
  "扇子　女性用": 6,
  "扇子　男性用": 6,
  懐紙: 6,
};

async function main() {
  console.log("書き込む内容:");
  console.log(items);

  const apply = process.argv.includes("--apply");
  if (!apply) {
    console.log("\n（確認のみ。実際に書き込むには --apply を付けて実行してください）");
    return;
  }

  await db.doc("meta/nyumonSetInventory").set({
    items,
    updatedAt: new Date().toISOString(),
    updatedBy: "script:setNyumonSetInventory",
  });
  console.log("\nmeta/nyumonSetInventory に書き込みました。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
