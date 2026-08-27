// DOM interaction actions. Each takes a puppeteer page plus args and returns
// a string result. They run inside the daemon process (single CDP client).

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function settle(page) {
  await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => {});
}

const SNAPSHOT_JS = `(() => {
  if (window.__dudeRefs === undefined) window.__dudeRefs = {};
  const interactive = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=combobox], [onclick], [contenteditable=true], summary';
  const nodes = document.querySelectorAll(interactive);
  const out = [];
  let next = 1;
  window.__dudeRefs = {};
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (rect.width === 0 && rect.height === 0 && el.tagName !== 'OPTION') continue;
    const idx = next; next += 1;
    el.setAttribute('data-dude-ref', String(idx));
    window.__dudeRefs[idx] = true;
    const isControl = ['input', 'select', 'textarea'].includes(el.tagName.toLowerCase());
    const label =
      el.getAttribute('aria-label') ||
      (el.labels && el.labels[0] && el.labels[0].innerText.trim().slice(0, 80)) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (isControl ? '' : (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80)) ||
      el.getAttribute('name') ||
      el.getAttribute('id') ||
      (isControl ? String(el.value ?? '').slice(0, 40) : '');
    out.push({
      ref: idx,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      role: el.getAttribute('role') || undefined,
      label: String(label).slice(0, 120),
      value: ['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())
        ? String(el.value ?? '').slice(0, 80)
        : undefined,
      checked: el.checked === true ? true : undefined,
      href: el.tagName === 'A' ? el.href : undefined,
    });
  }
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000),
    elements: out,
  };
})()`;

export async function snapshot(page) {
  await settle(page);
  const snap = await page.evaluate(SNAPSHOT_JS);
  return formatSnapshot(snap);
}

export function formatSnapshot(snap) {
  const lines = [];
  lines.push(`url: ${snap.url}`);
  lines.push(`title: ${snap.title}`);
  lines.push("");
  lines.push("--- page text (truncated) ---");
  lines.push(snap.text);
  lines.push("");
  lines.push("--- interactive elements ([ref] tag label) ---");
  for (const el of snap.elements) {
    const bits = [`[${el.ref}]`, `${el.tag}${el.type ? ":" + el.type : ""}`];
    if (el.label) bits.push(`"${el.label}"`);
    if (el.value !== undefined && el.value !== "") bits.push(`value=${JSON.stringify(el.value)}`);
    if (el.checked) bits.push("checked");
    if (el.href) bits.push(el.href);
    lines.push(bits.join(" "));
  }
  return lines.join("\n");
}

async function resolveEl(page, refOrSelector) {
  const s = String(refOrSelector);
  if (/^\d+$/.test(s)) {
    const el = await page.$(`[data-dude-ref="${s}"]`);
    if (!el) throw new Error(`ref ${s} not found — take a fresh snapshot`);
    return el;
  }
  const el = await page.$(s);
  if (!el) throw new Error(`selector ${s} not found`);
  return el;
}

export async function click(page, refOrSelector) {
  const el = await resolveEl(page, refOrSelector);
  await el.scrollIntoView();
  await el.click();
  await settle(page);
  return "clicked " + refOrSelector;
}

export async function clickXY(page, x, y) {
  await page.mouse.click(Number(x), Number(y));
  await sleep(400);
  return `clicked at (${x}, ${y})`;
}

export async function type(page, refOrSelector, text, opts = {}) {
  const el = await resolveEl(page, refOrSelector);
  await el.scrollIntoView();
  await el.click({ clickCount: 3 });
  if (opts.clear !== false) {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
  }
  await el.type(String(text), { delay: 10 });
  return `typed into ${refOrSelector}`;
}

export async function press(page, key) {
  await page.keyboard.press(key);
  await sleep(300);
  return `pressed ${key}`;
}

export async function selectOption(page, refOrSelector, value) {
  const el = await resolveEl(page, refOrSelector);
  try {
    const changed = await el.select(value);
    if (changed && changed.length) return `selected "${value}" in ${refOrSelector}`;
  } catch {}
  // fall back to matching the visible option label
  const matched = await page.evaluate(
    ({ sel, value }) => {
      const base = sel.match(/^\d+$/) ? `[data-dude-ref="${sel}"]` : sel;
      const el = document.querySelector(base);
      if (!el || el.tagName !== "SELECT") return null;
      for (const opt of el.options) {
        if (opt.text.trim().toLowerCase() === value.trim().toLowerCase()) {
          el.value = opt.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return opt.text;
        }
      }
      return null;
    },
    { sel: String(refOrSelector), value },
  );
  if (matched) return `selected option "${matched}" in ${refOrSelector}`;
  throw new Error(`could not select "${value}" in ${refOrSelector}`);
}

export async function uploadFile(page, refOrSelector, ...filePaths) {
  const el = await resolveEl(page, refOrSelector);
  await el.uploadFile(...filePaths.map((p) => resolve(p)));
  return `uploaded ${filePaths.length} file(s) to ${refOrSelector}`;
}

export async function screenshot(page, outPath) {
  const path = outPath || join(tmpdir(), `dude-browser-${Date.now()}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

export async function goto(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await settle(page);
  return `navigated to ${url}`;
}

export async function scroll(page, direction, px) {
  const amount = Number(px) || 600;
  await page.evaluate(
    ({ dir, amount }) => {
      window.scrollBy(0, dir === "up" ? -amount : amount);
    },
    { dir: direction || "down", amount },
  );
  await sleep(200);
  return `scrolled ${direction || "down"} ${amount}px`;
}

export async function evalJs(page, js) {
  const result = await page.evaluate(js);
  return result === undefined ? "undefined" : JSON.stringify(result, null, 2);
}

// dispatch table used by the daemon's HTTP API
export const actions = {
  noop: async () => "ok",
  snapshot,
  click,
  clickxy: clickXY,
  type: (page, sel, text, noClear) => type(page, sel, text, { clear: !noClear }),
  press,
  select: selectOption,
  upload: uploadFile,
  screenshot,
  goto,
  scroll,
  eval: evalJs,
};
