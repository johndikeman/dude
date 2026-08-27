---
name: browser-automation
description: "Drive a real (headless) browser to complete multistep javascript web forms, logins, file uploads, and captcha-style challenges. Use when a site needs clicking/typing/navigation rather than plain fetching. Companion to the pi-web-browse skill, which is better for read-only page extraction."
---

# Browser Automation

A persistent headless chromium session you can steer step by step from bash.
State (cookies, js state, scroll position) survives between commands because a
daemon owns the browser; each command connects over CDP.

## quick start

```bash
BROWSER=.pi/skills/browser-automation/browser.js   # adjust path if needed

$BROWSER start          # launch daemon (uses chromium from PATH / WEB_BROWSE_BROWSER_BIN)
$BROWSER goto https://example.com/form
$BROWSER snapshot       # dumps url/title/page text + indexed interactive elements
```

`snapshot` output looks like:

```
[3] a:button "Next page"
[4] input:email "" name=email
[7] select "" name=country
```

Use the `[ref]` numbers for subsequent actions:

```bash
$BROWSER type 4 "jane@example.com"
$BROWSER select 7 "United States"
$BROWSER click 3        # advances to form step 2 — snapshot again to see it
```

## commands

| command | purpose |
|---|---|
| `start [--fresh] [--headed]` | launch session (`--fresh` kills any old one) |
| `stop` | kill session |
| `goto <url>` | navigate |
| `snapshot` | page text + numbered interactive elements |
| `click <ref\|selector>` | click element |
| `clickxy <x> <y>` | raw coordinate click (use for canvas/captcha widgets) |
| `type <ref> "<text>" [--no-clear]` | clear field then type |
| `press <key>` | Enter / Tab / Escape / ArrowDown ... |
| `select <ref> "<value or label>"` | dropdown option |
| `upload <ref> <file...>` | file input upload |
| `screenshot [path]` | save png, prints path — **read the png** to visually verify |
| `scroll [up\|down] [px]` | scroll page |
| `eval "<js>"` | arbitrary js in page context |

## workflow guidance

1. after every navigation or click that changes the page, take a fresh
   `snapshot`. refs are reassigned per snapshot.
2. verify before submitting: re-snapshot and check field values are what you
   intend. on irreversible actions (submit, purchase) screenshot first.
3. captchas: take a `screenshot`, read the image, then use `clickxy` /
   `type` / `press` to solve it. for checkbox-style ("i am human") widgets,
   try a simple `click` first — many are trivially passable in a real browser.
4. if an element isn't in the snapshot, find it with `eval`
   (e.g. `document.querySelector(...)`), or act via css selector instead of ref.
5. always `$BROWSER stop` when finished so the chromium process is cleaned up.

## troubleshooting

- "no active browser session" → run `browser.js start`.
- "browser session is dead" → the daemon crashed or machine rebooted; `start` again.
- element not clickable → it may be offscreen or covered; `click` auto-scrolls,
  but overlays/modals may need closing first (check the screenshot).
