import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearTrash,
  listTrash,
  purgeTrash,
  restoreTrash,
  TRASH_RETAIN_DAYS,
  type TrashEntry,
} from "../features/trash/api";
import { getErrorMessage } from "../features/notes/api";
import type { NoteMetadata } from "../features/notes/types";
import { formatShortDate, formatTime } from "../features/notes/noteUtils";

interface TrashViewProps {
  /** 返回笔记列表。恢复/清空后父组件收到通知，好让笔记列表刷新。 */
  onBack: () => void;
  /** 恢复成功时回调，提示「已恢复到哪个分类」。 */
  onRestored?: (note: NoteMetadata) => void;
}

type Pending = { kind: "purge"; id: string } | { kind: "clear" } | null;

/**
 * 最近删除（回收站）。
 *
 * 删除的笔记先进 `.huajian\trash\`，保留 `TRASH_RETAIN_DAYS` 天，到期由后端
 * 在启动/列举时清掉。这个页面只做三件事：看、恢复、彻底删。
 *
 * 恢复和彻底删都不可逆（一个覆盖风险为零但会多出一篇，一个直接没了），
 * 所以都走二次确认——确认条就长在那一行里面，不弹模态框，
 * 免得挡住了别的条目。
 */
export function TrashView({ onBack, onRestored }: TrashViewProps) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listTrash();
      setEntries(list);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) =>
      [entry.title, entry.preview, entry.category].join(" ").toLowerCase().includes(q),
    );
  }, [entries, query]);

  const handleRestore = async (entry: TrashEntry) => {
    setBusyId(entry.id);
    setError(null);
    try {
      await restoreTrash(entry.id);
      setEntries((prev) => prev.filter((item) => item.id !== entry.id));
      onRestored?.({
        id: entry.id,
        title: entry.title,
        fileName: entry.fileName,
        category: entry.category,
        createdAt: entry.createdAt,
        updatedAt: entry.deletedAt,
        wordCount: entry.wordCount,
        preview: entry.preview,
        pinned: false,
      });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handlePurge = async (entry: TrashEntry) => {
    setPending(null);
    setBusyId(entry.id);
    setError(null);
    try {
      await purgeTrash(entry.id);
      setEntries((prev) => prev.filter((item) => item.id !== entry.id));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleClearAll = async () => {
    setPending(null);
    setLoading(true);
    setError(null);
    try {
      await clearTrash();
      setEntries([]);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 h-12 shrink-0 border-b border-paper-deep/20">
        <div className="flex items-baseline gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-[12px] text-ink-faint hover:text-bamboo transition-colors cursor-pointer"
            title="返回笔记"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
            笔记
          </button>
          <span className="text-[13px] font-display font-bold tracking-wide text-ink">最近删除</span>
          <span className="text-[10px] font-mono tabular-nums text-ink-ghost">
            {entries.length} 篇 · 保留 {TRASH_RETAIN_DAYS} 天
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索已删除的笔记"
            className="w-[180px] h-7 px-2.5 rounded-lg bg-paper-warm/60 text-[11px] text-ink-soft placeholder:text-ink-ghost/70 outline-none focus:bg-paper-warm transition-colors"
          />
          {entries.length > 0 &&
            (pending?.kind === "clear" ? (
              <div className="flex items-center gap-1 animate-delete-confirm">
                <span className="text-[11px] text-red-400 whitespace-nowrap">清空全部？</span>
                <button
                  onClick={() => void handleClearAll()}
                  className="px-2 h-6 rounded-md text-[11px] text-cloud bg-red-400 hover:bg-red-500 transition-colors cursor-pointer whitespace-nowrap"
                >
                  清空
                </button>
                <button
                  onClick={() => setPending(null)}
                  className="px-2 h-6 rounded-md text-[11px] text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                onClick={() => setPending({ kind: "clear" })}
                className="px-2 h-6 rounded-md text-[11px] text-ink-ghost hover:text-red-400 hover:bg-danger-bg transition-colors cursor-pointer"
              >
                清空
              </button>
            ))}
        </div>
      </div>

      {error && (
        <div className="px-6 py-2 text-[11px] text-red-400 bg-danger-bg/40 shrink-0">{error}</div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[12px] text-ink-ghost">
            正在读取…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <div className="text-[13px] text-ink-faint">
              {entries.length === 0 ? "回收站是空的" : "没有匹配的条目"}
            </div>
            <div className="text-[11px] text-ink-ghost">
              {entries.length === 0
                ? "删掉的笔记会在这里待 30 天，过了才会真正消失。"
                : "换个关键词试试。"}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filtered.map((entry) => {
              const expired = entry.daysLeft <= 0;
              const confirming = pending?.kind === "purge" && pending.id === entry.id;
              return (
                <div
                  key={entry.id}
                  className="group rounded-xl border border-paper-deep/25 bg-paper-warm/35 hover:bg-paper-warm/70 transition-colors px-3.5 py-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-ink truncate">
                          {entry.title || entry.fileName}
                        </span>
                        {entry.category && (
                          <span className="shrink-0 rounded bg-bamboo-mist px-1.5 py-0.5 text-[9px] text-bamboo">
                            {entry.category}
                          </span>
                        )}
                        <span
                          className={`shrink-0 text-[9px] font-mono tabular-nums ${
                            expired ? "text-red-400" : "text-ink-ghost/80"
                          }`}
                        >
                          {expired ? "即将清理" : `还剩 ${entry.daysLeft} 天`}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-ink-faint truncate leading-relaxed">
                        {entry.preview || "（无内容）"}
                      </div>
                      <div className="mt-1 text-[10px] text-ink-ghost font-mono tabular-nums">
                        删除于 {formatShortDate(entry.deletedAt)} {formatTime(entry.deletedAt)}
                        {" · "}
                        {entry.wordCount} 字
                      </div>
                    </div>

                    <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {confirming ? (
                        <>
                          <span className="text-[11px] text-red-400 whitespace-nowrap">彻底删掉？</span>
                          <button
                            onClick={() => void handlePurge(entry)}
                            className="px-2 h-6 rounded-md text-[11px] text-cloud bg-red-400 hover:bg-red-500 transition-colors cursor-pointer whitespace-nowrap"
                          >
                            删除
                          </button>
                          <button
                            onClick={() => setPending(null)}
                            className="px-2 h-6 rounded-md text-[11px] text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => void handleRestore(entry)}
                            disabled={busyId === entry.id}
                            className="px-2 h-6 rounded-md text-[11px] text-bamboo hover:bg-bamboo-mist transition-colors cursor-pointer disabled:opacity-40"
                          >
                            恢复
                          </button>
                          <button
                            onClick={() => setPending({ kind: "purge", id: entry.id })}
                            disabled={busyId === entry.id}
                            className="px-2 h-6 rounded-md text-[11px] text-ink-ghost hover:text-red-400 hover:bg-danger-bg transition-colors cursor-pointer disabled:opacity-40"
                          >
                            彻底删除
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center px-6 h-9 shrink-0 border-t border-paper-deep/20 text-[10px] text-ink-ghost">
        恢复时同名会自动加序号，不会覆盖现有笔记。
      </div>
    </div>
  );
}

export default TrashView;
