/**
 * Lichess Human Interface
 * Handles Lichess game analysis sessions
 */

import fs from "fs";
import path from "path";
import { HumanInterface } from "../base-interface.js";

const getPaths = () => {
  const configDir = process.env.DUDE_CONFIG_DIR || process.cwd();
  return {
    configDir,
    logFile: path.join(configDir, "agent.log"),
  };
};

function log(msg) {
  const { logFile } = getPaths();
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (e) {}
}

export class LichessInterface extends HumanInterface {
  constructor(config = {}) {
    super({
      ...config,
      name: "lichess",
      apiKey: config.apiKey || process.env.LICHESS_API_KEY,
      baseApiUrl: config.baseApiUrl || "https://lichess.org/api",
      gamesCheckInterval: config.gamesCheckInterval || 5 * 60 * 1000, // 5 minutes
    });

    this.sessionMapping = new Map(); // Maps game IDs to session info
    this.processedGames = new Set();
    this.lastGamesCheck = null;
  }

  /**
   * Initialize the interface
   */
  async init() {
    if (!this.config.apiKey) {
      log("Lichess API key not configured, skipping Lichess interface");
      this.isActive = false;
      return;
    }

    log("Lichess interface initialized");
  }

  /**
   * Poll for new games that haven't been analyzed
   */
  async poll() {
    if (!this.isActive) return;

    try {
      const newGames = await this.getUnanalyzedGames();

      if (newGames.length > 0) {
        log(`Found ${newGames.length} new games for analysis`);
        
        for (const game of newGames) {
          await this.startGameSession(game);
        }
      }
    } catch (err) {
      log(`Error polling for games: ${err.message}`);
    }
  }

  /**
   * Get unanalyzed games from Lichess
   */
  async getUnanalyzedGames() {
    if (!this.config.lastGamesCheck) {
      // First run, get all recent games
      this.config.lastGamesCheck = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
    }

    try {
      const since = Math.floor(this.config.lastGamesCheck / 1000);
      const url = `${this.config.baseApiUrl}/games/export?since=${since}&max=100`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const gamesText = await response.text();
      const games = this.parseGamesExport(gamesText);

      // Filter out already processed games
      const newGames = games.filter((g) => !this.processedGames.has(g.id));

      return newGames;
    } catch (err) {
      log(`Failed to fetch games: ${err.message}`);
      return [];
    }
  }

  /**
   * Parse Lichess game export format
   */
  parseGamesExport(text) {
    const games = [];
    const lines = text.split("\n");
    let currentGame = null;

    for (const line of lines) {
      if (line.startsWith('1.') || /^\[/.test(line)) {
        // New game header
        if (currentGame && currentGame.id) {
          games.push(currentGame);
        }
        currentGame = {};
      } else if (currentGame) {
        // Parse metadata
        const match = line.match(/^\[(\w+)\s+"(.*)"\]$/);
        if (match) {
          currentGame[match[1].toLowerCase()] = match[2];
        }
      }
    }

    // Add last game
    if (currentGame && currentGame.id) {
      games.push(currentGame);
    }

    return games;
  }

  /**
   * Start an analysis session for a game
   */
  async startGameSession(game) {
    const sessionId = `lichess-${game.id}`;

    this.sessionMapping.set(sessionId, {
      sessionId,
      gameId: game.id,
      white: game.white,
      black: game.black,
      timeControl: game.timeControl,
      analyzed: false,
    });

    this.processedGames.add(game.id);
    this.config.lastGamesCheck = Date.now();

    // Emit task event for the game analysis
    const task = `Analyze this Lichess game: ${game.id}\nWhite: ${game.white}\nBlack: ${game.black}\nTime Control: ${game.timeControl}`;
    
    this.emit("task", task, {
      gameId: game.id,
      sessionId,
      gameDetails: game,
    });

    log(`Started analysis session for game ${game.id}`);
  }

  /**
   * Get session for a game
   */
  getSessionByGame(gameId) {
    for (const [sessionId, info] of this.sessionMapping) {
      if (info.gameId === gameId) {
        return info;
      }
    }
    return null;
  }

  /**
   * Get all active game sessions
   */
  getActiveSessions() {
    return Array.from(this.sessionMapping.values());
  }

  /**
   * Mark a game as analyzed
   */
  markAnalyzed(gameId) {
    const session = this.getSessionByGame(gameId);
    if (session) {
      session.analyzed = true;
    }
    this.processedGames.add(gameId);
  }

  /**
   * Fetch game PGN from Lichess
   */
  async fetchGamePGN(gameId) {
    try {
      const url = `${this.config.baseApiUrl}/game/${gameId}/pgn`;
      
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      return await response.text();
    } catch (err) {
      log(`Failed to fetch game PGN: ${err.message}`);
      return null;
    }
  }

  /**
   * Get game analysis from Lichess mast
   */
  async getGameAnalysis(gameId) {
    try {
      const url = `${this.config.baseApiUrl}/game/expert/${gameId}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      return await response.json();
    } catch (err) {
      log(`Failed to fetch game analysis: ${err.message}`);
      return null;
    }
  }

  /**
   * Emit an event to registered handlers
   */
  emit(event, data) {
    const handlers = this.callbacks[`on${event.charAt(0).toUpperCase() + event.slice(1)}`];
    if (handlers) {
      handlers.forEach((handler) => handler(data));
    }
  }

  /**
   * Send a message (not typically needed for Lichess, but available)
   */
  async sendMessage(message, options = {}) {
    // Lichess interface primarily receives, not sends messages
    log(`[Lichess] ${message}`);
    return { sent: false, message };
  }

  /**
   * Start polling for games
   */
  startPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.pollingInterval = setInterval(() => this.poll(), this.config.gamesCheckInterval);
    log(`Lichess interface polling started (interval: ${this.config.gamesCheckInterval}ms)`);
  }

  /**
   * Stop the interface
   */
  async stop() {
    this.stopPolling();
    this.isActive = false;
  }
}
