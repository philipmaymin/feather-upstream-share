---
name: looper
description: Run a generator-evaluator loop — spawn an independent evaluator agent (its own context) that inspects the REAL artifact, critiques it against a rubric, and loops until [APPROVED]. Use when the user says /looper or wants iterative build → critique → revise on anything with a checkable artifact (a webpage, a README, a doc, code). Built on Feather sidecars.
---

# /looper — generator ↔ evaluator loop

The Anthropic harness pattern, distilled: a **generator** builds, an **independent-context
evaluator** judges the *real artifact* (not the generator's description of it), and they loop
until the work genuinely passes. Separating the maker from the judge beats self-review — a model
grading its own work rubber-stamps it.

- **Generator** = the current session (you're driving it).
- **Evaluator** = a sidecar peer spawned in the **same working directory**, so it can read, render,
  and exercise the actual output.

The one rule that makes it work: **the evaluator must inspect the real thing.** Open the page in a
browser, run the tests, exercise the app — never grade the generator's claims. Otherwise you've
rebuilt self-evaluation with extra steps.

## Setup (uses the sidecar broker — see /sidecar)

Install Looper together with Feather and Sidecar for both harnesses using
`bin/refeather install-capabilities`, and set the exact `FEATHER_URL` for the
promoted instance.

Spawn the evaluator in the project dir, primed with a rubric. `driverRole=generator`,
`peerRole=evaluator`, and **`cwd` = the project**:

```bash
DRIVER=$(tmux display-message -p '#S'); DRIVER=${DRIVER#f-}
RUBRIC='You are the EVALUATOR in a generator-evaluator loop. The generator is building <ARTIFACT> in your working directory.
Judge the REAL artifact, never the generator'\''s description:
1. Read it. 2. RENDER/RUN it — for a UI, serve it and open it in a browser (Playwright via ~/.cache/ms-playwright chromium, or the connect-chrome/browse skill) or screenshot it; for code, run the tests. If you truly cannot, say so and grade from source as a fallback.
3. Grade each criterion 1-10 with a concrete reason: <CRITERIA, e.g. design quality, originality, craft, functionality>.
4. Be specific and actionable — cite exact issues, not vibes. Measure where you can (DOM coords, contrast, test output).
5. Post your critique to the generator:  sidecar post --to generator "..."  — top fixes first.
6. Write [APPROVED] only when it genuinely clears a high bar on every criterion. Otherwise list what to fix and wait for "ready for review".
Do your first review NOW.'

curl -s -X POST "$FEATHER_URL/api/sidecar" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg d "$DRIVER" --arg t "$RUBRIC" \
        '{driverSessionId:$d, driverRole:"generator", peerRole:"evaluator", agent:"claude", cwd:"<PROJECT_DIR>", task:$t}')"
```

Use `agent:"codex"` for the evaluator when you want a different-model, less-correlated critic.

## The loop

1. **Build** the artifact (you're the generator).
2. **Submit:**  `sidecar post --to evaluator "ready for review — <what changed>"`
3. **End your turn.** The evaluator renders/runs the artifact and posts a critique, which arrives
   injected into your session as `[sidecar message from evaluator] …`.
4. **Revise** against the critique, then submit again.
5. Repeat until the evaluator posts **`[APPROVED]`**.

Ping-pong (submit, then end your turn) keeps it idle-by-construction — no mid-generation injection.

## Teardown

```bash
curl -s "$FEATHER_URL/api/sidecar" | jq -r '.groups[] | select(any(.members[]; .role=="evaluator")) | .id'   # find it
curl -s -X POST "$FEATHER_URL/api/sidecar/<id>/delete"   # kills the evaluator session
```

## Notes

- **No `contract.md`.** When the artifact is real code/a real page the evaluator inspects directly,
  the "contract" is just the evaluator's running critique — which already lives in the chat thread.
- **Tools the evaluator needs:** for visual artifacts, browser/screenshot (Playwright's bundled
  chromium lives in `~/.cache/ms-playwright`; the system `/usr/bin/chromium-browser` is a broken
  snap stub — don't use it). For code, the test runner.
- **One evaluator today.** A generator + N differentiated critics (a judge panel) is the multi-peer
  increment — see `docs/plans/2026-06-27-002-feat-sidecar-multipeer-plan.md`.
- **vs `Workflow` parallel()+schema:** use that for stateless, deterministic, high-fan-out batch
  judging; use `/looper` for **iterative, stateful, human-inspectable** loops where the critic
  remembers prior rounds.
