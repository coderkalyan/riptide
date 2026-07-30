import { For, createMemo, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { MenuItem } from "./ContextMenu";

// Shortcuts the menu cannot carry: they act on whatever holds focus, so there is
// no menu item to hang them off. Everything else in this dialog is read out of the
// menu itself, which is what keeps the two from drifting.
const FOCUS_GROUP = {
  name: "Signal tree",
  rows: [
    { keys: "Enter", label: "Add the selection to the view" },
    { keys: "Esc", label: "Clear the selection, or the filter text" },
  ],
};

// A `kbd` hint as this platform spells it, mirroring what the native menu shows:
// `menu.ts` rewrites a `Ctrl+` chord to `CmdOrCtrl+`, which macOS renders as ⌘.
function chord(kbd: string, mac: boolean): string {
  return mac ? kbd.replace(/^Ctrl\+/, "⌘") : kbd;
}

// Every menu item carrying a `kbd`, grouped by the section it lives in. Submenus
// are walked too; a section with no shortcuts in it is dropped.
function menuGroups(sections: { name: string; items: MenuItem[] }[], mac: boolean) {
  const groups: { name: string; rows: { keys: string; label: string }[] }[] = [];
  const walk = (items: MenuItem[], into: { keys: string; label: string }[]) => {
    for (const item of items) {
      if (item === "sep") continue;
      if (item.submenu) walk(item.submenu, into);
      // `disabled` is ignored on purpose: the dialog documents what exists, not
      // what happens to be actionable with no trace open.
      if (item.kbd) into.push({ keys: chord(item.kbd, mac), label: item.label });
    }
  };
  for (const section of sections) {
    const rows: { keys: string; label: string }[] = [];
    walk(section.items, rows);
    if (rows.length) groups.push({ name: section.name, rows });
  }
  return groups;
}

// Help ▸ Keyboard Shortcuts. Built from the live menu tree so a shortcut can never
// be listed here and missing there (or the reverse). Dismiss on backdrop, Esc, or
// the button.
export function ShortcutsDialog(props: {
  sections: { name: string; items: MenuItem[] }[];
  mac: boolean;
  onClose: () => void;
}) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  const groups = createMemo(() => [...menuGroups(props.sections, props.mac), FOCUS_GROUP]);
  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={props.onClose}>
        <div class="modal keys-modal" onMouseDown={(e) => e.stopPropagation()}>
          <div class="modal-title">Keyboard Shortcuts</div>
          <div class="keys-list">
            <For each={groups()}>{(group) => (
              <>
                <div class="keys-group">{group.name}</div>
                <For each={group.rows}>{(row) => (
                  <div class="keys-row">
                    <span class="keys-chord">{row.keys}</span>
                    <span class="keys-label">{row.label}</span>
                  </div>
                )}</For>
              </>
            )}</For>
          </div>
          <div class="modal-actions">
            <button class="btn primary" onClick={props.onClose}>Close</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
