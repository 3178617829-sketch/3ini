import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildMindMapGraph,
  layoutMindMap,
  type MindMapEdge,
  type MindMapGraph,
  type MindMapPoint,
} from "../features/notes/mindMap";
import { getNote } from "../features/notes/api";
import type { NoteMetadata } from "../features/notes/types";
import { getDisplayTitle } from "../features/notes/noteUtils";

interface MindMapProps {
  /** 全部笔记（含置顶信息）。 */
  notes: NoteMetadata[];
  /** 当前选中的笔记；画布上会高亮它和它的直接相邻节点。 */
  selectedId: string | null;
  /** 点某个节点时跳过去。 */
  onOpenNote: (id: string) => void;
}

/** 画布按这个尺寸算布局，再用 viewBox 缩放铺满容器——窗口拉伸时不用重排。 */
const CANVAS_W = 1100;
const CANVAS_H = 720;

/**
 * 双链网络图。
 *
 * 数据来源只有一处：笔记正文里的 `[[标题]]`。不引第三方图库，
 * 力导向在 `mindMap.ts` 里算完，这里只负责把点画成 SVG。
 *
 * 节点分两种：实心圆 = 真的有这篇笔记，虚线小圈 = 被引用但笔记还不存在，
 * 后者点不了（没有可跳的目标），但必须画出来——不然用户会以为链接没生效。
 */
