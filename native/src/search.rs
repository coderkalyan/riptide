//! Fuzzy name search over the flattened hierarchy.
//!
//! One index per trace, built alongside [`crate::hierarchy::flatten`] so entry
//! `i` is node id `i` — a caller gets ids back and looks the rest up in the
//! hierarchy it already holds.
//!
//! The index is three parallel arrays over a single byte pool holding every
//! node's dot path (tide interns those already, so this is the one copy). A
//! query first clears a per-node 32-bit character-presence mask, which rejects
//! the bulk of a large hierarchy with one AND before any path is read; only the
//! survivors are scanned.
//!
//! **Matching, not ranking.** The signal tree shows its hits *in the tree*, with
//! the scopes above them opened, so the result order is the tree's own and a
//! relevance score would have nowhere to apply. What the matcher owes a caller is
//! a yes/no per candidate plus the matched character offsets, for highlighting.
//! Precision therefore comes from the match rule rather than from ordering:
//!
//! * A term the user did not put a dot in must fit inside **one path segment**.
//!   Subsequence-matching the whole path instead would smear a short query across
//!   unrelated scope names — `pc` "matching" `TOP.pipe.decoder.rd` on the `p` of
//!   `pipe` and the `c` of `decoder` — which floods a deep hierarchy with hits
//!   that highlight nothing anyone typed. A term that *does* spell a dot asked to
//!   span segments, and is matched against the whole path.
//! * Whitespace splits a query into terms that must *all* match, in any order, so
//!   `hart clk` finds `TOP.hart.rf.i_clk` by scope and name together.
//! * Within a segment, a forward pass finds the earliest end of a subsequence
//!   match and a backward pass from there tightens the offsets, so `ab` in
//!   `axxxab` highlights the adjacent pair at the tail rather than the first `a`
//!   and the last `b`.

/// Longest term the matcher looks at. Query terms are truncated to this, which no
/// real identifier segment reaches, and it keeps the offset buffer on the stack.
const MAX_TERM: usize = 64;

/// ASCII case folding. A table rather than `to_ascii_lowercase` so the inner
/// loop is one load instead of a compare and branch, and so bytes outside ASCII
/// pass through untouched (UTF-8 continuation bytes must not be folded).
const LOWER: [u8; 256] = {
    let mut table = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        table[i] = if i >= b'A' as usize && i <= b'Z' as usize {
            i as u8 + 32
        } else {
            i as u8
        };
        i += 1;
    }
    table
};

/// The bit `byte` (already folded) contributes to a presence mask. Letters get
/// their own bit; digits, the characters hierarchical names are built from, and
/// everything else share the remaining four.
fn char_bit(byte: u8) -> u32 {
    match byte {
        b'a'..=b'z' => 1 << (byte - b'a'),
        b'0'..=b'9' => 1 << 26,
        b'_' => 1 << 27,
        b'.' => 1 << 28,
        b'[' | b']' => 1 << 29,
        _ => 1 << 30,
    }
}

/// One whitespace-separated piece of a query.
struct Term {
    /// The term as typed, for a case-sensitive compare.
    typed: Vec<u8>,
    /// The term folded, for the case-insensitive compare and the mask.
    folded: Vec<u8>,
    mask: u32,
    /// Smart case: a term carrying an uppercase letter is matched exactly, a
    /// wholly lowercase one case-insensitively.
    cased: bool,
    /// Whether the term itself spells a `.`, in which case spanning path segments
    /// is what it asked for.
    dotted: bool,
}

impl Term {
    fn new(text: &str) -> Term {
        // Truncation must land on a character boundary, or the exact compare
        // would look for a byte sequence no valid path holds.
        let mut end = text.len().min(MAX_TERM);
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        let typed = text.as_bytes()[..end].to_vec();
        let folded: Vec<u8> = typed.iter().map(|&b| LOWER[b as usize]).collect();
        Term {
            mask: folded.iter().fold(0, |mask, &b| mask | char_bit(b)),
            cased: typed.iter().any(u8::is_ascii_uppercase),
            dotted: typed.contains(&b'.'),
            typed,
            folded,
        }
    }

    fn len(&self) -> usize {
        self.folded.len()
    }

    /// Whether path byte `byte` matches the term's `k`th character.
    fn matches(&self, byte: u8, k: usize) -> bool {
        if self.cased {
            byte == self.typed[k]
        } else {
            LOWER[byte as usize] == self.folded[k]
        }
    }
}

/// A query compiled once per call, then run against every surviving path.
struct Query {
    terms: Vec<Term>,
    /// Every term's characters together: a path missing any of them cannot match
    /// all the terms, so one AND rejects it.
    mask: u32,
}

