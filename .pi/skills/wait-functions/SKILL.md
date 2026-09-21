---
name: wait-functions
description: How to build custom wait functions so a future dude agent run can be triggered by external events (file changes, PR updates, CI/redeploys) — including one-shot waits.
---

# wait functions: waking a future run of yourself

you (dude) run only when something signals you. the wait system is how you
arrange for a *future* version of yourself to be woken by an event, without
burning tokens polling on a timer. this skill explains the mechanism and
gives recipes.

## where the pieces live

- runner: `src/wait-runner.js` in the dude repo. one systemd timer
  (`dude-wait.timer`) runs it every **15 minutes**.
- bundled functions (read-only, nix store): `wait-functions/*.js` —
  e.g. `ai-tasks.js` fires the main agent when the task index checklist changes.
- **your functions dir** (writable): `~/.config/dude/wait-functions.d/`.
  the runner scans both. drop a `.js` file there and it's live next tick.
  the file name is the function name (and defaults to the purpose it invokes).
- state cache: `~/.config/dude/wait-state.json`, one key per function.
- lock: `~/.config/dude/wait-lock.json` — only one tick runs at a time;
  overlapping ticks are skipped, not queued.

## the contract

a wait function is a nodejs module exporting:

```js
// optional: which agent this wakes. default = the file name.
// `null` → main agent (no --purpose flag). a string → --purpose <name>.
export const purpose = null;
// optional: delete this file after its first clean fire (one-shot)
export const oneshot = true;

// state === whatever you returned as `state` last tick (persisted),
// or null on the very first run
export async function check({ state }) {
  // do a CHEAP check (read a file, gh api call, etc.)
  return {
    fire: true,                          // wake the agent now?
    context: "why you were woken ...",   // string, object of {key: text},
                                         // or array — passed via --context
    state: "...",                        // anything JSON-able; cached for next tick
  };
}
```

rules:

- first run must store a baseline and return `fire: false` (no state yet →
  nothing to diff against → don't fire).
- after a fired agent run exits cleanly, the runner re-baselines your state
  (runs check() again, persists it, ignores its fire). so if the agent edits
  the thing you watch during its run, it won't self-trigger next tick. if the
  agent run FAILS, state is left stale and the next tick retries. this is
  usually what you want.
- `oneshot: true` + clean fire ⇒ the file is deleted and state cleared.
  the wait is consumed. use this when a future run should be woken exactly
  once ("wake me when the deploy finishes, then forget it").
- context may be an object — e.g. `{ summary: "PR #12 merged", pr: 12, repo: "..." }`
  — it's flattened to `key: value` lines and handed to the agent as its
  wait-runner context. use this to make the wake-up cheap (no discovery pass).
- `state` must be JSON-serializable and CHEAP to compare. diff against your
  own last state, don't hardcode "last time" heuristics.

## testing your function before shipping it

```bash
mkdir -p /tmp/wf-test ~/.config/dude
cp your-function.js /tmp/wf-test/your-name.js
# isolated state so you don't clobber or read real wait-state
DUDE_WAIT_FUNCTIONS_DIR=/tmp/wf-test \
DUDE_WAIT_STATE_FILE=/tmp/wf-test/state.json \
dude-wait --check-only
# fires (without invoking the agent) only where it should
```

also: `node -e` quick checks on your check() logic, and always verify the
non-fire path (unchanged state → no fire) not just the fire path.

## recipes

### wait on a PR update / merge

```js
import { execSync } from "child_process";
const PR = 12, REPO = "johndikeman/dotfiles";
export const purpose = null; // main agent
export async function check({ state }) {
  const j = JSON.parse(execSync(
    `gh pr view ${PR} --repo ${REPO} --json state,headRefOid,title`, {encoding: "utf8"}));
  const sig = `${j.state}:${j.headRefOid}`;
  if (state?.sig === sig) return { fire: false, state };
  const first = state == null;
  return {
    fire: !first,   // baseline on first run
    context: first ? null : {
      summary: `PR #${PR} (${j.title}) is now ${j.state} at ${j.headRefOid}`,
      repo: REPO, pr: PR,
    },
    state: { sig },
  };
}
// don't export oneshot if you might want to fire again on later updates
```

### wait on the dotfiles redeploy (or any CI run)

```js
import { execSync } from "child_process";
const REPO = "johndikeman/dotfiles";
export const purpose = null;
export const oneshot = true; // wake once when the run finishes
export async function check({ state }) {
  const run = JSON.parse(execSync(
    `gh run list --repo ${REPO} --limit 1 --json databaseId,status,conclusion,headSha,workflowName`,
    {encoding: "utf8"}))[0];
  if (state?.id === run.databaseId) return { fire: false, state };
  const first = state == null;
  const done = run.status === "completed";
  return {
    fire: !first && done,   // only fire when a run you've seen started completes
    context: first ? null : {
      summary: `${run.workflowName} run ${run.databaseId} finished: ${run.conclusion}`,
      repo: REPO, run: run.databaseId,
    },
    state: { id: run.databaseId },
  };
}
```

(the same shape works for `gh pr checks`, cron job logs, log-file tails, etc.)

### one-shot self-reminder

need a future run poked exactly once after some external thing changes?
write a tiny function with `oneshot: true` into `~/.config/dude/wait-functions.d/`,
baseline it via `dude-wait --check-only` with isolated state (so it won't fire
on its first real tick), and note what you did in the task doc / agent log.
a later tick deletes the file after firing. don't leave one-shots pointing at
things that may never change — they're files on disk, cheap, but review.

## gotchas

- the lock: your fired agent run holds `wait-lock.json` for its whole run.
  a check that takes minutes should not live in check() — keep it fast.
- don't put secrets in functions; read them from env/1p like everything else.
- don't create functions that fire the agent every tick on purpose — that's
  what the timer already did and it's exactly what we deleted.