export function MindMap({ notes, selectedId, onOpenNote }: MindMapProps) {
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  // 只读一次正文：笔记内容可能很多，但这里的用途只是抽 [[标题]]。
  // 已经读过的 id 记在 ref 里，切换选中笔记不会重复拉取。
  useEffect(() => {
    let cancelled = false;
    const pending = notes.filter(
      (note) => !loadedRef.current.has(note.id) && !note.id.startsWith("external:"),
    );
    if (pending.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const next: Record<string, string> = {};
      for (const note of pending) {
        try {
          const full = await getNote(note.id);
          next[note.id] = full.content ?? "";
          loadedRef.current.add(note.id);
        } catch {
          // 读不到的笔记按「没有链接」处理，不因为它整张图都画不出来
          next[note.id] = "";
          loadedRef.current.add(note.id);
        }
      }
      if (cancelled) return;
      setContents((prev) => ({ ...prev, ...next }));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [notes]);

  const graph: MindMapGraph = useMemo(
    () => buildMindMapGraph(notes, contents),
    [notes, contents],
  );

  const layout = useMemo(
    () => layoutMindMap(graph, CANVAS_W, CANVAS_H),
    [graph],
  );

  const pointById = useMemo(() => {
    const map = new Map<string, MindMapPoint>();
    for (const point of layout.points) map.set(point.id, point);
    return map;
  }, [layout]);

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set());
      if (!map.has(edge.target)) map.set(edge.target, new Set());
      map.get(edge.source)!.add(edge.target);
      map.get(edge.target)!.add(edge.source);
    }
    return map;
  }, [graph]);

  /** 高亮集合：鼠标悬停优先，否则用当前选中的笔记。 */
  const focusId = hoverId ?? selectedId;
  const focused = focusId ? new Set([focusId, ...(neighbours.get(focusId) ?? [])]) : null;

  const isEmpty = graph.nodes.length === 0;

  const edgeLines = graph.edges.map((edge: MindMapEdge, i) => {
    const a = pointById.get(edge.source);
    const b = pointById.get(edge.target);
    if (!a || !b) return null;
    const active = focused ? focused.has(edge.source) && focused.has(edge.target) : false;
    return (
      <line
        key={`${edge.source}-${edge.target}-${i}`}
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke="currentColor"
        strokeWidth={active ? 1.6 : 1}
        className={
          focused
            ? active
              ? "text-bamboo/70"
              : "text-ink-ghost/20"
            : "text-ink-ghost/35"
        }
        style={{ transition: "stroke-width 160ms ease" }}
      />
    );
  });

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 h-12 shrink-0 border-b border-paper-deep/20">
        <div className="flex items-baseline gap-3">
          <span className="text-[13px] font-display font-bold tracking-wide text-ink">
            思维图
          </span>
          <span className="text-[10px] font-mono tabular-nums text-ink-ghost">
            {graph.nodes.length} 个节点 · {graph.edges.length} 条连线
            {graph.danglingCount > 0 ? ` · ${graph.danglingCount} 处指向不存在的笔记` : ""}
          </span>
        </div>
        <div className="text-[10px] font-mono text-ink-ghost/70">
          正文里写 [[笔记标题]] 就会自动连起来
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[12px] text-ink-ghost bg-paper/40">
            正在读取笔记…
          </div>
        )}

        {isEmpty ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-10">
            <div className="text-[13px] text-ink-faint">还没有可连的笔记</div>
            <div className="text-[11px] text-ink-ghost leading-relaxed">
              在任意笔记正文里写 <span className="font-mono text-bamboo">[[另一篇的标题]]</span>
              ，两篇之间就会出现一条连线。
            </div>
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
            preserveAspectRatio="xMidYMid meet"
            className="w-full h-full animate-view-fade"
          >
            <g>{edgeLines}</g>
            <g>
              {graph.nodes.map((node) => {
                const point = pointById.get(node.id);
                if (!point) return null;
                const degree = node.degree;
                const radius = 8 + Math.min(Math.sqrt(degree) * 3.4, 13);
                const dim = focused ? !focused.has(node.id) : false;
                const isFocus = focusId === node.id;
                const label = node.label.length > 14 ? `${node.label.slice(0, 14)}…` : node.label;

                return (
                  <g
                    key={node.id}
                    transform={`translate(${point.x} ${point.y})`}
                    className={node.occupied ? "cursor-pointer" : "cursor-default"}
                    style={{ opacity: dim ? 0.32 : 1, transition: "opacity 160ms ease" }}
                    onMouseEnter={() => setHoverId(node.id)}
                    onMouseLeave={() => setHoverId((current) => (current === node.id ? null : current))}
                    onClick={() => {
                      if (node.occupied) onOpenNote(node.id);
                    }}
                  >
                    {isFocus && (
                      <circle
                        r={radius + 5}
                        className="fill-none stroke-bamboo/40"
                        strokeWidth="1.5"
                      />
                    )}
                    <circle
                      r={radius}
                      className={
                        node.occupied
                          ? isFocus
                            ? "fill-bamboo"
                            : "fill-bamboo/75 hover:fill-bamboo"
                          : "fill-paper-deep/40 stroke-ink-ghost/50"
                      }
                      strokeWidth={node.occupied ? 0 : 1.2}
                      strokeDasharray={node.occupied ? undefined : "3 3"}
                      style={{ transition: "fill 160ms ease" }}
                    />
                    <text
                      y={radius + 13}
                      textAnchor="middle"
                      className={`text-[11px] select-none ${
                        isFocus ? "fill-ink" : node.occupied ? "fill-ink-soft" : "fill-ink-ghost"
                      }`}
                      style={{ fontFamily: "inherit" }}
                    >
                      {label}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>

      <div className="flex items-center gap-4 px-6 h-9 shrink-0 border-t border-paper-deep/20 text-[10px] text-ink-ghost">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-bamboo/75" />
          有这篇笔记
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full border border-dashed border-ink-ghost/60" />
          被引用但还没建
        </span>
        <span className="ml-auto font-mono">
          圆越大，引用越多 · 只在当前视图里画 {graph.nodes.length} 个
        </span>
      </div>
    </div>
  );
}

export default MindMap;

/** 供调用方判断某篇笔记有没有被别人引用过（标题比对口径与图一致）。 */
export function countIncomingLinks(notes: NoteMetadata[], contents: Record<string, string>, id: string): number {
  const target = notes.find((note) => note.id === id);
  if (!target) return 0;
  const title = getDisplayTitle(target).replace(/\s+/g, "").toLowerCase();
  let count = 0;
  for (const [noteId, body] of Object.entries(contents)) {
    if (noteId === id) continue;
    const pattern = /\[\[([^[\]\n]{1,40})\]\]/g;
    for (const match of body.matchAll(pattern)) {
      if (match[1].replace(/\s+/g, "").toLowerCase() === title) count += 1;
    }
  }
  return count;
}
