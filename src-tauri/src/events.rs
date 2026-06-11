//! Rust→JS event plumbing helpers (the channel itself lives in
//! `state::AppState`). OWNED BY UNIT U10 (coalescing of hot events —
//! ViewportChanged/HoverChanged at most once per frame).
