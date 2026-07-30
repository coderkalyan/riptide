import { For, createMemo } from "solid-js";

// Matched-character runs as (start, len) pairs of UTF-16 offsets into the text
// they came from — the shape native.searchHierarchy / searchStrings return.
export type Ranges = number[];

// The parts of `ranges` inside [from, to), rebased on `from`. Runs crossing
// either edge are clipped rather than dropped, so a match spanning the boundary
// between a path's parent prefix and its leaf name still highlights on both
// sides of the split.
export function clipRanges(ranges: Ranges, from: number, to: number): Ranges {
  const out: Ranges = [];
  for (let i = 0; i < ranges.length; i += 2) {
    const start = Math.max(ranges[i], from);
    const end = Math.min(ranges[i] + ranges[i + 1], to);
    if (end > start) out.push(start - from, end - start);
  }
  return out;
}

// `text` with its matched runs wrapped in `.hl`. Ranges arrive sorted and
// disjoint (the matcher merges adjacent positions into runs), so one walk emits
// the alternating plain/matched pieces.
export function Highlight(props: { text: string; ranges?: Ranges }) {
  const pieces = createMemo<{ text: string; hit: boolean }[]>(() => {
    const ranges = props.ranges;
    if (!ranges || ranges.length === 0) return [{ text: props.text, hit: false }];
    const out: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (let i = 0; i < ranges.length; i += 2) {
      const start = ranges[i];
      const end = start + ranges[i + 1];
      if (start > at) out.push({ text: props.text.slice(at, start), hit: false });
      out.push({ text: props.text.slice(start, end), hit: true });
      at = end;
    }
    if (at < props.text.length) out.push({ text: props.text.slice(at), hit: false });
    return out;
  });
  return <For each={pieces()}>{(piece) => (piece.hit ? <span class="hl">{piece.text}</span> : piece.text)}</For>;
}
