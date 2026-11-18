import { memo, useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { NoteNodeData, TextNodeData } from "./types";

/**
 * 拉线的把手：常驻淡显、hover 变实。
 *
 * react-flow 默认给 handle 加 `pointer-events: none`，只在它自己判定"可以连了"
 * 时才放开——自定义节点上这个判定不一定来得及，所以这里直接把指针事件打开，
 * 否则鼠标压上去根本抓不到把手。
 */
const HANDLE_CLASS =
  "!h-2.5 !w-2.5 !rounded-full !border !border-bamboo !bg-paper !pointer-events-auto cursor-crosshair opacity-40 group-hover:opacity-100 transition-opacity";

/** 笔记节点：一个圆点 + 下面的标题。圆点大小跟着引用数走。 */
export const NoteNodeView = memo(function NoteNodeView({ data }: NodeProps) {
  const node = data as NoteNodeData;
  const radius = 7 + Math.min(Math.sqrt(node.degree) * 2.4, 9);
  const label = node.label.length > 16 ? `${node.label.slice(0, 16)}…` : node.label;

  return (
    <div
      className={`group relative flex flex-col items-center transition-opacity ${
        node.dim ? "opacity-25" : "opacity-100"
      }`}
      title={node.occupied ? node.label : `${node.label}（还没有这篇笔记）`}
    >
      <div
        className={`rounded-full border transition-colors duration-150 ${
          node.occupied
            ? node.focus
              ? "border-bamboo bg-bamboo"
              : "border-bamboo/60 bg-bamboo/70"
            : "border-dashed border-ink-ghost/60 bg-paper-deep/30"
        }`}
        style={{ width: radius * 2, height: radius * 2 }}
      />
      <div className="mt-1 max-w-[96px] text-center text-[11px] leading-[1.25] text-ink-soft select-none">
        {label}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={HANDLE_CLASS}
        style={{ top: radius }}
      />
    </div>
  );
});

/** 文本卡片：双击写字，写完失焦保存；空白卡片自动丢掉。 */
export const TextNodeView = memo(function TextNodeView({ id, data, selected }: NodeProps) {
  const node = data as TextNodeData;
  const [editing, setEditing] = useState(node.autoEdit);
  const editorRef = useRef<HTMLDivElement>(null);

  // 进入编辑态时把光标放到末尾，而不是让它全选——全选会让用户一打字就把旧内容冲掉
  useEffect(() => {
    if (!editing) return;
    const element = editorRef.current;
    if (!element) return;
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);

  return (
    <div
      className={`group relative rounded-lg border px-3 py-2 transition-colors ${
        selected ? "border-bamboo/80" : "border-ink-ghost/20"
      }`}
      style={{
        background: node.color,
        minWidth: 88,
        maxWidth: 220,
        boxShadow: "0 1px 2px rgba(28, 26, 23, 0.07)",
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setEditing(true);
      }}
    >
      {editing ? (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          className="nodrag cursor-text whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink outline-none"
          onBlur={(event) => {
            setEditing(false);
            node.onCommit(id, event.currentTarget.innerText);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
          }}
        >
          {node.text}
        </div>
      ) : (
        <div
          className={`whitespace-pre-wrap break-words text-[12.5px] leading-relaxed ${
            node.text ? "text-ink" : "text-ink-ghost"
          }`}
        >
          {node.text || "双击输入"}
        </div>
      )}
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
    </div>
  );
});
