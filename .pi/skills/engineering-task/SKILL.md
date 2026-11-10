---
name: engineering-task
description: "Standing orders for the eng-orchestrator purpose: the staged engineering pipeline (gather → testing-design → implement → test) for projects tracked in ~/vault/ai-projects.md, with john sign-off gates and discord escalations."
---

# engineering task pipeline — standing orders

you run the staged engineering pipeline. each stage is its own agent run with
one artifact; the pipeline state lives in the project doc so any future run
can resume. index file: `~/vault/ai-projects.md` (tiny — checklist lines +
pointers only). each project has a doc `~/vault/projects/<name>.md` with the
standard structure:

```
# project: <name>
## objective — acceptance criteria from john (verbatim intent)
## pipeline — status lines: one `stage: <current> (<state>)` line per project
## feedback (john) — john's questions/answers; empty if none
## log / history — everything else: design, prd, test plan, implementation notes
```

never put logs under the top three sections. never touch ~/vault/ai-tasks.md.

## stages

1. **gather** — research run. read code/docs/vault state for the project's
   objective. ask clarifying questions on discord (blocking questions only;
   keep them minimal, prefer multiple-choice formatting). produce a
   **PRD-lite** as a `## design` section in the project doc: problem,
   constraints, proposed approach, user stories, implementation plan as
   specific as possible (files, functions, tech notes), explicit unknowns.
   when done, set `stage: testing-design (ready)`.
2. **testing-design** — fresh run. read ONLY the objective + `## design`
   section. produce a `## test plan` section: what proves each acceptance
   criterion, what's testable without live systems (mocks/unit), what needs
   live e2e, and explicit user-acceptance steps written against the user
   stories. this stage REQUIRES explicit john sign-off (discord reply or an
   edit in the project doc) before implementation may start. when ready for
   review, post a summary to discord and set `stage: testing-design
   (awaiting sign-off)`. when john signs off, set `stage: implement (ready)`.
3. **implement** — fresh coding run, intentionally blind to other runs'
   deliberations: consume ONLY the objective, `## design`, and `## test
   plan` sections. research prompting best practices if the plan seems
   thin. rules: pull fresh `origin/main` first, work on a feature branch,
   integrate with the existing codebase, add the smallest amount of code
   that satisfies the plan, write the tests the test plan calls for, commit,
   open a PR, post the PR link to discord. set `stage: test (ready)` and
   include the PR number in the status line.
4. **test** — verification run. review the PR diff against the `## test
   plan`, run the suite, optionally do live e2e for the user-acceptance
   steps. post a verdict to the project doc + discord. on failure, set
   `stage: implement (ready)` with the failure report in `## log` (loop back
   to implement). after 2 failed loops, escalate to john and stop. on
   success, set `stage: done (merged?)` — john merges the PR.

## supervisor rules (runs with no `stage=` in context)

- scan ai-projects.md; for each unchecked project whose status line says
  `<stage> (ready)`, queue ONE stage run per project by writing the
  dispatch to the pending-stage file:
  `echo '{"project": "<name>", "stage": "<stage>"}' > ~/.config/dude/pending-stage.json`
  (the wait-runner tick picks it up and launches the stage through the
  same robust detached-spawn path as wait-fired runs: env forwarding,
  current build, lock handling. NEVER hand-roll systemd-run commands —
  that broke stage runs twice: stale build = "unknown purpose", missing
  env = instant crash. see the 2026-11-08 offgridusb-parallel incident.)
- one run per project, then exit. don't do stage work yourself.
- escalations to john (post on discord, then stop the project): blocking
  clarifying questions, 2x failed test loops, scope creep beyond the
  objective, anything touching money/prod/his machines, PRD/test-plan ready
  for sign-off.

## hard rules

- don't run more than one stage run per project at a time.
- every stage run updates the project doc's pipeline status line and appends
  a short log entry. no history in the index file.
- artifacts (`## design`, `## test plan`) live in the project doc only.
- when john gives feedback in the doc, treat it as authoritative and act on
  it in the next stage run.
