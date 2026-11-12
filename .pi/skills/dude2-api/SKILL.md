---
name: dude2-api
description: How to use the dude2 capability api (discord_send, spawn_run, discord_presence, op_read, session_query) available as tools in every dude2 run.
---

# dude2 api

every dude2 run (any run with a `DUDE2_RUN_ID`) gets five custom tools from
the dude2-api extension. use them instead of hand-rolling their effects —
they are the sanctioned path to discord, the dispatcher, and the
1password vault.

## tools

- `discord_send` — send a discord message from this run. pass `text`
  (markdown). pass `choices` (array of strings) to render numbered
  multiple-choice options; john replies with the number. use for questions
  to john, status announcements, victory-condition callbacks. do NOT use
  it for secret dumps.
- `spawn_run` — enqueue a NEW isolated agent run with the dispatcher.
  pass `purpose` (named purpose, e.g. `eng-orchestrator`) and/or
  `context`. the sub-run gets ONLY the context you pass — overshare it.
  when handing a session off, write a summary of the current state into
  context (cheap summary is fine) rather than assuming shared memory.
- `discord_presence` — one-line whimsical status of what this run is
  doing; surfaces on the bot's discord presence.
- `op_read` — read a 1password item, e.g. `op://AI/<item>/<field>`. never
  paste secret values into discord messages.
- `session_query` — case-insensitive search across previous dude2 run
  logs and pi session transcripts. use to recover context from earlier
  runs before asking john anything.

## mechanics

all tools talk to the dispatcher via files under `$DUDE2_CONFIG_DIR`
(replies/, queue.d/, api/presence/); the dispatcher forwards/polls. you
never touch discord.js or the queue db directly.
