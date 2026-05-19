// minigame-base.js - Base class for all mini-games
// Provides common functionality for tournament mini-games

class MiniGameBase {
  constructor(config) {
    // Required config
    this.io = config.io;
    this.matchId = config.matchId;
    this.player1 = config.player1; // { key, name, socketId }
    this.player2 = config.player2; // { key, name, socketId }
    this.settings = config.settings || {};
    this.onComplete = config.onComplete; // Callback: (winnerKey) => {}

    // State
    this.gameActive = false;
    this.winner = null;

    // Socket references
    this.socket1 = null;
    this.socket2 = null;

    // Timers and intervals for cleanup
    this.timers = [];
    this.intervals = [];

    // Track registered socket events for safe cleanup
    this.registeredEvents = [];

    // Spectators (eliminated players)
    this.spectatorKeys = [];
  }

  // --- Lifecycle Methods (to be overridden) ---

  /**
   * Start the mini-game
   * Must be implemented by subclasses
   */
  async start() {
    throw new Error('start() must be implemented by subclass');
  }

  /**
   * Clean up resources (timers, intervals, socket listeners)
   * Can be overridden to add game-specific cleanup
   */
  async cleanup() {
    console.log(`[${this.constructor.name}] Cleaning up...`);

    // Clear all timers
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers = [];

    // Clear all intervals
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals = [];

    // Remove only game-specific socket listeners (preserve tournament listeners)
    for (const { socket, event, handler } of this.registeredEvents) {
      if (socket) {
        socket.off(event, handler);
      }
    }
    this.registeredEvents = [];

    this.gameActive = false;
  }

  /**
   * Register socket event handlers for this game
   * Must be implemented by subclasses
   */
  registerSocketHandlers() {
    throw new Error('registerSocketHandlers() must be implemented by subclass');
  }

  // --- State Methods ---

  /**
   * Get simplified game state for spectators
   * Should return minimal state for eliminated players to watch
   * Must be implemented by subclasses
   */
  getStateForSpectators() {
    return {
      player1: { name: this.player1.name },
      player2: { name: this.player2.name },
      status: this.gameActive ? 'active' : 'complete',
      winner: this.winner ? this.getPlayerName(this.winner) : null
    };
  }

  // --- Communication Methods ---

  /**
   * Emit event to a specific player
   * @param {string} playerKey - Player key
   * @param {string} event - Event name
   * @param {object} data - Event data
   */
  emitToPlayer(playerKey, event, data) {
    const socketId = this.getPlayerSocketId(playerKey);
    if (socketId) {
      this.io.to(socketId).emit(event, data);
    } else {
      console.log(`[${this.constructor.name}] Player ${playerKey} not connected, cannot emit ${event}`);
    }
  }

  /**
   * Emit event to both players
   * @param {string} event - Event name
   * @param {object} data - Event data
   */
  emitToBothPlayers(event, data) {
    this.emitToPlayer(this.player1.key, event, data);
    this.emitToPlayer(this.player2.key, event, data);
  }

  /**
   * Emit event to all spectators (eliminated players)
   * @param {string} event - Event name
   * @param {object} data - Event data
   */
  emitToSpectators(event, data) {
    // Add default spectator state
    const spectatorData = {
      ...data,
      matchId: this.matchId,
      gameType: this.constructor.name
    };

    // Emit to all connected sockets (spectators will filter)
    this.io.emit(event, spectatorData);
  }

  /**
   * Broadcast game state update to players and spectators
   * @param {object} playerState - State for players
   * @param {object} spectatorState - State for spectators (optional)
   */
  broadcastState(playerState, spectatorState = null) {
    // Send to players
    if (playerState) {
      this.emitToBothPlayers('game:update', playerState);
    }

    // Send to spectators
    if (spectatorState || playerState) {
      this.emitToSpectators('game:spectator_update', spectatorState || playerState);
    }
  }

  // --- Game Control Methods ---

  /**
   * Declare winner and end the game
   * @param {string} winnerKey - Key of winning player
   */
  declareWinner(winnerKey) {
    if (this.winner) {
      console.warn(`[${this.constructor.name}] Winner already declared`);
      return;
    }

    this.winner = winnerKey;
    this.gameActive = false;

    const winnerName = this.getPlayerName(winnerKey);
    const loserKey = this.getOpponentKey(winnerKey);
    const loserName = this.getPlayerName(loserKey);

    console.log(`[${this.constructor.name}] Winner: ${winnerName}`);

    // Notify players
    this.emitToPlayer(winnerKey, 'game:end', {
      result: 'win',
      message: 'You won!'
    });

    this.emitToPlayer(loserKey, 'game:end', {
      result: 'lose',
      message: 'You lost!'
    });

    // Notify spectators
    this.emitToSpectators('game:end', {
      winner: winnerName,
      loser: loserName,
      winnerKey: winnerKey
    });

    // Callback to tournament system
    if (this.onComplete) {
      this.onComplete(winnerKey);
    }

    // Cleanup after short delay
    setTimeout(() => {
      this.cleanup();
    }, 2000);
  }

