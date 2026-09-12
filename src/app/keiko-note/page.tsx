"use client";

export const dynamic = "force-dynamic";

// お稽古ノートページ（茶道教室：土曜日・日曜日・火曜日クラス）。
// もともとプロトタイプ（https://okeiko-note-saturday.netlify.app/）として作られていたものを
// 稽古管理システム本体に移植したもの。見た目・機能（クラス選択、講師モードでの記録・編集・削除、
// 「簡単フォーム」「テンプレート」「ブロック編集」の3種類の記録方法）はプロトタイプのままにしてあり、
// 保存先だけをNetlifyのwindow.storageからFirestore（keikoNoteEntries コレクション）に変更している。
// 「講師として編集する」トグルは、実際にはstaff/honbuロールのユーザーにしか表示されない
// （会員が誤って編集モードに入ることはない。書き込み自体もFirestoreルールで制限している）。

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { collection, deleteDoc, doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/AuthContext";
import { KEIKO_NOTE_CLASSES } from "@/lib/keikoNoteData";
import type {
  KeikoNoteBlock,
  KeikoNoteBlockType,
  KeikoNoteEntry,
  KeikoNoteToriawaseItem,
  KeikoNoteVideo,
} from "@/types";
import "./keiko-note.css";

const TORIAWASE_LABELS = ["床", "花入", "花", "菓子器", "茶", "菓子"];

const BLOCK_TYPE_LABELS: Record<KeikoNoteBlockType, string> = {
  text: "文章",
  section: "見出し＋文章",
  bullets: "箇条書き",
  tools: "道具リスト",
  toriawase: "取り合わせ",
  link: "リンク",
  videos: "動画",
  videoGroup: "動画グループ",
};

const BLOCK_TYPE_HINTS: Record<KeikoNoteBlockType, string> = {
  text: "自由に文章を入力してください。空行で段落が分かれます。",
  section: "見出しの下に続く文章を入力してください。空行で段落が分かれます。",
  bullets: "1行に1項目、箇条書きにしたい内容を入力してください。",
  tools: "1行ずつ「名前：説明」の形で入力してください（例：茶杓：お抹茶をすくうための道具）。",
  toriawase: "1行ずつ「ラベル：内容」の形で入力してください（例：床：土佐光貞筆「乞巧奠」）。",
  link: "1行目にタイトル、2行目にURLを入力してください。",
  videos:
    "動画1本ごとに「タイトル」「URL」「補足コメント（省略可）」の順で入力し、動画と動画の間は空行で区切ってください。",
  videoGroup:
    "グループごとに「グループ名」「ラベル：URL」を入力し、空行で区切ってください（複数行のラベル：URLも入力できます）。",
};

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${days[d.getDay()]}）`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Firestoreはundefinedを保存できないため、書き込み直前にJSONの往復で取り除く
// （空文字や空配列は残るが、undefinedのキーだけが落ちる）。
function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ---- ブロック ⇔ テキスト（ブロック編集フォームで使う） ----

function blockToLines(b: KeikoNoteBlock): string {
  if (b.type === "text" || b.type === "section") return b.text || "";
  if (b.type === "bullets") return (b.items || []).join("\n");
  if (b.type === "tools") return (b.items || []).map((i) => `${i.name}：${i.desc}`).join("\n");
  if (b.type === "toriawase") return (b.items || []).map((i) => `${i.label}：${i.value}`).join("\n");
  if (b.type === "link") return `${b.label || ""}\n${b.url || ""}`;
  if (b.type === "videos")
    return (b.items || []).map((v) => [v.label, v.url, v.caption].filter((x) => x).join("\n")).join("\n\n");
  if (b.type === "videoGroup")
    return (b.groups || [])
      .map((g) => {
        const lines: string[] = [];
        if (g.title) lines.push(g.title);
        if (g.note) lines.push(g.note);
        (g.variants || []).forEach((v) => lines.push(`${v.label}：${v.url}`));
        return lines.join("\n");
      })
      .join("\n\n");
  return "";
}

function linesToBlock(type: KeikoNoteBlockType, title: string, raw: string): KeikoNoteBlock {
  const trimmedTitle = (title || "").trim();
  if (type === "text") return { type: "text", text: raw };
  if (type === "section") return { type: "section", title: trimmedTitle, text: raw };
  if (type === "bullets") {
    const items = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    return { type: "bullets", title: trimmedTitle || undefined, items };
  }
  if (type === "tools") {
    const items = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf("：");
        return idx === -1
          ? { name: line, desc: "" }
          : { name: line.slice(0, idx).trim(), desc: line.slice(idx + 1).trim() };
      });
    return { type: "tools", title: trimmedTitle || undefined, items };
  }
  if (type === "toriawase") {
    const items = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf("：");
        return idx === -1
          ? { label: line, value: "" }
          : { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
      });
    return { type: "toriawase", title: trimmedTitle || undefined, items };
  }
  if (type === "link") {
    const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    return { type: "link", label: lines[0] || "", url: lines[1] || "" };
  }
  if (type === "videos") {
    const groups = raw.split(/\n\s*\n/).map((g) => g.trim()).filter(Boolean);
    const items = groups.map((g) => {
      const lines = g.split("\n").map((s) => s.trim()).filter(Boolean);
      return { label: lines[0] || "", url: lines[1] || "", caption: lines[2] || "" };
    });
    return { type: "videos", title: trimmedTitle || undefined, items };
  }
  // videoGroup
  const chunks = raw.split(/\n\s*\n/).map((g) => g.trim()).filter(Boolean);
  const groups = chunks.map((chunk) => {
    const lines = chunk.split("\n").map((s) => s.trim()).filter(Boolean);
    let gTitle = "";
    let gNote = "";
    const variants: { label: string; url: string }[] = [];
    lines.forEach((line) => {
      const idx = line.indexOf("：");
      if (idx !== -1 && /^https?:\/\//.test(line.slice(idx + 1).trim())) {
        variants.push({ label: line.slice(0, idx).trim(), url: line.slice(idx + 1).trim() });
      } else if (!gTitle) {
        gTitle = line;
      } else {
        gNote = line;
      }
    });
    return { title: gTitle || undefined, note: gNote || undefined, variants };
  });
  return { type: "videoGroup", title: trimmedTitle || undefined, groups };
}

function getToriawaseValue(items: KeikoNoteToriawaseItem[] | undefined, label: string): string {
  return items?.find((t) => t.label === label)?.value ?? "";
}

// ---- 表示用の部品 ----

function VideoCard({ video }: { video: KeikoNoteVideo }) {
  return (
    <div className="video-card">
      <a className="video-card-link" href={video.url} target="_blank" rel="noopener noreferrer">
        <div className="video-play" />
        <div className="video-label">{video.label}</div>
      </a>
      {video.caption && <p className="video-caption">{video.caption}</p>}
    </div>
  );
}

function ToriawaseBlock({ items, title }: { items?: KeikoNoteToriawaseItem[]; title?: string }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <div className="field-label">{title || "取り合わせ"}</div>
      <div className="toriawase">
        {items.map((it, i) => (
          <div className="toriawase-row" key={i}>
            <div className="t-label">{it.label}</div>
            <div className="t-value">{it.value}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function Paragraphs({ text }: { text: string }) {
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
  return (
    <>
      {paras.map((p, i) => (
        <p className="content-para" key={i}>
          {p}
        </p>
      ))}
    </>
  );
}

function VideoList({ items }: { items: KeikoNoteVideo[] }) {
  return (
    <>
      {items.map((v, i) => (
        <div key={i}>
          <VideoCard video={v} />
          {i < items.length - 1 && <div style={{ height: 10 }} />}
        </div>
      ))}
    </>
  );
}

function BlocksView({ blocks }: { blocks: KeikoNoteBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") {
          return (
            <div className="block" key={i}>
              <Paragraphs text={b.text} />
            </div>
          );
        }
        if (b.type === "section") {
          return (
            <div className="block" key={i}>
              <p className="block-title">{b.title}</p>
              <Paragraphs text={b.text} />
            </div>
          );
        }
        if (b.type === "toriawase") {
          return (
            <div className="block" key={i}>
              <ToriawaseBlock items={b.items} title={b.title} />
            </div>
          );
        }
        if (b.type === "bullets") {
          return (
            <div className="block" key={i}>
              {b.title && <p className="block-title">{b.title}</p>}
              <ul className="bullets">
                {b.items.map((it, j) => (
                  <li key={j}>{it}</li>
                ))}
              </ul>
            </div>
          );
        }
        if (b.type === "tools") {
          return (
            <div className="block" key={i}>
              {b.title && <p className="block-title">{b.title}</p>}
              <div className="tools-list">
                {b.items.map((it, j) => (
                  <div className="tools-row" key={j}>
                    <div className="tool-name">{it.name}</div>
                    <div className="tool-desc">{it.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (b.type === "link") {
          return (
            <div className="block" key={i}>
              <a className="link-row" href={b.url} target="_blank" rel="noopener noreferrer">
                <div className="link-icon" />
                <div className="link-label">{b.label}</div>
              </a>
            </div>
          );
        }
        if (b.type === "videos") {
          return (
            <div className="block" key={i}>
              <p className={`block-title ${b.emphasize ? "warn" : ""}`}>
                {b.emphasize ? "⚠️ " : ""}
                {b.title}
              </p>
              <VideoList items={b.items} />
            </div>
          );
        }
        if (b.type === "videoGroup") {
          return (
            <div className="block" key={i}>
              {b.title && <p className="block-title">{b.title}</p>}
              {b.groups.map((g, j) => (
                <div className="video-group-item" key={j}>
                  {g.title && <p className="vgi-title">{g.title}</p>}
                  {g.note && <p className="vgi-note">{g.note}</p>}
                  <div className={`vgi-variants ${g.variants.length <= 2 ? "inline" : ""}`}>
                    {g.variants.map((v, k) => (
                      <a href={v.url} target="_blank" rel="noopener noreferrer" key={k}>
                        {v.label}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

function EntryItem({
  entry,
  open,
  onToggle,
  showActions,
  onEdit,
  onDelete,
}: {
  entry: KeikoNoteEntry;
  open: boolean;
  onToggle: () => void;
  showActions: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`entry ${open ? "open" : ""}`}>
      <div className="entry-head" onClick={onToggle}>
        <div className="bar" />
        <div className="date-block">
          <div className="date-main">{fmtDate(entry.date)}</div>
          <div className="date-meta">
            {entry.teacher && (
              <span className="teacher-chip">
                <span className="seal">講</span>
                {entry.teacher}
              </span>
            )}
            {entry.title ? (
              <span className="entry-title">{entry.title}</span>
            ) : entry.topic ? (
              <span>{entry.topic}</span>
            ) : null}
          </div>
        </div>
        <div className="chevron" />
      </div>
      <div className="entry-body">
        <div className="entry-body-inner">
          {entry.blocks ? (
            <BlocksView blocks={entry.blocks} />
          ) : (
            <>
              <ToriawaseBlock items={entry.toriawase} />
              {entry.content ? (
                <>
                  <div className="field-label">お稽古内容</div>
                  <Paragraphs text={entry.content} />
                </>
              ) : entry.topic ? (
                <>
                  <div className="field-label">お稽古の内容</div>
                  <div className="field-text">{entry.topic}</div>
                </>
              ) : null}
              {entry.tools && (
                <>
                  <div className="field-label">お道具</div>
                  <div className="field-text">{entry.tools}</div>
                </>
              )}
              {entry.notes && (
                <>
                  <div className="field-label">講師より</div>
                  <div className="field-text">{entry.notes}</div>
                </>
              )}
              {entry.videos && entry.videos.length > 0 ? (
                <>
                  <div className="field-label">動画</div>
                  <VideoList items={entry.videos} />
                </>
              ) : entry.video ? (
                <>
                  <div className="field-label">動画</div>
                  <VideoCard video={entry.video} />
                </>
              ) : null}
            </>
          )}
          {showActions && (
            <div className="entry-actions">
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onEdit();
                }}
              >
                編集する
              </button>
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDelete();
                }}
              >
                削除する
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- 動画の追加・削除・編集を行う共通パーツ（簡単フォーム／テンプレートで使う） ----
function VideoFieldsEditor({
  videos,
  setVideos,
}: {
  videos: KeikoNoteVideo[];
  setVideos: React.Dispatch<React.SetStateAction<KeikoNoteVideo[]>>;
}) {
  if (videos.length === 0) {
    return (
      <p className="video-caption" style={{ marginBottom: 10 }}>
        まだ動画が追加されていません。
      </p>
    );
  }
  return (
    <>
      {videos.map((v, i) => (
        <div className="form-panel" style={{ marginBottom: 12, padding: 14 }} key={i}>
          <div className="form-row">
            <label>動画{i + 1}のタイトル</label>
            <input
              type="text"
              value={v.label}
              onChange={(e) => setVideos((prev) => prev.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))}
              placeholder="例：風炉薄茶平点前（通し）"
            />
          </div>
          <div className="form-row">
            <label>動画{i + 1}のURL</label>
            <input
              type="text"
              value={v.url}
              onChange={(e) => setVideos((prev) => prev.map((x, idx) => (idx === i ? { ...x, url: e.target.value } : x)))}
              placeholder="https://..."
            />
          </div>
          <div className="form-row">
            <label>動画{i + 1}の補足コメント（任意）</label>
            <input
              type="text"
              value={v.caption ?? ""}
              onChange={(e) =>
                setVideos((prev) => prev.map((x, idx) => (idx === i ? { ...x, caption: e.target.value } : x)))
              }
              placeholder="例：20:15あたりからご覧ください"
            />
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setVideos((prev) => prev.filter((_, idx) => idx !== i))}
          >
            この動画を削除
          </button>
        </div>
      ))}
    </>
  );
}

// ---- 簡単フォーム ----
function SimpleForm({
  classes,
  initial,
  onCancel,
  onSave,
}: {
  classes: typeof KEIKO_NOTE_CLASSES;
  initial?: KeikoNoteEntry;
  onCancel: () => void;
  onSave: (entry: KeikoNoteEntry) => void;
}) {
  const [classId, setClassId] = useState(initial?.classId ?? classes[0].id);
  const [date, setDate] = useState(initial?.date ?? today());
  const [topic, setTopic] = useState(initial?.topic ?? "");
  const [toriawaseValues, setToriawaseValues] = useState<string[]>(
    TORIAWASE_LABELS.map((l) => getToriawaseValue(initial?.toriawase, l))
  );
  const [tools, setTools] = useState(initial?.tools ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [teacher, setTeacher] = useState(initial?.teacher ?? "");
  const [videos, setVideos] = useState<KeikoNoteVideo[]>(
    initial?.videos?.map((v) => ({ ...v })) ?? (initial?.video ? [{ ...initial.video }] : [])
  );

  function handleSave() {
    if (!date) return;
    const toriawase = TORIAWASE_LABELS.map((label, i) => ({ label, value: toriawaseValues[i].trim() })).filter(
      (t) => t.value
    );
    const cleanVideos = videos
      .filter((v) => v.url.trim())
      .map((v) => ({ label: v.label.trim() || "動画", url: v.url.trim(), caption: v.caption?.trim() }));

    onSave({
      id: initial?.id ?? `e${Date.now()}`,
      classId,
      date,
      topic: topic.trim(),
      tools: tools.trim(),
      notes: notes.trim(),
      teacher: teacher.trim(),
      toriawase,
      videos: cleanVideos,
    });
  }

  return (
    <div className="form-panel">
      <p className="form-title">{initial ? "お稽古の記録を編集" : "今日のお稽古を記録する"}</p>
      <div className="form-row">
        <label>クラス</label>
        <select value={classId} onChange={(e) => setClassId(e.target.value)}>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.main}（{c.sub}）
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>日付</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="form-row">
        <label>お稽古の内容（点前・科目など）</label>
        <input type="text" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="例：濃茶点前、唱和之式" />
      </div>
      <p className="form-title" style={{ marginTop: 22 }}>
        取り合わせ（会記）・任意
      </p>
      {TORIAWASE_LABELS.map((label, i) => (
        <div className="form-row" key={label}>
          <label>{label}</label>
          <input
            type="text"
            value={toriawaseValues[i]}
            onChange={(e) => setToriawaseValues((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
          />
        </div>
      ))}
      <div className="form-row">
        <label>お道具（任意）</label>
        <textarea value={tools} onChange={(e) => setTools(e.target.value)} placeholder="例：〇〇棚、△△釜" />
      </div>
      <p className="form-title" style={{ marginTop: 22 }}>
        動画・任意
      </p>
      <VideoFieldsEditor videos={videos} setVideos={setVideos} />
      <button
        type="button"
        className="add-btn"
        onClick={() => setVideos((prev) => [...prev, { label: "", url: "", caption: "" }])}
      >
        ＋ 動画を追加
      </button>
      <div className="form-row">
        <label>講師より（任意）</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="お稽古で伝えたいこと、次回への一言など" />
      </div>
      <div className="form-row">
        <label>講師名</label>
        <input type="text" value={teacher} onChange={(e) => setTeacher(e.target.value)} placeholder="例：〇〇先生" />
      </div>
      <div className="form-actions">
        <button className="btn-primary" onClick={handleSave}>
          保存する
        </button>
        <button className="btn-secondary" onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  );
}

// ---- ブロック編集フォーム ----
function BlockEditorForm({
  classes,
  entry,
  onCancel,
  onSave,
}: {
  classes: typeof KEIKO_NOTE_CLASSES;
  entry: KeikoNoteEntry;
  onCancel: () => void;
  onSave: (entry: KeikoNoteEntry) => void;
}) {
  const [classId, setClassId] = useState(entry.classId);
  const [date, setDate] = useState(entry.date);
  const [title, setTitle] = useState(entry.title ?? "");
  const [teacher, setTeacher] = useState(entry.teacher ?? "");
  const [blocks, setBlocks] = useState<{ type: KeikoNoteBlockType; title: string; content: string }[]>(
    (entry.blocks ?? []).map((b) => ({
      type: b.type,
      title: (b as { title?: string }).title ?? "",
      content: blockToLines(b),
    }))
  );
  const [newBlockType, setNewBlockType] = useState<KeikoNoteBlockType>("text");

  function handleSave() {
    if (!date) return;
    const finalBlocks = blocks.map((b) => linesToBlock(b.type, b.title, b.content));
    onSave({ ...entry, classId, date, title: title.trim(), teacher: teacher.trim(), blocks: finalBlocks });
  }

  return (
    <>
      <div className="form-panel">
        <p className="form-title">お稽古の記録を編集</p>
        <div className="form-row">
          <label>クラス</label>
          <select value={classId} onChange={(e) => setClassId(e.target.value)}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.main}（{c.sub}）
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>日付</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="form-row">
          <label>見出し（日付の下に表示・任意）</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="form-row">
          <label>講師名（任意）</label>
          <input type="text" value={teacher} onChange={(e) => setTeacher(e.target.value)} />
        </div>
      </div>

      {blocks.map((b, i) => (
        <div className="form-panel" style={{ marginBottom: 14, padding: 14 }} key={i}>
          <p className="form-title" style={{ marginBottom: 6 }}>
            {BLOCK_TYPE_LABELS[b.type]}
          </p>
          {(["section", "bullets", "tools", "videos", "videoGroup"] as KeikoNoteBlockType[]).includes(b.type) && (
            <div className="form-row">
              <label>見出し（任意）</label>
              <input
                type="text"
                value={b.title}
                onChange={(e) => setBlocks((prev) => prev.map((x, idx) => (idx === i ? { ...x, title: e.target.value } : x)))}
              />
            </div>
          )}
          <div className="form-row">
            <label style={{ fontWeight: 400, color: "var(--ink-soft)" }}>{BLOCK_TYPE_HINTS[b.type]}</label>
            <textarea
              style={{ minHeight: 110 }}
              value={b.content}
              onChange={(e) => setBlocks((prev) => prev.map((x, idx) => (idx === i ? { ...x, content: e.target.value } : x)))}
            />
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setBlocks((prev) => prev.filter((_, idx) => idx !== i))}
          >
            この項目を削除
          </button>
        </div>
      ))}

      <div className="form-panel" style={{ marginBottom: 14, padding: 14 }}>
        <p className="form-title" style={{ marginBottom: 8 }}>
          項目を追加
        </p>
        <div className="form-row">
          <select value={newBlockType} onChange={(e) => setNewBlockType(e.target.value as KeikoNoteBlockType)}>
            {(Object.keys(BLOCK_TYPE_LABELS) as KeikoNoteBlockType[]).map((t) => (
              <option key={t} value={t}>
                {BLOCK_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setBlocks((prev) => [...prev, { type: newBlockType, title: "", content: "" }])}
        >
          ＋ この種類の項目を追加
        </button>
      </div>

      <div className="form-actions">
        <button className="btn-primary" onClick={handleSave}>
          保存する
        </button>
        <button className="btn-secondary" onClick={onCancel}>
          やめる
        </button>
      </div>
    </>
  );
}

// ---- テンプレートフォーム（写真・動画リンク／午前・午後） ----
function TemplateForm({
  classes,
  onCancel,
  onSave,
}: {
  classes: typeof KEIKO_NOTE_CLASSES;
  onCancel: () => void;
  onSave: (entry: KeikoNoteEntry) => void;
}) {
  const [classId, setClassId] = useState(classes[0].id);
  const [date, setDate] = useState(today());
  const [title, setTitle] = useState("");
  const [teacher, setTeacher] = useState("");
  const [toriawaseValues, setToriawaseValues] = useState<string[]>(TORIAWASE_LABELS.map(() => ""));
  const [photoUrl, setPhotoUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [amPrep, setAmPrep] = useState("");
  const [amContent, setAmContent] = useState("");
  const [amVideos, setAmVideos] = useState<KeikoNoteVideo[]>([]);
  const [pmContent, setPmContent] = useState("");
  const [pmVideos, setPmVideos] = useState<KeikoNoteVideo[]>([]);
  const [pmCleanup, setPmCleanup] = useState("");

  function buildHalfBlocks(prepText: string, contentText: string, videoList: KeikoNoteVideo[]): KeikoNoteBlock[] {
    const blocks: KeikoNoteBlock[] = [];
    const prepItems = prepText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (prepItems.length) blocks.push({ type: "bullets", title: "準備", items: prepItems });
    if (contentText.trim()) blocks.push({ type: "text", text: contentText.trim() });
    const videos = videoList
      .filter((v) => v.url.trim())
      .map((v) => ({ label: v.label.trim() || "動画", url: v.url.trim(), caption: v.caption?.trim() }));
    if (videos.length) blocks.push({ type: "videos", title: "おすすめ動画", items: videos });
    return blocks;
  }

  function buildPmBlocks(contentText: string, videoList: KeikoNoteVideo[], cleanupText: string): KeikoNoteBlock[] {
    const blocks: KeikoNoteBlock[] = [];
    if (contentText.trim()) blocks.push({ type: "text", text: contentText.trim() });
    const videos = videoList
      .filter((v) => v.url.trim())
      .map((v) => ({ label: v.label.trim() || "動画", url: v.url.trim(), caption: v.caption?.trim() }));
    if (videos.length) blocks.push({ type: "videos", title: "おすすめ動画", items: videos });
    const cleanupItems = cleanupText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (cleanupItems.length) blocks.push({ type: "bullets", title: "お片付け", items: cleanupItems });
    return blocks;
  }

  function handleSave() {
    if (!date) return;
    const toriawase = TORIAWASE_LABELS.map((label, i) => ({ label, value: toriawaseValues[i].trim() })).filter(
      (t) => t.value
    );
    const blocks: KeikoNoteBlock[] = [];
    if (toriawase.length) blocks.push({ type: "toriawase", items: toriawase });
    if (photoUrl.trim()) blocks.push({ type: "link", label: "写真", url: photoUrl.trim() });
    if (videoUrl.trim()) blocks.push({ type: "link", label: "動画", url: videoUrl.trim() });

    const amBlocks = buildHalfBlocks(amPrep, amContent, amVideos);
    if (amBlocks.length) {
      blocks.push({ type: "text", text: "午前" });
      blocks.push(...amBlocks);
    }
    const pmBlocks = buildPmBlocks(pmContent, pmVideos, pmCleanup);
    if (pmBlocks.length) {
      blocks.push({ type: "text", text: "午後" });
      blocks.push(...pmBlocks);
    }

    onSave({
      id: `e${Date.now()}`,
      classId,
      date,
      title: title.trim(),
      teacher: teacher.trim(),
      blocks,
    });
  }

  return (
    <>
      <div className="form-panel">
        <p className="form-title">テンプレートで記録する</p>
        <div className="form-row">
          <label>クラス</label>
          <select value={classId} onChange={(e) => setClassId(e.target.value)}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.main}（{c.sub}）
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>日付</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="form-row">
          <label>見出し（日付の下に表示・任意）</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：お稽古振り返り" />
        </div>
        <div className="form-row">
          <label>講師名（任意）</label>
          <input type="text" value={teacher} onChange={(e) => setTeacher(e.target.value)} />
        </div>
        <p className="form-title" style={{ marginTop: 22 }}>
          取り合わせ・任意
        </p>
        {TORIAWASE_LABELS.map((label, i) => (
          <div className="form-row" key={label}>
            <label>{label}</label>
            <input
              type="text"
              value={toriawaseValues[i]}
              onChange={(e) => setToriawaseValues((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
            />
          </div>
        ))}
        <p className="form-title" style={{ marginTop: 22 }}>
          写真・動画リンク・任意
        </p>
        <div className="form-row">
          <label>写真に飛ぶリンク</label>
          <input type="text" value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://..." />
        </div>
        <div className="form-row">
          <label>動画に飛ぶリンク</label>
          <input type="text" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://..." />
        </div>
      </div>

      <div className="form-panel">
        <p className="form-title">午前</p>
        <div className="form-row">
          <label>準備（1行に1項目）</label>
          <textarea value={amPrep} onChange={(e) => setAmPrep(e.target.value)} placeholder="例：加藤さん：床の間に軸と花を掛ける…" />
        </div>
        <div className="form-row">
          <label>お稽古内容</label>
          <textarea value={amContent} onChange={(e) => setAmContent(e.target.value)} />
        </div>
        <label style={{ fontSize: 12, fontWeight: 700, color: "var(--matcha)", display: "block", margin: "14px 0 6px" }}>
          おすすめ動画
        </label>
        <VideoFieldsEditor videos={amVideos} setVideos={setAmVideos} />
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setAmVideos((prev) => [...prev, { label: "", url: "", caption: "" }])}
        >
          ＋ 午前のおすすめ動画を追加
        </button>
      </div>

      <div className="form-panel">
        <p className="form-title">午後</p>
        <div className="form-row">
          <label>お稽古内容</label>
          <textarea value={pmContent} onChange={(e) => setPmContent(e.target.value)} />
        </div>
        <label style={{ fontSize: 12, fontWeight: 700, color: "var(--matcha)", display: "block", margin: "14px 0 6px" }}>
          おすすめ動画
        </label>
        <VideoFieldsEditor videos={pmVideos} setVideos={setPmVideos} />
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setPmVideos((prev) => [...prev, { label: "", url: "", caption: "" }])}
        >
          ＋ 午後のおすすめ動画を追加
        </button>
        <div className="form-row" style={{ marginTop: 18 }}>
          <label>片付け（1行に1項目）</label>
          <textarea value={pmCleanup} onChange={(e) => setPmCleanup(e.target.value)} placeholder="例：墨屋さん：火・釜を片付ける…" />
        </div>
      </div>

      <div className="form-actions">
        <button className="btn-primary" onClick={handleSave}>
          保存する
        </button>
        <button className="btn-secondary" onClick={onCancel}>
          やめる
        </button>
      </div>
    </>
  );
}

type FormState =
  | { kind: "simple"; entry?: KeikoNoteEntry }
  | { kind: "block"; entry: KeikoNoteEntry }
  | { kind: "template" }
  | null;

export default function KeikoNotePage() {
  const { role, loading } = useAuth();
  const canEdit = role === "honbu" || role === "staff";

  const [teacherMode, setTeacherMode] = useState(false);
  const [entries, setEntries] = useState<KeikoNoteEntry[]>([]);
  const [selectedClass, setSelectedClass] = useState(KEIKO_NOTE_CLASSES[0].id);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "keikoNoteEntries"), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<KeikoNoteEntry, "id">) }));
      list.sort((a, b) => b.date.localeCompare(a.date));
      setEntries(list);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!canEdit) setTeacherMode(false);
  }, [canEdit]);

  const visible = useMemo(() => entries.filter((e) => e.classId === selectedClass), [entries, selectedClass]);

  async function persistEntry(entry: KeikoNoteEntry) {
    try {
      await setDoc(doc(db, "keikoNoteEntries", entry.id), stripUndefined(entry));
      setForm(null);
      setStatusMsg("保存しました。");
    } catch (err) {
      console.error(err);
      setStatusMsg("保存に失敗しました。もう一度お試しください。");
    }
  }

  async function removeEntry(id: string) {
    if (!window.confirm("この記録を削除しますか？")) return;
    try {
      await deleteDoc(doc(db, "keikoNoteEntries", id));
    } catch (err) {
      console.error(err);
      setStatusMsg("削除に失敗しました。もう一度お試しください。");
    }
  }

  function startEdit(entry: KeikoNoteEntry) {
    setForm(entry.blocks ? { kind: "block", entry } : { kind: "simple", entry });
  }

  if (loading) return <div className="p-8 text-muted">確認中…</div>;

  const backHref =
    role === "member" ? "/mypage" : role === "staff" ? "/staff" : role === "honbu" ? "/admin" : null;

  return (
    <div className="keiko-note-page">
      <div className="wrap">
        {backHref && (
          <div style={{ marginBottom: 16 }}>
            <Link href={backHref} style={{ fontSize: 12, color: "var(--ink-soft)", textDecoration: "underline" }}>
              ← もどる
            </Link>
          </div>
        )}

        <header>
          <h1>茶道教室 お稽古ノート</h1>
          <p className="sub">クラスを選ぶと、その日のお稽古の内容がご覧いただけます。</p>
        </header>

        <div className="class-tabs">
          {KEIKO_NOTE_CLASSES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`class-tab ${c.id === selectedClass ? "active" : ""}`}
              onClick={() => {
                setSelectedClass(c.id);
                setOpenId(null);
              }}
            >
              <div className="ct-main">{c.main}</div>
              <div className="ct-sub">{c.sub}</div>
            </button>
          ))}
        </div>

        {canEdit && (
          <div className="mode-row">
            <span className="mode-label">講師として編集する</span>
            <button
              type="button"
              className={`toggle ${teacherMode ? "on" : ""}`}
              aria-pressed={teacherMode}
              onClick={() => {
                setTeacherMode((v) => !v);
                setForm(null);
              }}
            >
              <span className="knob" />
            </button>
          </div>
        )}

        {teacherMode && (
          <>
            <button type="button" className="add-btn" onClick={() => setForm({ kind: "simple" })}>
              ＋ 今日のお稽古を記録する（簡単フォーム）
            </button>
            <button type="button" className="add-btn" style={{ marginTop: 8 }} onClick={() => setForm({ kind: "template" })}>
              ＋ テンプレートで記録する（写真・動画リンク／午前・午後）
            </button>
          </>
        )}

        <div>
          {form?.kind === "simple" && (
            <SimpleForm classes={KEIKO_NOTE_CLASSES} initial={form.entry} onCancel={() => setForm(null)} onSave={persistEntry} />
          )}
          {form?.kind === "block" && (
            <BlockEditorForm classes={KEIKO_NOTE_CLASSES} entry={form.entry} onCancel={() => setForm(null)} onSave={persistEntry} />
          )}
          {form?.kind === "template" && (
            <TemplateForm classes={KEIKO_NOTE_CLASSES} onCancel={() => setForm(null)} onSave={persistEntry} />
          )}
        </div>

        <div>
          {visible.length === 0 ? (
            <div className="empty">
              まだ記録がありません。
              {teacherMode ? "上のボタンから、今日のお稽古を記録できます。" : "講師が記録すると、こちらに表示されます。"}
            </div>
          ) : (
            visible.map((e) => (
              <EntryItem
                key={e.id}
                entry={e}
                open={openId === e.id}
                onToggle={() => setOpenId((prev) => (prev === e.id ? null : e.id))}
                showActions={teacherMode}
                onEdit={() => startEdit(e)}
                onDelete={() => removeEntry(e.id)}
              />
            ))
          )}
        </div>

        {statusMsg && <div className="status">{statusMsg}</div>}
      </div>
    </div>
  );
}
