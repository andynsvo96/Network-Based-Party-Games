/**
 * Shared Player Manager for Session-Based Multiplayer Games
 * 
 * This module provides a centralized system for managing players across multiple games.
 * Key features:
 * - Players are session-based, not connection-based
 * - Disconnect only marks players as offline, doesn't remove them
 * - Players persist until explicitly kicked by host
 * - Supports reconnection via persistent player keys
 * - Handles preset names validation
 * 
 * Usage:
 *   const PlayerManager = require('../shared/playerManager');
 *   const pm = new PlayerManager(io, { ... options });
 */

'use strict';

const crypto = require('crypto');

/**
 * Generate a unique player key
 */
function generateKey() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/**
 * Normalize a player name (uppercase, trimmed)
 */
function normalizeName(name) {
  return String(name || '').trim().toUpperCase();
}

/**
 * Validate name format (letters and spaces only by default)
 */
function isValidNameFormat(name, options = {}) {
  const n = normalizeName(name);
  if (!n || n.length === 0) return false;
  
  const maxLength = options.maxLength || 20;
  if (n.length > maxLength) return false;
  
  // Allow only letters and spaces by default
  if (options.allowSpecialChars) {
    return true;
  }
  return /^[A-Z ]+$/.test(n);
}

class PlayerManager {
  /**
   * @param {Object} io - Socket.IO server instance
   * @param {Object} options - Configuration options
   * @param {Function} options.onPlayerJoin - Callback when player joins
   * @param {Function} options.onPlayerLeave - Callback when player disconnects
   * @param {Function} options.onPlayerReconnect - Callback when player reconnects
   * @param {Function} options.onPlayerKicked - Callback when player is kicked
   * @param {Function} options.onPlayersUpdated - Callback when player list changes
   * @param {boolean} options.allowSpecialChars - Allow special characters in names
   * @param {number} options.maxNameLength - Maximum name length (default: 20)
   * @param {boolean} options.allowJoinDuringGame - Allow new players during active game
   */
  constructor(io, options = {}) {
    this.io = io;
    this.options = {
      allowSpecialChars: false,
      maxNameLength: 20,
      allowJoinDuringGame: false,
      ...options
    };

    // Player storage: key -> PlayerData
    this.players = new Map();
    
    // Socket to key mapping for quick lookups
    this.socketToKey = new Map();
    
    // Host tracking
    this.hostSocketId = null;
    
    // Preset names configuration
    this.presetNamesEnabled = false;
    this.presetNames = [];
    this.usedPresetNames = new Set();
    
    // Game state (for join restrictions)
    this.gamePhase = 'lobby';
    
    // Callbacks
    this.onPlayerJoin = options.onPlayerJoin || (() => {});
    this.onPlayerLeave = options.onPlayerLeave || (() => {});
    this.onPlayerReconnect = options.onPlayerReconnect || (() => {});
    this.onPlayerKicked = options.onPlayerKicked || (() => {});
    this.onPlayersUpdated = options.onPlayersUpdated || (() => {});
  }

  /**
   * Player data structure
   */
  createPlayerData(key, name, socketId) {
    return {
      key,
      name: normalizeName(name),
      socketId,
      connected: true,
      lastSeen: Date.now(),
      // Game-specific data can be added via extend()
      data: {}
    };
  }

  /**
   * Set host socket
   */
  setHost(socketId) {
    this.hostSocketId = socketId;
  }

  /**
   * Check if socket is host
   */
  isHost(socketId) {
    return socketId === this.hostSocketId;
  }

  /**
   * Set game phase (affects join restrictions)
   */
  setGamePhase(phase) {
    this.gamePhase = phase;
  }

  /**
   * Configure preset names
   */
  setPresetNames(enabled, names = []) {
    this.presetNamesEnabled = enabled;
    this.presetNames = names.map(n => normalizeName(n)).filter(n => n);
    
    // Rebuild used names from current players
    this.usedPresetNames.clear();
    if (enabled) {
      for (const player of this.players.values()) {
        if (player.connected && this.presetNames.includes(player.name)) {
          this.usedPresetNames.add(player.name);
        }
      }
    }
    
    return {
      enabled: this.presetNamesEnabled,
      names: this.presetNames,
      usedNames: Array.from(this.usedPresetNames)
    };
  }

  /**
   * Get preset names state
   */
  getPresetNamesState() {
    return {
      enabled: this.presetNamesEnabled,
      names: this.presetNames,
      usedNames: Array.from(this.usedPresetNames)
    };
  }

  /**
   * Check if a name is already taken
   */
  isNameTaken(name, exceptKey = null) {
    const normalized = normalizeName(name);
    for (const [key, player] of this.players.entries()) {
      if (exceptKey && key === exceptKey) continue;
      if (!player.connected) continue;
      if (player.name === normalized) return true;
    }
    return false;
  }