  // --- Utility Methods ---

  /**
   * Get socket ID for a player
   * @param {string} playerKey - Player key
   * @returns {string|null} Socket ID or null if not connected
   */
  getPlayerSocketId(playerKey) {
    if (playerKey === this.player1.key) {
      return this.player1.socketId;
    } else if (playerKey === this.player2.key) {
      return this.player2.socketId;
    }
    return null;
  }

  /**
   * Get player name by key
   * @param {string} playerKey - Player key
   * @returns {string} Player name
   */
  getPlayerName(playerKey) {
    if (playerKey === this.player1.key) {
      return this.player1.name;
    } else if (playerKey === this.player2.key) {
      return this.player2.name;
    }
    return 'Unknown';
  }

  /**
   * Get opponent's key
   * @param {string} playerKey - Player key
   * @returns {string} Opponent's key
   */
  getOpponentKey(playerKey) {
    return playerKey === this.player1.key ? this.player2.key : this.player1.key;
  }

  /**
   * Get opponent's name
   * @param {string} playerKey - Player key
   * @returns {string} Opponent's name
   */
  getOpponentName(playerKey) {
    return this.getPlayerName(this.getOpponentKey(playerKey));
  }

  /**
   * Get opponent's socket ID
   * @param {string} playerKey - Player key
   * @returns {string|null} Opponent's socket ID
   */
  getOpponentSocketId(playerKey) {
    return this.getPlayerSocketId(this.getOpponentKey(playerKey));
  }

  /**
   * Check if a player is connected
   * @param {string} playerKey - Player key
   * @returns {boolean} True if connected
   */
  isPlayerConnected(playerKey) {
    return !!this.getPlayerSocketId(playerKey);
  }

  /**
   * Get socket reference for a player
   * @param {string} playerKey - Player key
   * @returns {Socket|null} Socket object or null
   */
  getPlayerSocket(playerKey) {
    const socketId = this.getPlayerSocketId(playerKey);
    if (!socketId) {
      console.warn(`[${this.constructor.name}] No socket ID for player ${playerKey}`);
      return null;
    }

    // Handle both: io as Namespace (io.sockets is a Map) or Server (io.sockets is a Namespace)
    let socket = null;
    if (this.io.sockets instanceof Map) {
      // io is a Namespace - io.sockets IS the socket map
      socket = this.io.sockets.get(socketId);
    } else if (this.io.sockets && this.io.sockets.sockets instanceof Map) {
      // io is a Server - io.sockets.sockets is the socket map
      socket = this.io.sockets.sockets.get(socketId);
    }

    if (!socket) {
      console.warn(`[${this.constructor.name}] Socket not found for ${playerKey} (id: ${socketId})`);
    }

    return socket || null;
  }

  /**
   * Register a socket event handler and track it for safe cleanup
   * @param {Socket} socket - Socket to register on
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   */
  registerEvent(socket, event, handler) {
    if (socket) {
      socket.on(event, handler);
      this.registeredEvents.push({ socket, event, handler });
    } else {
      console.warn(`[${this.constructor.name}] Cannot register '${event}' - socket is null`);
    }
  }

  /**
   * Add a timeout and track it for cleanup
   * @param {Function} callback - Function to call
   * @param {number} delay - Delay in milliseconds
   * @returns {number} Timer ID
   */
  setTimeout(callback, delay) {
    const timer = setTimeout(callback, delay);
    this.timers.push(timer);
    return timer;
  }

  /**
   * Add an interval and track it for cleanup
   * @param {Function} callback - Function to call
   * @param {number} interval - Interval in milliseconds
   * @returns {number} Interval ID
   */
  setInterval(callback, interval) {
    const intervalId = setInterval(callback, interval);
    this.intervals.push(intervalId);
    return intervalId;
  }

  /**
   * Clear a specific timeout
   * @param {number} timer - Timer ID
   */
  clearTimeout(timer) {
    clearTimeout(timer);
    const index = this.timers.indexOf(timer);
    if (index > -1) {
      this.timers.splice(index, 1);
    }
  }

  /**
   * Clear a specific interval
   * @param {number} interval - Interval ID
   */
  clearInterval(interval) {
    clearInterval(interval);
    const index = this.intervals.indexOf(interval);
    if (index > -1) {
      this.intervals.splice(index, 1);
    }
  }

  // --- Validation Methods ---

  /**
   * Validate that the game is active
   * @returns {boolean} True if game is active
   */
  validateGameActive() {
    if (!this.gameActive) {
      console.warn(`[${this.constructor.name}] Action attempted on inactive game`);
      return false;
    }
    return true;
  }

  /**
   * Validate that a player key is valid
   * @param {string} playerKey - Player key to validate
   * @returns {boolean} True if valid
   */
  validatePlayer(playerKey) {
    if (playerKey !== this.player1.key && playerKey !== this.player2.key) {
      console.warn(`[${this.constructor.name}] Invalid player key: ${playerKey}`);
      return false;
    }
    return true;
  }
}

module.exports = MiniGameBase;
