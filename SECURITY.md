# Security Policy

## Reporting a vulnerability

Email **info@ronunest.com** with details. Please don't open a public issue for a security problem until it's been addressed. We aim to acknowledge reports within a few working days.

## For implementers — the one real hazard

A `.ronu` file arrives from **untrusted channels by design** — email, USB, a stranger's link. Treat the whole file as untrusted input:

- **`code` nodes carry executable source** (spec §7). A player MUST NOT execute a code node's `source` outside a sandbox that denies filesystem, network, and DOM access by default. Never `eval`/`Function` it in your app's context. If you can't sandbox it, treat `code` as an unsupported node type and fall back (spec §5.2) — a conformant minimal player is allowed to.
- **Bundled assets and media references** are attacker-controlled. Validate paths stay inside the zip's `assets/` (no `..` traversal), cap sizes, and don't trust declared MIME types.
- **Text content may contain HTML** (`message` nodes). Sanitise before rendering; assume script-injection intent.
- **Run the [reference validator](rust/) before playing** a file you didn't create — it rejects structurally broken modules, though it is not a security sandbox on its own.

The format specification itself does not define DRM or access control; those are a platform's concern, not the file's.
