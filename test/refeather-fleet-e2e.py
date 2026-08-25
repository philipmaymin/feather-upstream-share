#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "bin" / "refeather-fleet"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")


def release(root, name, version):
    target = root / name
    target.mkdir()
    write_json(target / ".refeather-release.json", {
        "schema": 2,
        "sourceCommit": name,
        "version": version,
        "treeHash": f"hash-{name}",
    })
    return target


def point(link, target):
    link.parent.mkdir(parents=True, exist_ok=True)
    link.unlink(missing_ok=True)
    link.symlink_to(target)


def invoke(*args, env=None, expected=0):
    result = subprocess.run([str(CLI), *map(str, args)], text=True, capture_output=True, env=env)
    assert result.returncode == expected, result.stderr or result.stdout
    return result


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    old = release(root, "old", "old-v1")
    first = release(root, "first", "candidate-v1")
    second = release(root, "second", "candidate-v2")
    canary = root / "canary-current"
    point(canary, first)
    instances = []
    links = {}
    for index, name in enumerate(("tobin", "maya"), start=1):
        current = root / name / "current"
        point(current, old)
        links[name] = current
        instances.append({
            "name": name,
            "home": str(root / name),
            "currentLink": str(current),
            "systemdUnit": f"feather-{name}.service",
            "healthUrl": f"http://127.0.0.1:{4900 + index}/api/health",
            "journalDir": str(root / "journal" / name),
            "lockFile": str(root / "lock" / f"{name}.lock"),
        })
    config = root / "fleet.json"
    write_json(config, {"schema": 1, "instances": instances})
    state = root / "schedule.json"
    log = root / "switches.jsonl"
    fake = root / "fake-refeather"
    fake.write_text("""#!/usr/bin/env python3
import json, os
from pathlib import Path
import sys
args=sys.argv[1:]
action=args[0]
def value(flag): return args[args.index(flag)+1]
current=Path(value('--current-link'))
release=Path(value('--release')).resolve()
with open(os.environ['SWITCH_LOG'],'a',encoding='utf-8') as h: h.write(json.dumps({'action':action,'current':str(current),'release':str(release)})+'\\n')
if action == 'promote' and os.environ.get('FAIL_CURRENT') == str(current): sys.exit(7)
tmp=Path(str(current)+'.tmp')
tmp.unlink(missing_ok=True)
tmp.symlink_to(release)
os.replace(tmp,current)
""", encoding="utf-8")
    fake.chmod(0o755)
    environment = {**os.environ, "SWITCH_LOG": str(log)}
    idle = invoke("run", "--state", root / "idle.json", "--refeather", fake, env=environment)
    assert json.loads(idle.stdout)["status"] == "idle"


    invoke("schedule", "--release", first, "--canary-current", canary,
           "--fleet-config", config, "--state", state, "--delay-seconds", "0")
    invoke("run", "--state", state, "--refeather", fake, env=environment)
    completed = json.loads(state.read_text())
    assert completed["status"] == "completed"
    assert all(link.resolve() == first for link in links.values())

    point(canary, first)
    invoke("schedule", "--release", first, "--canary-current", canary,
           "--fleet-config", config, "--state", state)
    point(canary, second)
    invoke("schedule", "--release", second, "--canary-current", canary,
           "--fleet-config", config, "--state", state)
    pending = json.loads(state.read_text())
    assert pending["release"] == str(second)
    assert list((root / "schedule.json.history").glob("*-superseded.json"))

    point(canary, first)
    invoke("schedule", "--release", first, "--canary-current", canary,
           "--fleet-config", config, "--state", state, "--delay-seconds", "0")
    point(canary, second)
    invoke("run", "--state", state, "--refeather", fake, env=environment)
    assert json.loads(state.read_text())["status"] == "superseded"

    point(canary, first)
    for current in links.values(): point(current, old)
    invoke("schedule", "--release", first, "--canary-current", canary,
           "--fleet-config", config, "--state", state, "--delay-seconds", "0")
    failing_environment = {**environment, "FAIL_CURRENT": str(links["maya"])}
    invoke("run", "--state", state, "--refeather", fake, env=failing_environment, expected=1)
    failed = json.loads(state.read_text())
    assert failed["status"] == "failed"
    assert links["tobin"].resolve() == old
    assert links["maya"].resolve() == old
    failed["status"] = "running"
    failed["nextAttemptAt"] = 0
    write_json(state, failed)
    invoke("run", "--state", state, "--refeather", fake, env=environment)
    assert json.loads(state.read_text())["status"] == "completed"
    assert all(link.resolve() == first for link in links.values())

print("refeather-fleet-e2e: PASS")
