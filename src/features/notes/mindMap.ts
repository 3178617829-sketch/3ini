import type { NoteMetadata } from "./types";

/** 力导向迭代轮数。笔记数不多，70 节点 × 320 轮在浏览器里是毫秒级。 */
const ITERATIONS = 320;

/**
 * 从 `[[标题]]` 里抽出被引用的标题。
 *
 * 只认方括号里的 1–40 个非方括号非换行字符，和面板里 `MEMO_LINK_PATTERN`
 * 保持同一套规则——同一个概念在两处解析，规则一旦分叉就会出现
 * 「面板里能跳转、图上却没线」。
 */
export function extractWikiLinks(content: string): string[] {
  const pattern = /\[\[([^[\]\n]{1,40})\]\]/g;
  const found: string[] = [];
  for (const match of content.matchAll(pattern)) {
    const target = match[1].trim();
    if (target) found.push(target);
  }
  return found;
}

export interface MindMapNode {
  id: string;
  label: string;
  /** 连出去 + 被连进来的总条数，用来定圆的大小。 */
  degree: number;
  occupied: boolean;
}

export interface MindMapEdge {
  source: string;
  target: string;
}

export interface MindMapGraph {
  nodes: MindMapNode[];
  edges: MindMapEdge[];
  /** 正文里有 [[…]] 但找不到同名笔记的引用条数，用于提示。 */
  danglingCount: number;
}

/** 标题比对用的归一化：去空白、转小写。 */
function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * 把「笔记 + 每篇正文」拼成一张图。
 *
 * `contents` 是 id → 正文。凡是被 `[[标题]]` 指到、但库里没有同名笔记的，
 * 也算一个节点（`occupied: false`，画成虚线小圈）——否则一条指向未来笔记的
 * 链接在图上是彻底看不见的，用户会以为双链没写进去。
 *
 * 节点太多时只留关系最密的 MAX_NODES 个：力导向图一旦超过几十个点，
 * 线就会糊成一团，不如让人先看见主干。
 */
export function buildMindMapGraph(
  notes: NoteMetadata[],
  contents: Record<string, string>,
  maxNodes = 70,
): MindMapGraph {
  const byTitle = new Map<string, NoteMetadata>();
  for (const note of notes) {
    const title = (note.title || note.preview || "").trim();
    if (!title) continue;
    const key = normalizeTitle(title);
    if (!byTitle.has(key)) byTitle.set(key, note);
  }

  const nodeIds = new Map<string, { id: string; label: string; occupied: boolean }>();
  const degree = new Map<string, number>();
  const edges: MindMapEdge[] = [];
  const seenEdge = new Set<string>();
  let danglingCount = 0;

  for (const note of notes) {
    const title = (note.title || note.preview || "").trim();
    if (!title) continue;
    nodeIds.set(note.id, { id: note.id, label: title, occupied: true });
    if (!degree.has(note.id)) degree.set(note.id, 0);

    const links = extractWikiLinks(contents[note.id] ?? "");
    for (const link of links) {
      const targetNote = byTitle.get(normalizeTitle(link));
      const targetId = targetNote ? targetNote.id : `dangling:${normalizeTitle(link)}`;
      if (!targetNote) {
        danglingCount += 1;
        if (!nodeIds.has(targetId)) {
          nodeIds.set(targetId, { id: targetId, label: link, occupied: false });
        }
      }
      if (targetId === note.id) continue;
      const edgeKey = `${note.id}\u0000${targetId}`;
      if (seenEdge.has(edgeKey)) continue;
      seenEdge.add(edgeKey);
      edges.push({ source: note.id, target: targetId, });
      degree.set(note.id, (degree.get(note.id) ?? 0) + 1);
      degree.set(targetId, (degree.get(targetId) ?? 0) + 1);
    }
  }

  let nodeList: MindMapNode[] = [...nodeIds.values()].map((node) => ({
    ...node,
    degree: degree.get(node.id) ?? 0,
  }));

  if (nodeList.length > maxNodes) {
    nodeList = nodeList
      .slice()
      .sort((a, b) => b.degree - a.degree)
      .slice(0, maxNodes);
  }
  const kept = new Set(nodeList.map((node) => node.id));
  const keptEdges = edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));

  return { nodes: nodeList, edges: keptEdges, danglingCount };
}

