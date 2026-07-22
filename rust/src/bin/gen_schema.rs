//! Emit the JSON Schema for `module.json`, generated from the Rust types.
//! This is the mechanism that keeps `schema/ronu-module.schema.json` honest:
//! regenerate it here instead of hand-editing, so it can never drift from the
//! validator. CI regenerates and fails if the committed file is out of date.
//!
//!   cargo run --bin gen-schema > ../schema/ronu-module.schema.json

use schemars::schema_for;
use serde_json::Value;

/// Trunk-based (unversioned): the `$id` pins to the main branch, no version.
const SCHEMA_ID: &str =
    "https://raw.githubusercontent.com/ronuhq/ronu-format/main/schema/ronu-module.schema.json";

fn main() {
    let schema = schema_for!(ronu::Module);
    let mut value = serde_json::to_value(&schema).expect("schema serializes");
    if let Value::Object(map) = &mut value {
        map.insert("$id".to_string(), Value::String(SCHEMA_ID.to_string()));
    }
    // serde_json Values sort keys, so output is deterministic (CI diff-checks it).
    println!("{}", serde_json::to_string_pretty(&value).unwrap());
}
