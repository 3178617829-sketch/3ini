import { useCallback, useEffect, useMemo, useState } from "react";
import { getNote } from "../features/notes/api";
import type { NoteMetadata } from "../features/notes/types";
import {
  formatShortDate,
  formatTime,
  getDisplayTitle,
  groupNotesByCategory,
} from "../features/notes/noteUtils";
import { MindMap } from "./MindMap";

interface KnowledgeViewProps {
  /** 全部笔记的元信息。 */
  notes: NoteMetadata[];
  /** 已知分类（用于把空分类也摆出来）。 */
  categories: string[];
  /** 当前选中的笔记，用于高亮。 */
  selectedId: string | null;
  onBack: () => void;
  onOpenNote: (id: string) => void;
}

type KnowledgeTab = "cards" | "graph";

interface TagHit {
  tag: string;
  count: number;
}

/** 从正文里抓 #标签。中文、字母、数字、下划线都算，1–20 个字符。 */
const TAG_PATTERN = /(^|[\s，。、；：！？,.;:!?（(\[【])#([\p{L}\p{N}_]{1,20})/gu;

function extractTags(content: string): string[] {
  const tags: string[] = [];
  for (const match of content.matchAll(TAG_PATTERN)) {
    if (match[2]) tags.push(match[2]);
  }
  return tags;
}

/**
 * 知识库视图。
 *
 * 复用现有笔记，不另存一份数据：分类来自笔记本身的 `category`，
 * 标签来自正文里手写的 `#标签`，正文全文用来支持搜索定位。
 *
 * 分两块：「卡片」按分类铺开，点卡片开笔记；「关系」是 MindMap，
 * 把笔记之间的 `[[双链]]` 画成网络图。
 *
 * 正文是懒加载的：只在打开这个页面时读一遍，标签和搜索才有内容。
 * 笔记多了会慢一点，所以顶部明确显示进度，而不是让人对着空白页等。
 */
export function KnowledgeView({
  notes,
  categories,
  selectedId,
  onBack,
  onOpenNote,
}: KnowledgeViewProps) {
  const [tab, setTab] = useState<KnowledgeTab>("cards");
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const next: Record<string, string> = {};
      for (const note of notes) {
        try {
          const full = await getNote(note.id);
          next[note.id] = full.content ?? "";
        } catch {
          next[note.id] = "";
        }
      }
      if (cancelled) return;
      setContents(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [notes]);

  /** 每篇笔记的标签。 */
  const noteTags = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const note of notes) {
      map.set(note.id, extractTags(contents[note.id] ?? ""));
    }
    return map;
  }, [notes, contents]);

  /** 全局标签频次，用于左侧标签云（只列出现 ≥1 次的，按次数倒序）。 */
  const tagCloud: TagHit[] = useMemo(() => {
    const counter = new Map<string, number>();
    for (const tags of noteTags.values()) {
      for (const tag of tags) counter.set(tag, (counter.get(tag) ?? 0) + 1);
    }
    return [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 40);
  }, [noteTags]);

  const normalizedQuery = query.trim().toLowerCase();

  /** 命中搜索/筛选的笔记 id 集合；空值表示不筛。 */
  const matchedIds = useMemo(() => {
    if (!normalizedQuery && !activeTag && !activeCategory) return null;
    const hit = new Set<string>();
    for (const note of notes) {
      if (activeCategory !== null && (note.category || "") !== activeCategory) continue;
      if (activeTag && !(noteTags.get(note.id) ?? []).includes(activeTag)) continue;
      if (normalizedQuery) {
        const haystack = [
          getDisplayTitle(note),
          note.preview,
          note.fileName,
          contents[note.id] ?? "",
        ]
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(normalizedQuery)) continue;
      }
      hit.add(note.id);
    }
    return hit;
  }, [notes, contents, noteTags, normalizedQuery, activeTag, activeCategory]);

  const groups = useMemo(() => {
    const visible = matchedIds ? notes.filter((note) => matchedIds.has(note.id)) : notes;
    return groupNotesByCategory(visible, categories);
  }, [notes, categories, matchedIds]);

  /** 搜索时给命中片段做一段上下文，而不是只显示开头 80 字。 */
  const buildSnippet = useCallback(
    (noteId: string): string | null => {
      if (!normalizedQuery) return null;
      const body = (contents[noteId] ?? "").toLowerCase();
      if (!body) return null;
      const index = body.indexOf(normalizedQuery);
      if (index < 0) return null;
      const raw = contents[noteId] ?? "";
      const start = Math.max(0, index - 24);
      const end = Math.min(raw.length, index + normalizedQuery.length + 48);
      return `${start > 0 ? "…" : ""}${raw.slice(start, end).replace(/\s+/g, " ")}${end < raw.length ? "…" : ""}`;
    },
    [contents, normalizedQuery],
  );

  const totalMatched = groups.reduce((sum, group) => sum + group.notes.length, 0);
  const hasFilter = Boolean(normalizedQuery || activeTag || activeCategory);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 h-12 shrink-0 border-b border-paper-deep/20">
        <div className="flex items-center gap-3">
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
          <span className="text-[13px] font-display font-bold tracking-wide text-ink">知识库</span>
          <div className="flex items-center rounded-lg bg-paper-warm/60 p-0.5">
            {(
              [
                { key: "cards", label: "卡片" },
                { key: "graph", label: "关系" },
              ] as const
            ).map((item) => (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`px-2.5 h-6 rounded-md text-[11px] transition-colors cursor-pointer ${
                  tab === item.key
                    ? "bg-cloud text-ink shadow-sm"
                    : "text-ink-ghost hover:text-ink-faint"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono tabular-nums text-ink-ghost">
            {loading
              ? "正在读取正文…"
              : hasFilter
                ? `命中 ${totalMatched} / ${notes.length} 篇`
                : `${notes.length} 篇 · ${tagCloud.length} 个标签`}
          </span>
          {tab === "cards" && (
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题与正文"
              className="w-[180px] h-7 px-2.5 rounded-lg bg-paper-warm/60 text-[11px] text-ink-soft placeholder:text-ink-ghost/70 outline-none focus:bg-paper-warm transition-colors"
            />
          )}
        </div>
      </div>

      {tab === "graph" ? (
        <MindMap notes={notes} selectedId={selectedId} onOpenNote={onOpenNote} />
      ) : (
        <div className="flex-1 flex min-h-0">
          {(tagCloud.length > 0 || categories.length > 0) && (
            <div className="w-[168px] shrink-0 border-r border-paper-deep/20 overflow-y-auto px-3 py-3">
              {categories.length > 0 && (
                <div className="mb-4">
                  <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-ghost/70">
                    分类
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {categories.map((category) => (
                      <button
                        key={category}
                        onClick={() =>
                          setActiveCategory((current) => (current === category ? null : category))
                        }
                        className={`px-2 h-6 rounded-md text-[11px] transition-colors cursor-pointer ${
                          activeCategory === category
                            ? "bg-bamboo text-cloud"
                            : "text-ink-faint hover:bg-paper-warm"
                        }`}
                      >
                        {category}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {tagCloud.length > 0 && (
                <div>
                  <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-ghost/70">
                    标签
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {tagCloud.map((hit) => (
                      <button
                        key={hit.tag}
                        onClick={() => setActiveTag((current) => (current === hit.tag ? null : hit.tag))}
                        className={`px-2 h-6 rounded-md text-[11px] transition-colors cursor-pointer ${
                          activeTag === hit.tag
                            ? "bg-bamboo text-cloud"
                            : "text-ink-faint hover:bg-paper-warm"
                        }`}
                        title={`${hit.count} 篇带这个标签`}
                      >
                        #{hit.tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {hasFilter && (
                <button
                  onClick={() => {
                    setQuery("");
                    setActiveTag(null);
                    setActiveCategory(null);
                  }}
                  className="mt-4 text-[11px] text-ink-ghost hover:text-bamboo transition-colors cursor-pointer"
                >
                  清除筛选
                </button>
              )}
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
            {groups.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2">
                <div className="text-[13px] text-ink-faint">
                  {notes.length === 0 ? "还没有笔记" : "没有匹配的笔记"}
                </div>
                {notes.length > 0 && (
                  <div className="text-[11px] text-ink-ghost">换个关键词或点掉筛选试试。</div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {groups.map((group) => (
                  <div key={group.category || "__none__"}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-mono text-[9px] uppercase tracking-widest text-ink-ghost/70">
                        {group.category || "未分类"}
                      </span>
                      <span className="font-mono text-[9px] tabular-nums text-ink-ghost/50">
                        {group.notes.length}
                      </span>
                      <div className="flex-1 h-px bg-paper-deep/20" />
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
                      {group.notes.map((note) => {
                        const tags = noteTags.get(note.id) ?? [];
                        const snippet = buildSnippet(note.id);
                        const isActive = selectedId === note.id;
                        return (
                          <button
                            key={note.id}
                            onClick={() => onOpenNote(note.id)}
                            className={`text-left rounded-xl border px-3 py-2.5 transition-all cursor-pointer ${
                              isActive
                                ? "border-bamboo/40 bg-bamboo-mist/40"
                                : "border-paper-deep/25 bg-paper-warm/35 hover:bg-paper-warm/70 hover:border-paper-deep/40"
                            }`}
                          >
                            <div className="flex items-start gap-1.5">
                              {note.pinned && (
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 24 24"
                                  fill="currentColor"
                                  className="mt-1 shrink-0 text-bamboo/70"
                                >
                                  <path d="M16 3v9l3 3v2h-6v6l-1 1-1-1v-6H5v-2l3-3V3h8z" />
                                </svg>
                              )}
                              <span className="text-[12px] text-ink leading-snug line-clamp-2">
                                {getDisplayTitle(note)}
                              </span>
                            </div>
                            <div className="mt-1 text-[10.5px] text-ink-faint leading-relaxed line-clamp-2">
                              {snippet ?? note.preview ?? "（无内容）"}
                            </div>
                            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                              <span className="font-mono text-[9px] tabular-nums text-ink-ghost">
                                {formatShortDate(note.updatedAt)} {formatTime(note.updatedAt)}
                              </span>
                              <span className="font-mono text-[9px] tabular-nums text-ink-ghost/60">
                                {note.wordCount} 字
                              </span>
                              {tags.slice(0, 3).map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded bg-bamboo-mist px-1 py-0.5 text-[9px] text-bamboo/90"
                                >
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default KnowledgeView;
