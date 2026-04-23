import { useEffect, useRef } from "react";

const PRESETS = [
  "#72F5DF", "#F06B5B", "#E6B14E", "#B48CFF", "#57C88A",
  "#727BF5", "#4FD2BD", "#72F5B4", "#E86A5A", "#F4A698",
];

export function ColorPicker({
  color,
  onChange,
  onClose,
  anchorRect,
}: {
  color: string;
  onChange: (c: string) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="color-picker"
      ref={ref}
      style={{ left: anchorRect.right + 6, top: anchorRect.top - 4 }}
    >
      <div className="swatches">
        {PRESETS.map((c) => (
          <span
            key={c}
            className={"sw" + (c.toLowerCase() === color.toLowerCase() ? " on" : "")}
            style={{ background: c }}
            onClick={() => { onChange(c); onClose(); }}
          />
        ))}
      </div>
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
