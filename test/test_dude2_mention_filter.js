/**
 * tests for src/dude2/discord-gateway.js shouldIngest() — dude2 must only
 * trigger on tags/replies aimed at itself, not on messages tagged at dude1
 * or anything else in shared channels.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldIngest } from "./../src/dude2/discord-gateway.js";

const ME = "DUDE2";

/** minimal fake message shaped like a discord.js message */
function fakeMessage({ author = { id: "u1", bot: false }, guild = {}, mentions = null, reference = null, fetchReference = null } = {}) {
  return {
    author,
    guild,
    mentions: mentions ?? { has: (id) => false },
    reference,
    fetchReference: fetchReference ?? (() => Promise.reject(new Error("not mocked"))),
  };
}

test("direct tag of dude2 → ingest", async () => {
  const m = fakeMessage({ mentions: { has: (id) => id === ME } });
  assert.equal(await shouldIngest(ME, m), true);
});

test("tag of dude1 → skip (the reported bug: dude2 hijacking dude1 tags)", async () => {
  const m = fakeMessage({ mentions: { has: (id) => id === "DUDE1" } });
  assert.equal(await shouldIngest(ME, m), false);
});

test("no tag at all → skip", async () => {
  assert.equal(await shouldIngest(ME, fakeMessage()), false);
});

test("reply to a dude2 message → ingest", async () => {
  const m = fakeMessage({
    reference: { messageId: "ref-1" },
    fetchReference: () => Promise.resolve({ author: { id: ME } }),
  });
  assert.equal(await shouldIngest(ME, m), true);
});

test("reply to a message from another bot (dude1) → skip", async () => {
  const m = fakeMessage({
    reference: { messageId: "ref-1" },
    fetchReference: () => Promise.resolve({ author: { id: "DUDE1" } }),
  });
  assert.equal(await shouldIngest(ME, m), false);
});

test("reply to a human message → skip", async () => {
  const m = fakeMessage({
    reference: { messageId: "ref-1" },
    fetchReference: () => Promise.resolve({ author: { id: "some-human" } }),
  });
  assert.equal(await shouldIngest(ME, m), false);
});

test("fetchReference hanging/hard-fails → skip without hanging", async () => {
  const m = fakeMessage({
    reference: { messageId: "ref-1" },
    fetchReference: () => new Promise(() => {}), // never resolves
  });
  const start = Date.now();
  assert.equal(await shouldIngest(ME, m), false);
  assert.ok(Date.now() - start < 6000, "should resolve via the 5s timeout");
});

test("DMs (no guild) from humans → ingest", async () => {
  assert.equal(await shouldIngest(ME, fakeMessage({ guild: null })), true);
});

test("bot-authored messages never ingest (even if they tag us)", async () => {
  const m = fakeMessage({
    author: { id: "DUDE1", bot: true },
    mentions: { has: (id) => id === ME },
  });
  assert.equal(await shouldIngest(ME, m), false);
});

test("null/undefined message → skip", async () => {
  assert.equal(await shouldIngest(ME, null), false);
});
