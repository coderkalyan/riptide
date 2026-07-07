import { createSignal, createEffect } from "solid-js";

// Inline click-to-edit number. Plain text until clicked, then a content-sized
// <input> in the same spot. Enter/blur commits via onCommit; Esc cancels; a
// rejected commit flashes a red border. Quirk preserved from the React build:
// onBlur ALWAYS exits editing (even on a rejected commit), while Enter keeps
// editing (and flashes) when the commit is rejected.
export function EditableNum(props: {
  value: number;
  onCommit: (n: number) => boolean;
  format: (n: number) => string;
  // Seed for the edit field if it differs from the display (e.g. clock mode
  // shows the cycle index but edits in cycle units).
  editValue?: number;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [err, setErr] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => { if (editing()) { inputRef?.focus(); inputRef?.select(); } });

  const tryCommit = () => props.onCommit(parseFloat(draft()));

  return (
    <>
      {editing() ? (
        <input
          ref={inputRef}
          class={`num-input${err() ? " err" : ""}`}
          value={draft()}
          // box-sizing is border-box (global reset), so the 8px padding + 2px
          // border eat into the width — add them back or long numbers clip.
          style={{ width: `calc(${Math.max(2, draft().length + 1)}ch + 10px)` }}
          onInput={(e) => { setDraft(e.currentTarget.value); setErr(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { if (tryCommit()) setEditing(false); else setErr(true); }
            else if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => { tryCommit(); setEditing(false); }}
        />
      ) : (
        <span
          class="num-edit"
          // Seed the field at the display precision (e.g. "5.00", not "5"). When a
          // distinct edit unit is given (clock cycles), that's an integer — seed raw.
          onClick={() => { setDraft(props.editValue != null ? String(props.editValue) : props.format(props.value)); setErr(false); setEditing(true); }}
        >{props.format(props.value)}</span>
      )}
    </>
  );
}
