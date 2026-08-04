//! The file table, span decoding, and the one field no front end exports.
//!
//! Verilator's `loc` is `"<fileId>,<line>:<col>,<endLine>:<endCol>"` with the file
//! id resolved through the companion `.tree.meta.json`. Doc comments are not in the
//! dump at all — Verilator's lexer discards them, and so does slang's — so they are
//! recovered from the source text a producer has open anyway.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sdi::{Language, SourceFile, Span};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Meta {
    #[serde(default)]
    pub files: HashMap<String, MetaFile>,
}

#[derive(Deserialize)]
pub struct MetaFile {
    pub filename: String,
    #[serde(default)]
    pub realpath: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
}

/// Interns the real source files a span can name, and reads them for text.
pub struct Sources {
    meta: Meta,
    source_root: PathBuf,
    /// Verilator file id -> index into `files`, or `None` for synthetic files.
    resolved: HashMap<String, Option<u32>>,
    pub files: Vec<SourceFile>,
    text: Vec<Option<Vec<String>>>,
    pub hash_failures: usize,
}

/// `<built-in>`, `<command-line>`, `<verilated_std>` and friends: real spans never
/// point at them, and a reviewer cannot open them.
fn is_synthetic(name: &str) -> bool {
    name.starts_with('<') && name.ends_with('>')
}

impl Sources {
    pub fn new(meta: Meta, source_root: &Path) -> Self {
        Self {
            meta,
            source_root: source_root.to_path_buf(),
            resolved: HashMap::new(),
            files: Vec::new(),
            text: Vec::new(),
            hash_failures: 0,
        }
    }

    /// Intern a Verilator file id, hashing the file the first time it is seen.
    fn file_index(&mut self, id: &str) -> Option<u32> {
        if let Some(hit) = self.resolved.get(id) {
            return *hit;
        }
        // With `--json-ids` (the default) the id is a letter into the meta table.
        // With `--no-json-ids` Verilator writes the filename inline instead, and the
        // meta table stays letter-keyed — so an id that is not a key IS a path.
        let (name, language) = match self.meta.files.get(id) {
            Some(f) => (
                f.realpath
                    .as_deref()
                    .filter(|p| !is_synthetic(p))
                    .unwrap_or(&f.filename)
                    .to_string(),
                f.language.as_deref().map(language_of),
            ),
            None => (id.to_string(), None),
        };

        let resolved = if is_synthetic(&name) {
            None
        } else {
            let abs = if Path::new(&name).is_absolute() {
                PathBuf::from(&name)
            } else {
                self.source_root.join(&name)
            };
            let mut rec = SourceFile {
                path: relative_to(&abs, &self.source_root).into(),
                real_path: None,
                language,
                blake3: None,
            };
            match sdi::digest(&abs) {
                Ok(hex) => rec.blake3 = Some(hex.into()),
                Err(_) => self.hash_failures += 1,
            }
            self.files.push(rec);
            self.text.push(None);
            Some(self.files.len() as u32 - 1)
        };
        self.resolved.insert(id.to_string(), resolved);
        resolved
    }

    /// Decode a Verilator `loc`. Splits on the **last two** commas: with
    /// `--no-json-ids` the file id is a filename, which may itself contain commas.
    pub fn span(&mut self, loc: &str) -> Option<Span> {
        let (rest, end) = loc.rsplit_once(',')?;
        let (file_id, start) = rest.rsplit_once(',')?;
        let (line, col) = parse_pair(start)?;
        let (end_line, end_col) = parse_pair(end)?;
        if line == 0 {
            return None;
        }
        let file = self.file_index(file_id)?;
        Some(Span { file, line, col, end_line, end_col })
    }

    fn lines_of(&mut self, file: u32) -> Option<&[String]> {
        let i = file as usize;
        if self.text.get(i)?.is_none() {
            let abs = self.source_root.join(&*self.files[i].path);
            let loaded = std::fs::read_to_string(&abs)
                .ok()
                .map(|t| t.lines().map(str::to_owned).collect::<Vec<_>>());
            self.text[i] = Some(loaded.unwrap_or_default());
        }
        self.text[i].as_deref()
    }

    /// The trimmed source line a span starts on, when it is short enough to show in
    /// a driver list. Lets a viewer name a driver without opening the file.
    pub fn line_text(&mut self, span: Span) -> Option<Box<str>> {
        let line = self.lines_of(span.file)?.get(span.line as usize - 1)?;
        let trimmed = line.trim();
        (!trimmed.is_empty() && trimmed.len() < 160).then(|| trimmed.into())
    }

