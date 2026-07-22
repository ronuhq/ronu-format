//! `ronu` — the reference types, validator, and JSON Schema for the `.ronu`
//! open learning-experience format. This crate is the **single source of
//! truth**: the same Rust types drive (de)serialization, semantic validation,
//! and the generated JSON Schema, so no two of them can disagree.

pub mod formula;
pub mod types;
pub mod validate;

pub use types::Module;
pub use validate::{validate_module, Issue, ValidationResult};
