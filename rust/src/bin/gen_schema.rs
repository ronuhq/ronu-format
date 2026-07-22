//! Emit the JSON Schema for `module.json`, generated from the Rust types.
//! This is the mechanism that keeps `schema/ronu-module.schema.json` honest —
//! regenerate it here instead of hand-editing, so it can never drift from the
//! validator.
//!
//!   cargo run --bin gen-schema > ../schema/ronu-module.schema.json

use schemars::schema_for;

fn main() {
    let schema = schema_for!(ronu::Module);
    println!("{}", serde_json::to_string_pretty(&schema).unwrap());
}