    /// Recover a doc comment: a trailing comment on the declaration line, else the
    /// run of comment lines directly above it. This is how the producer fills the
    /// one field no surveyed front end exports.
    pub fn doc_comment(&mut self, span: Span) -> Option<Box<str>> {
        let lines = self.lines_of(span.file)?;
        let idx = span.line as usize - 1;
        let line = lines.get(idx)?;

        // Trailing: `input logic rst_n,   // active-low reset`
        let after_decl = line.get(span.col.saturating_sub(1) as usize..).unwrap_or(line);
        if let Some(pos) = after_decl.find("//") {
            let text = after_decl[pos..].trim_start_matches('/').trim();
            if !text.is_empty() && text.len() < 200 {
                return Some(text.into());
            }
        }

        // Above: a contiguous run of `//`, `/*` or `*` lines.
        let mut collected: Vec<&str> = Vec::new();
        for i in (0..idx).rev() {
            let t = lines[i].trim();
            let body = if let Some(rest) = t.strip_prefix("//") {
                rest
            } else if let Some(rest) = t.strip_prefix("/*") {
                rest.trim_end_matches("*/")
            } else if let Some(rest) = t.strip_prefix('*') {
                rest.trim_end_matches("*/")
            } else {
                break;
            };
            collected.push(body.trim());
        }
        collected.reverse();
        let joined = collected.join(" ").trim().to_string();
        (!joined.is_empty() && joined.len() < 200).then(|| joined.into_boxed_str())
    }
}

fn parse_pair(text: &str) -> Option<(u32, u32)> {
    let (a, b) = text.split_once(':')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

fn language_of(lang: &str) -> Language {
    if lang.starts_with("1800") {
        Language::SystemVerilog
    } else if lang.starts_with("1364") {
        Language::Verilog
    } else {
        Language::Other
    }
}

/// Make a path relative to the source root when possible, so a generated file is
/// portable to a reviewer's checkout. Falls back to the file name.
fn relative_to(path: &Path, root: &Path) -> String {
    let abs_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let abs_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    match abs_path.strip_prefix(&abs_root) {
        Ok(rel) => rel.to_string_lossy().into_owned(),
        Err(_) => path
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources_with(name: &str, dir: &Path) -> Sources {
        let mut files = HashMap::new();
        files.insert(
            "e".to_string(),
            MetaFile {
                filename: name.to_string(),
                realpath: Some(dir.join(name).to_string_lossy().into_owned()),
                language: Some("1800-2023".into()),
            },
        );
        files.insert(
            "a".to_string(),
            MetaFile { filename: "<built-in>".into(), realpath: None, language: None },
        );
        Sources::new(Meta { files }, dir)
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sdi-src-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn decodes_locs_and_skips_synthetic_files() {
        let dir = scratch("loc");
        std::fs::write(dir.join("top.sv"), "module top;\nendmodule\n").unwrap();
        let mut s = sources_with("top.sv", &dir);

        let span = s.span("e,28:16,28:21").unwrap();
        assert_eq!((span.line, span.col, span.end_line, span.end_col), (28, 16, 28, 21));
        assert_eq!(span.file, 0);
        assert_eq!(s.files.len(), 1);
        assert_eq!(&*s.files[0].path, "top.sv");
        assert!(s.files[0].blake3.is_some(), "every interned file should be hashed");

        // Built-ins are not real source and must not enter the table.
        assert!(s.span("a,0:0,0:0").is_none());
        assert_eq!(s.files.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn splits_on_the_last_two_commas() {
        let dir = scratch("comma");
        std::fs::write(dir.join("od,d.sv"), "x\n").unwrap();
        let mut s = sources_with("od,d.sv", &dir);
        // `--no-json-ids` puts the filename in the loc, commas and all.
        let span = s.span("od,d.sv,7:1,7:9").unwrap();
        assert_eq!((span.line, span.end_col), (7, 9));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recovers_trailing_and_leading_doc_comments() {
        let dir = scratch("doc");
        std::fs::write(
            dir.join("top.sv"),
            "// Lane state.\n// Second line.\ntypedef enum { A } state_e;\n  input logic rst_n,   // active-low reset\n",
        )
        .unwrap();
        let mut s = sources_with("top.sv", &dir);

        let above = s.span("e,3:1,3:8").unwrap();
        assert_eq!(s.doc_comment(above).as_deref(), Some("Lane state. Second line."));

        let trailing = s.span("e,4:15,4:20").unwrap();
        assert_eq!(s.doc_comment(trailing).as_deref(), Some("active-low reset"));

        let none = s.span("e,1:1,1:2").unwrap();
        assert_eq!(s.doc_comment(none).as_deref(), Some("Lane state."));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn line_text_is_trimmed_and_bounded() {
        let dir = scratch("text");
        let long = "x".repeat(200);
        std::fs::write(dir.join("top.sv"), format!("   assign a = b;\n{long}\n")).unwrap();
        let mut s = sources_with("top.sv", &dir);
        let first = s.span("e,1:4,1:16").unwrap();
        assert_eq!(s.line_text(first).as_deref(), Some("assign a = b;"));
        let second = s.span("e,2:1,2:2").unwrap();
        assert_eq!(s.line_text(second), None, "over-long lines are not worth carrying");
        std::fs::remove_dir_all(&dir).ok();
    }
}
