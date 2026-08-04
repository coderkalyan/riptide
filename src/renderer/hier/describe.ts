// Human-readable descriptions of tree nodes, and which source location each one
// points at.
//
// Everything here is derived from source debug info (`native/src/design.rs` reads it
// from the SDI beside the trace) and degrades to what the trace alone carries when
// there is none — a path and a width. Kept in one place because the signal tree and
// the active-signal list must describe the same node the same way.

import type { HierNode, Hierarchy, Scope, Signal, SourceLoc } from "./types";
import { declaredRange, pathOf } from "./types";

/// `mock.sv:60` — a location short enough for a tooltip or a menu label.
export function locLabel(loc: SourceLoc): string {
  const base = loc.file.replace(/^.*[\\/]/, "");
  return `${base}:${loc.line}`;
}

/// Where "Open Declaration" goes: a signal's declaration, or a scope's definition.
export function declarationOf(node: HierNode): SourceLoc | null {
  return (node.kind === "signal" ? node.sourceLoc : node.declSourceLoc) ?? null;
}

/// Where "Open Instantiation" goes. Scopes only — a signal is declared once.
export function instantiationOf(node: HierNode): SourceLoc | null {
  return node.kind === "scope" ? (node.instSourceLoc ?? null) : null;
}

/// Whether any source information exists for this node at all.
export function hasSource(node: HierNode): boolean {
  return declarationOf(node) !== null || instantiationOf(node) !== null;
}

/// The declared type as the source spells it, else what the trace implies. `null`
/// for a 1-bit signal with no declared type, where the name already says enough.
function typeLabel(sig: Signal): string | null {
  if (sig.typeName) return sig.typeName;
  const range = declaredRange(sig);
  if (range) return `[${range.msb}:${range.lsb}]`;
  return sig.bitWidth > 1 ? `${sig.bitWidth}b` : null;
}

/// One line describing a signal: where it lives, what it is, and where it came
/// from. Parts that are unknown are left out rather than padded with placeholders.
export function signalTip(h: Hierarchy, sig: Signal): string {
  const parts = [pathOf(h, sig.id)];
  const type = typeLabel(sig);
  if (type) parts.push(type);
  if (sig.direction && sig.direction !== "implicit") parts.push(sig.direction);
  const decl = declarationOf(sig);
  if (decl) parts.push(locLabel(decl));
  const line = parts.join(" · ");
  return sig.comment ? `${line} — ${sig.comment}` : line;
}

/// The same for a scope, naming its definition and its instantiation separately
/// because a module is defined once and created somewhere else.
export function scopeTip(h: Hierarchy, scope: Scope): string {
  const parts = [pathOf(h, scope.id), scope.scopeType];
  const decl = scope.declSourceLoc;
  const inst = scope.instSourceLoc;
  if (decl) parts.push(locLabel(decl));
  if (inst && (!decl || inst.file !== decl.file || inst.line !== decl.line)) {
    parts.push(`instantiated ${locLabel(inst)}`);
  }
  const line = parts.join(" · ");
  return scope.comment ? `${line} — ${scope.comment}` : line;
}

/// The tooltip for any node, or `undefined` when there is nothing worth saying
/// beyond what the row already shows.
export function nodeTip(h: Hierarchy, node: HierNode): string | undefined {
  if (node.kind === "scope") {
    return hasSource(node) || node.comment ? scopeTip(h, node) : undefined;
  }
  return hasSource(node) || node.comment || node.typeName
    ? signalTip(h, node)
    : undefined;
}
