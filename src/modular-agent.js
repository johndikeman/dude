/**
 * Modular Agent Architecture Exports
 * 
 * This module exports the new modular architecture components
 * that separate human interfaces from agents.
 * 
 * Usage:
 *   import { ManagerAgent, WorkerAgent } from './modular-agent.js';
 *   import { DiscordInterface, GitHubInterface, LichessInterface } from './modular-agent.js';
 */

// Human Interfaces
export { HumanInterface, InterfaceManager } from "./hi/base-interface.js";
export { DiscordInterface } from "./hi/discord/discord-interface.js";
export { GitHubInterface, GitHubExtensions } from "./hi/github/github-interface.js";
export { LichessInterface } from "./hi/lichess/lichess-interface.js";

// Agent Components  
export { AgentSessionWrapper, SubAgent } from "./agents/session-wrapper.js";
export { ManagerAgent, createManagerAgent } from "./agents/manager/manager-agent.js";
export { WorkerAgent, createWorkerAgent } from "./agents/worker/worker-agent.js";
