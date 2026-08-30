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
allowlisted to health; feed, Room, project, search, activity, usage, identity,
and build summaries; session messages, streams, exports, protocol runs, and
Room membership; Room updates, friction, residents, Wiki index, and Wiki pages;
Sidecar lists, threads, and streams; quick links, mute state, push subscriptions,
starred messages; and classified file, local-media, bridge, and protocol reads.
Unknown future GET endpoints remain closed until explicitly classified.

Every other API request receives HTTP 403 with:

```json
{ "error": "read-only canary", "code": "FEATHER_READ_ONLY" }
```

This includes all POST/DELETE mutations, uploads, transcription, push-key
generation, session/tmux control, session model changes, Leader or resident
changes, Room updates, Sidecar delivery and cleanup, and editor launch.

Terminal, shell, and streaming-transcription WebSocket upgrades receive HTTP
403 before WebSocket, PTY, or upstream connection creation. The idle reaper,
auto-title/activity controllers, notification poller, Room pulses, Sidecar
synchronization/priming, and Sidecar garbage collection are disabled, and
startup does not create or chmod state paths.

## Deployment containment

Application read-only mode is one canary gate, not an OS sandbox. A real canary
must also use copied `HOME` and `FEATHER_STATE_DIR` trees, a private `TMPDIR` and
`TMUX_TMPDIR`, loopback-only listening, read-only source mounts, and no production
home/state/tmux bind mounts. Before exposure, the migration preflight must reject
absolute symlinks, sockets, temporary paths, mounts, or writable realpaths that
escape those copied roots. The server's JSON-state layer separately rejects
recorded state files that resolve outside their configured state root.

The canary gate must record the process PID, install a termination trap, and
verify that both that process and its listener are gone before promotion.
Closing SSH or a hub session is not cleanup for a detached canary. After an
interrupted gate, match the recorded PID to its command line before terminating
it; never kill an unverified PID.
