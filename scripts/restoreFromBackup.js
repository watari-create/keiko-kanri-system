// 全データのバックアップ（管理画面「システム管理 → バックアップ」、Firestore の backups）から
// データを戻すスクリプト。2026-10-14 作成。
//
// 誤って全体を巻き戻さないよう、戻す範囲（コレクション、または1件）を必ず指定し、
// --apply を付けない限り「何が変わるか」の確認だけを行う。
//
// 使い方（必ず ~/Desktop/keiko-app で実行。事前に npx firebase-tools login --reauth）：
//   node scripts/restoreFromBackup.js
//       … バックアップの一覧
//   node scripts/restoreFromBackup.js <バックアップID>
//       … そのバックアップの中身（データの種類ごとの件数）
//   node scripts/restoreFromBackup.js <バックアップID> --collection=members
//       … members を戻したら何が変わるかの確認だけ（変更しない）
//   node scripts/restoreFromBackup.js <バックアップID> --collection=members --doc=30000012
//       … 1件だけの確認
//   上の2つに --apply を付けると実際に戻す（バックアップにあるドキュメントを、その時点の内容で上書き）。
//   --delete-extra を付けると、バックアップ後に新しく作られたドキュメントも削除する（--collection 指定時のみ）。
//
// 戻す前に、管理画面で「今すぐバックアップ」を押して今の状態を保存しておくこと（戻した操作を取り消せるように）。

const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const { getFirestore, Timestamp, GeoPoint } = require("firebase-admin/firestore");
const os = require("os");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
const firebaseCliConfig = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
const adcPath = path.join(os.tmpdir(), "keiko-app-adc.json");
if (fs.existsSync(keyPath)) {
  initializeApp({ credential: cert(require(keyPath)) });
} else if (fs.existsSync(firebaseCliConfig) && require(firebaseCliConfig).tokens?.refresh_token) {
  fs.writeFileSync(
    adcPath,
    JSON.stringify({
      type: "authorized_user",
      client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
      refresh_token: require(firebaseCliConfig).tokens.refresh_token,
      quota_project_id: "sohenryu-okeiko-management",
    }),
    { mode: 0o600 }
  );
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
  initializeApp({ credential: applicationDefault(), projectId: "sohenryu-okeiko-management" });
} else {
  initializeApp({ credential: applicationDefault(), projectId: "sohenryu-okeiko-management" });
}
const db = getFirestore();

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

/** バックアップのJSON表現（{__type: "timestamp"} など）をFirestoreの値に戻す */
function fromJson(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(fromJson);
  if (typeof v === "object") {
    if (v.__type === "timestamp") return Timestamp.fromDate(new Date(v.value));
    if (v.__type === "geopoint") return new GeoPoint(v.latitude, v.longitude);
    if (v.__type === "ref") return db.doc(v.path);
    if (v.__type === "bytes") return Buffer.from(v.base64, "base64");
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = fromJson(val);
    return out;
  }
  return v;
}

async function loadBackup(id) {
  const ref = db.collection("backups").doc(id);
  const meta = await ref.get();
  if (!meta.exists) throw new Error(`バックアップ ${id} が見つかりません`);
  if (meta.data().status !== "done") throw new Error(`バックアップ ${id} は完了していません（${meta.data().status}）`);
  const chunks = await ref.collection("chunks").orderBy("index").get();
  const b64 = chunks.docs.map((d) => d.data().data).join("");
  const json = zlib.gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
  return JSON.parse(json);
}

