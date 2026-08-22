# Read-only canary contract

Set `FEATHER_READ_ONLY=1` to start Feather as an inspection-only server. This
is enforced by the backend; hiding controls in the SPA is optional presentation,
not the security boundary.

`GET /api/health` reports the active contract under `capabilities`:

```json
{
  "readOnly": true,
  "mutations": false,
  "terminal": false,
  "shell": false,
  "backgroundControllers": false
}
```

## Allowed HTTP surface

Static assets and non-API GET/HEAD requests remain readable. API GET/HEAD is
allowlisted to health, session lists/messages/streams/exports, Sidecar
lists/threads/streams, project/search/activity summaries, quick links, mute and
push-subscription reads, starred messages, file reads/previews, agents, auth
identity, build version, and Rooms.

Every other API request receives HTTP 403 with:

```json
{ "error": "read-only canary", "code": "FEATHER_READ_ONLY" }
```

This includes all POST/DELETE mutations, unknown future GET endpoints, uploads,
transcription, push-key generation, session/tmux control, Room changes, Sidecar
delivery and cleanup, and editor launch.

Terminal, shell, and streaming-transcription WebSocket upgrades receive HTTP
403 before WebSocket, PTY, or upstream connection creation. The idle reaper,
auto-title/activity controllers, notification poller, and Sidecar garbage
collection are disabled, and startup does not create or chmod state paths.

## Deployment containment

Application read-only mode is one canary gate, not an OS sandbox. A real canary
must also use copied `HOME` and `FEATHER_STATE_DIR` trees, a private `TMPDIR` and
`TMUX_TMPDIR`, loopback-only listening, read-only source mounts, and no production
home/state/tmux bind mounts. Before exposure, the migration preflight must reject
absolute symlinks, sockets, temporary paths, mounts, or writable realpaths that
escape those copied roots. The server's JSON-state layer separately rejects
recorded state files that resolve outside their configured state root.
