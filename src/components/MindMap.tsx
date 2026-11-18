import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildMindMapGraph, type MindMapGraph } from "../features/notes/mindMap";
import { getNote } from "../features/notes/api";
import type { NoteMetadata } from "../features/notes/types";
import {
  CARD_COLORS,
  loadCanvas,
  saveCanvasSoon,
  writeCanvas,
  type CanvasDoc,
} from "../features/notes/canvas";
import { NoteNodeView, TextNodeView } from "./whiteboard/BoardNodes";
import { DoodleLayer } from "./whiteboard/Doodle";
import type { NoteNodeData, TextNodeData } from "./whiteboard/types";

interface MindMapProps {
  /** 全部笔记（含置顶信息）。 */
  notes: NoteMetadata[];
  /** 当前选中的笔记；画布上会高亮它和它的直接相邻节点。 */
  selectedId: string | null;
  /** 双击某个节点时跳过去。 */
  onOpenNote: (id: string) => void;
}

const NODE_TYPES = { note: NoteNodeView, text: TextNodeView };

/** 手绘的颜色和笔宽：黑色、比圆点略细，像铅笔不像马克笔。 */
const STROKE_COLOR = "#22201c";
const STROKE_WIDTH = 3.4;

/** 自动边（正文双链）走虚线，手动边走实线——一眼看得出哪条是自己拉的。 */
const AUTO_EDGE_STYLE = { stroke: "#a9bcaa", strokeWidth: 1.3, strokeDasharray: "4 4" };
const MANUAL_EDGE_STYLE = { stroke: "#7f9c7f", strokeWidth: 1.6 };

const TEXT_PREFIX = "text:";

/**
 * 笔记节点第一次出现在白板上时摆哪儿：全部堆在中间。
 *
 * 用黄金角 + 平方根半径铺成一小团，既不会完全重叠、
 * 又不会像力导向那样满屏散开——摆位是用户自己的事，程序只负责先给个能看的一堆。
 */
function defaultPosition(index: number): { x: number; y: number } {
  const angle = index * 2.39996;
  const ring = 44 + Math.sqrt(index) * 38;
  return { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring * 0.92 };
}

function buildNodes(options: {
  graph: MindMapGraph;
  doc: CanvasDoc;
  focusId: string | null;
  selectedId: string | null;
  neighbours: Map<string, Set<string>>;
  autoEditId: string | null;
  onCommitText: (id: string, text: string) => void;
}): Node[] {
  const { graph, doc, focusId, selectedId, neighbours, autoEditId, onCommitText } = options;
  // 变淡只在「自己点了某个节点」时发生；从列表带进来的 selectedId 只让那个节点实心，
  // 不然一进页面整版灰掉，看着像坏了
  const focused = focusId ? new Set([focusId, ...(neighbours.get(focusId) ?? [])]) : null;
  const nodes: Node[] = [];

  graph.nodes.forEach((node, index) => {
    const isFocused = focusId === node.id || selectedId === node.id;
    const data: NoteNodeData = {
      kind: "note",
      label: node.label,
      occupied: node.occupied,
      degree: node.degree,
      focus: isFocused,
      dim: focused ? !focused.has(node.id) : false,
    };
    nodes.push({
      id: node.id,
      type: "note",
      position: doc.positions[node.id] ?? defaultPosition(index),
      data,
      deletable: false,
      selected: isFocused,
    });
  });

  for (const text of doc.texts) {
    const id = `${TEXT_PREFIX}${text.id}`;
    const isFocused = focusId === id || selectedId === id;
    const data: TextNodeData = {
      kind: "text",
      text: text.text,
      color: text.color,
      autoEdit: autoEditId === id,
      onCommit: onCommitText,
    };
    nodes.push({
      id,
      type: "text",
      position: doc.positions[id] ?? { x: text.x, y: text.y },
      data,
      deletable: true,
      selected: isFocused,
    });
  }

  return nodes;
}

