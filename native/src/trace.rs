//! Opening a trace file.

use std::fmt;
use std::path::Path;
use std::sync::Arc;

use tide_core::Trace;
use tide_core::metadata::Timestamp;
use tide_vcd::load::{LoadError, load};

use crate::hierarchy::{self, Flat};

/// A parsed trace, plus the two pieces of presentation metadata the renderer
/// needs that live outside the sample data.
pub struct Loaded {
    pub trace: Trace,
    /// The trace's last tick, which every row's final segment extends to and the
    /// viewport clamps against.
    pub end_t: Timestamp,
    /// `$timescale`, split into the magnitude and the unit as VCD spells it.
    pub timescale_value: u32,
    pub timescale_unit: &'static str,
    /// The scope tree, flattened once here rather than on every `getHierarchy`.
    /// Behind an `Arc` so a background search can hold it open across a trace
    /// swap; immutable once built, so nothing synchronizes.
    pub hierarchy: Arc<Flat>,
}

/// Why a trace would not open.
pub enum OpenError {
    Read(std::io::Error),
    Parse(LoadError),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::Read(error) => write!(f, "{error}"),
            OpenError::Parse(error) => write!(f, "{error}"),
        }
    }
}

/// Reads and parses the VCD at `path`.
pub fn open(path: &Path) -> Result<Loaded, OpenError> {
    let source = std::fs::read(path).map_err(OpenError::Read)?;
    let (trace, report) = load(&source).map_err(OpenError::Parse)?;
    let hierarchy = Arc::new(hierarchy::flatten(&trace.hierarchy, &trace.db));

    Ok(Loaded {
        // A trace whose body never advanced past tick 0 still needs a timeline
        // with width, or the viewport divides by a zero span.
        end_t: report.last_time.max(1),
        timescale_value: report.timescale.number.magnitude(),
        timescale_unit: report.timescale.unit.as_str(),
        hierarchy,
        trace,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hierarchy::Node;
    use std::io::Write;

    /// Writes `source` to a scratch file and opens it, so the io path is
    /// exercised rather than stubbed.
    fn open_source(name: &str, source: &str) -> Result<Loaded, OpenError> {
        let path = std::env::temp_dir().join(format!("riptide-{name}.vcd"));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(source.as_bytes()).unwrap();
        drop(file);
        open(&path)
    }

    const SOURCE: &str = "\
$timescale 10ns $end
$version v $end
$scope module top $end
$var wire 1 ! clk $end
$var real 64 # temp $end
$var wire 8 $ idle $end
$scope module u_cnt $end
$var reg 4 \" count [3:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
0!
b0 \"
#10
1!
b1 \"
#40
";

    #[test]
    fn opens_a_trace_and_reports_its_extent() {
        let loaded = open_source("extent", SOURCE).ok().unwrap();
        // The trailing time record with no changes still ends the trace.
        assert_eq!(40, loaded.end_t);
        assert_eq!(10, loaded.timescale_value);
        assert_eq!("ns", loaded.timescale_unit);
        assert!(loaded.trace.hierarchy.signal("top.u_cnt.count").is_some());
    }

    #[test]
    fn flattens_variables_ahead_of_subscopes() {
        let loaded = open_source("order", SOURCE).ok().unwrap();
        let names: Vec<&str> = loaded.hierarchy.nodes.iter().map(Node::name).collect();
        // The signal tree renders in this order, so it is part of the contract:
        // the scope, then its variables, then its subscopes.
        assert_eq!(vec!["top", "clk", "temp", "idle", "u_cnt", "count"], names);
        assert_eq!(vec![0], loaded.hierarchy.root_ids);

        let Node::Scope { children, .. } = &loaded.hierarchy.nodes[0] else {
            panic!("top is a scope");
        };
        assert_eq!(&[1, 2, 3, 4], children.as_slice());
    }

    #[test]
    fn the_search_index_holds_one_path_per_node_in_id_order() {
        let loaded = open_source("paths", SOURCE).ok().unwrap();
        let flat = &loaded.hierarchy;
        assert_eq!(flat.nodes.len(), flat.search.len());

        // Search returns node ids and highlight offsets measured against the path
        // it indexed; the renderer rebuilds that path from these parent links, so
        // the two spellings have to agree character for character.
        for id in 0..flat.nodes.len() {
            let mut parts = Vec::new();
            let mut cursor = Some(id as u32);
            while let Some(at) = cursor {
                parts.push(flat.nodes[at as usize].name());
                cursor = flat.nodes[at as usize].parent();
            }
            parts.reverse();
            assert_eq!(parts.join("."), flat.search.path(id));
        }
    }

    #[test]
    fn pruning_keeps_the_scopes_above_a_match_and_drops_its_siblings() {
        let loaded = open_source("prune", SOURCE).ok().unwrap();
        let flat = &loaded.hierarchy;
        let row = |name: &str, rows: &[crate::hierarchy::Row]| {
            rows.iter()
                .find(|row| flat.nodes[row.id as usize].name() == name)
                .map(|row| (row.depth, row.matched))
        };

        // `count` lives two scopes down: both open, nothing beside them survives.
        let deep = flat.prune(&[5]);
        assert_eq!(3, deep.len());
        assert_eq!(Some((0, false)), row("top", &deep));
        assert_eq!(Some((1, false)), row("u_cnt", &deep));
        assert_eq!(Some((2, true)), row("count", &deep));
        assert_eq!(None, row("clk", &deep));

        // Tree order, not the order the matches came in.
        let two = flat.prune(&[5, 1]);
        let names: Vec<&str> = two.iter().map(|row| flat.nodes[row.id as usize].name()).collect();
        assert_eq!(vec!["top", "clk", "u_cnt", "count"], names);

        assert!(flat.prune(&[]).is_empty());
    }

    #[test]
    fn variables_the_database_cannot_hold_are_listed_but_unsupported() {
        let loaded = open_source("unsupported", SOURCE).ok().unwrap();
        let supported = |name: &str| {
            loaded
                .hierarchy
                .nodes
                .iter()
                .find_map(|node| match node {
                    Node::Signal {
                        name: n, supported, ..
                    } if n == name => Some(*supported),
                    _ => None,
                })
                .unwrap()
        };

        // A real is typed and visible so a viewer can show it, with nothing
        // behind it. A net declared but never assigned is stored nowhere either.
        assert!(supported("clk"));
        assert!(!supported("temp"));
        assert!(!supported("idle"));
    }

    #[test]
    fn a_missing_file_reports_the_io_error() {
        let error = open(Path::new("/nonexistent/nope.vcd")).err().unwrap();
        assert!(matches!(error, OpenError::Read(_)));
    }

    #[test]
    fn a_malformed_header_reports_the_parse_error() {
        let error = open_source("bad", "$scope module top $end\n")
            .err()
            .unwrap();
        assert!(matches!(error, OpenError::Parse(_)));
    }
}
