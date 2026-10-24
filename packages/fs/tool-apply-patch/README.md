# coding-tool-apply-patch

`coding-tool-apply-patch` exposes the Codex-style `apply_patch` model tool over the existing filesystem seam. The current JSON-based LLM contract carries the patch as one required `input` string.

## Supported patch subset

The parser accepts Codex's `*** Begin Patch` / `*** End Patch` envelope, `*** Add File`, and `*** Update File` hunks with `@@` context, `+`/`-`/space lines, and `*** End of File`. Additions and updates call `ctx.fs.writeText` or `ctx.fs.editText`, so the existing observation policy, stale-version checks, sandbox fence, and remote filesystem routing remain authoritative.

`*** Delete File` and `*** Move to` are rejected explicitly. `coding-fs` does not expose delete or rename primitives, and the tool does not bypass that boundary with direct host filesystem calls.

## Model Experience

The tool adds one `tool:apply_patch` prompt section and the `apply_patch` schema. A successful result lists each added or updated path; replayable diff metadata is attached for the client tool surface. The patch text is request input and is not copied into the success summary.

#### KV Cache effect

The schema and guidance are stable while the package is mounted. Patch results are appended after the reusable request prefix.

## Known Limitations and Deferred Work

- Delete and move operations require explicit delete/rename capabilities in `coding-fs` and every filesystem provider before they can be enabled safely.
- The current Harness LLM contract represents the tool as a JSON function with one string property; native Responses `custom` freeform transport is not enabled by this package.