async function main() {
  const id = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const col = arg("collection");
  const docId = arg("doc");
  const apply = process.argv.includes("--apply");
  const deleteExtra = process.argv.includes("--delete-extra");

  if (!id) {
    const snap = await db.collection("backups").orderBy("createdAt", "desc").limit(40).get();
    console.log("バックアップの一覧（新しい順）：");
    snap.docs.forEach((d) => {
      const b = d.data();
      console.log(
        `  ${d.id}  ${b.trigger === "manual" ? "手動" : "自動"}  ${b.status}  ${b.docCount ?? "-"}件  ${b.by ?? ""}`
      );
    });
    console.log("\n中身を見るには：node scripts/restoreFromBackup.js <バックアップID>");
    return;
  }

  const backup = await loadBackup(id);
  if (!col) {
    console.log(`バックアップ ${id}（${backup.createdAt}）の中身：`);
    for (const [k, n] of Object.entries(backup.counts).sort()) console.log(`  ${k}: ${n}件`);
    console.log("\n戻す範囲を --collection=<名前>（と --doc=<ID>）で指定してください。");
    return;
  }

  const docs = backup.collections[col];
  if (!docs) throw new Error(`バックアップに ${col} はありません`);
  let entries = Object.entries(docs);
  if (docId) entries = entries.filter(([p]) => p.split("/").pop() === docId);
  if (entries.length === 0) throw new Error(`バックアップの ${col} に ${docId ?? "（対象）"} はありません`);

  // 今の状態と比べる
  let willCreate = 0;
  let willOverwrite = 0;
  let same = 0;
  for (const [p, data] of entries) {
    const cur = await db.doc(p).get();
    if (!cur.exists) willCreate++;
    else if (JSON.stringify(cur.data()) === JSON.stringify(fromJson(data))) same++;
    else willOverwrite++;
  }
  let extras = [];
  if (deleteExtra && !docId) {
    if (col.includes("/")) throw new Error("--delete-extra はトップレベルのコレクションにだけ使えます");
    const backupPaths = new Set(entries.map(([p]) => p));
    const curSnap = await db.collection(col).get();
    extras = curSnap.docs.map((d) => d.ref.path).filter((p) => !backupPaths.has(p));
  }

  console.log(`バックアップ ${id}（${backup.createdAt}）→ ${col}${docId ? `/${docId}` : ""}`);
  console.log(`  バックアップ時点の内容で上書き：${willOverwrite}件`);
  console.log(`  削除されていたので作り直す：${willCreate}件`);
  console.log(`  変更なし：${same}件`);
  if (deleteExtra) console.log(`  バックアップ後に作られたので削除：${extras.length}件`);

  if (!apply) {
    console.log("\n確認のみ（変更していません）。実行するには末尾に --apply を付けてください。");
    console.log("※ 実行前に管理画面「システム管理 → バックアップ」で「今すぐバックアップ」を押しておくこと。");
    return;
  }

  let written = 0;
  let batch = db.batch();
  let n = 0;
  for (const [p, data] of entries) {
    batch.set(db.doc(p), fromJson(data));
    n++;
    written++;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  for (const p of extras) {
    batch.delete(db.doc(p));
    n++;
    if (n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n > 0) await batch.commit();

  // 管理画面の操作ログにも残す（スクリプトからの書き込みは自動では記録されないため）
  await db.collection("operationLogs").add({
    at: Timestamp.now(),
    op: "update",
    collection: col.split("/")[0],
    collectionLabel: `バックアップから復元（${col}）`,
    path: `${col}${docId ? `/${docId}` : ""}`,
    docId: docId ?? col,
    targetLabel: `バックアップ ${id}`,
    actorType: "script",
    actorUid: "",
    actorLabel: `復元スクリプト（${os.userInfo().username}）`,
    actorRole: "console",
    changes: [
      { field: "書き戻し", before: "", after: `${written}件` },
      ...(extras.length ? [{ field: "削除", before: "", after: `${extras.length}件` }] : []),
    ],
    changeCount: extras.length ? 2 : 1,
    snapshot: null,
  });
  console.log(`\n完了：${written}件を書き戻しました${extras.length ? `、${extras.length}件を削除しました` : ""}。`);
}

main()
  .catch((e) => {
    console.error("エラー：", e.message || e);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      if (fs.existsSync(adcPath)) fs.unlinkSync(adcPath);
    } catch {}
  });
