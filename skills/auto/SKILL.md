---
name: auto
description: Manage autonomous improvement instances via Feather's /api/auto endpoints. Use when user says /auto or wants to start/stop/inspect a self-improving loop. Each instance lives in ~/auto-NAME/ with run.sh + program.md + results.tsv. Pipeline definitions live in feather-next/templates/auto/*.json.
---

# /auto — autonomous loop control

## Install

Symlink this directory into your Claude skills dir, then restart Claude Code:

```bash
ln -sf "$(pwd)/skills/auto" ~/.claude/skills/auto
```

(Run from the feather-next repo root.) The skill talks to a running Feather server's `/api/auto/*` endpoints.

Set `PORT` to your feather port (4870 by default). All `curl` examples below use `localhost:$PORT`:

```bash
export PORT=4870   # change to match your install
```

## Pipelines

A pipeline is a JSON file in `feather-next/templates/auto/`. It lists the phases (designer / worker / verifier / simplifier / …) and which engine runs each. Three ship by default:

| Pipeline | Phases | Engine | Use for |
|----------|--------|--------|---------|
| `simple` | 1 | claude | trivial goals, harness tests |
| `all-claude` | 5 + 1/10 reviewer | claude | full cycle without codex |
| `claude-codex` | 6 + 1/10 reviewer | claude+codex | real codebase work |

Add your own by dropping `<name>.json` into `templates/auto/` (see existing files for the schema). `GET /api/auto/pipelines` lists what's available.

Legacy `template:"simple"` and `template:"full"` still work; `full` maps to `claude-codex`.

## Commands

### `/auto status` (or `/auto`)

```bash
curl -s localhost:$PORT/api/auto/instances | python3 -c "
import json, sys
for i in json.load(sys.stdin)['instances']:
    flag = '●' if i['running'] else '○'
    print(f\"{flag} {i['name']:20} k={i['keeps']:3} r={i['reverts']:2} c={i['crashes']:2} — {i['current'][:80]}\")
"
```

### `/auto pipelines`

```bash
curl -s localhost:$PORT/api/auto/pipelines | python3 -m json.tool
```

### `/auto new <name> [args]`

**simple** (claude-only, ~30s/iter — for quick goals like "what is 1+1"):
```bash
curl -s -X POST localhost:$PORT/api/auto/instances \
  -H "Content-Type: application/json" \
  -d '{"name":"NAME","pipeline":"simple","goal":"GOAL TEXT"}'
```

**all-claude** (5-phase, claude-only, real codebase work without codex):
```bash
curl -s -X POST localhost:$PORT/api/auto/instances \
  -H "Content-Type: application/json" \
  -d '{"name":"NAME","pipeline":"all-claude","target":"/path/to/file","url":"https://...","repo":"/path/to/repo"}'
```

**claude-codex** (default, 6-phase claude+codex):
```bash
curl -s -X POST localhost:$PORT/api/auto/instances \
  -H "Content-Type: application/json" \
  -d '{"name":"NAME","pipeline":"claude-codex","target":"/path/to/file","url":"https://...","repo":"/path/to/repo"}'
```

After create, edit `~/auto-NAME/program.md` to flesh out CAN/CANNOT/verify, then start.

### `/auto start <name>` / `/auto stop <name>`

```bash
curl -s -X POST localhost:$PORT/api/auto/instances/NAME/start
curl -s -X POST localhost:$PORT/api/auto/instances/NAME/stop
```

### `/auto focus <name> <text>`

Replace (or append) `## CURRENT FOCUS` section in program.md.
```bash
curl -s -X POST localhost:$PORT/api/auto/instances/NAME/focus \
  -H "Content-Type: application/json" -d '{"focus":"TEXT"}'
```

### `/auto btw <name> <note>`

Append a timestamped note to `## Known issues` (worker picks up next iteration).
```bash
curl -s -X POST localhost:$PORT/api/auto/instances/NAME/btw \
  -H "Content-Type: application/json" -d '{"note":"TEXT"}'
```

### `/auto link <name> <sessionId>`

Bind a Feather chat session as the "main chat" for this instance (steering wheel).
```bash
curl -s -X POST localhost:$PORT/api/auto/instances/NAME/link \
  -H "Content-Type: application/json" -d '{"sessionId":"SID"}'
```

### `/auto show <name>`

```bash
curl -s localhost:$PORT/api/auto/instances/NAME | python3 -m json.tool
```

### `/auto tail <name>`

```bash
tail -f ~/auto-NAME/auto.log    # supervisor stdout
ls -t ~/auto-NAME/logs/ | head -3  # per-iteration claude/codex output
```

### `/auto deploy <name>`

Per-instance deploy. If `~/auto-NAME/deploy.sh` exists, run it. Otherwise ask the user how their project ships and write the script for them — once it exists, future `/auto deploy <name>` invocations are a single `bash ~/auto-NAME/deploy.sh`.

## Files per instance

| Path | Purpose |
|------|---------|
| `~/auto-NAME/run.sh` | Loop harness (generated from pipeline JSON) |
| `~/auto-NAME/program.md` | Goal + focus + bugs + constraints |
| `~/auto-NAME/results.tsv` | timestamp \t status \t description |
| `~/auto-NAME/current.txt` | One-line live status |
| `~/auto-NAME/auto.pid` | Running pid (used by /api/auto) |
| `~/auto-NAME/auto.log` | Stdout from harness |
| `~/auto-NAME/logs/` | Per-iteration claude/codex output |
| `~/auto-NAME/main_chat.txt` | Bound Feather session id (optional) |
| `~/auto-NAME/deadline` | Epoch deadline for current iter |

## Notes

- Names: lowercase alphanumeric + dashes, max 30 chars.
- `claude-codex` and `all-claude` honor the `repo` field for the codex `-C` working dir; pass any existing dir if you don't have a real repo.
- `simple` is claude-only, 10-min timeout, no codex calls. Use for harness tests or trivial goals.
