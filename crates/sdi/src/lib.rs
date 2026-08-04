//! Riptide **source debug info** — the design-side companion to a waveform trace.
//!
//! This crate is the Rust definition of the format specified by
//! `docs/sdi.schema.json` and explained in `docs/sdi.md`: the record types, the
//! positional `span`/`bits` encodings, the structural invariants a JSON Schema
//! cannot express, and transparent gzip on both ends.
//!
//! It is deliberately the *only* place the format lives in Rust, so a producer and
//! the future importer in `native/` cannot drift apart. Producers build a [`Sdi`]
//! and call [`write`]; consumers call [`read`] and then [`validate`].
//!
//! ```no_run
//! use sdi::{Design, Root, Sdi, Unit, UnitKind};
//!
//! let mut doc = Sdi::new(Design {
//!     name: Some("gate".into()),
//!     language: None,
//!     roots: vec![Root { name: "dut".into(), unit: 0, decl: None }],
//! });
//! doc.units.push(Unit::new(UnitKind::Module, "gate"));
//! assert!(sdi::validate(&doc).is_empty());
//! sdi::write("gate.vcd.sdi.json.gz".as_ref(), &doc, sdi::Format::Minified)?;
//! # Ok::<_, sdi::Error>(())
//! ```

mod enums;
mod model;
mod validate;

pub use enums::*;
pub use model::*;
pub use validate::{Problem, validate};

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;

/// Anything that can go wrong reading or writing a file.
#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Json(serde_json::Error),
    /// The file parsed but broke an invariant [`validate`] checks.
    Invalid(Vec<Problem>),
    /// A version this build does not understand. Riptide ignores such a file
    /// rather than guessing, the same rule the sidecar follows.
    Version(u32),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::Json(e) => write!(f, "{e}"),
            Error::Version(v) => write!(f, "unsupported SDI version {v} (this build reads {VERSION})"),
            Error::Invalid(problems) => {
                write!(f, "{} structural problem(s)", problems.len())?;
                for p in problems.iter().take(10) {
                    write!(f, "\n  {p}")?;
                }
                if problems.len() > 10 {
                    write!(f, "\n  … {} more", problems.len() - 10)?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Json(e)
    }
}

/// How to lay out the JSON. Minified for real designs, pretty for samples that
/// exist to be read: pretty costs 3.3× the bytes and nothing at runtime.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    Minified,
    Pretty,
}

const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// Read an SDI file, gunzipping when the content is gzipped — sniffed from the
/// magic bytes rather than the extension, so a mislabelled `.json` still loads.
/// Rejects a version this build does not understand; does **not** validate.
pub fn read(path: &Path) -> Result<Sdi, Error> {
    let mut head = [0u8; 2];
    let mut file = File::open(path)?;
    let gzipped = match file.read(&mut head)? {
        2 => head == GZIP_MAGIC,
        _ => false,
    };
    drop(file);

    let file = File::open(path)?;
    let doc: Sdi = if gzipped {
        serde_json::from_reader(BufReader::new(GzDecoder::new(file)))?
    } else {
        serde_json::from_reader(BufReader::new(file))?
    };
    if doc.version != VERSION {
        return Err(Error::Version(doc.version));
    }
    Ok(doc)
}

/// Write an SDI file, gzipping when the path ends in `.gz`.
pub fn write(path: &Path, doc: &Sdi, format: Format) -> Result<(), Error> {
    let gz = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("gz"));
    let file = BufWriter::new(File::create(path)?);
    if gz {
        let mut enc = GzEncoder::new(file, Compression::new(6));
        emit(&mut enc, doc, format)?;
        enc.finish()?.flush()?;
    } else {
        let mut w = file;
        emit(&mut w, doc, format)?;
        w.flush()?;
    }
    Ok(())
}

/// Serialize to any writer, with a trailing newline so the file is `cat`-friendly
/// and diffs do not report a missing one.
pub fn emit<W: Write>(w: &mut W, doc: &Sdi, format: Format) -> Result<(), Error> {
    match format {
        Format::Minified => serde_json::to_writer(&mut *w, doc)?,
        Format::Pretty => serde_json::to_writer_pretty(&mut *w, doc)?,
    }
    w.write_all(b"\n")?;
    Ok(())
}

/// BLAKE3 of a file's bytes, lowercase hex — what `files[].blake3` carries, and the
/// only staleness check the format needs.
pub fn digest(path: &Path) -> Result<String, Error> {
    let mut hasher = blake3::Hasher::new();
    let mut file = BufReader::new(File::open(path)?);
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Sdi {
        let mut doc = Sdi::new(Design {
            name: Some("gate".into()),
            language: Some(Language::SystemVerilog),
            roots: vec![Root { name: "dut".into(), unit: 0, decl: None }],
        });
        doc.files.push(SourceFile {
            path: "gate.sv".into(),
            real_path: None,
            language: Some(Language::SystemVerilog),
            blake3: None,
        });
        doc.types.push(Type::bits("logic", 1, 4));
        let mut u = Unit::new(UnitKind::Module, "gate");
        u.decl = Some(Span::range(0, 3, 8, 3, 12));
        let mut v = Var::new("clk", 0);
        v.direction = Some(Direction::Input);
        u.vars.push(v);
        u.ports.push(0);
        doc.units.push(u);
        doc
    }

    #[test]
    fn round_trips_plain_and_gzipped() {
        let dir = std::env::temp_dir().join(format!("sdi-rt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let doc = sample();

        for (name, format) in [
            ("a.sdi.json", Format::Minified),
            ("b.sdi.json", Format::Pretty),
            ("c.sdi.json.gz", Format::Minified),
        ] {
            let path = dir.join(name);
            write(&path, &doc, format).unwrap();
            let back = read(&path).unwrap();
            assert_eq!(back.units[0].name, doc.units[0].name);
            assert_eq!(back.units[0].decl, doc.units[0].decl);
            assert_eq!(back.files[0].path, doc.files[0].path);
            assert!(validate(&back).is_empty());
        }

        // The gzipped form must actually be gzipped, and smaller.
        let gz = std::fs::read(dir.join("c.sdi.json.gz")).unwrap();
        assert_eq!(&gz[..2], &GZIP_MAGIC);
        assert!(gz.len() < std::fs::metadata(dir.join("b.sdi.json")).unwrap().len() as usize);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_future_version() {
        let dir = std::env::temp_dir().join(format!("sdi-ver-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("v2.sdi.json");
        let mut doc = sample();
        doc.version = 2;
        write(&path, &doc, Format::Minified).unwrap();
        assert!(matches!(read(&path), Err(Error::Version(2))));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn digests_are_stable_lowercase_hex() {
        let dir = std::env::temp_dir().join(format!("sdi-dig-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.txt");
        std::fs::write(&path, b"hello sdi\n").unwrap();
        let d = digest(&path).unwrap();
        assert_eq!(d.len(), 64);
        assert!(d.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(d, digest(&path).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }
}
