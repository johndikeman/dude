/**
 * Tests for the modular agent architecture
 */

import assert from "assert";
import { describe, it } from "node:test";
import { HumanInterface, InterfaceManager } from "./hi/base-interface.js";
import { SubAgent } from "./agents/session-wrapper.js";

describe("HumanInterface", () => {
  it("should create a basic interface", () => {
    const iface = new HumanInterface({ name: "test" });
    assert.equal(iface.name, "test");
    assert.equal(iface.isActive, false);
  });

  it("should register callbacks", () => {
    const iface = new HumanInterface({ name: "test" });
    
    let callbackCalled = false;
    iface.onTaskReceived(() => { callbackCalled = true; });
    
    // Trigger the callback
    iface.callbacks.onTaskReceived.forEach(cb => cb("test task", {}));
    
    assert.equal(callbackCalled, true);
  });

  it("should track multiple callbacks", () => {
    const iface = new HumanInterface({ name: "test" });
    
    let count = 0;
    iface.onTaskReceived(() => count++);
    iface.onTaskReceived(() => count++);
    iface.onTaskReceived(() => count++);
    
    iface.callbacks.onTaskReceived.forEach(cb => cb("test", {}));
    
    assert.equal(count, 3);
  });
});

describe("InterfaceManager", () => {
  it("should register and retrieve interfaces", () => {
    const manager = new InterfaceManager();
    const iface = new HumanInterface({ name: "test" });
    
    manager.register(iface);
    
    assert.equal(manager.get("test"), iface);
    assert.equal(manager.getAll().length, 1);
  });

  it("should start all interfaces", async () => {
    const manager = new InterfaceManager();
    
    let started = false;
    const testIface = new HumanInterface({ name: "test" });
    testIface.start = async () => { started = true; };
    
    manager.register(testIface);
    await manager.startAll();
    
    assert.equal(started, true);
  });

  it("should handle task broadcast", async () => {
    const manager = new InterfaceManager();
    
    let taskReceived = false;
    const iface = new HumanInterface({ name: "test" });
    iface.handleTask = async (task) => { taskReceived = true; return { handled: true }; };
    
    manager.register(iface);
    await manager.handleTask("test task");
    
    assert.equal(taskReceived, true);
  });
});

describe("SubAgent", () => {
  it("should create a subagent with role", () => {
    const subagent = new SubAgent("test-session", "/tmp/test.jsonl", null, {
      role: "worker",
      acceptanceCriteria: "test criteria",
    });
    
    assert.equal(subagent.sessionId, "test-session");
    assert.equal(subagent.role, "worker");
    assert.equal(subagent.acceptanceCriteria, "test criteria");
  });

  it("should track session info", () => {
    const subagent = new SubAgent("test", "/tmp/test.jsonl", null, {
      role: "worker",
    });
    
    const info = subagent.getSessionInfo();
    
    assert.equal(info.sessionId, "test");
    assert.equal(info.role, "worker");
  });
});

describe("SubAgent - parent communication", () => {
  it("should report to parent", () => {
    let receivedResult = null;
    
    const parent = {
      sessionId: "parent-123",
      receiveSubAgentResult: async (result) => {
        receivedResult = result;
      },
    };
    
    const subagent = new SubAgent("worker-123", "/tmp/worker.jsonl", parent, {
      role: "worker",
    });
    
    subagent.reportToParent({ test: "data" });
    
    assert.notEqual(receivedResult, null);
    assert.equal(receivedResult.test, "data");
  });
});
