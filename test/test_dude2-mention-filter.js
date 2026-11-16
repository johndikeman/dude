/** shouldIngestDiscord — the dude-2-tagged-by-dude-1-tag bug guard
 * (2026-11-15: tags aimed at dude 1 fired dude 2 runs; gateway messages
 * must only ingest when THIS bot is tagged / DM'd / thread reply)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldIngestDiscord } from "../src/dude2/dispatcher.js";

test("plain channel message with no mention is ignored", () => {
  assert.equal(shouldIngestDiscord({ channelId: "c", content: "hi bots", messageId: "m1" }), false);
});

test("message mentioning (mention flag) another bot is ignored", () => {
  assert.equal(shouldIngestDiscord({ channelId: "c", content: "<@111> do the thing", messageId: "m2", mentionedUs: false }), false);
});

test("message tagging THIS bot is ingested", () => {
  assert.equal(shouldIngestDiscord({ channelId: "c", content: "hey <@222> do the thing", messageId: "m3", mentionedUs: true }), true);
});

test("DM to the bot is ingested even without a tag", () => {
  assert.equal(shouldIngestDiscord({ channelId: "dm1", content: "psst", messageId: "m4", isDm: true }), true);
});

test("reply inside an existing run thread re-prompts regardless of mention", () => {
  assert.equal(shouldIngestDiscord({ channelId: "thread", content: "go ahead", messageId: "m5", mentionedUs: false }, "run-1"), true);
});

test("null/undefined message is ignored", () => {
  assert.equal(shouldIngestDiscord(null), false);
  assert.equal(shouldIngestDiscord(undefined, null), false);
});