function buildEdges(graph: MindMapGraph, doc: CanvasDoc): Edge[] {
  const available = new Set(graph.nodes.map((node) => node.id));
  for (const text of doc.texts) available.add(`${TEXT_PREFIX}${text.id}`);

  const edges: Edge[] = [];

  for (const edge of graph.edges) {
    if (!available.has(edge.source) || !available.has(edge.target)) continue;
    edges.push({
      id: `auto:${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      style: AUTO_EDGE_STYLE,
      markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10, color: "#a9bcaa" },
      deletable: false,
      selectable: false,
    });
  }

  for (const edge of doc.edges) {
    if (!available.has(edge.source) || !available.has(edge.target)) continue;
    edges.push({
      id: `manual:${edge.id}`,
      source: edge.source,
      target: edge.target,
      style: MANUAL_EDGE_STYLE,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "#7f9c7f" },
      deletable: true,
    });
  }

  return edges;
}

/**
 * 思维图 → 可编辑白板。
 *
 * 笔记节点仍然来自正文里的 `[[标题]]`（跟以前一样自动连起来），
 * 但位置、手写卡片、手拉的线、涂鸦都归用户自己，存在 `<数据目录>\.huajian\canvas.json`。
 * 笔记本身不进这个文件——删掉画布最多丢掉摆位，丢不掉笔记。
 */
export function MindMap({ notes, selectedId, onOpenNote }: MindMapProps) {
  return (
    <ReactFlowProvider>
      <Whiteboard notes={notes} selectedId={selectedId} onOpenNote={onOpenNote} />
    </ReactFlowProvider>
  );
}

function Whiteboard({ notes, selectedId, onOpenNote }: MindMapProps) {
  const [contents, setContents] = useState<Record<string, string>>({});
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [autoEditId, setAutoEditId] = useState<string | null>(null);
  const [tool, setTool] = useState<"select" | "draw">("select");
  const [live, setLive] = useState<Array<[number, number]> | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const { screenToFlowPosition, fitView } = useReactFlow();
  const docRef = useRef<CanvasDoc | null>(null);
  const savedRef = useRef<string>("");
  const loadedNotesRef = useRef<Set<string>>(new Set());
  const didFitRef = useRef(false);
  const drawingRef = useRef(false);
  const draggingRef = useRef(false);
  const liveRef = useRef<Array<[number, number]> | null>(null);

  // 只读一次正文：这里的用途只是抽 [[标题]]，读过的 id 记在 ref 里不重复拉
  useEffect(() => {
    let cancelled = false;
    const pending = notes.filter(
      (note) => !loadedNotesRef.current.has(note.id) && !note.id.startsWith("external:"),
    );
    if (pending.length === 0) return;
    void (async () => {
      const next: Record<string, string> = {};
      for (const note of pending) {
        try {
          next[note.id] = (await getNote(note.id)).content ?? "";
        } catch {
          // 读不到的笔记按「没有链接」处理，不因为它让整张图都画不出来
          next[note.id] = "";
        }
        loadedNotesRef.current.add(note.id);
      }
      if (cancelled) return;
      setContents((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [notes]);

  // 画布文件只读一次
  useEffect(() => {
    void (async () => {
      const loaded = await loadCanvas();
      savedRef.current = JSON.stringify(loaded);
      setDoc(loaded);
    })();
  }, []);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  // 防抖落盘：拖节点时每帧都在改位置，但磁盘只该被写最后一次
  useEffect(() => {
    if (!doc) return;
    const serialized = JSON.stringify(doc);
    if (serialized === savedRef.current) return;
    savedRef.current = serialized;
    saveCanvasSoon(doc);
  }, [doc]);

  // 切走页面时把还没落盘的那点改动补上
  useEffect(
    () => () => {
      const current = docRef.current;
      if (current) void writeCanvas(current);
    },
    [],
  );

  const graph = useMemo(() => buildMindMapGraph(notes, contents), [notes, contents]);

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

  /** 文本卡片的提交：空内容就当这张卡片没存在过。 */
  const commitText = useCallback((id: string, text: string) => {
    const textId = id.startsWith(TEXT_PREFIX) ? id.slice(TEXT_PREFIX.length) : id;
    const value = text.trim();
    setDoc((prev) => {
      if (!prev) return prev;
      if (!value) return { ...prev, texts: prev.texts.filter((item) => item.id !== textId) };
      return {
        ...prev,
        texts: prev.texts.map((item) => (item.id === textId ? { ...item, text: value } : item)),
      };
    });
    setAutoEditId((current) => (current === id ? null : current));
  }, []);

  useEffect(() => {
    if (!doc) return;
    // 拖动中重建会把节点从用户手里弹开，等拖完（dragStop 里会再触发一次）再说
    if (draggingRef.current) return;
    setNodes(
      buildNodes({
        graph,
        doc,
        focusId,
        selectedId,
        neighbours,
        autoEditId,
        onCommitText: commitText,
      }),
    );
    setEdges(buildEdges(graph, doc));
  }, [doc, graph, focusId, selectedId, neighbours, autoEditId, commitText, setNodes, setEdges]);

  // 第一次有节点了就自动居中；之后不再打扰用户已经摆好的视图
  useEffect(() => {
    if (didFitRef.current || nodes.length === 0) return;
    didFitRef.current = true;
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.45, maxZoom: 1.15 });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [nodes.length, fitView]);

  // Esc 从画笔退回选择，避免「画完忘了切回去，点不动节点」
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTool("select");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleNodeDragStart = useCallback(() => {
    draggingRef.current = true;
  }, []);

  const handleNodeDragStop = useCallback((_event: unknown, node: Node) => {
    draggingRef.current = false;
    setDoc((prev) => {
      if (!prev) return prev;
      if (node.id.startsWith(TEXT_PREFIX)) {
        const textId = node.id.slice(TEXT_PREFIX.length);
        return {
          ...prev,
          texts: prev.texts.map((item) =>
            item.id === textId ? { ...item, x: node.position.x, y: node.position.y } : item,
          ),
        };
      }
      return {
        ...prev,
        positions: { ...prev.positions, [node.id]: { x: node.position.x, y: node.position.y } },
      };
    });
  }, []);

  const handleConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target || source === target) return;
      // 正文双链已经连上的，不重复画一条；反向也允许，白板上箭头有方向
      if (graph.edges.some((edge) => edge.source === source && edge.target === target)) return;
      setDoc((prev) => {
        if (!prev) return prev;
        if (prev.edges.some((edge) => edge.source === source && edge.target === target)) return prev;
        return {
          ...prev,
          edges: [...prev.edges, { id: `${source}=>${target}=${Date.now().toString(36)}`, source, target }],
        };
      });
    },
    [graph],
  );

  const handleNodesDelete = useCallback((deleted: Node[]) => {
    if (deleted.length === 0) return;
    setDoc((prev) => {
      if (!prev) return prev;
      const ids = new Set(deleted.map((node) => node.id));
      const texts = prev.texts.filter((item) => !ids.has(`${TEXT_PREFIX}${item.id}`));
      const positions = { ...prev.positions };
      for (const id of ids) delete positions[id];
      const edges = prev.edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target));
      return { ...prev, positions, texts, edges };
    });
  }, []);

  const handlePaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // 只认空白处；双击节点/卡片是另一套语义
      if (!(event.target as HTMLElement).classList.contains("react-flow__pane")) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              texts: [
                ...prev.texts,
                { id, text: "", color: CARD_COLORS[0], x: position.x, y: position.y },
              ],
            }
          : prev,
      );
      setAutoEditId(`${TEXT_PREFIX}${id}`);
    },
    [screenToFlowPosition],
  );

  const handleNodeClick = useCallback((_event: unknown, node: Node) => {
    setFocusId(node.id);
  }, []);

  const handleNodeDoubleClick = useCallback(
    (_event: unknown, node: Node) => {
      if (node.id.startsWith(TEXT_PREFIX)) return;
      const data = node.data as NoteNodeData;
      if (data.occupied) onOpenNote(node.id);
    },
    [onOpenNote],
  );

  const applyColor = useCallback(
    (color: string) => {
      if (!focusId || !focusId.startsWith(TEXT_PREFIX)) return;
      const textId = focusId.slice(TEXT_PREFIX.length);
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              texts: prev.texts.map((item) => (item.id === textId ? { ...item, color } : item)),
            }
          : prev,
      );
    },
    [focusId],
  );

  const clearStrokes = useCallback(() => {
    setDoc((prev) => (prev ? { ...prev, strokes: [] } : prev));
  }, []);

  const startDraw = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drawingRef.current = true;
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const first: Array<[number, number]> = [[point.x, point.y]];
      liveRef.current = first;
      setLive(first);
    },
    [screenToFlowPosition],
  );

  const moveDraw = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drawingRef.current) return;
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const next = [...(liveRef.current ?? []), [point.x, point.y] as [number, number]];
      liveRef.current = next;
      setLive(next);
    },
    [screenToFlowPosition],
  );

  const endDraw = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const points = liveRef.current;
    liveRef.current = null;
    setLive(null);
    if (!points || points.length < 2) return;
    setDoc((prev) =>
      prev
        ? {
            ...prev,
            strokes: [...prev.strokes, { color: STROKE_COLOR, width: STROKE_WIDTH, points }],
          }
        : prev,
    );
  }, []);

  const strokeCount = doc?.strokes.length ?? 0;
  const isEmpty =
    graph.nodes.length === 0 && (doc?.texts.length ?? 0) === 0 && strokeCount === 0;
  const isTextSelected = Boolean(focusId && focusId.startsWith(TEXT_PREFIX));

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 h-12 shrink-0 border-b border-paper-deep/20">
        <div className="flex items-baseline gap-3">
          <span className="text-[13px] font-display font-bold tracking-wide text-ink">思维图</span>
          <span className="text-[10px] font-mono tabular-nums text-ink-ghost">
            {graph.nodes.length} 个节点 · {edges.length} 条连线 · {strokeCount} 笔涂鸦
            {graph.danglingCount > 0
              ? ` · ${graph.danglingCount} 处指向不存在的笔记`
              : ""}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {isTextSelected &&
            CARD_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label="换卡片底色"
                onClick={() => applyColor(color)}
                className="h-4 w-4 rounded-full border border-ink-ghost/30 transition-transform hover:scale-110"
                style={{ background: color }}
              />
            ))}
          {isTextSelected && <span className="mx-1 h-4 w-px bg-paper-deep/40" />}

          <ToolButton active={tool === "select"} onClick={() => setTool("select")}>
            选择
          </ToolButton>
          <ToolButton active={tool === "draw"} onClick={() => setTool("draw")}>
            画笔
          </ToolButton>
          <ToolButton onClick={() => void fitView({ padding: 0.45, maxZoom: 1.15 })}>
            居中
          </ToolButton>
          {strokeCount > 0 && <ToolButton onClick={clearStrokes}>擦涂鸦</ToolButton>}
        </div>
      </div>

      <div className="flex-1 min-h-0 relative" onDoubleClick={handlePaneDoubleClick}>
        {doc === null && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[12px] text-ink-ghost">
            正在打开白板…
          </div>
        )}

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={handleNodeDragStop}
          onConnect={handleConnect}
          onNodesDelete={handleNodesDelete}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeDragStart={handleNodeDragStart}
          onPaneClick={() => setFocusId(null)}
          nodeTypes={NODE_TYPES}
          connectionMode={ConnectionMode.Loose}
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={2.5}
          panOnDrag={tool === "select"}
          nodesDraggable={tool === "select"}
          elementsSelectable={tool === "select"}
          deleteKeyCode={["Delete"]}
          proOptions={{ hideAttribution: true }}
          className="bg-paper"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#cfc7b6" />
          <Controls showInteractive={false} className="!bottom-3 !left-3" />
          {doc && (
            <DoodleLayer
              strokes={doc.strokes}
              live={live}
              liveColor={STROKE_COLOR}
              liveWidth={STROKE_WIDTH}
            />
          )}
        </ReactFlow>

        {tool === "draw" && (
          <div
            className="absolute inset-0 z-30 cursor-crosshair"
            onPointerDown={startDraw}
            onPointerMove={moveDraw}
            onPointerUp={endDraw}
            onPointerCancel={endDraw}
          />
        )}

        {isEmpty && doc !== null && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-10 text-center">
            <div className="text-[13px] text-ink-faint">这块画布还是空的</div>
            <div className="text-[11px] leading-relaxed text-ink-ghost">
              双击空白写一张卡片，或者切到画笔随手画两笔。
              <br />
              笔记之间想连线，把鼠标移到圆点上，从右侧小圆点拖到另一个节点。
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 px-6 h-9 shrink-0 border-t border-paper-deep/20 text-[10px] text-ink-ghost">
        <span className="truncate">
          拖节点摆位置 · 从节点右侧小圆点拉线 · 双击空白写字 · 双击卡片改字 · 双击笔记节点打开
        </span>
        <span className="ml-auto shrink-0 font-mono">
          {tool === "draw" ? "画笔模式 · Esc 退回选择" : "滚轮缩放 · 拖空白平移"}
        </span>
      </div>
    </div>
  );
}

function ToolButton({
  active = false,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-6 rounded px-2 text-[11px] transition-colors ${
        active ? "bg-bamboo text-paper" : "text-ink-ghost hover:bg-paper-deep/25"
      }`}
    >
      {children}
    </button>
  );
}

export default MindMap;
