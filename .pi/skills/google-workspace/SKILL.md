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

## auth (one-time setup, needs john for the browser step)

the oauth client lives in 1password (item `gws oauth client secret`, field `credential` —
john created it 9/1/2026). the wrapper never writes client secrets or credentials to the
home dir (john's feedback); the exported credentials end up in the 1p item `gws credentials`
(field `credential`), which dude reads at runtime.

### doing the login (two options)

**a. john runs it locally** (any machine with a browser + 1password cli):

```bash
export GOOGLE_WORKSPACE_CLI_CLIENT_ID=$(op read 'op://AI/gws oauth client secret/credential' | jq -r .installed.client_id)
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET=$(op read 'op://AI/gws oauth client secret/credential' | jq -r .installed.client_secret)
gws auth login -s drive,docs,gmail      # pick drive + docs + gmail scopes
gws auth export --unmasked > creds.json  # then paste into 1p item 'gws credentials'
```

**b. dude runs it on the vps** with an ssh port-forward (gws listens on an auto-negotiated
localhost port, printed when the command starts):

```bash
.pi/skills/google-workspace/gwsx.sh auth-login -s drive,docs,gmail
# john, in another terminal: ssh -L <port>:localhost:<port> ubuntu@<vps>, then open
# http://localhost:<port> when google redirects, or open the printed consent url on any
# machine with the tunnel active
```

### after login (either path)

```bash
.pi/skills/google-workspace/gwsx.sh auth-export --unmasked   # prints credentials json
```

paste that json into 1password vault AI, item **`gws credentials`**, field `credential`
(john has to create the item — dude's service account is read-only). after that,
`gwsx.sh` picks it up automatically (env var → 1password) and gws auto-refreshes tokens.
if auth ever dies, redo the login + export.

## troubleshooting

- `no gws credentials found` — the 1p item `gws credentials` doesn't exist yet; do the
  login + export above
- `Access blocked` during consent — john's account isn't a test user on the oauth app
- scope picker shows too many scopes / fails — unverified apps cap at ~25 scopes; pick
  individual services (`-s drive,docs,gmail`) rather than the `recommended` preset