impl Query {
    fn new(text: &str) -> Query {
        let terms: Vec<Term> = text
            .split_ascii_whitespace()
            .map(Term::new)
            .filter(|term| term.len() > 0)
            .collect();
        Query {
            mask: terms.iter().fold(0, |mask, term| mask | term.mask),
            terms,
        }
    }
}

/// Per-candidate match flags and highlight offsets, parallel to the index.
///
/// `matched` is every term matching (what a filter keeps). `ranges` is the union
/// of the offsets of the terms that *did* match (what a highlight draws), so a
/// caller rendering only part of a path still marks the piece the query touched
/// there — the `clk` of `hart clk` lights up on the signal's own name even though
/// `hart` never appears in it.
pub struct Marks {
    /// One byte per candidate: 1 when every term matched.
    pub matched: Vec<u8>,
    /// `(start, len)` pairs of matched characters, as UTF-16 offsets into the
    /// candidate so a JS string slices with them directly. Grouped per candidate
    /// by `range_counts`.
    pub ranges: Vec<u32>,
    /// How many ranges belong to each candidate.
    pub range_counts: Vec<u32>,
    /// UTF-16 offset where each candidate's leaf segment starts. A consumer
    /// showing only the leaf name keeps the ranges at or past it, shifted down.
    pub leaf_offsets: Vec<u32>,
}

/// Searchable paths, in node id order.
pub struct Index {
    /// Every path's bytes, back to back. Bounds come from `offs`, so no
    /// terminator is stored.
    pool: Vec<u8>,
    /// Start of each path, with a trailing end sentinel: `offs.len() == len + 1`.
    offs: Vec<u32>,
    masks: Vec<u32>,
    /// Byte offset of the leaf segment (past the last `.`) within each path.
    leaves: Vec<u32>,
}

impl Index {
    pub fn new() -> Index {
        Index {
            pool: Vec::new(),
            offs: vec![0],
            masks: Vec::new(),
            leaves: Vec::new(),
        }
    }

    /// An index over an arbitrary candidate list, for the callers whose
    /// candidates are not hierarchy nodes (an active row may be a derived signal,
    /// which has no node behind it; a tree row highlights against its own name).
    pub fn of_strings<S: AsRef<str>>(candidates: &[S]) -> Index {
        let mut index = Index::new();
        index.pool.reserve(candidates.len() * 32);
        for candidate in candidates {
            index.push(candidate.as_ref());
        }
        index
    }

    /// Appends `path`. Called once per node, in id order.
    pub fn push(&mut self, path: &str) {
        let mut mask = 0;
        let mut leaf = 0;
        for (offset, &byte) in path.as_bytes().iter().enumerate() {
            mask |= char_bit(LOWER[byte as usize]);
            if byte == b'.' {
                leaf = offset as u32 + 1;
            }
        }
        self.pool.extend_from_slice(path.as_bytes());
        self.offs.push(self.pool.len() as u32);
        self.masks.push(mask);
        self.leaves.push(leaf);
    }

    pub fn len(&self) -> usize {
        self.masks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.masks.is_empty()
    }

    /// The raw bytes of the path at `id`.
    fn bytes(&self, id: usize) -> &[u8] {
        &self.pool[self.offs[id] as usize..self.offs[id + 1] as usize]
    }

    /// The indexed path at `id`. Never fails: the pool only ever receives `&str`
    /// bytes and is only ever sliced at the boundaries `push` recorded.
    pub fn path(&self, id: usize) -> &str {
        std::str::from_utf8(self.bytes(id)).unwrap_or("")
    }

    /// Every id whose path matches `query`, ascending. Empty for a blank query.
    pub fn matches(&self, query: &str) -> Vec<u32> {
        let query = Query::new(query);
        let mut ids = Vec::new();
        if query.terms.is_empty() {
            return ids;
        }
        let mut offsets = Vec::new();
        for id in 0..self.len() {
            if self.masks[id] & query.mask != query.mask {
                continue;
            }
            if self.evaluate(id, &query, &mut offsets) {
                ids.push(id as u32);
            }
        }
        ids
    }

    /// Match flags and highlight offsets for every indexed candidate.
    pub fn marks(&self, query: &str) -> Marks {
        let query = Query::new(query);
        let mut marks = Marks {
            matched: vec![0; self.len()],
            ranges: Vec::new(),
            range_counts: vec![0; self.len()],
            leaf_offsets: Vec::with_capacity(self.len()),
        };
        let mut offsets = Vec::new();
        for id in 0..self.len() {
            let path = self.bytes(id);
            let leaf = self.leaves[id] as usize;
            marks.leaf_offsets.push(utf16_len(&path[..leaf]));
            if query.terms.is_empty() {
                continue;
            }
            marks.matched[id] = u8::from(self.evaluate(id, &query, &mut offsets));
            let before = marks.ranges.len();
            emit_ranges(path, &offsets, &mut marks.ranges);
            marks.range_counts[id] = ((marks.ranges.len() - before) / 2) as u32;
        }
        marks
    }

