// meta/g1ShippingDoc の sections 配列の並び順を変更し、
// 「発送チェックリスト」（page3-checklist）を先頭に持ってくるスクリプト。
// 既存のセクション内容（編集済みの内容も含む）はそのまま、並び順だけを変更する。
// 使い方： node scripts/reorderG1ShippingSections.js         … 変更内容の確認のみ（dry-run）
//         node scripts/reorderG1ShippingSections.js --apply … 実際に書き込む

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

const FIRST_SECTION_ID = "page3-checklist";
const apply = process.argv.includes("--apply");

async function main() {
  const ref = db.doc("meta/g1ShippingDoc");
  const snap = await ref.get();
  if (!snap.exists) {
    console.log("meta/g1ShippingDoc がまだ存在しません。先に seedG1ShippingDoc.js を実行してください。");
    return;
  }

  const data = snap.data();
  const sections = data.sections || [];
  const before = sections.map((s) => s.title);

  const target = sections.filter((s) => s.id === FIRST_SECTION_ID);
  const rest = sections.filter((s) => s.id !== FIRST_SECTION_ID);

  if (target.length === 0) {
    console.log(`id="${FIRST_SECTION_ID}" のセクションが見つかりませんでした。何もしません。`);
    console.log("現在の順番:", before);
    return;
  }

  const reordered = [...target, ...rest];
  const after = reordered.map((s) => s.title);

  console.log("変更前:", before);
  console.log("変更後:", after);

  if (!apply) {
    console.log("---");
    console.log("dry-runです。実際に書き込むには --apply を付けて再実行してください。");
    return;
  }

  await ref.update({
    sections: reordered,
    updatedAt: new Date().toISOString(),
    updatedBy: (data.updatedBy || "") + "／並び替え（スクリプト）",
  });
  console.log("並び順を更新しました。");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
