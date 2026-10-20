// tests for src/status.js
import assert from "node:assert";
import {
  setAgentStatus,
  clearAgentStatus,
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
  return {
    user: { setActivity: (...args) => calls.push(args) },
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

  test("setAgentStatus no-ops safely when the client is not ready", async () => {
    const logs = [];
    // must not throw for null/undefined client
    setAgentStatus(null, (m) => logs.push(m));
    setAgentStatus(undefined, (m) => logs.push(m));
    setAgentStatus({}, (m) => logs.push(m)); // logged-in client has no .user
    assert.ok(
      logs.some((m) => /skipping presence update/.test(m)),
      "expected a skip message in the log",
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
console.log(`\n${results.length} status tests finished`);
