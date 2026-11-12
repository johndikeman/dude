<div align="center">

# hey dude!

**a lightweight + opinionated orchestration layer for autonomous remote runs of [pi-agent](https://github.com/earendil-works/pi)**

*your agent lives on a vps now. it checks in on its own todo list. it tells you how it's doing on discord.*

</div>

<div align="center">

autonomous • self-documenting • one • very • specific • cat • approved

</div>

## ✨ what is this

dude is what happens when you get tired of babysitting llm agents on your personal computer, so you give them a vps, a task list, and the keys to everything they actually need.

the agent runs periodically, checks in on tasks in an obsidian file, writes its own documentation when it finishes something, and surfaces one-off triggers via discord. you mostly find out things went well after they already went well.

**the stack it leans on:**

- 🔐 [1password](https://1password.com) — credentials, managed properly, not `cat`'d into a shell
- 📝 [obsidian](https://obsidian.md) — communication + documentation (the agent's actual memory)
- 💬 [discord](https://discord.com) — one-off triggers, plus the agent's mouth
- ❄️ [nix flakes](https://nixos.org) — reproducible deploys, no snowflake servers
- 🤖 [pi-agent](https://github.com/earendil-works/pi) — the brains underneath

## 🚀 what it exposes

three services, deployable as one nix-managed unit:

| service | what it does | default cadence |
|---|---|---|
| **periodic triggers** | the agent wakes up and works on its task list | every 6 hours (configurable) |
| **on-demand triggers** | ping the agent from discord whenever | whenever you want |
| **obsidian sync** | keeps the vault in sync via obsidian-headless | continuous |

scheduled + wait-fired runs are no longer silent: they post a short start and finish message to discord (`src/notify.js`), so you can tell at a glance when a cycle ran and what it did.

## 🧠 the self-improving loop

the short version: the agent reads a task index, follows links to full task docs, does the work, writes its own design notes and history, and marks things done. when it needs a human, it leaves a note and quits. when it ships code, it branches, tests, PRs, and logs the whole thing.

it's not quite skynet. it's more like a very enthusiastic intern with root access.

## 🤖 dude2 — the dispatcher era

v1 is one agent. **dude2 is a civilization of them.** same repo, `dude2` branch, running alongside v1 with zero shared state:

```
        ┌───────────────────────────────────────────────┐
        │  dude2-dispatch (one long-running spine)      │
        │  queue · registry · discord presence · locks  │
        └──────┬──────────┬──────────┬──────────────────┘
               ▼          ▼          ▼
           dude2-run   dude2-run   dude2-run   ← isolated runs
           (discord)   (wait)      (api spawn)   (own sessions, own paths)
```

- **agents run agents.** any run can spawn another run (`spawn_run`) with a full context handoff — the eng-orchestrator now launches personalized per-stage sub-agents and collects victory-condition callbacks.
- **one generic input queue.** discord messages, wait-runner one-shots, file drops, and api calls all normalize into a sqlite queue; replies to a run's thread re-prompt *that same session*.
- **the dude2 api.** every run gets `discord_send` (rich messages, numbered multiple-choice — john loves those), `op_read` (1password), `session_query` (search past runs), `spawn_run`, and `discord_presence`.
- **sourced logging.** every log entry says who wrote it (`dispatcher` / `pi-stdout` / `pi-session` / `agent`), lands in per-run jsonl + a sqlite index, exports langfuse-shaped to supabase, and is browsable/rateable in a tiny web viewer.
- **elite e2e.** `nix run .#e2e` runs the mocked end-to-end UAT harness — real binaries, fake discord/1pass/model. few sharp tests > a pile of bash.
- **compaction tuned for glm-5.3**, with custom instructions that preserve state machines and victory conditions across summaries.

the hardening that made v1 trustworthy (tool-loop breaker, empty-response retry, stall watchdog, crash guard, runtime caps) is reused verbatim by every dude2 run. we only got parallel *because* of it.

## 🛠 deployment

this repo contains an action that opens a PR to update itself in my [VPS nix repo](https://github.com/johndikeman/dotfiles/tree/vps_nix). pushes to that branch trigger a **deploy-rs** action which redeploys the configuration — with auto-rollback baked in via nix home-manager.

so yes: the agent manages its own deployment pipeline. we're fine. everything is fine.

## 🐈 credits

profile picture by **brother qt the foster cat**, who did not consent to this but was purring at the time.

---

<div align="center">

*if something breaks, it was probably a race condition. or a lock file. or me.*

</div>
