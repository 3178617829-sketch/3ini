import { getDataBaseDir, readExternalFile, saveExternalFile } from "./api";

/**
 * 白板（关系页的画布）的数据与落盘。
 *
 * 存的东西只有四种：节点摆在哪、手写的文本卡片、人拉的连线、手绘笔迹。
 * 笔记本身不存这里——笔记是笔记，画布只是它在白板上的位置。
 * 这样删掉画布文件最多丢掉摆位，不会动到一篇笔记。
 */

/** 一个节点在画布上的坐标。单位是 react-flow 的 flow 坐标（px），缩放时不变。 */
export interface CanvasPosition {
  x: number;
  y: number;
}

/** 手打的文本卡片：只活在画布上，不是笔记。 */
export interface CanvasTextNode {
  id: string;
  text: string;
  /** 卡片底色，取值见 CARD_COLORS。 */
  color: string;
  x: number;
  y: number;
}

/** 用户自己拉的连线。正文里 `[[标题]]` 生成的自动连线不存这里。 */
export interface CanvasManualEdge {
  id: string;
  source: string;
  target: string;
}

/** 一笔手写。points 是 flow 坐标，落盘时保留原精度。 */
export interface CanvasStroke {
  color: string;
  width: number;
  points: Array<[number, number]>;
}

export interface CanvasDoc {
  version: 1;
  /** 笔记/空节点 id → 位置。没记过的节点由界面自己摆到中间。 */
  positions: Record<string, CanvasPosition>;
  texts: CanvasTextNode[];
  edges: CanvasManualEdge[];
  strokes: CanvasStroke[];
}

export function emptyCanvas(): CanvasDoc {
  return { version: 1, positions: {}, texts: [], edges: [], strokes: [] };
}

/** 文本卡片可选底色，跟着纸感走：米白、竹青、藕粉、雾蓝、麦黄、藕荷。 */
export const CARD_COLORS = [
  "#f7f1e6",
  "#e7efe4",
  "#f5e9e5",
  "#e5eef4",
  "#f3eeda",
  "#ebe6f1",
] as const;

/** 落盘路径固定在数据目录的 `.huajian` 下，和 backup、trash 做邻居。 */
const CANVAS_FILE = "\\.huajian\\canvas.json";

/** 进程内只问一次数据目录：`images_get_base_dir` 每次都要过一次 IPC。 */
let cachedPath: string | null = null;

async function canvasPath(): Promise<string> {
  if (cachedPath) return cachedPath;
  const base = await getDataBaseDir();
  cachedPath = `${base}${CANVAS_FILE}`;
  return cachedPath;
}

/**
 * 读画布。
 *
 * 文件不存在、JSON 坏了、字段类型不对，一律当空画布——画布是附属品，
 * 不能因为它读不出来就把「关系」页卡死。
 */
export async function loadCanvas(): Promise<CanvasDoc> {
  try {
    const path = await canvasPath();
    const raw = await readExternalFile(path);
    return normalizeCanvas(JSON.parse(raw));
  } catch {
    return emptyCanvas();
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizePositions(value: unknown): Record<string, CanvasPosition> {
  const result: Record<string, CanvasPosition> = {};
  if (!value || typeof value !== "object") return result;
  for (const [id, point] of Object.entries(value as Record<string, unknown>)) {
    if (!point || typeof point !== "object") continue;
    const { x, y } = point as { x?: unknown; y?: unknown };
    if (isFiniteNumber(x) && isFiniteNumber(y)) result[id] = { x, y };
  }
  return result;
}

function isTextNode(value: unknown): value is CanvasTextNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return (
    typeof node.id === "string" &&
    typeof node.text === "string" &&
    typeof node.color === "string" &&
    isFiniteNumber(node.x) &&
    isFiniteNumber(node.y)
  );
}

function isManualEdge(value: unknown): value is CanvasManualEdge {
  if (!value || typeof value !== "object") return false;
  const edge = value as Record<string, unknown>;
  return (
    typeof edge.id === "string" &&
    typeof edge.source === "string" &&
    typeof edge.target === "string"
  );
}

function isStroke(value: unknown): value is CanvasStroke {
  if (!value || typeof value !== "object") return false;
  const stroke = value as Record<string, unknown>;
  if (typeof stroke.color !== "string" || !isFiniteNumber(stroke.width)) return false;
  if (!Array.isArray(stroke.points)) return false;
  return stroke.points.every(
    (point) =>
      Array.isArray(point) &&
      point.length === 2 &&
      isFiniteNumber(point[0]) &&
      isFiniteNumber(point[1]),
  );
}

/** 只留认得的字段，顺手把老版本/手改坏的数据挡在外面。 */
function normalizeCanvas(value: unknown): CanvasDoc {
  if (!value || typeof value !== "object") return emptyCanvas();
  const source = value as Partial<CanvasDoc>;
  return {
    version: 1,
    positions: sanitizePositions(source.positions),
    texts: Array.isArray(source.texts) ? source.texts.filter(isTextNode) : [],
    edges: Array.isArray(source.edges) ? source.edges.filter(isManualEdge) : [],
    strokes: Array.isArray(source.strokes) ? source.strokes.filter(isStroke) : [],
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 防抖落盘。
 *
 * 拖节点时每帧都会产生新位置，但磁盘只该被写最后一次；
 * 500ms 足够盖住连续拖动，又短到关窗口前来得及写完。
 */
export function saveCanvasSoon(doc: CanvasDoc): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void writeCanvas(doc);
  }, 500);
}

/** 立即落盘（关页面前用）。 */
export async function writeCanvas(doc: CanvasDoc): Promise<void> {
  try {
    await saveExternalFile(await canvasPath(), JSON.stringify(doc));
  } catch {
    // 存不下来不影响这一会话继续用，下一次改动会再试
  }
}
