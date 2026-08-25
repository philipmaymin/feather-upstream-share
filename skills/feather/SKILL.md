---
name: feather
description: Manage a running Feather session viewer — health, logs, quick links, projects, and guarded versioned releases. Use when the user says /feather.
---

# /feather — server ops

Set the exact mounted instance URL. This is authoritative and prevents a CLI
from selecting another local Feather process:

```bash
export FEATHER_URL="https://host.example/feather2"
```

## Install

Install the complete promoted bundle for Claude and Codex:

```bash
bin/refeather install-capabilities --release /opt/feather/releases/<commit> --target-root /opt/feather/current
```

(Run from the feather repo root.)

## Health

```bash
curl -sf "$FEATHER_URL/api/health" | python3 -m json.tool
```

Non-200 → server is down. Returns `{version, ...}`.

## Logs

Depends on how feather is running:

| Runtime | Tail logs |
|---------|-----------|
| supervisord (`infra/feather.supervisor.conf`) | `supervisorctl tail -f feather stdout` |
| systemd (`infra/feather.service`) | `journalctl -u feather -f` |
| foreground `npm start` | look at the terminal |

## Restart

| Runtime | Command |
|---------|---------|
| supervisord | `supervisorctl restart feather` |
| systemd | `systemctl restart feather` |
| foreground | `Ctrl-C` then `npm start` |

## Stage and promote

```bash
release=$(bin/refeather stage --source path/to/clean/feather --releases-dir /opt/feather/releases)

# Supervisor
sudo bin/refeather promote --release "$release" --current-link /opt/feather/current \
  --program feather-zak --supervisor-socket unix:///run/supervisor.sock \
  --health-url http://127.0.0.1:8123/feather2/api/health

# Or systemd; name every unit sharing the release pointer
sudo bin/refeather promote --release "$release" --current-link /opt/feather/current \
  --systemd-unit feather.service --systemd-unit feather-philip.service \
  --health-url http://127.0.0.1:4871/api/health
```

Staging never restarts a service. Promotion refuses an unsafe source unless a
complete archive receipt was supplied, owns the host deployment lock, switches
the stable release link atomically, and verifies the exact built version.
Supervisor and systemd transactions use the same journaled rollback; repeated
`--systemd-unit` options stop and restart the complete shared-pointer unit set.
Run `bin/refeather recover` after an interrupted promotion. Follow
`docs/runbooks/refeather.md`; never rebase a personalized deployment checkout.

After deploy, both `/api/health` and the frontend tab bar should show the same fresh version timestamp.

## Refeather

Use the staged release workflow above. `refeather` never pulls, rebases,
resets, or edits the source checkout.

After deploy, sanity-check `/api/health` and click through any feature you
just integrated to confirm it still works (a passing build doesn't prove
runtime behavior).

## Quick links

The "Links" tab in the sidebar reads `quick-links.json`.

```bash
# List
curl -s "$FEATHER_URL/api/quick-links" | python3 -m json.tool

# Add
links=$(curl -s "$FEATHER_URL/api/quick-links")
curl -s -X POST "$FEATHER_URL/api/quick-links" \
  -H "Content-Type: application/json" \
  -d "$(echo "$links" | python3 -c "import sys,json; l=json.load(sys.stdin); l.append({'label':'LABEL','url':'URL'}); print(json.dumps(l))")"

# Remove
links=$(curl -s "$FEATHER_URL/api/quick-links")
curl -s -X POST "$FEATHER_URL/api/quick-links" \
  -H "Content-Type: application/json" \
  -d "$(echo "$links" | python3 -c "import sys,json; l=json.load(sys.stdin); l=[x for x in l if x['label']!='LABEL']; print(json.dumps(l))")"
```

## Projects

The "Projects" section in the sidebar reads `project-labels.json`. It's an
allowlist: a project shows up only if its Claude-encoded directory name is a
key in this file. The value is the display label (or `null` to use the
auto-derived basename). Use ` / ` in the label to make a two-level group, e.g.
`"crypto / hft"` puts it under a "crypto" group.

A project ID is the directory name under `~/.claude/projects/`, which Claude
encodes from your cwd by replacing `/` with `-`. So `/home/user/feather`
becomes `-home-user-feather`. Encode helper:

```bash
encode_project_id() { echo "$(realpath "${1:-$PWD}")" | sed 's|/|-|g'; }
```

```bash
# List
curl -s "$FEATHER_URL/api/projects" | python3 -m json.tool

# Add current dir (auto label)
id=$(encode_project_id)
curl -s -X POST "$FEATHER_URL/api/projects/$id/label" \
  -H "Content-Type: application/json" -d '{"label":null}'

# Add a path with custom label
id=$(encode_project_id ~/life/taxes)
curl -s -X POST "$FEATHER_URL/api/projects/$id/label" \
  -H "Content-Type: application/json" -d '{"label":"life / taxes"}'

# Remove
id=$(encode_project_id ~/old-experiment)
curl -s -X DELETE "$FEATHER_URL/api/projects/$id"
```

## Sub-commands

| Command | What it does |
|---------|--------------|
| `/feather` or `/feather status` | Hit `/api/health` |
| `/feather logs` | Tail logs (best-effort detect supervisord/systemd) |
| `/feather restart` | Restart the server |
| `/feather deploy` | Stage, then explicitly promote a versioned release |
| `/feather refeather` | Run the guarded workflow in `docs/runbooks/refeather.md` |
| `/feather links` | List quick links |
| `/feather add link LABEL URL` | Append a quick link |
| `/feather remove link LABEL` | Remove a quick link by label |
| `/feather projects` | List projects in the allowlist |
| `/feather add project [PATH] [--label LABEL]` | Add to allowlist (default PATH = `pwd`) |
| `/feather remove project [PATH]` | Remove from allowlist (default PATH = `pwd`) |
