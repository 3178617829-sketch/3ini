import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface SlidingButtonGroupProps<T extends string> {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
}

/**
 * 上次切换距今短于这个时长，就不播滑块动画，直接跳到位。
 * 快速连点时色块如果每次都走 0.22s 的补间，会看起来来回抽动。
 */
const FAST_SWITCH_MS = 180;

export function SlidingButtonGroup<T extends string>({
  options,
  value,
  onChange,
  className = "",
  buttonClassName = "h-7",
}: SlidingButtonGroupProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [animated, setAnimated] = useState(false);
  const lastMeasuredAtRef = useRef(0);

  /**
   * 量当前选中按钮的几何位置。用 offsetLeft/offsetTop 是因为它们是相对
   * 容器 padding box 的值，正好对应滑块 absolute 定位的基准。
   */
  const measure = useCallback(
    (withAnimation: boolean) => {
      const btn = buttonsRef.current.get(value);
      if (!btn) return;
      lastMeasuredAtRef.current = performance.now();
      setAnimated(withAnimation);
      setPos({
        left: btn.offsetLeft,
        top: btn.offsetTop,
        width: btn.offsetWidth,
        height: btn.offsetHeight,
      });
    },
    [value],
  );

  // 切换值：距上次切换太近就跳动画，避免快速连点时色块抽动
  useLayoutEffect(() => {
    measure(performance.now() - lastMeasuredAtRef.current > FAST_SWITCH_MS);
  }, [measure]);

  // 容器尺寸变化（拖窗口、收侧栏、改字号）也要重量，否则滑块停在旧位置
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // 首帧之后才允许过渡，否则挂载瞬间滑块会从 (0,0) 滑过来
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const transition = animated
    ? "left 0.22s cubic-bezier(0.22,1,0.36,1), top 0.22s cubic-bezier(0.22,1,0.36,1), width 0.22s cubic-bezier(0.22,1,0.36,1), height 0.22s cubic-bezier(0.22,1,0.36,1)"
    : "none";

  return (
    <div
      ref={containerRef}
      className={`relative flex items-center gap-1 bg-paper-warm/60 rounded-lg p-[2px] border border-paper-deep/30 ${className}`}
    >
      <div
        className="absolute rounded-md bg-cloud shadow-[0_1px_2px_rgba(0,0,0,0.04)] pointer-events-none sliding-highlight"
        style={{ left: pos.left, top: pos.top, width: pos.width, height: pos.height, transition }}
      />
      {options.map((option) => (
        <button
          key={option.value}
          ref={(el) => {
            if (el) buttonsRef.current.set(option.value, el);
            else buttonsRef.current.delete(option.value);
          }}
          type="button"
          onClick={() => onChange(option.value)}
          className={`relative z-[1] flex-1 rounded-md text-[11px] whitespace-nowrap transition-colors duration-200 cursor-pointer ${buttonClassName} ${
            value === option.value
              ? "text-bamboo font-medium"
              : "text-ink-ghost hover:text-ink-faint"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
