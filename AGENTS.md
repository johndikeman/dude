# AGENTS.md — dude-agent architecture + self-update guide

this is the map of the dude-agent codebase for future agent runs. read it
before changing anything here. last full audit: 2026-09-28 (self-audit task).

## what dude is

dude is a self-improving coding agent that runs on john's vps inside the
pi coding-agent runtime (`@earendil-works/pi-coding-agent`). it has a
discord presence, processes a task list in an obsidian vault, runs
special-purpose agents (prediction markets, meal planning), and manages
its own deployment through nix/home-manager.

repos:
- `johndikeman/dude` — this repo, the agent runtime
- `johndikeman/dotfiles` (branch `vps_nix`) — vps config; flake input pins dude-agent; push = auto-deploy
- `johndikeman/dude-prediction-markets` — deterministic pm runner (this repo only supplies the LLM purpose)
- workspace: `/home/ubuntu/dude-workspace`, vault: `/home/ubuntu/vault`, config: `/home/ubuntu/.config/dude`

## source layout (`src/`)

| file | what it does |
|---|---|
| `index.js` | entry point + discord bot. resolves paths, builds prompt, creates the pi session, runs it, relays results to discord. also SIGTERM/interrupt handling. |
| `agent-lock.js` | cross-process lock at `$DUDE_CONFIG_DIR/agent-lock.json` `{pid, startedAt, purpose}`. exit 75 = "skipped, busy". dead-pid takeover + age-stale takeover (6h default, `DUDE_AGENT_LOCK_MAX_AGE_MS`). |
| `runtime-cap.js` | wall-clock cap per run (default 4h, `DUDE_MAX_RUNTIME_MS`): soft abort → 60s grace → release lock + exit 124. exists because a 13h runaway held the lock on 2026-09-24. |
| `wait-runner.js` | event-driven scheduler (`dude-wait`, 15min timer). each wait function exports `check(ctx) -> {fire, context?, state}`; when it fires, the agent runs `--once --purpose <name> --context ...` **detached** in a transient systemd unit (`systemd-run`), with `--runtime-maxsec` matching the cap. `wait-functions.d/` in the config dir is the user drop dir (bundled dir is read-only nix store). |
| `run-result.js` | `last-run.json` written on every process exit — how the wait runner learns the outcome of a detached run (lazy re-baseline). |
| `interrupted.js` | SIGTERM during a run: session marker (`interrupted` custom entry), breadcrumb (`interrupted.json`), and a self-deleting `resume-interrupted` one-shot wait function. |
| `loop-detect.js` | tool-loop breaker: same tool+args repeated → steer nudge → abort session. (born from an 813× identical bash call on 2026-08-31.) |
| `empty-response-retry.js` | glm-5.3-flash sometimes settles with zero output; nudge the session up to N times before ending the run. |
| `typing.js` | discord "typing…" keepalive during runs. |
| `notify.js` | discord start/finish pings for NON-discord-triggered runs (scheduled cron + wait-fired --once, incl. purposes). channel = `DUDE_NOTIFY_CHANNEL_ID` env falling back to `config.json` `lastChannelId`; reuses the service client when logged in, else lazily logins with a throwaway minimal client (15s timeouts, best-effort — never delays/crashes a run). finish pings map `discord-message-sessions.json` so john can reply-to continue the session. |
| `purpose.js` | registry loader: `src/purposes/<name>.js` → `--purpose <name>`. unknown purpose = loud error. |
| `agent-prompt.js` | builds the system prompt. full template (task processing) vs trimmed template (`trimBasePrompt: true` — purpose runs must not triage the task file; that's deliberate, task-file edits by purposes re-trigger the wait runner). |

purposes (`src/purposes/`): `prediction-markets.js` (LLM half of pm agent),
`meal-planner.js` (weekly dinner planning), `eng-orchestrator.js` (staged
engineering pipeline — see below). all `trimBasePrompt: true`.

## engineering pipeline (ai-projects)

larger engineering projects use a staged pipeline, separate from ai-tasks:
index file `~/vault/ai-projects.md` (wait function `wait-functions/ai-projects.js`
fires `eng-orchestrator` on checklist change), project docs in
`~/vault/projects/<name>.md` hold the pipeline state + artifacts (design,
test plan). stage runs (gather → testing-design → implement → test) are
detached `dude-agent --once --purpose eng-orchestrator --context
"project=<name> stage=<stage>"` invocations; standing orders in
`.pi/skills/engineering-task/SKILL.md`. PRD + test-plan need explicit john
sign-off before implementation. the tasks-wait-state-sync extension
re-baselines BOTH index files (INDEX_FILES in tasks-wait-state.js) after
self-edits.

## run lifecycle

1. invocation: systemd timer (`--once`/`--cron`), wait-runner fire, or a
   discord message (reply-to-bot / @tag / DM).
2. runtime cap armed → lock acquired (`acquireLockOrExit` for one-shots =
   exit 75 when busy; discord trigger just skips).
3. prompt built, model resolved (openrouter glm-5.3-flash, with quota
   fallback logic), pi session created, prompt sent.
4. during the run: loop breaker + empty-response nudges watch the event
   stream; the runtime cap watches the clock.
5. `agent_settled` → release lock + disarm cap → discord summary (if
   discord-triggered) or a start/finish ping via `notify.js` (if
   non-discord-triggered) → exit. every exit writes `last-run.json`.

lock rules to remember:
- a leaked lock with an ALIVE pid (e.g. the discord service) blocks all
  other triggers until the 6h age takeover — so every throw path after
  lock acquisition must release. (fixed 2026-09-28: catch handlers in
  `handleMessage` + entry-point `.catch`es.)
- manual lock-clearing is dangerous: it doesn't stop the running holder,
  and new fires will then overlap the zombie run. instead, kill the holder
  pid (`cat agent-lock.json` → `kill <pid>`) or wait for the cap.
- pm purpose runs share the same lock file as the main agent.

## wait-runner semantics (subtle, get these right)

- state persists in `wait-state.json`; a fired check persists state
  IMMEDIATELY, then detached-spawns the agent. if the spawn succeeded the
  state is rolled back to pre-check, and a later tick resolves the outcome
  from `last-run.json` (pending rebaseline): clean exit → refresh state +
  consume one-shots; dirty exit/never-finished → state stays stale so the
  event re-fires.
- busyCheck: if an agent is already running, the check isn't even run
  (state untouched, re-fires next tick).
- one-shots (`oneshot: true`) are deleted only after a CLEAN detached run.
- the ai-tasks watcher is a wait function watching the vault task file's
  hash — that's how you (the agent) get invoked when john edits tasks.

## deployment chain (self-update — READ THIS, recent runs got it wrong)

1. make your change in `johndikeman/dude` on a feature branch **off fresh
   `origin/main`** (pull first; always).
2. add/adjust tests (`node test_<thing>.js`, or node:test style like
   `test_runtime_cap.js`). run them. `node --check src/index.js` before
   pushing.
3. PR to `main` → merge.
4. **the CI workflow auto-bumps `dotfiles` flake.lock** (`nix flake update
   dude`), opens a PR to `vps_nix`, and merges via `--fill`. you do NOT
   manually bump the dotfiles lock for dude changes — don't duplicate it,
   and don't be confused by the CI run that exits with "nothing to commit"
   (pre-2026-09-28 that failed the run; now it exits cleanly).
5. dotfiles push → "Deploy VPS" action → deploy-rs activates the
   home-manager profile, restarts dude services, then runs
   `checkDudeServices` — if a service fails to become active, deploy-rs
   MAGIC-ROLLS BACK to the previous generation. so a failed deploy leaves
   the old build running; verify which generation you're on.
6. verification: the `dotfiles-deploy-verify` wait function checks the
   deploy run and fires the agent on failure. manual check:
   `readlink ~/.local/state/nix/profiles/home-manager` +
   `systemctl --user status dude-agent-watch dude-wait`.

when changing deploy-facing behavior (systemd units, service env), that
lives in the dotfiles repo, not here. dude repo = agent code only.

## config/env surface

env files: `~/.config/dude/.env`, workspace `.env`, and the nix store
`.opvars` (1password-injected via `op run`). key vars: `DUDE_CONFIG_DIR`,
`DUDE_WORKING_DIR`, `PI_SESSION_DIR`, `PI_SKILLS`, `OBSIDIAN_DIR`,
`DUDE_MAX_RUNTIME_MS`, `DUDE_AGENT_LOCK_MAX_AGE_MS`, `DISCORD_TOKEN`,
model selection (`MODEL_PROVIDER/CODE` + fallbacks).

systemd units (home-manager, see dotfiles): `dude-agent-watch.service`
(long-running discord bot), `dude-wait.service` + timer (wait runner),
`dude-agent-prediction-markets.service` (own timer), obsidian-sync +
obsidian-sync-recipes (`op run -- ob sync --continuous`).

## dude2 (dispatcher-centric v2, branch `dude2`)

dude2 is the multi-agent revision of dude: one dispatcher process, N spawned
isolated runs, a generic input queue, and an agent api extension bundle.
**IT RUNS ALONGSIDE V1 — zero shared mutable state, ever.**

- **the state-path rule (john's hard requirement):** every dude2 state file
  path MUST be env-configurable and tracked by nix. `src/dude2/config.js`
  is the single code-level source of truth (`DUDE2_CONFIG_DIR`,
  `DUDE2_WORKSPACE`, `DUDE2_SESSION_DIR`, `DUDE2_QUEUE_DB`,
  `DUDE2_AGENTS_STATE_FILE`, `DUDE2_LOG_DIR`, ...); the
  `homeManagerModules.dude2-agent` flake module is the deployment-level
  source of truth. adding any new state file? add it to BOTH. never let a
  dude2 path default into v1's `~/.config/dude` tree —
  `assertIsolation()` enforces this at startup.
- `src/dude2/queue.js` — generic input queue (sqlite, node:sqlite). every
  input (discord msg, wait-runner one-shot, file drop, api) normalizes to
  `{source, type, context, runId?}`; dedupe by key; entries claim/complete.
- `src/dude2/dispatcher.js` — the long-running spine: drains the queue,
  spawns runs (cap: `DUDE2_MAX_CONCURRENT_RUNS`, default 3), owns the
  discord client + presence, ingests file drops from
  `$DUDE2_CONFIG_DIR/queue.d/*.json` (the pending-stage.json pattern).
  injectable gateway/spawner seams exist for the e2e harness.
- `src/dude2/run.js` (`dude2-run`) / `run-executor.js` — per-run wrapper
  that delegates to v1's `dude-agent --once` with the environment
  re-pointed at dude2 paths, so ALL of v1's battle-tested hardening
  (loop breaker, empty-response retry, stall watchdog, crash guard,
  runtime cap, resume breadcrumbs) is reused verbatim. runs file outbound
  discord replies as `$DUDE2_CONFIG_DIR/replies/<runId>.json`; the
  dispatcher (which owns the bot client) forwards them in-thread.
- `src/dude2/registry.js` + `presence.js` — agents-state.json bookkeeping
  and the whimsical discord presence cycler driven from it.
- tests: `test/dude2-*.js` (unit) + `test/dude2-e2e.js` (mocked e2e:
  stub gateway + stub run impl). elite e2e > piles of batch scripts.

## debugging

- agent log: `~/.config/dude/agent.log` (also journald under the unit)
- `journalctl --user -u dude-wait -u dude-agent-watch -f`
- session transcripts: `~/.config/dude/sessions/*.jsonl` — type-tagged
  jsonl; `message` entries carry role/content; tool calls are content
  items with `type: "toolCall"`.
- lock state: `cat ~/.config/dude/agent-lock.json` (pid + startedAt +
  purpose). stale = holder pid dead OR older than max age.

## incident history + standing lessons

- 2026-08-31: tool loop, 813 identical bash calls → loop breaker.
- 2026-09-24: 13h runaway held the lock; every cycle skipped; blamed a pm
  flake wrongly → runtime cap + age-stale lock takeover + `--runtime-maxsec`.
- 2026-09-28 deploy failure (#88): obsidian-sync services transiently
  failed "No account logged in" during activation (op/ob startup race under
  activation load); deploy-rs rolled back to the previous generation. the
  generation 54 code was fine — the rollback re-activation succeeded, so
  treat flaky-startup failures as retriable, not code regressions.
- 2026-09-28 resume run: SIGTERM'd discord-triggered run wrote a resume
  one-shot; the resumed run then did 4h of legitimate-but-low-value
  auditing and hit the cap (exit 124). lessons: resume runs should close
  out and quit, not start new investigations; and a 4h resume burn on an
  account with $0.38 of credits is a real cost.
- 2026-09-28: `activeSession.appendCustomEntry is not a function` — pi
  renamed the session marker API; fixed via `appendSessionMarker` fallback
  chain in interrupted.js.
- CI "failure" on dude main pushes where the lock was already current was
  cosmetic (`git commit` on empty index); fixed 2026-09-28.
- 2026-11-06 deploy failures + dude-agent-watch crash loop: obsidian auth
  server 504'd for ~20h; the unbounded ob-login retry ExecStartPre (5 ×
  60-80s + 15s backoff) blew past systemd's default 90s TimeoutStartSec →
  "start-pre operation timed out" → watch never active → checkDudeServices
  failed → deploy-rs rolled back EVERY deploy. WORSE: the crash loop held
  the user manager's boot transaction open (watch is WantedBy=default.target,
  5-per-120s start limit never tripped at ~100s/cycle) so the manager sat in
  "starting" for 3h47m, HM's reloadSystemd skipped daemon-reload (it only
  proceeds on running/degraded) and deploys activated STALE units. deploy-rs
  also has a hard 240s activation confirmation window — long synchronous
  restarts inside activation blow it. fixes: per-attempt `timeout 30` cap,
  graceful "-"-prefixed login on dude-agent/watch, 5min TimeoutStartSec,
  trippable start limits (20min/3) so loops settle, checkDudeServices does
  its own daemon-reload + --no-block restarts of changed units and treats
  obsidian-sync as a soft check.
