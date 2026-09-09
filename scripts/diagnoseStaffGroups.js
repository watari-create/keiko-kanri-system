// 「講師画面で名簿が表示されない」を調査するための一度きりのスクリプト。
// staff コレクションの groups 配列と、members コレクションに実際にある group の値を突き合わせ、
// 一致しないものがあれば表示する（Firestoreルールの isStaffFor は完全一致でしか通らないため、
// 全角/半角や末尾スペースなどの些細な違いでも名簿が空になる）。
//
// 使い方： node scripts/diagnoseStaffGroups.js

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

function show(s) {
  // 目に見えない差分（全角スペース・末尾スペースなど）を可視化する
  return JSON.stringify(s);
}

async function run() {
  const staffSnap = await db.collection("staff").get();
  const membersSnap = await db.collection("members").get();

  const memberGroups = new Set();
  for (const doc of membersSnap.docs) {
    const g = doc.data().group;
    if (g) memberGroups.add(g);
  }

  console.log("=== members コレクションに実在する group の値 ===");
  for (const g of memberGroups) console.log(`  ${show(g)}`);

  console.log("\n=== staff コレクション一覧 ===");
  for (const doc of staffSnap.docs) {
    const d = doc.data();
    console.log(`\n${doc.id}  ${d.name ?? "(名前なし)"}  role=${d.role}`);
    const groups = d.groups ?? [];
    if (groups.length === 0) {
      console.log("  ⚠ groups が空です");
    }
    for (const g of groups) {
      const matches = memberGroups.has(g);
      console.log(`  groups: ${show(g)}  ${matches ? "✓ membersに一致あり" : "✗ 一致する会員が見つかりません！"}`);
    }
  }
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