  /**
   * Validate a player name
   * @returns {{ valid: boolean, error?: string }}
   */
  validateName(name, exceptKey = null) {
    const normalized = normalizeName(name);
    
    if (!normalized) {
      return { valid: false, error: 'Name is required.' };
    }
    
    if (!isValidNameFormat(name, {
      maxLength: this.options.maxNameLength,
      allowSpecialChars: this.options.allowSpecialChars
    })) {
      if (normalized.length > this.options.maxNameLength) {
        return { valid: false, error: `Name is too long (max ${this.options.maxNameLength} chars).` };
      }
      return { valid: false, error: 'Special characters are not allowed.' };
    }
    
    // Check preset names
    if (this.presetNamesEnabled && this.presetNames.length > 0) {
      if (!this.presetNames.includes(normalized)) {
        return { valid: false, error: 'Please select a name from the preset list.' };
      }
      if (this.usedPresetNames.has(normalized)) {
        const existing = this.getPlayerByName(normalized);
        if (!existing || existing.key !== exceptKey) {
          return { valid: false, error: 'This name is already taken. Choose another.' };
        }
      }
    } else {
      // Standard duplicate check
      if (this.isNameTaken(normalized, exceptKey)) {
        return { valid: false, error: 'That name is already taken. Please choose another one.' };
      }
    }
    
    return { valid: true };
  }

  /**
   * Handle player join/register
   * @param {Object} socket - Player's socket
   * @param {Object} payload - { name, playerKey }
   * @param {Function} callback - Acknowledgment callback
   * @returns {{ ok: boolean, error?: string, player?: Object }}
   */
  handleJoin(socket, payload, callback) {
    const isObj = payload && typeof payload === 'object';
    const rawName = isObj ? payload.name : payload;
    const rawKey = isObj ? (payload.playerKey || payload.key) : null;
    
    const name = normalizeName(rawName);
    const key = String(rawKey || '').trim() || generateKey();
    
    // Check if this is a reconnection
    const existingPlayer = this.players.get(key);
    const isReconnecting = !!existingPlayer;
    
    // Check game phase restrictions
    if (this.gamePhase !== 'lobby' && !isReconnecting) {
      if (!this.options.allowJoinDuringGame) {
        const result = { ok: false, error: 'Game already started. Please wait for the next game.' };
        if (callback) callback(result);
        return result;
      }
    }
    
    // Validate name
    const validation = this.validateName(name, key);
    if (!validation.valid) {
      const result = { ok: false, error: validation.error };
      if (callback) callback(result);
      return result;
    }
    
    const now = Date.now();
    
    if (isReconnecting) {
      // Update existing player
      const oldName = existingPlayer.name;
      
      // Handle preset name changes
      if (this.presetNamesEnabled && oldName !== name) {
        this.usedPresetNames.delete(oldName);
        this.usedPresetNames.add(name);
      }
      
      existingPlayer.name = name;
      existingPlayer.socketId = socket.id;
      existingPlayer.connected = true;
      existingPlayer.lastSeen = now;
      
      this.socketToKey.set(socket.id, key);
      
      const result = { ok: true, name, key, player: existingPlayer, reconnected: true };
      if (callback) callback(result);
      
      this.onPlayerReconnect(existingPlayer, socket);
      this.broadcastPlayers();
      
      return result;
    } else {
      // Create new player
      const player = this.createPlayerData(key, name, socket.id);
      this.players.set(key, player);
      this.socketToKey.set(socket.id, key);
      
      if (this.presetNamesEnabled) {
        this.usedPresetNames.add(name);
      }
      
      const result = { ok: true, name, key, player, reconnected: false };
      if (callback) callback(result);
      
      this.onPlayerJoin(player, socket);
      this.broadcastPlayers();
      
      return result;
    }
  }

  /**
   * Handle player disconnect
   * NOTE: This marks the player as offline, NOT removes them
   * @param {Object} socket - Disconnecting socket
   */
  handleDisconnect(socket) {
    const key = this.socketToKey.get(socket.id);
    if (!key) return null;
    
    this.socketToKey.delete(socket.id);
    const player = this.players.get(key);
    
    if (player) {
      player.connected = false;
      player.lastSeen = Date.now();
      player.socketId = null;
      
      // Free up preset name when disconnected
      if (this.presetNamesEnabled && player.name) {
        this.usedPresetNames.delete(player.name);
      }
      
      this.onPlayerLeave(player, socket);
      this.broadcastPlayers();
    }
    
    return player;
  }

