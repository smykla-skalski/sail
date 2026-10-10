# Local output store contract

The Rust `context_output_store` module is a storage core for #304. It does not intercept tool output or expose a broker tool yet. #302 will connect trusted tool results to it.

## Caller boundary

- The caller chooses a private, local store root and derives `OutputScope` from Sail's authenticated repository, worktree, operating-system user, provider, session, and source revision. Tool arguments and provider-supplied metadata are not authority for these fields.
- A dirty worktree needs a revision value that changes with its local content. A new revision makes older references inaccessible through the new scope. The broker must explicitly decide whether and how to retrieve an older revision.
- The scope key is a SHA-256 digest of all six fields. Item filenames are UUIDv4 values. Reads always require the same scope, and malformed references cannot become paths.
- Stored bytes stay on the local machine. Any remote processing needs a separate user approval in the broker.

## Limits and behavior

Defaults are 8 MiB per item, 128 MiB of stored content, 512 items, 32 KiB per read, a 256-byte summary, and seven-day retention. Configured values cannot exceed compiled hard ceilings: 16 MiB per item, 256 MiB of content, 1,024 items, and 64 KiB per read. The store serializes operations with one file lock across processes. An expired item is removed before quota checks; explicit scope purge and expiry purge are available. Usage reports content bytes and item count.

`put` returns an opaque reference, content hash, byte count, bounded summary, and expiry. `read_range` returns exact byte ranges after checking scope, expiry, length, and content hash. The caller chooses how to encode those bytes for an agent. Storage and quota errors return fixed warnings without embedding the original output.

Files are written to private per-scope directories with a temporary file and atomic rename. Under the store lock, orphan temporary files from interrupted writes are removed. On Unix, item opens reject symbolic links. The root must be owned by Sail in a private parent directory; this module does not provide an operating-system security boundary against another process running as the same user.

## Remaining #304 work

- Wire terminal, test, browser, and MCP output through the #302 broker, with a threshold that replaces large responses with summaries and references.
- Expose retention, size, usage, and purge controls in Sail's settings.
- Verify the broker derives each scope from trusted state and that remote providers never receive unapproved local content.
