---
name: google-workspace
description: Read and edit google docs, drive files, sheets, gmail, and calendar via the official `gws` CLI (@googleworkspace/cli), authenticated with john's account.
---

# google workspace (gws)

`gws` is google's (unofficially-supported) workspace cli: it builds its command surface
dynamically from google's discovery service, so it covers drive, docs, sheets, gmail,
calendar, chat, and more — all with json output. we use it via the `gwsx.sh` wrapper
in this directory, which handles binary install + credential plumbing automatically.

## usage

always call the wrapper, not `gws` directly:

```bash
.pi/skills/google-workspace/gwsx.sh drive files list --params '{"pageSize": 10}'
.pi/skills/google-workspace/gwsx.sh docs documents get --params '{"documentId": "..."}'
```

common patterns:

```bash
# list files in drive (docs, sheets, everything)
gwsx.sh drive files list --params '{"q": "name contains \"report\"", "pageSize": 10}'

# read a google doc as structured json
gwsx.sh docs documents get --params '{"documentId": "<DOC_ID>"}'

# append text to a doc (helper)
gwsx.sh docs +write --params '{"documentId": "<DOC_ID>"}' --json '{"text": "hello"}'

# read cells from a spreadsheet
gwsx.sh sheets spreadsheets values get --params '{"spreadsheetId": "<ID>", "range": "Sheet1!A1:C10"}'

# export a file (pdf/docx/etc) from drive
gwsx.sh drive files export --params '{"fileId": "<ID>", "mimeType": "application/pdf"}' --output /tmp/out.pdf

# introspect any method's schema before calling it
gwsx.sh schema drive.files.list

# gmail: unread summary
gwsx.sh gmail +triage
```

sheets ranges contain `!` — always single-quote them in bash.

auto-pagination: add `--page-all` to stream results as ndjson. preview requests with
`--dry-run`. if the binary isn't installed, `gwsx.sh` downloads the latest release from
github (googleworkspace/cli) into `~/bin/gws`.

## auth (one-time setup, needs john)

the vps is headless, so we use gws's export flow:

1. john, on any machine with a browser (or ask dude to drive the browser-automation skill
   through it), set up an oauth client once:
   - google cloud console → oauth consent screen: external, testing mode, add your
     account as test user
   - credentials → oauth client id → type **desktop app** → download json as
     `client_secret.json`
   - put `client_secret.json` in 1password vault AI, item `gws oauth client secret`,
     field `credential` (dude reads it from there)
2. run `gws auth login` (with `client_secret.json` at `~/.config/gws/client_secret.json`),
   pick drive + docs + gmail scopes, approve in browser
3. export headless credentials: `gws auth export --unmasked > credentials.json`
4. get those credentials onto the vps: either drop them into 1password item
   `gws credentials` (field `credential`) or hand them over in-session — dude will place
   them at `~/.config/gws/credentials.json` (mode 600)

after that, `gwsx.sh` finds credentials automatically (env var → local file → 1password)
and gws auto-refreshes tokens. if auth ever dies, redo steps 2–4.

## troubleshooting

- `no gws credentials found` — run the setup above
- `Access blocked` during consent — john's account isn't a test user on the oauth app
- scope picker shows too many scopes / fails — unverified apps cap at ~25 scopes; pick
  individual services (`-s drive,docs,gmail`) rather than the `recommended` preset
