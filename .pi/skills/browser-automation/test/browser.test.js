// integration tests: spin up a local multistep form site and drive it with
// the browser skill against a real chromium. requires chromium (BROWSER_BIN
// or WEB_BROWSE_BROWSER_BIN) — skipped gracefully if unavailable.

import { test, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "browser.js");

function run(cli, args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, BROWSER_BIN: browserBin() }, timeout: 60000, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

process.env.BROWSER_SESSION_STATE = join(
  mkdtempSync(join(tmpdir(), "dude-browser-test-")),
  "state.json",
);

function browserBin() {
  for (const c of [
    process.env.WEB_BROWSE_BROWSER_BIN,
    process.env.BROWSER_BIN,
    "/run/current-system/sw/bin/chromium",
    "/usr/bin/chromium",
  ]) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

const haveChromium = Boolean(browserBin());

let server;
let base;
const submissions = [];

function page(title, body) {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

before(async () => {
  if (!haveChromium) {
    console.log("skipping integration tests: no chromium found");
    return;
  }
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/step1") {
      res.end(
        page(
          "step 1",
          `<form action="/step2" method="GET">
             <label for="email">Email</label>
             <input id="email" name="email" type="email">
             <select name="color"><option value="">choose</option><option value="red">Red</option><option value="blue">Blue</option></select>
             <input type="file" name="resume" id="resume">
             <button type="submit">Next</button>
           </form>`,
        ),
      );
    } else if (url.pathname === "/step2") {
      res.end(
        page(
          "step 2",
          `<p>confirm ${url.searchParams.get("email")} / ${url.searchParams.get("color")}</p>
           <form action="/done" method="POST">
             <textarea name="cover"></textarea>
             <button id="apply">Submit application</button>
           </form>`,
        ),
      );
    } else if (url.pathname === "/done" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        submissions.push(body);
        res.end(page("thanks", "<h1>Application received</h1>"));
      });
    } else if (url.pathname === "/captcha") {
      res.end(
        page(
          "human check",
          `<div id="box" style="width:400px;height:200px;position:relative">
             <button id="imhuman" style="position:absolute;left:180px;top:80px;width:40px;height:40px"
               onclick="this.textContent='OK';document.title='verified'">?</button>
           </div>`,
        ),
      );
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (!haveChromium) return;
  server?.close();
});

test("multistep form flow", { skip: !haveChromium }, async () => {
  await run(CLI, ["start", "--fresh"]);

  await run(CLI, ["goto", `${base}/step1`]);

  const snap1 = await run(CLI, ["snapshot"]);
  const refOf = (snap, label) => {
    const m = snap.match(new RegExp(`\\[(\\d+)\\][^\\n]*"${label}"`));
    assert(m, `element "${label}" not in snapshot:\\n${snap}`);
    return m[1];
  };

  const emailRef = refOf(snap1, "Email");
  await run(CLI, ["type", emailRef, "jane@example.com"]);

  const colorRef = refOf(snap1, "color");
  const selOut = await run(CLI, ["select", colorRef, "Blue"]);
  assert.match(selOut, /selected/);

  // upload a resume
  const resumePath = join(tmpdir(), `resume-${Date.now()}.txt`);
  writeFileSync(resumePath, "i am a resume");
  const fileRef = refOf(snap1, "resume");
  await run(CLI, ["upload", fileRef, resumePath]);

  const nextRef = refOf(snap1, "Next");
  await run(CLI, ["click", nextRef]);
  console.log("DEBUG href:", await run(CLI, ["eval", "location.href"]));

  // step 2 should show our values carried through
  const snap2 = await run(CLI, ["snapshot"]);
  assert.match(snap2, /jane@example\.com \/ blue/);

  const coverRef = refOf(snap2, "cover");
  await run(CLI, ["type", coverRef, "hire me please"]);

  const submitRef = refOf(snap2, "Submit application");
  await run(CLI, ["click", submitRef]);

  const snap3 = await run(CLI, ["snapshot"]);
  assert.match(snap3, /Application received/);
  assert.equal(submissions.length, 1);
  assert.match(submissions[0], /hire\+me\+please|hire me please/);
});

test("coordinate click (captcha-style widget)", { skip: !haveChromium }, async () => {
  await run(CLI, ["goto", `${base}/captcha`]);
  // button is at left:180 top:80 within a div at 0,0 → absolute ~ (200,100)
  await run(CLI, ["clickxy", "200", "100"]);
  const out = await run(CLI, ["eval", "document.title"]);
  assert.equal(JSON.parse(out), "verified");
});

test("screenshot produces readable png", { skip: !haveChromium }, async () => {
  const path = join(tmpdir(), `shot-${Date.now()}.png`);
  const out = await run(CLI, ["screenshot", path]);
  assert.match(out, /\.png$/);
  const buf = readFileSync(path);
  assert.equal(buf.readUInt32BE(0), 0x89504e47); // png magic
});

test("session persistence and stop", { skip: !haveChromium }, async () => {
  // session from earlier tests should still be alive
  await run(CLI, ["goto", `${base}/step1`]);
  const out = await run(CLI, ["eval", "location.pathname"]);
  assert.equal(JSON.parse(out), "/step1");

  const stopOut = await run(CLI, ["stop"]);
  assert.match(stopOut, /session stopped/);

  // commands now fail cleanly with guidance
  let failed = false;
  try {
    await run(CLI, ["snapshot"]);
  } catch (err) {
    failed = true;
    assert.match(String(err.stderr), /no active browser session/);
  }
  assert(failed, "expected snapshot to fail after stop");
  await run(CLI, ["stop"]).catch(() => {});
});