- 2026-11-06 follow-up: sync services' ob-login/sync-setup ExecStartPre
  must ALSO be graceful — sd-switch (HM reloadSystemd) restarts changed
  units synchronously, and deploy-rs' rollback re-activation uses the OLD
  units; a hard start-pre failure in either aborts the deploy even with
  all the other fixes. graceful start-pre + runtime failure + start-limit
  ban is the only combination that survives an outage end to end.
- 2026-11-09 22:58 (session 01a1c288): discord-triggered run hung 100 min
  on a silently-wedged openrouter request ("upstream idle timeout"), pi's
  auto-retry recovered at 00:39 — and the run DIED at the moment of
  recovery. root cause: pi emits `auto_retry_end {success: true, attempt}`
  when a retry succeeds, and the subscriber's auto_retry_end case treated
  every auto_retry_end as terminal: tore down the run, then crashed on
  truncateLine(undefined) in the discord reply (TypeError → unhandled
  rejection → crash-guard exit 1). the successful retry's tool call never
  executed; the user got no reply. FIXED: isAutoRetryFailure() only tears
  down on explicit success:false. LESSON: match event fields, not event
  names — the two auto_retry_end shapes are opposites. SECONDARY: the
  stall watchdog produced ZERO output during the 100-min hang (evidence
  contradictory: process provably alive at 23:55 via a typing log line,
  yet an armed 2-min re-arming timer never logged); the tick is now a
  self-rescheduling interval (a dropped re-arm can't silently disarm it)
  and onStall runs before the fire log so a blocked log can't prevent the
  abort. keep an eye on watchdog output in the next stall incident.
  follow-up (same day): stall diag/fire lines now carry per-run event
  counts, last event timestamp, and node event-loop-lag max
  (monitorEventLoopDelay) via getDiagnostics — a future stall incident
  answers "were events arriving / was the loop blocked" from the
  persistent log alone, no process-memory access needed.

## tone / house rules for future runs

- task index (`/home/ubuntu/vault/ai-tasks.md`) stays tiny: checklist +
  pointers only. everything else goes in task docs or `agent-log.md`.
- lowercase, semi-informal. no bare angle brackets in vault markdown.
- leave notes-to-self + feedback markers in task docs, not the index.
