//! File/menu/persistence commands. Bodies OWNED BY UNIT U11 (except
//! `save_canvas`'s render-side internals, which call U12's frozen
//! `riptide_render::capture` API).
//!
//! Semantics mirror the Electron handlers in `src/main/index.ts`
//! (`riptide:recent-vcds`, `riptide:export-sidecar`, `riptide:save-canvas`,
//! `riptide:close-window`) and the renderer-side sidecar IO in
//! `src/renderer/hier/sidecar.ts` (atomic tmp+rename write).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

/// Cap on the recent-traces list — mirrors `RECENT_MAX` in `src/main/index.ts`.
const RECENT_MAX: usize = 10;

// ---- pure helpers (unit-tested below) --------------------------------------

/// Reads a text file; `Ok(None)` when it does not exist (missing sidecar is
/// the normal fresh-trace case, not an error).
fn read_text_or_absent(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Atomic write: `<path>.tmp` in the same directory + rename, so a concurrent
/// reader never sees a torn file (mirrors `writeSidecarFile` in
/// `src/renderer/hier/sidecar.ts`).
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let mut tmp_os = path.as_os_str().to_owned();
    tmp_os.push(".tmp");
    let tmp = PathBuf::from(tmp_os);
    fs::write(&tmp, text).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), path.display())
    })
}

/// Parses recent.json. Mirrors Electron's `readRecent`: any parse error or
/// non-array shape yields an empty list; non-string entries are dropped.
fn parse_recent(raw: &str) -> Vec<String> {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Array(items)) => items
            .into_iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Bumps `path` to the front of `list`, deduped, capped at `RECENT_MAX` —
/// mirrors Electron's `addRecent`.
fn push_recent(list: Vec<String>, path: String) -> Vec<String> {
    let mut out = Vec::with_capacity(RECENT_MAX);
    out.push(path);
    out.extend(list.into_iter().filter(|p| *p != out[0]));
    out.truncate(RECENT_MAX);
    out
}

/// Strips a trailing `.vcd` (case-insensitive) — mirrors the Electron
/// handlers' `path.basename(currentVcd).replace(/\.vcd$/i, "")`.
fn strip_vcd_ext(name: &str) -> &str {
    let n = name.len();
    if n >= 4 && name.is_char_boundary(n - 4) && name[n - 4..].eq_ignore_ascii_case(".vcd") {
        &name[..n - 4]
    } else {
        name
    }
}

// ---- app-handle plumbing ----------------------------------------------------

/// `recent.json` under the Tauri app-data dir (Electron kept it in userData).
fn recent_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(dir.join("recent.json"))
}

fn read_recent_list(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let file = recent_file(app)?;
    Ok(match fs::read_to_string(file) {
        Ok(raw) => parse_recent(&raw),
        Err(_) => Vec::new(),
    })
}

