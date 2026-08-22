# Feather JSON state compatibility

Feather's durable JSON documents intentionally remain in their pre-U9 shapes.
U9 changes how whole documents reach disk, not their wire or file schema. Each
write validates the complete next value, writes and fsyncs a temporary file in
the target directory, atomically renames it, then fsyncs the directory. The
previous valid bytes are retained beside the resolved target as
`<name>.last-good`.

Mutations are serialized within one Node process and reject reentrant writes to
the same resolved target. This is not a distributed lock: deployment must still
enforce one writer process per state root.

Missing and corrupt state are different conditions. A genuinely missing target
uses the default below without creating a file. An existing malformed or
shape-invalid target fails startup, reads, and mutations. If a recovery copy
exists while its target is missing or corrupt, recovery must be requested
explicitly; Feather never silently substitutes or overwrites it.

## Compatibility matrix

All current schemas are **v0 (unversioned)**. Adding a version envelope or
changing a root type requires a new matrix row/version and a downgrade adapter
before the new writer may be deployed.

| Document | Owner/root | Valid v0 root | Missing default | Mutation compatibility with `601c2dc` | Mode |
|---|---|---|---|---|---|
| `session-meta.json` | Instance state | Object keyed by session id | `{}` | Per-session updates spread existing records; deletion removes only the selected id | Existing mode, new `0644` |
| `project-labels.json` | Instance state | Object keyed by project id | `{}` | Label updates preserve all other keys | Existing mode, new `0644` |
| `quick-links.json` | Instance state | Array | `[]` | Whole-array API remains unchanged; clients own the complete array | Existing mode, new `0644` |
| `starred.json` | Instance state | Object | `{}` | Whole-object API remains unchanged; clients own the complete object | Existing mode, new `0644` |
| `muted.json` | Instance state | Array of session ids | `[]` | Whole-array API remains unchanged | Existing mode, new `0644` |
| `push-keys.json` | Instance state | Object | `{}` | Existing key pair is retained; generation writes the same shape | `0600` |
| `push-subscriptions.json` | Instance state | Array | `[]` | Endpoint updates preserve unrelated subscriptions | Existing mode, new `0644` |
| `room-sessions.json` | `~/.feather` coordination state | Object mapping session id to Room name | `{}` | Assignment updates preserve all other mappings | Existing mode, new `0644` |
| `sidecars/groups.json` | `~/.feather/sidecars` coordination state | Object keyed by group id | `{}` | Group/member/sequence updates preserve unknown document and group fields | Existing mode, new `0644` |

`sidecars/<id>/chat.jsonl` and agent transcripts are append-only event streams,
not whole-document JSON state, so they are outside this primitive and matrix.
Release `version.json` is an immutable release asset, not instance state.

## Rollback gate

Rollback is allowed only with all writers stopped and on a copied state root.
The candidate old release must read every non-missing document, perform the
representative mutation for each affected row, and leave unrelated keys and
unknown fields intact. Compare parsed documents and file modes before allowing
that release to touch the sole-writer root. If any future schema is not marked
compatible, use its tested downgrade adapter; restoring an older snapshot after
accepted new writes would discard those writes.

The automated rehearsal starts the single-server build against a temporary
external state root, verifies that copied quick-link state remains readable,
performs a representative mutation, and confirms that no fallback state leaked
under the temporary home. The other rows retain their exact v0 root types and
mutation shapes; a production cutover still requires the per-document
copied-state rehearsal above rather than treating that representative test as
production authorization.
