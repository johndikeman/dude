/**
 * Base Human Interface
 * Defines the contract for all human interface implementations
 */

export class HumanInterface {
  constructor(config = {}) {
    this.config = config;
    this.name = config.name || "base";
    this.isActive = false;
    this.sessionId = null;
    this.callbacks = {
      onTaskReceived: [],
      onFeedbackReceived: [],
      onMessageToUser: [],
      onStatusUpdate: [],
      onSessionComplete: [],
    };
  }

  /**
   * Initialize the interface
   */
  async init() {
    throw new Error("Subclass must implement init()");
  }

  /**
   * Start receiving events
   */
  async start() {
    this.isActive = true;
    await this.init();
  }

  /**
   * Stop receiving events
   */
  async stop() {
    this.isActive = false;
  }

  /**
   * Send a message to the user
   * @param {string} message - The message content
   * @param {Object} options - Additional options (e.g., attachments, ephemeral)
   */
  async sendMessage(message, options = {}) {
    throw new Error("Subclass must implement sendMessage()");
  }

  /**
   * Handle a task received from the user
   * @param {string} task - The task description
   * @param {Object} options - Task options (e.g., attachments)
   */
  async handleTask(task, options = {}) {
    this.callbacks.onTaskReceived.forEach(cb => cb(task, options));
    return { handled: true, interface: this.name };
  }

  /**
   * Handle feedback from the user
   * @param {string} feedback - The feedback content
   * @param {Object} context - Context (e.g., original message ID)
   */
  async handleFeedback(feedback, context = {}) {
    this.callbacks.onFeedbackReceived.forEach(cb => cb(feedback, context));
    return { handled: true, interface: this.name };
  }

  /**
   * Register a callback for task received events
   */
  onTaskReceived(callback) {
    this.callbacks.onTaskReceived.push(callback);
    return this;
  }

  /**
   * Register a callback for feedback events
   */
  onFeedbackReceived(callback) {
    this.callbacks.onFeedbackReceived.push(callback);
    return this;
  }

  /**
   * Register a callback for status updates
   */
  onStatusUpdate(callback) {
    this.callbacks.onStatusUpdate.push(callback);
    return this;
  }

  /**
   * Register a callback for session completion
   */
  onSessionComplete(callback) {
    this.callbacks.onSessionComplete.push(callback);
    return this;
  }

  /**
   * Get active sessions
   */
  getActiveSessions() {
    return [];
  }

  /**
   * Store a message ID for later resumption
   * @param {string} messageId - The message ID
   */
  storeMessageId(messageId) {
    this.config.lastMessageId = messageId;
  }

  /**
   * Get the last stored message ID
   */
  getLastMessageId() {
    return this.config.lastMessageId || null;
  }

  /**
   * Query for the latest message from a session
   * @param {string} sessionId - The session ID
   */
  async queryLatestMessage(sessionId) {
    throw new Error("Subclass must implement queryLatestMessage()");
  }

  /**
   * Check for new user interactions (for polling-based interfaces)
   */
  async poll() {
    // Override in subclass for polling-based interfaces
  }

  /**
   * Start polling for interactions
   */
  startPolling(intervalMs) {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.pollingInterval = setInterval(() => this.poll(), intervalMs);
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Get interface capability info
   */
  getCapabilities() {
    return {
      supportsTask: true,
      supportsFeedback: !!this.callbacks.onFeedbackReceived.length,
      supportsStatusUpdates: !!this.callbacks.onStatusUpdate.length,
      supportsMessaging: true,
      supportsPolling: typeof this.poll === "function",
    };
  }
}

/**
 * Interface Manager - manages multiple human interfaces
 */
export class InterfaceManager {
  constructor() {
    this.interfaces = new Map();
    this.activeInterfaces = new Set();
  }

  /**
   * Register a new interface
   * @param {HumanInterface} iface - The interface instance
   */
  register(iface) {
    this.interfaces.set(iface.name, iface);
  }

  /**
   * Unregister an interface
   * @param {string} name - The interface name
   */
  unregister(name) {
    const iface = this.interfaces.get(name);
    if (iface) {
      iface.stop();
      this.activeInterfaces.delete(name);
      this.interfaces.delete(name);
    }
  }

  /**
   * Get an interface by name
   * @param {string} name - The interface name
   */
  get(name) {
    return this.interfaces.get(name);
  }

  /**
   * Get all registered interfaces
   */
  getAll() {
    return Array.from(this.interfaces.values());
  }

  /**
   * Start all interfaces
   */
  async startAll() {
    for (const iface of this.interfaces.values()) {
      try {
        await iface.start();
        this.activeInterfaces.add(iface.name);
      } catch (err) {
        console.error(`Failed to start interface ${iface.name}:`, err);
      }
    }
  }

  /**
   * Stop all interfaces
   */
  async stopAll() {
    for (const iface of this.interfaces.values()) {
      try {
        await iface.stop();
        this.activeInterfaces.delete(iface.name);
      } catch (err) {
        console.error(`Failed to stop interface ${iface.name}:`, err);
      }
    }
  }

  /**
   * Handle a task from any interface
   * @param {string} task - The task description
   * @param {Object} options - Task options with optional source interface
   */
  async handleTask(task, options = {}) {
    const { sourceInterface, ...rest } = options;
    
    if (sourceInterface && this.interfaces.has(sourceInterface)) {
      return await this.interfaces.get(sourceInterface).handleTask(task, rest);
    }
    
    // Handle through all interfaces (for broadcast)
    const results = [];
    for (const iface of this.interfaces.values()) {
      results.push(await iface.handleTask(task, rest));
    }
    return results;
  }

  /**
   * Send a message to the user through a specific interface
   */
  async sendMessage(message, options = {}) {
    const { destinationInterface, ...rest } = options;
    
    if (destinationInterface && this.interfaces.has(destinationInterface)) {
      return await this.interfaces.get(destinationInterface).sendMessage(message, rest);
    }
    
    // Send through default or primary interface
    const primary = this.interfaces.values().next().value;
    if (primary) {
      return await primary.sendMessage(message, rest);
    }
    
    throw new Error("No interface available to send message");
  }

  /**
   * Get all active sessions across interfaces
   */
  getAllActiveSessions() {
    const sessions = [];
    for (const iface of this.interfaces.values()) {
      const ifaceSessions = iface.getActiveSessions?.() || [];
      sessions.push(...ifaceSessions.map(s => ({ ...s, interface: iface.name })));
    }
    return sessions;
  }

  /**
   * Broadcast a message to all active interfaces
   */
  async broadcast(message, options = {}) {
    const results = [];
    for (const iface of this.interfaces.values()) {
      try {
        results.push(await iface.sendMessage(message, options));
      } catch (err) {
        console.error(`Failed to send message via ${iface.name}:`, err);
      }
    }
    return results;
  }
}