/// Save-dialog default basename: the loaded trace's file name minus `.vcd`,
/// else `fallback` ("waveform" / "view", as in the Electron handlers).
fn current_trace_base(state: &AppState, fallback: &str) -> String {
    let engine = state.engine.lock().expect("engine lock");
    engine
        .trace
        .as_ref()
        .and_then(|t| t.path().file_name())
        .and_then(|n| n.to_str())
        .map(|n| strip_vcd_ext(n).to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// Native save dialog; `Ok(None)` on cancel. Async commands run off the main
/// thread, so the blocking dialog API is safe here (the dialog itself is
/// dispatched to the main thread by the plugin).
async fn save_dialog(
    app: &tauri::AppHandle,
    title: &str,
    default_name: &str,
    filter_name: &str,
    extensions: &[&str],
) -> Result<Option<PathBuf>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(default_name)
        .add_filter(filter_name, extensions)
        .blocking_save_file();
    match picked {
        None => Ok(None),
        Some(fp) => fp.into_path().map(Some).map_err(|e| e.to_string()),
    }
}

// ---- commands ----------------------------------------------------------------

/// Reads the sidecar text next to the trace; Ok(None) when absent.
#[tauri::command]
pub fn read_sidecar(path: String) -> Result<Option<String>, String> {
    read_text_or_absent(Path::new(&path))
}

/// Atomic write (tmp + rename) of the sidecar.
#[tauri::command]
pub fn write_sidecar(path: String, text: String) -> Result<(), String> {
    write_atomic(Path::new(&path), &text)
}

/// The recent-traces list (recent.json in the app data dir). Replaces
/// `riptide:recent-vcds`.
#[tauri::command]
pub fn recent_vcds(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    read_recent_list(&app)
}

#[tauri::command]
pub fn add_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file = recent_file(&app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let list = push_recent(read_recent_list(&app)?, path);
    let text = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    write_atomic(&file, &text)
}

/// "Export sidecar…" — save dialog + write. Replaces `riptide:export-sidecar`.
#[tauri::command]
pub async fn export_sidecar(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Result<(), String> {
    let base = current_trace_base(state.inner(), "view");
    let Some(path) = save_dialog(
        &app,
        "Export Sidecar",
        &format!("{base}.sidecar.json"),
        "Riptide Sidecar",
        &["json"],
    )
    .await?
    else {
        return Ok(()); // dialog cancelled
    };
    fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

/// "Save canvas…" — offscreen wgpu render → PNG → save dialog. Replaces
/// `riptide:save-canvas` (capture moves fully to Rust).
#[tauri::command]
pub async fn save_canvas(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Capture first — mirrors Electron, where the renderer snapshotted the
    // canvas before the save dialog appeared (no dialog when capture fails).
    let png = capture_canvas_png(state.inner())?;
    let base = current_trace_base(state.inner(), "waveform");
    let Some(path) = save_dialog(
        &app,
        "Save Canvas Image",
        &format!("{base}.png"),
        "PNG Image",
        &["png"],
    )
    .await?
    else {
        return Ok(()); // dialog cancelled
    };
    fs::write(&path, png).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Pixel source for `save_canvas`. TODO(U12/U15 integration): render the
/// current scene offscreen via the frozen capture API —
///
/// `riptide_render::capture::capture_png(&gpu, width_px, height_px, &mut |view| {
///     /* encode one frame into `view` (render_loop's frame path) */
/// })`
///
/// — using the engine's canvas size × dpr. The dialog + file-write half of
/// `save_canvas` above is final; only this pixel source is stubbed.
fn capture_canvas_png(_state: &AppState) -> Result<Vec<u8>, String> {
    Err("needs U12 capture".into())
}

#[tauri::command]
pub fn close_window(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

// ---- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Self-cleaning unique temp dir (no tempfile dep in the workspace).
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("riptide-u11-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // -- recent-list logic --

    #[test]
    fn push_recent_prepends() {
        assert_eq!(push_recent(v(&["a", "b"]), "c".into()), v(&["c", "a", "b"]));
    }

    #[test]
    fn push_recent_dedupes_existing_entry() {
        assert_eq!(
            push_recent(v(&["a", "b", "c"]), "b".into()),
            v(&["b", "a", "c"])
        );
    }

    #[test]
    fn push_recent_caps_at_max() {
        let list: Vec<String> = (0..RECENT_MAX).map(|i| format!("p{i}")).collect();
        let out = push_recent(list, "new".into());
        assert_eq!(out.len(), RECENT_MAX);
        assert_eq!(out[0], "new");
        assert_eq!(out.last().unwrap(), &format!("p{}", RECENT_MAX - 2));
    }

    #[test]
    fn push_recent_on_empty() {
        assert_eq!(push_recent(Vec::new(), "a".into()), v(&["a"]));
    }

    #[test]
    fn parse_recent_roundtrip() {
        assert_eq!(parse_recent(r#"["a","b"]"#), v(&["a", "b"]));
    }

    #[test]
    fn parse_recent_tolerates_garbage() {
        assert_eq!(parse_recent("not json"), Vec::<String>::new());
        assert_eq!(parse_recent(r#"{"a":1}"#), Vec::<String>::new());
        // Non-string entries are dropped, strings kept (Electron's filter).
        assert_eq!(parse_recent(r#"["a", 1, null, "b"]"#), v(&["a", "b"]));
    }

    // -- atomic write --

    #[test]
    fn write_atomic_roundtrip_and_no_tmp_left() {
        let dir = TempDir::new("atomic");
        let target = dir.path().join("x.sidecar.json");
        write_atomic(&target, "{\"version\":1}\n").expect("write ok");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"version\":1}\n");
        assert!(!target.with_extension("json.tmp").exists());
        assert!(!dir.path().join("x.sidecar.json.tmp").exists());
        // Overwrite is atomic too.
        write_atomic(&target, "second").expect("rewrite ok");
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
    }

    #[test]
    fn write_atomic_failure_leaves_no_partial_target() {
        let dir = TempDir::new("atomic-fail");
        let target = dir.path().join("missing-subdir").join("x.json");
        let err = write_atomic(&target, "data").expect_err("must fail");
        assert!(err.contains("write"), "unexpected error: {err}");
        assert!(!target.exists(), "no partial target file may appear");
    }

    // -- sidecar read --

    #[test]
    fn read_text_or_absent_missing_is_none() {
        let dir = TempDir::new("read-none");
        let p = dir.path().join("nope.sidecar.json");
        assert_eq!(read_text_or_absent(&p).unwrap(), None);
    }

    #[test]
    fn read_text_or_absent_present_is_some() {
        let dir = TempDir::new("read-some");
        let p = dir.path().join("x.sidecar.json");
        fs::write(&p, "hello").unwrap();
        assert_eq!(read_text_or_absent(&p).unwrap(), Some("hello".into()));
    }

    // -- default basename --

    #[test]
    fn strip_vcd_ext_cases() {
        assert_eq!(strip_vcd_ext("trace.vcd"), "trace");
        assert_eq!(strip_vcd_ext("TRACE.VCD"), "TRACE");
        assert_eq!(strip_vcd_ext("trace.vcd.vcd"), "trace.vcd");
        assert_eq!(strip_vcd_ext("trace.txt"), "trace.txt");
        assert_eq!(strip_vcd_ext("vcd"), "vcd");
        assert_eq!(strip_vcd_ext(""), "");
    }
}