export interface MindMapPoint {
  id: string;
  x: number;
  y: number;
}

export interface MindMapLayout {
  points: MindMapPoint[];
  width: number;
  height: number;
}

/**
 * 力导向布局。纯函数、无依赖：斥力 O(n²) + 弹簧吸引力 + 向心力，
 * 每轮降温。70 个节点 320 轮在毫秒量级，不需要 web-worker。
 *
 * 用标题的字符码做一个确定性的初始角度——同一份数据每次跑出来是同一张图，
 * 不会每打开一次就跳成另一个样子。
 */
export function layoutMindMap(
  graph: MindMapGraph,
  width: number,
  height: number,
  seed = 7,
): MindMapLayout {
  const count = graph.nodes.length;
  const cx = width / 2;
  const cy = height / 2;
  if (count === 0) return { points: [], width, height };

  const index = new Map<string, number>();
  graph.nodes.forEach((node, i) => index.set(node.id, i));

  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const radius0 = Math.min(width, height) * 0.34;

  graph.nodes.forEach((node, i) => {
    let hash = seed;
    for (const ch of node.id) hash = (hash * 31 + ch.codePointAt(0)!) % 100000;
    const angle = ((hash % 360) / 180) * Math.PI;
    const r = radius0 * (0.5 + ((hash % 97) / 97) * 0.6);
    xs[i] = cx + Math.cos(angle) * r;
    ys[i] = cy + Math.sin(angle) * r;
  });

  const area = width * height;
  const idealLength = Math.max(46, Math.sqrt(area / Math.max(count, 1)) * 0.55);
  const repulsion = idealLength * idealLength * 1.6;

  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    const cooling = 1 - iter / ITERATIONS;
    const dx = new Float64Array(count);
    const dy = new Float64Array(count);

    // 斥力：每一对节点互相推开
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let vx = xs[i] - xs[j];
        let vy = ys[i] - ys[j];
        let dist = Math.hypot(vx, vy);
        if (dist < 0.01) {
          // 完全重合时给一个确定性的小扰动，避免除零后位置变 NaN
          vx = (i % 3) - 1 + 0.5;
          vy = (j % 3) - 1 + 0.5;
          dist = Math.hypot(vx, vy) || 1;
        }
        const force = repulsion / (dist * dist);
        const fx = (vx / dist) * force;
        const fy = (vy / dist) * force;
        dx[i] += fx;
        dy[i] += fy;
        dx[j] -= fx;
        dy[j] -= fy;
      }
    }

    // 弹簧：有边的互相拉近
    for (const edge of graph.edges) {
      const a = index.get(edge.source);
      const b = index.get(edge.target);
      if (a === undefined || b === undefined) continue;
      const vx = xs[b] - xs[a];
      const vy = ys[b] - ys[a];
      const dist = Math.hypot(vx, vy) || 1;
      const force = (dist - idealLength) * 0.045;
      const fx = (vx / dist) * force;
      const fy = (vy / dist) * force;
      dx[a] += fx;
      dy[a] += fy;
      dx[b] -= fx;
      dy[b] -= fy;
    }

    // 向心力 + 位移上限，避免甩出画布
    const step = 26 * cooling + 1.5;
    for (let i = 0; i < count; i += 1) {
      dx[i] += (cx - xs[i]) * 0.012;
      dy[i] += (cy - ys[i]) * 0.012;
      const len = Math.hypot(dx[i], dy[i]);
      const scale = len > step ? step / len : 1;
      xs[i] += dx[i] * scale;
      ys[i] += dy[i] * scale;
    }
  }

  const margin = 42;
  const points: MindMapPoint[] = graph.nodes.map((node, i) => ({
    id: node.id,
    x: Math.min(width - margin, Math.max(margin, xs[i])),
    y: Math.min(height - margin, Math.max(margin, ys[i])),
  }));

  return { points, width, height };
}
