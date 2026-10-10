"use client";

import { useState } from "react";
import type { LineMessageLog } from "@/types";

type LogGroup = {
  key: string;
  sentAt: string;
  kind: LineMessageLog["kind"];
  sentBy?: string;
  message: string;
  recipients: string[];
};

const MAX_GROUPS = 30;
// 一斉送信は宛先ごとに1件ずつ記録されるため、同じ内容・送信者で近い時刻のものを1回の送信としてまとめる
const SAME_SEND_WINDOW_MS = 60 * 1000;

function groupLogs(logs: LineMessageLog[]): LogGroup[] {
  const groups: LogGroup[] = [];
  for (const log of logs) {
    const t = new Date(log.sentAt).getTime();
    const g = groups.find(
      (x) =>
        x.kind === log.kind &&
        x.message === log.message &&
        (x.sentBy ?? "") === (log.sentBy ?? "") &&
        Math.abs(new Date(x.sentAt).getTime() - t) <= SAME_SEND_WINDOW_MS
    );
    if (g) {
      if (log.memberName && !g.recipients.includes(log.memberName)) g.recipients.push(log.memberName);
    } else {
      groups.push({
        key: log.id,
        sentAt: log.sentAt,
        kind: log.kind,
        sentBy: log.sentBy,
        message: log.message,
        recipients: log.memberName ? [log.memberName] : [],
      });
    }
  }
  return groups.slice(0, MAX_GROUPS);
}

function subjectOf(message: string): string {
  const firstLine = message.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

function recipientsSummary(names: string[]): string {
  if (names.length === 0) return "—";
  if (names.length === 1) return names[0];
  return `${names[0]} ほか${names.length - 1}名`;
}

// initialCount：最初に表示する件数（未指定なら全件）。残りは下の「▼」で開いて表示する
export default function LineMessageLogList({ logs, initialCount }: { logs: LineMessageLog[]; initialCount?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (logs.length === 0) {
    return <p className="text-xs text-muted">まだ送信履歴がありません。</p>;
  }
  const groups = groupLogs(logs);
  const limit = initialCount ?? groups.length;
  const shown = expanded ? groups : groups.slice(0, limit);
  const hiddenCount = groups.length - limit;
  return (
    <div>
    <ul className="divide-y divide-line border border-line rounded">
      {shown.map((g) => (
        <li key={g.key}>
          <details className="group">
            <summary className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:bg-black/5">
              <span className="text-xs text-muted shrink-0">
                {new Date(g.sentAt).toLocaleString("ja-JP", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="text-xs border border-line rounded px-1.5 shrink-0">{g.kind}</span>
              <span className="font-medium flex-1 min-w-0 truncate">{subjectOf(g.message)}</span>
              <span className="text-xs text-muted shrink-0">宛先：{recipientsSummary(g.recipients)}</span>
              <span className="text-xs text-muted shrink-0 group-open:rotate-180 transition-transform">▼</span>
            </summary>
            <div className="px-3 pb-3 pt-1 text-sm bg-black/[0.02]">
              <dl className="text-xs text-muted mb-2 space-y-0.5">
                <div>送信日時：{new Date(g.sentAt).toLocaleString("ja-JP")}</div>
                <div>宛先（{g.recipients.length}名）：{g.recipients.join("、") || "—"}</div>
                {g.sentBy && <div>送信者：{g.sentBy}</div>}
              </dl>
              <p className="whitespace-pre-wrap break-words">{g.message}</p>
            </div>
          </details>
        </li>
      ))}
    </ul>
    {hiddenCount > 0 && (
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full mt-1 py-1.5 text-xs text-muted hover:bg-black/5 rounded flex items-center justify-center gap-1"
        aria-expanded={expanded}
      >
        <span className={`inline-block transition-transform ${expanded ? "rotate-180" : ""}`}>▼</span>
        {expanded ? "閉じる" : `過去の履歴をもっと見る（${hiddenCount}件）`}
      </button>
    )}
    </div>
  );
}
