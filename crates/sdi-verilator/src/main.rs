//! `sdi-verilator` — turn `verilator --json-only` output into an SDI file.
//!
//! ```text
//! verilator --json-only --Mdir obj_dir top.sv --top-module top
//! sdi-verilator obj_dir/Vtop.tree.json --out top.vcd.sdi.json \
//!     --trace top.vcd --root-prefix tb --root-name dut --source-root .
//! ```
//!
//! What this fills, what it computes, and what it cannot know are listed in
//! `docs/sdi.md` under "Producing SDI". The short version: Verilator supplies the
//! structure, this tool supplies the arithmetic Verilator omits (every width, every
//! packed-struct offset, state counts, body extents, control dependence) plus doc
//! comments read from the source, and the caller supplies the trace binding, because
//! no front end knows which dumper wrote the trace.

mod ast;
mod build;
mod source;
mod types;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use build::{Builder, Options, UnpackedArrays};
use sdi::{Coverage, Design, Fidelity, Format, Language, Root, Sdi, TraceBinding};

/// Deep expression trees are normal in generated RTL, and both the parser and the
/// converter walk them recursively, so the work runs on a thread with room for it
/// rather than risking a stack overflow on a legitimate design.
const STACK: usize = 256 << 20;

fn main() -> ExitCode {
    let worker = std::thread::Builder::new()
        .stack_size(STACK)
        .name("sdi-verilator".into())
        .spawn(run)
        .expect("spawn worker thread");
    match worker.join().unwrap_or_else(|_| Err("worker thread panicked".into())) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("sdi-verilator: {message}");
            ExitCode::FAILURE
        }
    }
}

const USAGE: &str = "\
usage: sdi-verilator <Vtop.tree.json> [options]

  --out <file>            write here; `-` or omitted writes to stdout.
                          A `.gz` suffix gzips, which docs/sdi.md recommends at scale.
  --meta <file>           verilator meta file (default: alongside the tree file)
  --source-root <dir>     paths in `files[]` are relative to this (default: .)
  --trace <file>          the trace this SDI is authored against
  --root-prefix <scope>   dumper-added scope above the design root, e.g. `tb`
  --root-name <name>      trace scope name of the root instance, e.g. `dut`
  --unpacked-arrays <p>   keep | omit | elements — how the dumper treated unpacked
                          arrays. Verilator cannot know; only you do.
  --lean                  drop the display-string fields (~18% smaller)
  --pretty                pretty-print (3.3x the bytes, no runtime benefit)
  --quiet                 do not print the summary to stderr
";

struct Args {
    tree: PathBuf,
    meta: Option<PathBuf>,
    out: Option<PathBuf>,
    source_root: PathBuf,
    trace: Option<PathBuf>,
    root_prefix: Option<String>,
    root_name: Option<String>,
    unpacked_arrays: UnpackedArrays,
    lean: bool,
    pretty: bool,
    quiet: bool,
}

/// Hand-rolled rather than a CLI crate: eight flags do not justify the dependency
/// or the compile time in a build-time tool.
fn parse_args() -> Result<Args, String> {
    let mut tree = None;
    let mut args = Args {
        tree: PathBuf::new(),
        meta: None,
        out: None,
        source_root: PathBuf::from("."),
        trace: None,
        root_prefix: None,
        root_name: None,
        unpacked_arrays: UnpackedArrays::Keep,
        lean: false,
        pretty: false,
        quiet: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = |name: &str| -> Result<String, String> {
            it.next().ok_or_else(|| format!("--{name} needs a value"))
        };
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            "--meta" => args.meta = Some(value("meta")?.into()),
            "--out" => {
                let v = value("out")?;
                args.out = (v != "-").then(|| PathBuf::from(v));
            }
            "--source-root" => args.source_root = value("source-root")?.into(),
            "--trace" => args.trace = Some(value("trace")?.into()),
            "--root-prefix" => args.root_prefix = Some(value("root-prefix")?),
            "--root-name" => args.root_name = Some(value("root-name")?),
            "--unpacked-arrays" => {
                args.unpacked_arrays = match value("unpacked-arrays")?.as_str() {
                    "keep" => UnpackedArrays::Keep,
                    "omit" => UnpackedArrays::Omit,
                    "elements" => UnpackedArrays::Elements,
                    other => return Err(format!("--unpacked-arrays: expected keep|omit|elements, got {other}")),
                }
            }
            "--lean" => args.lean = true,
            "--pretty" => args.pretty = true,
            "--quiet" => args.quiet = true,
            other if other.starts_with("--") => return Err(format!("unknown option {other}")),
            other => {
                if tree.replace(PathBuf::from(other)).is_some() {
                    return Err("expected exactly one tree file".into());
                }
            }
        }
    }
    args.tree = tree.ok_or_else(|| format!("no tree file given\n\n{USAGE}"))?;
    Ok(args)
}

