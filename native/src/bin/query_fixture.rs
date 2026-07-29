//! The direct half of the marshalling differential.
//!
//! Loads a VCD and, for every signal in the hierarchy, samples the same value
//! function `getValueAt` calls at (a stride of) its transition ticks. Each result
//! is one line:
//!
//! ```text
//! <handle> <tick> <width> <min hex> <max hex> <z hex>
//! ```
//!
//! `tests/differential.test.cjs` replays every `(handle, tick)` through the
//! addon and asserts byte equality, so anything the Node-API boundary mutates —
//! word packing, truncation, byte order, a lost x or z — shows up as a diff with
//! no oracle needed. Planes are tide's storage bytes, least significant first, in
//! lowercase hex; an empty plane is `-`.
//!
//! ```text
//! query-fixture <vcd> <out.txt> [--max-per-sig=N]
//! ```

use std::fmt::Write as _;
use std::path::PathBuf;
use std::process::ExitCode;

use riptide::hierarchy::Node;
use riptide::pack::with_value_at;
use riptide::trace::{self, Loaded};
use tide_core::Samples;
use tide_core::metadata::{Id, Timestamp};

const MAX_PER_SIG_DEFAULT: usize = 400;
const USAGE: &str = "usage: query-fixture <vcd> <out.txt> [--max-per-sig=N]";

struct Args {
    vcd: PathBuf,
    out: PathBuf,
    max_per_sig: usize,
}

fn parse_args() -> Result<Args, String> {
    let mut positional = Vec::new();
    let mut max_per_sig = MAX_PER_SIG_DEFAULT;
    for arg in std::env::args().skip(1) {
        if let Some(value) = arg.strip_prefix("--max-per-sig=") {
            max_per_sig = value.parse().map_err(|_| format!("bad count: {value}"))?;
        } else if arg.starts_with("--") {
            return Err(format!("unknown flag: {arg}"));
        } else {
            positional.push(arg);
        }
    }
    if positional.len() < 2 {
        return Err(USAGE.to_owned());
    }
    Ok(Args {
        vcd: PathBuf::from(&positional[0]),
        out: PathBuf::from(&positional[1]),
        max_per_sig,
    })
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };

    match run(&args) {
        Ok(bytes) => {
            println!(
                "query-fixture: wrote {bytes} bytes for {}",
                args.vcd.display()
            );
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("query-fixture: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &Args) -> Result<usize, String> {
    let loaded = trace::open(&args.vcd).map_err(|error| error.to_string())?;

    // Aliased declarations share a handle and so repeat here, which keeps the
    // dump a function of the file alone.
    let handles: Vec<Id> = loaded
        .hierarchy
        .nodes
        .iter()
        .filter_map(|node| match node {
            Node::Signal { handle, .. } if *handle != 0 => Some(Id(*handle)),
            _ => None,
        })
        .collect();

    let mut out = String::new();
    for id in handles {
        dump_signal(&loaded, id, args.max_per_sig, &mut out);
    }
    std::fs::write(&args.out, &out).map_err(|error| format!("{}: {error}", args.out.display()))?;
    Ok(out.len())
}

fn dump_signal(loaded: &Loaded, id: Id, max_per_sig: usize, out: &mut String) {
    let db = &loaded.trace.db;
    let Some(mut cursor) = db.samples(id, 0, loaded.end_t) else {
        return;
    };
    let Some(chunk) = cursor.next_chunk() else {
        return;
    };
    let times = chunk.times();

    // Stride so a dense signal emits at most `max_per_sig` samples, with the
    // first and last always among them. No randomness and no clock: the same
    // file always produces the same dump.
    let stride = if times.len() <= max_per_sig {
        1
    } else {
        times.len().div_ceil(max_per_sig)
    };

    let mut ticks: Vec<Timestamp> = times.iter().copied().step_by(stride).collect();
    if times.len() > 1 && (times.len() - 1) % stride != 0 {
        ticks.push(times[times.len() - 1]);
    }

    for tick in ticks {
        let line = with_value_at(db, id, tick, |sample, width| {
            let (min, max, z) = (hex(sample.min), hex(sample.max), hex(sample.z));
            format!("{} {tick} {width} {min} {max} {z}", id.0)
        });
        if let Some(line) = line {
            let _ = writeln!(out, "{line}");
        }
    }
}

/// tide's storage bytes as lowercase hex, least significant byte first. An empty
/// plane has no digits to print, so it reads as a dash.
fn hex(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "-".to_owned();
    }
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}