  /**
   * Kick a player (host only)
   * @param {string} hostSocketId - Host's socket ID (for verification)
   * @param {string} playerKey - Key of player to kick
   * @returns {{ ok: boolean, error?: string }}
   */
  kickPlayer(hostSocketId, playerKey) {
    if (hostSocketId !== this.hostSocketId) {
      return { ok: false, error: 'Only the host can kick players.' };
    }
    
    const player = this.players.get(playerKey);
    if (!player) {
      return { ok: false, error: 'Player not found.' };
    }
    
    // Disconnect their socket if connected
    if (player.socketId && this.io) {
      const socket = this.io.sockets.sockets.get(player.socketId);
      if (socket) {
        socket.emit('kicked', { reason: 'You have been removed by the host.' });
        socket.disconnect(true);
      }
    }
    
    // Free preset name
    if (this.presetNamesEnabled && player.name) {
      this.usedPresetNames.delete(player.name);
    }
    
    // Remove player completely
    this.players.delete(playerKey);
    if (player.socketId) {
      this.socketToKey.delete(player.socketId);
    }
    
    this.onPlayerKicked(player);
    this.broadcastPlayers();
    
    return { ok: true, player };
  }

  /**
   * Remove disconnected player by key
   * @param {string} playerKey - Key of player to remove
   */
  removePlayer(playerKey) {
    const player = this.players.get(playerKey);
    if (!player) return false;
    
    if (this.presetNamesEnabled && player.name) {
      this.usedPresetNames.delete(player.name);
    }
    
    this.players.delete(playerKey);
    if (player.socketId) {
      this.socketToKey.delete(player.socketId);
    }
    
    this.broadcastPlayers();
    return true;
  }

  /**
   * Get player by socket ID
   */
  getPlayerBySocket(socketId) {
    const key = this.socketToKey.get(socketId);
    return key ? this.players.get(key) : null;
  }

  /**
   * Get player by key
   */
  getPlayerByKey(key) {
    return this.players.get(key) || null;
  }

  /**
   * Get player by name
   */
  getPlayerByName(name) {
    const normalized = normalizeName(name);
    for (const player of this.players.values()) {
      if (player.name === normalized) return player;
    }
    return null;
  }

  /**
   * Get all players
   */
  getAllPlayers() {
    return Array.from(this.players.values());
  }

  /**
   * Get connected players only
   */
  getConnectedPlayers() {
    return this.getAllPlayers().filter(p => p.connected);
  }

  /**
   * Get player names
   */
  getPlayerNames(connectedOnly = false) {
    const list = connectedOnly ? this.getConnectedPlayers() : this.getAllPlayers();
    return list.map(p => p.name);
  }

  /**
   * Get player count
   */
  getPlayerCount(connectedOnly = false) {
    return connectedOnly
      ? this.getConnectedPlayers().length
      : this.players.size;
  }

  /**
   * Broadcast player list update
   */
  broadcastPlayers() {
    const players = this.getAllPlayers().map(p => ({
      key: p.key,
      name: p.name,
      connected: p.connected,
      data: p.data
    }));
    
    this.onPlayersUpdated(players);
    
    if (this.io) {
      this.io.emit('playersUpdated', this.getPlayerNames());
    }
  }

  /**
   * Extend player data (for game-specific fields)
   */
  extendPlayer(playerKey, data) {
    const player = this.players.get(playerKey);
    if (player) {
      player.data = { ...player.data, ...data };
      return true;
    }
    return false;
  }

  /**
   * Reset all player data (but keep players)
   */
  resetPlayerData() {
    for (const player of this.players.values()) {
      player.data = {};
    }
  }

  /**
   * Clear all players (full reset)
   */
  clearAllPlayers() {
    this.players.clear();
    this.socketToKey.clear();
    this.usedPresetNames.clear();
    this.broadcastPlayers();
  }

  /**
   * Remove all disconnected players
   */
  pruneDisconnected() {
    for (const [key, player] of this.players.entries()) {
      if (!player.connected) {
        this.players.delete(key);
        if (this.presetNamesEnabled && player.name) {
          this.usedPresetNames.delete(player.name);
        }
      }
    }
    this.broadcastPlayers();
  }

  /**
   * Set up socket handlers for a connection
   */
  setupSocketHandlers(socket) {
    // Register player
    socket.on('registerPlayer', (payload, cb) => {
      this.handleJoin(socket, payload, cb);
    });
    
    socket.on('joinGame', (payload, cb) => {
      this.handleJoin(socket, payload, cb);
    });
    
    // Get preset names
    socket.on('getPresetNames', (cb) => {
      if (cb && typeof cb === 'function') {
        cb(this.getPresetNamesState());
      }
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
      this.handleDisconnect(socket);
    });
  }
}

module.exports = PlayerManager;
module.exports.generateKey = generateKey;
module.exports.normalizeName = normalizeName;
module.exports.isValidNameFormat = isValidNameFormat;