    /// Whether every term matches the path at `id`, collecting the offsets of the
    /// ones that did into `offsets` (sorted, deduplicated). A term that misses
    /// still leaves the others' offsets behind: the flag drives filtering, the
    /// offsets drive highlighting, and those are not the same question.
    fn evaluate(&self, id: usize, query: &Query, offsets: &mut Vec<u32>) -> bool {
        let path = self.bytes(id);
        let leaf = self.leaves[id] as usize;
        let mut all = true;
        let mut found = [0u32; MAX_TERM];
        offsets.clear();
        for term in &query.terms {
            // Per-term mask, not the query's: the caller may have prefiltered on
            // the union already, but `marks` deliberately does not — it has to see
            // the terms that hit even when another one misses.
            if self.masks[id] & term.mask == term.mask && locate(path, leaf, term, &mut found) {
                offsets.extend_from_slice(&found[..term.len()]);
            } else {
                all = false;
            }
        }
        offsets.sort_unstable();
        offsets.dedup();
        all
    }
}

impl Default for Index {
    fn default() -> Index {
        Index::new()
    }
}

/// Finds `term` in `path`, writing its matched byte offsets into `offsets`.
///
/// The leaf segment is tried first: it is the signal's own name, the part a
/// search is nearly always aiming at and the only part a caller showing just the
/// name can highlight.
fn locate(path: &[u8], leaf: usize, term: &Term, offsets: &mut [u32; MAX_TERM]) -> bool {
    if term.dotted {
        return locate_in(path, 0, term, offsets);
    }
    if locate_in(&path[leaf..], leaf, term, offsets) {
        return true;
    }
    let mut start = 0;
    while start < leaf {
        let end = path[start..leaf]
            .iter()
            .position(|&byte| byte == b'.')
            .map_or(leaf - 1, |at| start + at);
        if locate_in(&path[start..end], start, term, offsets) {
            return true;
        }
        start = end + 1;
    }
    false
}

/// Finds `term` in `hay`, writing offsets biased by `base`.
fn locate_in(hay: &[u8], base: usize, term: &Term, offsets: &mut [u32; MAX_TERM]) -> bool {
    let want = term.len();

    // Forward: the earliest offset the whole term can end at.
    let mut k = 0;
    let mut end = 0;
    for (offset, &byte) in hay.iter().enumerate() {
        if term.matches(byte, k) {
            k += 1;
            if k == want {
                end = offset + 1;
                break;
            }
        }
    }
    if k < want {
        return false;
    }

    // Backward from that end: the tightest offsets for a match ending there.
    let mut k = want;
    let mut offset = end;
    while k > 0 && offset > 0 {
        offset -= 1;
        if term.matches(hay[offset], k - 1) {
            k -= 1;
            offsets[k] = (base + offset) as u32;
        }
    }
    true
}

/// Merges the sorted byte offsets in `matched` into `(start, len)` runs, as
/// UTF-16 offsets into `path`.
fn emit_ranges(path: &[u8], matched: &[u32], out: &mut Vec<u32>) {
    let mut index = 0;
    while index < matched.len() {
        let start = matched[index] as usize;
        let mut end = start + 1;
        index += 1;
        while index < matched.len() && matched[index] as usize == end {
            end += 1;
            index += 1;
        }
        let start16 = utf16_len(&path[..start]);
        out.push(start16);
        out.push(utf16_len(&path[..end]) - start16);
    }
}

