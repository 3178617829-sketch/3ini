import { getStroke } from "perfect-freehand";
import { useViewport } from "@xyflow/react";
import type { CanvasStroke } from "../../features/notes/canvas";

/**
 * 手绘层。
 *
 * 用 perfect-freehand 把鼠标轨迹压成带笔锋的填充多边形——这也是 Excalidraw
 * 用的同一套引擎，所以画出来的手感不是「粗线条」而是真笔迹。
 *
 * 这一层压在 react-flow 的节点之上、且不吃指针事件：平时它只是一张透明纸，
 * 只有切到画笔模式时才会有一个捕捉层盖上来接管指针。
 */

/** 把手绘得到的轮廓点连成一条首尾闭合的平滑 path。 */
function outlineToPath(outline: number[][]): string {
  if (outline.length === 0) return "";
  const [startX, startY] = outline[0];
  const parts: Array<string | number> = ["M", startX, startY, "Q"];
  for (let i = 0; i < outline.length; i += 1) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    parts.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  parts.push("Z");
  return parts.join(" ");
}

/** 一笔轨迹 → 一条可以直接 `<path d=…>` 的字符串。 */
export function strokeToPath(points: Array<[number, number]>, size: number): string {
  if (points.length < 2) return "";
  const outline = getStroke(points, {
    size,
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: true,
    last: true,
  });
  return outlineToPath(outline as number[][]);
}

interface DoodleLayerProps {
  strokes: CanvasStroke[];
  /** 正在画、还没落盘的那一笔。 */
  live: Array<[number, number]> | null;
  liveColor: string;
  liveWidth: number;
}

export function DoodleLayer({ strokes, live, liveColor, liveWidth }: DoodleLayerProps) {
  const { x, y, zoom } = useViewport();

  return (
    <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full">
      <g transform={`translate(${x}, ${y}) scale(${zoom})`}>
        {strokes.map((stroke, index) => (
          <StrokeShape
            key={`${index}-${stroke.points.length}`}
            points={stroke.points}
            color={stroke.color}
            width={stroke.width}
          />
        ))}
        {live && <StrokeShape points={live} color={liveColor} width={liveWidth} />}
      </g>
    </svg>
  );
}

function StrokeShape({
  points,
  color,
  width,
}: {
  points: Array<[number, number]>;
  color: string;
  width: number;
}) {
  // 点一下没拖动：画一个小圆，否则 perfect-freehand 会返回空轮廓，什么都看不见
  if (points.length === 1) {
    const [cx, cy] = points[0];
    return <circle cx={cx} cy={cy} r={width / 2.4} fill={color} />;
  }
  const path = strokeToPath(points, width);
  if (!path) return null;
  return <path d={path} fill={color} stroke="none" />;
}
