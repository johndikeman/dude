---
name: dude2-orchestrator
description: How to run the eng-orchestrator pipeline on the dude2 runtime — spawning isolated per-stage sub-agent runs via spawn_run with personalized briefs.
---

# dude2 orchestrator

on dude2 the eng-orchestrator is an ordinary agent run that spawns stage
runs as isolated sub-agents through the `spawn_run` api tool (never
systemd, never hand-rolled). standing orders (staged pipeline, sign-off
gates, escalation rules) live in the `engineering-task` skill — read it.

## how to dispatch a stage run

1. read the project doc `~/vault/projects/<name>.md`; find the pipeline
   status line and the next stage.
2. build the context with the pure helper (it contains the personalized
   per-stage brief + victory condition):
   `node -e 'import("src/dude2/orchestrator.js").then(m => console.log(m.buildStageContext({project, stage, projectDocPath, pipelineLine})))'`
   or write it by hand following the same shape (see STAGE_BRIEFS).
3. `spawn_run` with that context. the sub-run is fully isolated — it gets
   ONLY this context, so overshare: inline the pipeline line, the
   project doc path, and any critical state.
4. when the sub-run posts its victory callback (discord_send), validate
   the artifact actually landed in the project doc before advancing the
   stage line. a callback without an artifact = failed loop.

## rules carried over from v1 (do not lose these)

- one stage run per project at a time.
- sign-off gates: testing-design waits for john. implement/test do not.
- after 2 failed test loops: escalate to john via discord_send (with
  numbered choices) and STOP the project.
- artifacts live in the project doc only; keep ai-projects.md tiny.
