//! WebAssembly bindings for the `.ronu` reference validator.
//!
//! This lets JavaScript / TypeScript run the **actual Rust validator** — the
//! single source of truth — instead of maintaining a parallel port. The
//! platform (RonuNest) is the intended first consumer: it can drop its
//! hand-written TS validator and call this instead.
//!
//! Build:  `wasm-pack build bindings/wasm --target web`   (or `--target nodejs`)

use wasm_bindgen::prelude::*;

/// Validate `.ronu` `module.json` content (passed as a JSON string).
///
/// Returns `{ valid: boolean, errors: Issue[], warnings: Issue[] }`, where each
/// `Issue` is `{ code, message, nodeId? }` — the same shape the platform's TS
/// `ValidationResult` uses, so this is a drop-in replacement. Throws (rejects
/// with a string) if the input isn't valid JSON.
#[wasm_bindgen]
pub fn validate(module_json: &str) -> Result<JsValue, JsValue> {
    let value: serde_json::Value = serde_json::from_str(module_json)
        .map_err(|e| JsValue::from_str(&format!("invalid JSON: {e}")))?;
    let result = ronu::validate_module(&value);
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}
