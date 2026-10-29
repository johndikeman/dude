// tests for src/scheduled-presence.js — presence + typing for scheduled runs
// (one-shot runs never log in the main client; this module lazily provides
// a persistent client so scheduled runs get presence + typing indicator).
// NOTE: the module is stateful (module-level `active` + `pending`), so these
// tests MUST run sequentially — parallel execution races the shared state
// and produces false failures.
import assert from "node:assert";
import {
  acquireScheduledPresence,
  releaseScheduledPresence,
  getScheduledPresenceClient,
} from "./src/scheduled-presence.js";

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(`ok - ${name}`);
    })
    .catch((e) => {
      console.error(`fail - ${name}: ${e?.stack || e?.message || e}`);
      process.exitCode = 1;
    });
}

/** fake discord client: records setActivity/destroy calls, lets tests
 * emit clientReady immediately or never (to simulate a hung gateway). */
function fakeClientFactory({ emitsReady = true, sendable = true } = {}) {
  const calls = { setActivity: [], destroy: 0, sendTyping: 0 };
  const client = {
    user: {
      setActivity: async (activity, opts) => {
        calls.setActivity.push({ activity, opts });
      },
    },
    channels: {
      fetch: async () => {
        if (!sendable) return null;
        return {
          id: "test-channel",
          sendTyping: async () => {
            calls.sendTyping += 1;
          },
        };
      },
    },
    login: async () => {
      if (emitsReady && client._ready) client._ready();
    },
    destroy: async () => {
      calls.destroy += 1;
    },
    _once: {},
    once: (event, fn) => {
      client._once[event] = fn;
    },
    calls,
  };
  // fire the clientReady listener when login is called (like the real gateway)
  if (emitsReady) {
    const realLogin = client.login;
    client.login = async (...args) => {
      client._ready = client._once["clientReady"];
      return realLogin(...args);
    };
  }
  return () => client;
}

const FAST_LOGIN = { loginTimeoutMs: 200 };

// list of [name, fn] tuples so tests only start when the loop reaches them
// (calling test() eagerly would run them all in parallel, racing the module
// state).
const tests = [
  [
    "acquire sets presence and starts typing indicator",
    async () => {
      process.env.DISCORD_TOKEN = "test-token";
      process.env.DUDE_NOTIFY_CHANNEL_ID = "12345";
      const factory = fakeClientFactory();
      const logs = [];
      const handle = await acquireScheduledPresence({
        log: (m) => logs.push(m),
        clientFactory: factory,
        ...FAST_LOGIN,
      });
      assert.ok(handle, "expected a handle");
      assert.ok(handle.client, "handle has a client");
      assert.ok(
        handle.client.calls.setActivity.some((c) => c.activity === "running a task"),
        `presence not set: ${JSON.stringify(handle.client.calls.setActivity)}`,
      );
      assert.ok(handle.client.calls.sendTyping >= 1, "typing indicator not started");
      assert.ok(
        getScheduledPresenceClient() === handle.client,
        "getter returns active client",
      );
      await releaseScheduledPresence({ log: (m) => logs.push(m) });
      assert.strictEqual(getScheduledPresenceClient(), null, "client released");
    },
  ],
  [
    "release clears presence and destroys the client",
    async () => {
      process.env.DISCORD_TOKEN = "test-token";
      process.env.DUDE_NOTIFY_CHANNEL_ID = "12345";
      const handle = await acquireScheduledPresence({
        log: () => {},
        clientFactory: fakeClientFactory(),
        ...FAST_LOGIN,
      });
      assert.ok(handle);
      await releaseScheduledPresence({ log: () => {} });
      assert.ok(handle.client.calls.destroy >= 1, "client destroyed");
      assert.ok(
        handle.client.calls.setActivity.some((c) => c.activity === null),
        "presence cleared",
      );
    },
  ],
  [
    "acquire is a singleton — second call returns the same client",
    async () => {
      process.env.DISCORD_TOKEN = "test-token";
      process.env.DUDE_NOTIFY_CHANNEL_ID = "12345";
      const first = await acquireScheduledPresence({
        log: () => {},
        clientFactory: fakeClientFactory(),
        ...FAST_LOGIN,
      });
      const second = await acquireScheduledPresence({ log: () => {} });
      assert.strictEqual(second?.client, first.client);
      await releaseScheduledPresence({ log: () => {} });
    },
  ],
  [
    "release while acquire is still pending awaits and tears down",
    async () => {
      process.env.DISCORD_TOKEN = "test-token";
      process.env.DUDE_NOTIFY_CHANNEL_ID = "12345";
      // client that never emits ready within the timeout → acquire resolves
      // null after 100ms; release called immediately must wait for that and
      // not leak a client.
      const factory = fakeClientFactory({ emitsReady: false });
      const logs = [];
      const acquireP = acquireScheduledPresence({
        log: (m) => logs.push(m),
        clientFactory: factory,
        loginTimeoutMs: 100,
      });
      await releaseScheduledPresence({ log: (m) => logs.push(m) });
      const got = await acquireP;
      if (got) {
        assert.ok(got.client.calls.destroy >= 1, "leaked client destroyed");
      }
      assert.strictEqual(getScheduledPresenceClient(), null, "no client leaked");
    },
  ],
  [
    "no DISCORD_TOKEN → acquire resolves null, nothing broken",
    async () => {
      delete process.env.DISCORD_TOKEN;
      const logs = [];
      const got = await acquireScheduledPresence({ log: (m) => logs.push(m) });
      assert.strictEqual(got, null);
      assert.ok(logs.some((m) => m.includes("no DISCORD_TOKEN")));
      await releaseScheduledPresence({ log: () => {} });
    },
  ],
  [
    "no notify channel id → acquire resolves null",
    async () => {
      process.env.DISCORD_TOKEN = "test-token";
      delete process.env.DUDE_NOTIFY_CHANNEL_ID;
      // resolveNotifyChannelId also falls back to the config.json lastChannelId
      // via DUDE_CONFIG_DIR — delete it so the fallback can't rescue the test
      delete process.env.DUDE_CONFIG_DIR;
      const logs = [];
      const got = await acquireScheduledPresence({ log: (m) => logs.push(m) });
      assert.strictEqual(got, null);
      assert.ok(logs.some((m) => m.includes("no notify channel id")));
    },
  ],
  [
    "login timeout → acquire resolves null and destroys the client",
    async () => {
      process.env.DISCORD_TOKEN = "test-token";
      process.env.DUDE_NOTIFY_CHANNEL_ID = "12345";
      const factory = fakeClientFactory({ emitsReady: false });
      const logs = [];
      const got = await acquireScheduledPresence({
        log: (m) => logs.push(m),
        clientFactory: factory,
        loginTimeoutMs: 100,
      });
      assert.strictEqual(got, null, "expected null on login timeout");
      assert.ok(logs.some((m) => m.includes("timed out")));
      const fake = factory();
      assert.ok(fake.calls.destroy >= 1, "client destroyed on timeout");
    },
  ],
  [
    "release is safe when nothing is active",
    async () => {
      await releaseScheduledPresence({ log: () => {} });
      assert.strictEqual(getScheduledPresenceClient(), null);
    },
  ],
];

for (const [name, fn] of tests) {
  await test(name, fn);
}

console.log(results.join("\n"));
