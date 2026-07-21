import { For, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { MenuItem } from "./ContextMenu";
import { buildMenus, type MenuState } from "./menuModel";

export function MenuBar(props: {
  // Document/UI state driving labels + enabled/checked flags (see menuModel).
  state: () => MenuState;
  // Dispatches a menu action string (shared with the native macOS menu via App.tsx
  // `runMenuAction`). `path` carries the target for Open Recent.
  onAction: (action: string, path?: string) => void;
  getRecent: () => Promise<string[]>;
}) {
  const [open, setOpen] = createSignal<{ name: string; rect: DOMRect } | null>(null);
  // Frozen snapshot of the last-open menu — stays mounted while `open` is null so
  // the popup can fade out.
  const [pop, setPop] = createSignal<{ rect: DOMRect; items: MenuItem[] } | null>(null);
  // Second-tier submenu (e.g. Open Recent), and its frozen snapshot for the fade.
  const [sub, setSub] = createSignal<{ rect: DOMRect; items: MenuItem[] } | null>(null);
  const [subPop, setSubPop] = createSignal<{ rect: DOMRect; items: MenuItem[] } | null>(null);
  const [recent, setRecent] = createSignal<string[]>([]);

  const menus = () => buildMenus(props.state(), recent());

  createEffect(() => {
    const o = open();
    if (!o) return;
    const menu = menus().find((m) => m.name === o.name);
    if (menu) setPop({ rect: o.rect, items: menu.items });
  });
  // Refresh the recent list whenever the File menu opens.
  createEffect(() => {
    if (open()?.name === "File") props.getRecent().then(setRecent);
  });
  createEffect(() => {
    const s = sub();
    if (s) setSubPop(s);
  });
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".menubar") && !t.closest(".menu-pop")) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });
  // Closing the top menu collapses any open submenu.
  createEffect(() => { if (!open()) setSub(null); });

  const activate = (it: Exclude<MenuItem, "sep">) => {
    if (it.disabled || it.submenu) return;
    setOpen(null);
    if (it.action) props.onAction(it.action, it.path);
  };

  const renderItem = (it: MenuItem, isSub: boolean) =>
    it === "sep" ? <div class="menu-sep" /> : (
      <div
        class={`menu-item${it.disabled ? " disabled" : ""}${it.unimplemented ? " unimplemented" : ""}${!isSub && it.submenu && sub() ? " active" : ""}`}
        onClick={() => activate(it)}
        onMouseEnter={(e) => {
          if (isSub) return;
          if (it.submenu) setSub({ rect: e.currentTarget.getBoundingClientRect(), items: it.submenu });
          else setSub(null);
        }}
      >
        <span>{it.label}</span>
        {it.submenu ? <span class="menu-arrow">›</span>
          : it.checked !== undefined ? <span class="menu-check">{it.checked ? "✓" : ""}</span>
          : it.kbd ? <span class="menu-kbd">{it.kbd}</span> : null}
      </div>
    );

  return (
    <div class="menubar">
      <For each={menus()}>{(m) => (
        <span
          class={`m${open()?.name === m.name ? " open" : ""}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setOpen((o) => (o?.name === m.name ? null : { name: m.name, rect }));
          }}
          onMouseEnter={(e) => { if (open()) setOpen({ name: m.name, rect: e.currentTarget.getBoundingClientRect() }); }}
        >{m.name}</span>
      )}</For>
      <Portal>
        <div
          class={`menu-pop${open() ? " show" : ""}`}
          style={{ left: `${pop()?.rect.left ?? 0}px`, top: `${(pop()?.rect.bottom ?? 0) + 4}px` }}
        >
          <For each={pop()?.items ?? []}>{(it) => renderItem(it, false)}</For>
        </div>
        <div
          class={`menu-pop${open() && sub() ? " show" : ""}`}
          style={{ left: `${(subPop()?.rect.right ?? 0) - 4}px`, top: `${(subPop()?.rect.top ?? 0) - 6}px` }}
        >
          <For each={subPop()?.items ?? []}>{(it) => renderItem(it, true)}</For>
        </div>
      </Portal>
    </div>
  );
}
