# Guarded Feather release workflow

`bin/refeather` replaces in-place checkout rebases with immutable release
staging and an explicit sole-writer promotion. It never fetches, rebases,
resets, merges, or edits the source worktree.

## Paths and runtime identity

Choose these once per host and keep them in the operator receipt:

```bash
export REFEATHER_RELEASES_DIR=/opt/feather/releases
export REFEATHER_CURRENT_LINK=/opt/feather/current
export REFEATHER_JOURNAL_DIR=/var/lib/feather/refeather
export REFEATHER_LOCK_FILE=/var/lock/feather-refeather.lock
export REFEATHER_HEALTH_URL=http://127.0.0.1:8123/feather2/api/health
```

Choose exactly one service manager identity. For Supervisor:

```bash
export REFEATHER_SUPERVISOR_PROGRAM=feather-zak
export REFEATHER_SUPERVISOR_SOCKET=unix:///run/supervisor.sock
```

For systemd, list every unit that reads the same stable release pointer:

```bash
export REFEATHER_SYSTEMD_UNITS="feather.service feather-philip.service"
```

Each declared service must execute the stable current link, use external mutable
state, and include the installed CLI directory on `PATH`. `refeather` does not
infer a service identity, release link, or health URL from a checkout or port.

## 1. Stage without changing production

```bash
release=$(bin/refeather stage \
  --source /srv/feather/source \
  --releases-dir "$REFEATHER_RELEASES_DIR")
```

Staging verifies dependencies, disk projection, Git conflicts, tracked and
untracked changes, and commits ahead of the configured upstream. It archives
HEAD into `<releases>/<full-commit>`, builds inside that temporary tree, writes
`.refeather-release.json`, removes write permission, and atomically publishes
the release directory. It never changes `current` or invokes the service manager.

Use `--check-port <canary-port>` when reserving a canary listener. A collision
stops staging.

### Personalized or unpushed source

Unsafe source proceeds only with `--archive-receipt FILE`. Receipt schema 1
must name the exact `sourceCommit` and four independently hash-verified files:

```json
{
  "schema": 1,
  "sourceCommit": "full Git commit",
  "artifacts": {
    "refs": { "path": "refs.bundle", "sha256": "..." },
    "binaryDiff": { "path": "worktree.diff", "sha256": "..." },
    "untracked": { "path": "untracked.tar", "sha256": "..." },
    "mutableState": { "path": "state.tar", "sha256": "..." }
  }
}
```

Paths may be relative to the receipt. An unresolved Git conflict always stops;
an archive receipt cannot make a conflicted index deployable.

## 2. Install and preflight capabilities

```bash
bin/refeather install-capabilities \
  --release "$release" \
  --target-root "$REFEATHER_CURRENT_LINK"
```

This installs Feather, Sidecar, and Looper into both `~/.claude/skills` and
`~/.codex/skills`, and `room`, `sidecar`, plus `refeather` into `~/.local/bin`. Existing
correct links are left alone. A file or foreign link is copied into a conflict
evidence directory and causes a full preflight abort; nothing is overwritten.
Promotion runs the same preflight by default before stopping the service.

Inside an OMP session, the local CLIs use its health-checked bridge metadata to
target the Feather instance that launched it. Outside a session, fallback probes
`FEATHER_PORT` (or legacy `PORT` when `FEATHER_PORT` is unset), 4870, and 3300,
and refuses zero or multiple Feather-shaped responses.

## 3. Promote as the sole writer

Run any canary/backup gate through `--pre-promote-check` before quiescing.
Supervisor example:

```bash
sudo -E bin/refeather promote \
  --release "$release" \
  --current-link "$REFEATHER_CURRENT_LINK" \
  --program "$REFEATHER_SUPERVISOR_PROGRAM" \
  --supervisor-socket "$REFEATHER_SUPERVISOR_SOCKET" \
  --health-url "$REFEATHER_HEALTH_URL" \
  --pre-promote-check '/path/to/canary-gate'
```

Systemd example, with every unit that shares the pointer:

```bash
sudo -E bin/refeather promote \
  --release "$release" \
  --current-link "$REFEATHER_CURRENT_LINK" \
  --systemd-unit feather.service \
  --systemd-unit feather-philip.service \
  --health-url "$REFEATHER_HEALTH_URL" \
  --pre-promote-check '/path/to/canary-gate'
```

Promotion verifies the staged release content hash immediately before mutation,
takes the host lock, writes `active.json` and an fsynced JSONL phase journal,
stops the declared program or unit set, atomically replaces `current`, starts the
same services, and requires `/api/health.version` to equal the staged manifest.
Service operations have a finite timeout (`REFEATHER_SERVICE_TIMEOUT`, 15
seconds by default; the older `REFEATHER_SUPERVISOR_TIMEOUT` remains honored).
An ordinary failure is recovered only after the prior link, prior services,
listener, and exact prior health version are all verified. The durable state
records the manager and complete unit set, so `recover` cannot use the wrong
backend after host loss. Record the completed state JSON and journal with the
migration receipt.

## Recovery and rollback

After host loss or an untrappable process termination:

```bash
sudo -E bin/refeather recover
```

`recover` owns the same lock. A transaction interrupted before service
mutation is finalized as a no-op; one interrupted from stop through health
verification restores and verifies the recorded prior release; an already
promoted transaction is only finalized.

To deliberately return to a retained compatible release, pass the same service
manager identity used for promotion. Systemd example:

```bash
sudo -E bin/refeather rollback \
  --release /opt/feather/releases/<prior-commit> \
  --current-link "$REFEATHER_CURRENT_LINK" \
  --systemd-unit feather.service \
  --systemd-unit feather-philip.service \
  --health-url "$REFEATHER_HEALTH_URL"
```

Supervisor deployments use `--program` and `--supervisor-socket` instead.
Rollback uses the same lock, phase journal, atomic link, health-version gate,
and failure restoration. It does not restore an older state snapshot; state
schema compatibility must already have passed the separate downgrade gate.

If restoration cannot be verified, the journal records `rollback-failed` and
retains `active.json`. Repair the underlying service manager or listener issue
and rerun `refeather recover`; do not remove the active transaction by hand.

## Failure gates and retained evidence

Stop before promotion for an incomplete restore rehearsal, malformed state,
unreconciled transcript prefixes, active second writer, failed canary,
conflicting capabilities, or version mismatch. Retain source archive receipts,
release manifests, pre/post state hashes, the current/prior release targets,
service-manager identity, journal JSONL, completed transaction state, and the exact
recovery command. Never include secret values in these receipts.