fn run() -> Result<(), String> {
    let args = parse_args()?;

    let meta_path = args.meta.clone().unwrap_or_else(|| default_meta(&args.tree));
    let meta_bytes = std::fs::read(&meta_path)
        .map_err(|e| format!("{}: {e}", meta_path.display()))?;
    let meta: source::Meta = serde_json::from_slice(&meta_bytes)
        .map_err(|e| format!("{}: {e}", meta_path.display()))?;

    let tree_bytes =
        std::fs::read(&args.tree).map_err(|e| format!("{}: {e}", args.tree.display()))?;
    let ast = ast::Ast::parse(&tree_bytes).map_err(|e| format!("{}: {e}", args.tree.display()))?;
    // Fail clearly on the wrong file rather than emitting an empty design: a meta
    // file or a `--dump-tree-json` pass dump both parse but have no NETLIST root.
    if ast.root().ty != "NETLIST" {
        return Err(format!(
            "{}: root node is {}, not NETLIST — expected a `Vtop.tree.json` from `verilator --json-only`",
            args.tree.display(),
            ast.root().ty
        ));
    }

    let sources = source::Sources::new(meta, &args.source_root);
    let placeholder = Sdi::new(Design { name: None, language: None, roots: Vec::new() });
    let mut builder = Builder::new(
        &ast,
        sources,
        placeholder,
        Options { unpacked_arrays: args.unpacked_arrays, lean: args.lean },
    );

    builder.declare_units();
    builder.fill();

    let (top_unit, top_name) = builder
        .top_unit()
        .ok_or("the tree contains no modules")?;

    let mut doc = std::mem::replace(
        &mut builder.out,
        Sdi::new(Design { name: None, language: None, roots: Vec::new() }),
    );
    doc.design = Design {
        name: Some(top_name.clone().into()),
        language: Some(Language::SystemVerilog),
        roots: vec![Root {
            name: args.root_name.clone().unwrap_or(top_name).into(),
            unit: top_unit,
            decl: None,
        }],
    };
    doc.files = std::mem::take(&mut builder.src.files);
    doc.generator = Some(sdi::Generator {
        tool: Some("verilator".into()),
        tool_version: verilator_version().map(Into::into),
        command: Some("verilator --json-only … | sdi-verilator".into()),
        created_at: None,
        source_root: Some(args.source_root.to_string_lossy().into_owned().into()),
    });
    doc.fidelity = Fidelity {
        tree: Some(sdi::TreeFidelity::Complete),
        types: Some(sdi::TypeFidelity::Declared),
        drivers: Some(Coverage::Complete),
        bits: Some(sdi::BitsFidelity::Exact),
        // A black box means the graph is not closed, and saying so is the point of
        // the axis. Never claim complete when a cell has no body.
        coi: Some(if builder.has_black_box() {
            Coverage::Partial
        } else {
            Coverage::Complete
        }),
    };
    if let Some(trace) = &args.trace {
        let fst = trace.extension().is_some_and(|e| e.eq_ignore_ascii_case("fst"));
        doc.trace = Some(TraceBinding {
            format: Some(if fst { "fst".into() } else { "vcd".into() }),
            files: vec![file_name(trace).into()],
            separator: Some(".".into()),
            root_prefix: args.root_prefix.clone().map(Into::into),
            // A VCD writer may bake the packed range into a vector's leaf name; FST
            // does not. Both spellings are tried on resolution either way.
            range_in_name: !fst,
            case_sensitive: None,
            escape_style: None,
        });
    }

    if builder.src.hash_failures > 0 {
        builder.notes.push(format!(
            "{} file(s) could not be read for hashing; their blake3 is missing",
            builder.src.hash_failures
        ));
    }
    doc.warnings = builder.notes.iter().map(|n| n.as_str().into()).collect();

    // The invariants a JSON Schema cannot see. Failing here beats writing a file
    // that validates and then breaks a consumer.
    let problems = sdi::validate(&doc);
    if !problems.is_empty() {
        let mut message = format!("produced {} structural problem(s):", problems.len());
        for p in problems.iter().take(10) {
            message.push_str(&format!("\n  {p}"));
        }
        return Err(message);
    }

    let format = if args.pretty { Format::Pretty } else { Format::Minified };
    match &args.out {
        Some(path) => sdi::write(path, &doc, format).map_err(|e| format!("{}: {e}", path.display()))?,
        None => {
            let mut stdout = std::io::stdout().lock();
            sdi::emit(&mut stdout, &doc, format).map_err(|e| e.to_string())?;
        }
    }

    if !args.quiet {
        let vars: usize = doc.units.iter().map(|u| u.vars.len()).sum();
        let processes: usize = doc.units.iter().map(|u| u.processes.len()).sum();
        let assigns: usize = doc
            .units
            .iter()
            .flat_map(|u| &u.processes)
            .map(|p| p.assigns.len())
            .sum();
        let instances: usize = doc.units.iter().map(|u| u.instances.len()).sum();
        eprintln!(
            "{}: {} files, {} types, {} units, {vars} vars, {processes} processes, \
             {assigns} assigns, {instances} instances (from {} AST nodes)",
            args.out.as_ref().map(|p| p.display().to_string()).unwrap_or("<stdout>".into()),
            doc.files.len(),
            doc.types.len(),
            doc.units.len(),
            ast.len(),
        );
        for note in &doc.warnings {
            eprintln!("  note: {note}");
        }
    }
    Ok(())
}

fn default_meta(tree: &Path) -> PathBuf {
    let text = tree.to_string_lossy();
    match text.strip_suffix(".tree.json") {
        Some(stem) => PathBuf::from(format!("{stem}.tree.meta.json")),
        None => tree.with_extension("meta.json"),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Verilator's JSON carries no version field and its own docs call the format
/// evolving, so the version has to be captured out of band.
fn verilator_version() -> Option<String> {
    let out = std::process::Command::new("verilator").arg("--version").output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    Some(text.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_meta_path_from_the_tree_path() {
        assert_eq!(
            default_meta(Path::new("obj_dir/Vgate.tree.json")),
            PathBuf::from("obj_dir/Vgate.tree.meta.json")
        );
        assert_eq!(
            default_meta(Path::new("/tmp/x/Vtop.tree.json")),
            PathBuf::from("/tmp/x/Vtop.tree.meta.json")
        );
    }
}
