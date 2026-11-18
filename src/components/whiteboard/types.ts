/** 白板节点的 data。react-flow 要求 data 是 `Record<string, unknown>`。 */

/** 笔记节点（含「被引用但还没建」的虚线节点）。 */
export interface NoteNodeData extends Record<string, unknown> {
  kind: "note";
  label: string;
  /** false = 被 `[[标题]]` 指到、但库里没有这篇笔记。 */
  occupied: boolean;
  /** 连出去 + 被连进来的条数，用来定圆点大小。 */
  degree: number;
  /** 当前选中/聚焦，画得实一点。 */
  focus: boolean;
  /** 不挨着当前节点，淡下去。 */
  dim: boolean;
}

/** 手打的文本卡片。 */
export interface TextNodeData extends Record<string, unknown> {
  kind: "text";
  text: string;
  color: string;
  /** 刚建出来的那一张，渲染后自动进编辑态。 */
  autoEdit: boolean;
  onCommit: (id: string, text: string) => void;
}

export type BoardNodeData = NoteNodeData | TextNodeData;
