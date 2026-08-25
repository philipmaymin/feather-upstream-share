---
name: sidecar
description: Spin up a sidecar — a second agent thread (its own context) paired to the current session that you chat with back and forth, brokered by Feather. Use when the user says /sidecar or wants an independent peer/critic to argue with or hand a subtask to. State lives in ~/.feather/sidecars/<id>/chat.jsonl; the peer is a normal Feather session.
---

# /sidecar — paired agent threads

A **sidecar** is just "another thread to chat with": Feather spawns a peer agent
session with its own fresh context, pairs it to *this* session, and brokers a
chat channel between you. You talk via the `sidecar` CLI; messages are recorded
in `chat.jsonl` and injected straight into each other's tmux. The peer is an
ordinary Feather session (shows up in the session list, resumable).

Sidecar provides the durable peer channel only; workflow-specific iteration and judgment belong to the caller.

## Install

Install the complete promoted capability bundle for Claude and Codex:

```bash
bin/refeather install-capabilities --release /opt/feather/releases/<commit> --target-root /opt/feather/current
```

Configure the exact instance URL when more than one Feather may be reachable:

```bash
export FEATHER_URL="https://host.example/feather2"
```

Without `FEATHER_URL`, `sidecar` probes `FEATHER_PORT`, 4870, and 3300, validates
the health shape, and succeeds only when exactly one instance answers. Use
`sidecar url` to show the selected base URL.

## How it works

- **Driver** = this session (identified by its tmux name, `f-<id8>`).
- **Peer** = the spawned sidecar session.
- **Send** = `sidecar post --to <role> "..."` → Feather appends to `chat.jsonl`,
  broadcasts to the GUI, and injects into the recipient's tmux.
- A per-session **lock** in Feather guarantees two senders never garble a pane,
  so either side can post anytime (no turn-taking required).

## Commands

### `/sidecar <task>` — spawn a peer and start talking

Register a group with the current session as the driver and spawn a `claude`
peer (use `"agent":"codex"` for a less-correlated second brain). The driver id is
just this session's tmux prefix:

```bash
DRIVER=$(tmux display-message -p '#S'); DRIVER=${DRIVER#feather-}
curl -s -X POST "$FEATHER_URL/api/sidecar" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg d "$DRIVER" --arg task "$1" \
        '{driverSessionId:$d, agent:"claude", task:$task}')"
```

The peer boots, is primed with how to reach you, and (if you passed a task)
starts on it. Then converse:

```bash
sidecar post --to peer "Here's my API design — poke holes in it: ..."
sidecar read                      # show the full thread
sidecar whoami                    # show this session's group(s)
```

Replies from the peer are injected straight into this session as
`[sidecar message from peer] ...`.

### `/sidecar list` — show groups

```bash
curl -s "$FEATHER_URL/api/sidecar" | jq -r '.groups[] | "\(.id)  [\(.status)]  \([.members[].role]|join(" ↔ "))  (\(.agent))"'
```

### `/sidecar show <id>` — inspect a thread

```bash
curl -s "$FEATHER_URL/api/sidecar/<id>" | jq -r '.thread[] | "[\(.from) → \(.to)] \(.text)"'
```

### `/sidecar kill <id>` — tear down

Kills the spawned peer session and marks the group done; `chat.jsonl` persists.

```bash
curl -s -X POST "$FEATHER_URL/api/sidecar/<id>/delete"
```

## Multiple peers (fan-out / judge panel)

A group can hold **N peers**, addressed by role name — the substrate for a generator + many critics.

```bash
# spawn a panel: one driver + three differentiated critics
DRIVER=$(tmux display-message -p '#S'); DRIVER=${DRIVER#feather-}
curl -s -X POST "$FEATHER_URL/api/sidecar" -H 'Content-Type: application/json' -d "$(jq -nc --arg d "$DRIVER" '{
  driverSessionId:$d, driverRole:"generator", agent:"claude",
  peers:[ {role:"critic-security",task:"Review only for security."},
          {role:"critic-perf",task:"Review only for performance."},
          {role:"critic-correctness",task:"Review only for correctness."} ]}')"

# add or drop a peer later
curl -s -X POST "$FEATHER_URL/api/sidecar/<id>/peers" -H 'Content-Type: application/json' -d '{"role":"critic-ux","task":"..."}'
curl -s -X POST "$FEATHER_URL/api/sidecar/<id>/peers/critic-ux/delete"
```

Addressing and collecting from the CLI:

```bash
sidecar post --to all "candidate ready — review it"     # broadcast to every other member
sidecar post --to critic-perf,critic-security "..."     # comma-list to a subset
sidecar wait --from all --count 3 --timeout 120         # block until 3 distinct peers reply
sidecar read --since 12 --from critic-perf              # filter the thread by seq / sender
```

Roles are unique per group and shell-safe. Each message carries a monotonic `seq` so fan-in
ordering survives millisecond ties. If this session is in **several** groups, pass `--group <id>`
(or export `SIDECAR_GROUP`) — otherwise addressing is by most-recent group.

The **aggregation policy** (majority / weighted / veto) lives in the generator's prompt, not the
broker — the broker only addresses and collects. See `docs/plans/2026-06-27-002-feat-sidecar-multipeer-plan.md`.

## State files

- `~/.feather/sidecars/groups.json` — the group registry (`{id, members:[{sessionId, role, spawned}], agent, task, status, createdAt}`).
- `~/.feather/sidecars/<id>/chat.jsonl` — the durable message record (`{ts, from, to, text}` per line).

## GUI

The **Sidecar** sidebar tab in Feather lists groups and renders the live thread,
with buttons to open each member session. Spawn/kill from there too.

## Notes

- The `sidecar` CLI self-identifies via its tmux session name, so it only works
  from inside a `feather-*` session. Outside one it errors clearly.
- `--to <role>` is the *other* member's role (`peer` by default; the driver is
  `driver`). Add more roles later by extending the members list — addressing is
  by name, so N peers is the same shape as one.