/// How many UTF-16 code units `bytes` spells. Paths are ASCII in every real
/// dump, in which case this is the byte length, but a highlight range handed to
/// JS has to be right either way.
fn utf16_len(bytes: &[u8]) -> u32 {
    if bytes.is_ascii() {
        return bytes.len() as u32;
    }
    std::str::from_utf8(bytes)
        .map(|text| text.encode_utf16().count() as u32)
        .unwrap_or(bytes.len() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_of(paths: &[&str]) -> Index {
        Index::of_strings(paths)
    }

    /// The paths the query matches, in id order.
    fn hits(index: &Index, query: &str) -> Vec<String> {
        index
            .matches(query)
            .iter()
            .map(|&id| index.path(id as usize).to_string())
            .collect()
    }

    /// The `(start, len)` highlight pairs for the one indexed candidate.
    fn ranges(index: &Index, query: &str) -> Vec<u32> {
        index.marks(query).ranges
    }

    #[test]
    fn matches_a_subsequence_of_any_segment() {
        let index = index_of(&["top.core.alu.result", "top.fifo.enq_ptr"]);
        // Gapped inside the leaf, and a whole parent segment.
        assert_eq!(vec!["top.core.alu.result"], hits(&index, "reslt"));
        assert_eq!(vec!["top.core.alu.result"], hits(&index, "core"));
        assert_eq!(vec!["top.fifo.enq_ptr"], hits(&index, "enq"));
        assert!(hits(&index, "zzz").is_empty());
    }

    #[test]
    fn a_term_without_a_dot_must_fit_inside_one_segment() {
        // "pc" is a real name in one path and, in the other, the `p` of `pipe` plus
        // the `c` of `decoder` — a smear across two scope names nobody typed.
        let index = index_of(&["top.pipe.decoder.rd", "top.hart.pc"]);
        assert_eq!(vec!["top.hart.pc"], hits(&index, "pc"));
        // A scope name still matches every path it appears in, leaf or not.
        assert_eq!(2, hits(&index, "top").len());
        assert_eq!(vec!["top.pipe.decoder.rd"], hits(&index, "pipe"));
        assert_eq!(vec!["top.pipe.decoder.rd"], hits(&index, "decoder"));
    }

    #[test]
    fn a_term_holding_a_dot_may_span_segments() {
        let index = index_of(&["top.core.alu.result", "top.corealu"]);
        assert_eq!(vec!["top.core.alu.result"], hits(&index, "core.alu"));
    }

    #[test]
    fn every_term_must_match_in_any_order() {
        let index = index_of(&["top.fifo.enq_ptr", "top.fifo.deq_ptr", "top.core.enq"]);
        assert_eq!(vec!["top.fifo.enq_ptr"], hits(&index, "fifo enq"));
        assert_eq!(vec!["top.fifo.enq_ptr"], hits(&index, "enq fifo"));
        assert!(hits(&index, "fifo nope").is_empty());
    }

    #[test]
    fn a_lowercase_query_ignores_case_and_an_uppercase_one_does_not() {
        let index = index_of(&["top.ClkGen.out", "top.clkgen.out"]);
        assert_eq!(2, hits(&index, "clkgen").len());
        assert_eq!(vec!["top.ClkGen.out"], hits(&index, "ClkGen"));
    }

    #[test]
    fn an_empty_or_blank_query_matches_nothing() {
        let index = index_of(&["top.clk"]);
        assert!(index.matches("").is_empty());
        assert!(index.matches("   ").is_empty());
        assert_eq!(vec![0], index.marks("").matched);
    }

    #[test]
    fn a_term_past_the_length_cap_is_truncated_not_rejected() {
        let long = "a".repeat(MAX_TERM + 8);
        let index = index_of(&[long.as_str()]);
        assert_eq!(1, index.matches(&long).len());
    }

    #[test]
    fn highlights_cover_the_matched_characters_as_runs() {
        let index = index_of(&["top.fifo_level"]);
        let marks = index.marks("fifo");
        assert_eq!(vec![1], marks.matched);
        assert_eq!(vec![1], marks.range_counts);
        // One run of four, starting past "top.".
        assert_eq!(vec![4, 4], marks.ranges);
        assert_eq!(vec![4], marks.leaf_offsets);
    }

    #[test]
    fn highlights_the_leaf_occurrence_not_an_earlier_one() {
        // Both `u_clkgen` and the leaf hold "clk"; the leaf is the name a caller
        // renders, so that is the occurrence the offsets have to point at.
        assert_eq!(vec![13, 3], ranges(&index_of(&["top.u_clkgen.clk"]), "clk"));
    }

    #[test]
    fn highlights_tighten_a_greedy_forward_match() {
        // Forward-greedy pairs a@4 with b@9, a four-character gap. The backward
        // pass must find the adjacent pair at the tail: one run, not two.
        assert_eq!(vec![8, 2], ranges(&index_of(&["top.axxxab"]), "ab"));
    }

    #[test]
    fn highlights_every_term_that_matched_even_when_one_did_not() {
        // A tree row highlighting its own name sees only `clk` of `hart clk`; the
        // row is not a match on its own, but the part the query touched still marks.
        let index = index_of(&["i_clk"]);
        let marks = index.marks("hart clk");
        assert_eq!(vec![0], marks.matched);
        assert_eq!(vec![2, 3], marks.ranges);
    }

    #[test]
    fn highlights_are_utf16_offsets_not_byte_offsets() {
        // The scope name is three bytes but two UTF-16 units ahead of the leaf.
        let index = index_of(&["tµp.clk"]);
        let marks = index.marks("clk");
        assert_eq!(vec![4, 3], marks.ranges);
        assert_eq!(vec![4], marks.leaf_offsets);
    }

    #[test]
    fn paths_index_by_node_order() {
        let mut index = Index::new();
        index.push("top");
        index.push("top.clk");
        assert_eq!(2, index.len());
        assert_eq!("top", index.path(0));
        assert_eq!("top.clk", index.path(1));
    }
}
