// tests for src/status.js
import assert from "node:assert";
import {
  setAgentStatus,
  clearAgentStatus,
  attachStatusReady,
  AGENT_ACTIVITY,
} from "./src/status.js";

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(`ok - ${name}`);
    })
    .catch((e) => {
      console.error(`fail - ${name}: ${e?.message || e}`);
      process.exitCode = 1;
    });
}

function mockClient() {
  const calls = [];
  const handlers = {};
  return {
    user: { setActivity: (...args) => calls.push(args) },
    once: (ev, fn) => {
      (handlers[ev] ||= []).push(fn);
    },
    emit: (ev) => {
      for (const fn of handlers[ev] || []) fn();
    },
    calls,
  };
}

await Promise.all([
  test("setAgentStatus sets a Playing presence on the client", async () => {
    const client = mockClient();
    setAgentStatus(client, () => {});
    assert.strictEqual(client.calls.length, 1, "setActivity must be called once");
    const [activity, opts] = client.calls[0];
    assert.strictEqual(activity, AGENT_ACTIVITY);
    assert.strictEqual(opts.type, 0, "presence type must be 0 (Playing)");
  }),

  test("setAgentStatus queues the presence when the client is not ready", async () => {
    const logs = [];
    // must not throw for null/undefined client
    setAgentStatus(null, (m) => logs.push(m));
    setAgentStatus(undefined, (m) => logs.push(m));
    setAgentStatus({}, (m) => logs.push(m)); // logged-in client has no .user
    assert.ok(
      logs.some((m) => /presence queued/.test(m)),
      "expected a queued message in the log",
    );
  }),

  test("setAgentStatus swallows client errors and logs them", async () => {
    const logs = [];
    const client = {
      user: {
        setActivity: () => {
          throw new Error("gateway down");
        },
      },
    };
    setAgentStatus(client, (m) => logs.push(m));
    assert.ok(
      logs.some((m) => /failed to set presence/.test(m)),
      "expected a failure log",
    );
  }),

  test("clearAgentStatus clears the presence on the client", async () => {
    const client = mockClient();
    clearAgentStatus(client, () => {});
    assert.strictEqual(client.calls.length, 1, "setActivity must be called once");
    assert.strictEqual(client.calls[0][0], null, "activity must be cleared with null");
  }),

  test("clearAgentStatus no-ops safely when the client is not ready", async () => {
    clearAgentStatus(null, () => {});
    clearAgentStatus(undefined, () => {});
    clearAgentStatus({}, () => {});
  }),
]);

await Promise.all(results);

// state-dependent tests (module-level presenceWanted), run sequentially.
// reset first: the tests above left the flag in some state.
await test("queued presence is applied once the gateway reaches ready", async () => {
  clearAgentStatus(mockClient(), () => {}); // reset module state
  const notReady = {}; // client without .user (login still in flight)
  setAgentStatus(notReady, () => {});
  const client = mockClient();
  attachStatusReady(client, () => {});
  client.emit("clientReady");
  assert.strictEqual(client.calls.length, 1, "setActivity must be applied on ready");
  assert.strictEqual(client.calls[0][0], AGENT_ACTIVITY);
});

await test("clearAgentStatus before ready cancels the queued presence", async () => {
  const notReady = {};
  setAgentStatus(notReady, () => {}); // queue it
  clearAgentStatus(notReady, () => {}); // run ended before login resolved
  const client = mockClient();
  attachStatusReady(client, () => {});
  client.emit("clientReady");
  assert.strictEqual(client.calls.length, 0, "no presence must be applied after clear");
});

await test("attachStatusReady is a no-op when nothing was queued", async () => {
  clearAgentStatus(mockClient(), () => {}); // ensure flag is false
  const client = mockClient();
  attachStatusReady(client, () => {});
  client.emit("clientReady");
  assert.strictEqual(client.calls.length, 0);
});

await Promise.all(results);
console.log(`\n${results.length} status tests finished`);
