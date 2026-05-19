// Master Game Launcher - Jackbox-style game selector
// Runs on port 3000, serves host UI at / and player UI at /players
// Games are dynamically mounted as Express routers on /game/{gameId}

"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { Server } = require("socket.io");
const chokidar = require("chokidar");

// Settings and Stats file paths
const SETTINGS_FILE = process.env.GAME_LAUNCHER_SETTINGS_FILE || path.join(__dirname, "settings.json");
const STATS_FILE = process.env.GAME_LAUNCHER_STATS_FILE || path.join(__dirname, "stats.json");

const PORT = process.env.PORT || 3000;

function resolveGamesFolder() {
  const preferred = path.join(__dirname, "Games");
  const legacy = path.join(__dirname, "games");

  if (fs.existsSync(preferred)) return preferred;
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

// Active game instances: gameId -> { module, namespace, cleanup }
const activeGames = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 120000,
});

// ============ GAME REGISTRY (Dynamic) ============
const GAMES_FOLDER = resolveGamesFolder();

function loadGames() {
  const games = [];

  // Create games folder if it doesn't exist
  if (!fs.existsSync(GAMES_FOLDER)) {
    console.warn("Warning: 'Games' folder not found. Creating empty folder...");
    fs.mkdirSync(GAMES_FOLDER);
    return games;
  }

  // Scan for game folders
  const entries = fs.readdirSync(GAMES_FOLDER, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const gameDir = path.join(GAMES_FOLDER, entry.name);
    const configPath = path.join(gameDir, "game.json");
    const serverPath = path.join(gameDir, "server.js");

    // Validate required files exist
    if (!fs.existsSync(configPath)) {
      console.warn(`  Skipping ${entry.name}: missing game.json`);
      continue;
    }

    if (!fs.existsSync(serverPath)) {
      console.warn(`  Skipping ${entry.name}: missing server.js`);
      continue;
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

      // Validate required fields
      if (!config.id || !config.name || config.minPlayers === undefined || config.maxPlayers === undefined) {
        console.warn(`  Skipping ${entry.name}: invalid game.json (missing required fields)`);
        continue;
      }

      // Build icon URL if icon exists
      let iconUrl = null;
      if (config.icon) {
        const iconPath = path.join(gameDir, config.icon);
        if (fs.existsSync(iconPath)) {
          iconUrl = `/games/${entry.name}/${config.icon}`;
        }
      }

      // Build preview URL if preview exists
      let previewUrl = null;
      if (config.preview) {
        const previewPath = path.join(gameDir, config.preview);
        if (fs.existsSync(previewPath)) {
          previewUrl = `/games/${entry.name}/${config.preview}`;
        }
      }

      games.push({
        id: config.id,
        name: config.name,
        folder: entry.name, // Actual folder name (for path resolution)
        minPlayers: config.minPlayers,
        maxPlayers: config.maxPlayers,
        description: config.description || "",
        icon: iconUrl,
        preview: previewUrl,
      });

      console.log(`  Loaded: ${config.name} (${entry.name})`);
    } catch (err) {
      console.warn(`  Error loading ${entry.name}:`, err.message);
    }
  }

  return games;
}

let GAMES = []; // Will be populated at startup

// ============ STATE ============
let state = {
  phase: "menu", // "menu" | "voting" | "game"
  hostSocketId: null,
  players: new Map(), // playerKey -> { key, name, socketId, connected }
  votes: {}, // playerId -> gameId (for voting mode)
  currentGameId: null,
  votingDeadline: null,
  currentGameData: null, // Store game launch data for reconnecting players
  hostDisconnectTime: null, // FIX 2: Track when host disconnected
  hostRecoveryTimer: null,  // FIX 2: Store timer ID for cleanup
};

let joinSeq = 0;

// FIX 5: Mutex flag to prevent concurrent game launches
let isLaunching = false;

// FIX 7: Track pending graceful shutdowns for player acknowledgments
let pendingShutdowns = new Map(); // shutdownId -> { resolve, timeout, ackCount, expectedCount, gameId }

// FIX 8: Track games currently being shut down to prevent double-shutdown
const shuttingDownGames = new Set();

// ============ SETTINGS PERSISTENCE ============
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      return {
        usePresetNames: data.usePresetNames || false,
        presetNames: data.presetNames || [],
      };
    }
  } catch (e) {
    console.error("Failed to load settings:", e.message);
  }
  return { usePresetNames: false, presetNames: [] };
}

function saveSettings() {
  try {
    const settings = { usePresetNames, presetNames };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error("Failed to save settings:", e.message);
  }
}

// ============ PLAYER STATISTICS ============
function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load stats:", e.message);
  }
  return {};
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {
    console.error("Failed to save stats:", e.message);
  }
}

function updatePlayerStats(playerName, won = false) {
  const stats = loadStats();
  if (!stats[playerName]) {
    stats[playerName] = { gamesPlayed: 0, wins: 0 };
  }
  stats[playerName].gamesPlayed++;
  if (won) stats[playerName].wins++;
  saveStats(stats);
}

function getPlayerStats() {
  return loadStats();
}

// Load saved settings on startup
const savedSettings = loadSettings();
let usePresetNames = savedSettings.usePresetNames;
let presetNames = savedSettings.presetNames;

// ============ HELPERS ============
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        if (!iface.address.startsWith("169.254")) {
          return iface.address;
        }
      }
    }
  }
  return "127.0.0.1";
}

function generateKey() {
  return `p_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getConnectedPlayers() {
  return Array.from(state.players.values()).filter(p => p.connected);
}

function getAllLogicalPlayers() {
  return Array.from(state.players.values());
}

function getPlayerList() {
  return Array.from(state.players.values()).map(p => ({
    key: p.key,
    name: p.name,
    connected: p.connected,
  }));
}

function getHealthPayload() {
  const players = getAllLogicalPlayers();
  return {
    ok: true,
    phase: state.phase,
    currentGameId: state.currentGameId,
    mountedGames: Array.from(activeGames.keys()),
    playerCount: players.length,
    connectedPlayerCount: players.filter(p => p.connected).length,
    hostConnected: !!state.hostSocketId,
    pendingShutdowns: pendingShutdowns.size,
    shuttingDownGames: Array.from(shuttingDownGames),
  };
}

function broadcastToAll(event, data) {
  io.emit(event, data);
}

function broadcastToHost(event, data) {
  if (state.hostSocketId) {
    io.to(state.hostSocketId).emit(event, data);
  }
}

function getTakenNames() {
  return Array.from(state.players.values())
    .map(p => p.name.toUpperCase());
}

function broadcastState() {
  const payload = {
    phase: state.phase,
    players: getPlayerList(),
    games: GAMES,
    currentGameId: state.currentGameId,
    votes: state.phase === "voting" ? getVoteTally() : null,
    usePresetNames,
    presetNames,
    takenNames: getTakenNames(),
  };
  broadcastToAll("state_update", payload);
}

function getVoteTally() {
  const tally = {};
  for (const gameId of Object.values(state.votes)) {
    tally[gameId] = (tally[gameId] || 0) + 1;
  }
  return tally;
}

function getEligibleGames() {
  const playerCount = getAllLogicalPlayers().length;
  return GAMES.filter(g => playerCount >= g.minPlayers && playerCount <= g.maxPlayers);
}

function selectRandomGame() {
  const eligible = getEligibleGames();
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

function resolveVote() {
  const tally = getVoteTally();
  const entries = Object.entries(tally);

  if (entries.length === 0) {
    // No votes - pick random
    return selectRandomGame();
  }

  const maxVotes = Math.max(...entries.map(([_, count]) => count));
  const winners = entries.filter(([_, count]) => count === maxVotes).map(([gameId]) => gameId);

  // Random from tied winners
  const winnerId = winners[Math.floor(Math.random() * winners.length)];
  return GAMES.find(g => g.id === winnerId) || null;
}

// ============ STATIC FILES ============
app.use("/shared", express.static(path.join(__dirname, "shared")));
app.use("/sounds", express.static(path.join(__dirname, "sounds")));
app.use("/games", express.static(GAMES_FOLDER));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/index.html", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/players", (req, res) => {
  res.sendFile(path.join(__dirname, "player.html"));
});

app.get("/player.html", (req, res) => {
  res.sendFile(path.join(__dirname, "player.html"));
});

// Avoid noisy favicon 404s in the console
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get("/host-info", (req, res) => {
  res.json({
    ip: getLocalIP(),
    port: PORT,
    joinPath: "/players",
  });
});

app.get("/health", (req, res) => {
  res.json(getHealthPayload());
});

// ============ SOCKET.IO ============
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // HOST JOIN
  socket.on("host_join", async () => {
    state.hostSocketId = socket.id;

    // FIX 2: Cancel recovery timer if host reconnects
    if (state.hostRecoveryTimer) {
      clearTimeout(state.hostRecoveryTimer);
      state.hostRecoveryTimer = null;
      state.hostDisconnectTime = null;
      console.log("[INFO] Host reconnected. Cancelling auto-recovery timer.");
      io.emit("host_reconnected", { message: "Host reconnected!" });
    }

    // If the host arrives back at the launcher while a game is active, treat that
    // as an intentional return-to-menu and bring connected players with them.
    if (state.phase === "game" && state.currentGameId) {
      await returnToMenuFromGame(state.currentGameId, "host_join");
    } else if (state.phase === "menu" && activeGames.size > 0) {
      // Clean up any stale mounted namespaces from a previous return.
      for (const gId of Array.from(activeGames.keys())) {
        console.log(`[DEBUG] host_join: cleaning up lingering game ${gId}`);
        await returnToMenuFromGame(gId, "host_join_cleanup");
      }
    }

    broadcastState();
    socket.emit("host_init", {
      localIp: getLocalIP(),
      port: PORT,
      games: GAMES,
      usePresetNames,
      presetNames,
      takenNames: getTakenNames(),
    });
  });

  // PLAYER REQUESTS STATE (for preset names on connect)
  socket.on("player_request_state", () => {
    socket.emit("player_init", {
      usePresetNames,
      presetNames,
      takenNames: getTakenNames(),
    });
  });

  // PLAYER JOIN
  socket.on("player_join", (data) => {
    const name = (data?.name || "").trim().slice(0, 20).toUpperCase();
    let playerKey = data?.playerKey || null;

    if (!name) {
      socket.emit("join_error", "Please enter a name.");
      return;
    }

    // Validate against preset names if enabled
    if (usePresetNames && presetNames.length > 0) {
      const normalizedPresets = presetNames.map(n => n.toUpperCase());
      if (!normalizedPresets.includes(name)) {
        socket.emit("join_error", "Please select a name from the preset list.");
        return;
      }
    }

    // Check if name is taken (for new players or name changes) — includes offline players
    const takenByOther = Array.from(state.players.values()).some(p =>
      p.name.toUpperCase() === name && p.key !== playerKey
    );
    if (takenByOther) {
      socket.emit("join_error", "That name is already taken.");
      return;
    }

    // Check for existing player with same key (reconnection)
    let player = playerKey ? state.players.get(playerKey) : null;

    if (player) {
      // Reconnecting
      player.socketId = socket.id;
      player.connected = true;
      player.name = name;
      player.lastSeen = Date.now(); // FIX 4: Track last activity
    } else {
      // New player
      playerKey = generateKey();
      player = {
        key: playerKey,
        name,
        socketId: socket.id,
        connected: true,
        joinOrder: ++joinSeq,
        lastSeen: Date.now(), // FIX 4: Track last activity
      };
      state.players.set(playerKey, player);

      // FIX 6: Post-creation re-validation to detect race condition
      // Re-check if another player took this name between our initial check and now — includes offline
      const duplicatePlayer = Array.from(state.players.values()).find(p =>
        p.name.toUpperCase() === name &&
        p.key !== playerKey // Exclude self
      );

      if (duplicatePlayer) {
        // RACE CONDITION DETECTED! Remove newly created player
        console.log(`[WARN] Race condition detected: ${name} taken by ${duplicatePlayer.key}. Rejecting ${playerKey}.`);
        state.players.delete(playerKey);
        socket.emit("join_error", "That name was just taken by another player. Please try again.");
        return;
      }
    }

    socket.emit("join_success", { playerKey, name });
    broadcastState();

    // If a game is in progress, redirect reconnecting player to it
    // FIX 1: Check if game is still actively mounted (not just phase==="game")
    if (state.phase === "game" && state.currentGameId && activeGames.has(state.currentGameId) && state.currentGameData) {
      console.log(`[DEBUG] Redirecting reconnecting player ${name} to active game ${state.currentGameId}`);
      socket.emit("launch_game", {
        game: state.currentGameData.game,
        playerUrl: state.currentGameData.playerUrl,
        playerKey: playerKey,
        playerName: player.name,
      });
    } else if (state.phase === "game" && !activeGames.has(state.currentGameId)) {
      // Game was unmounted but state not reset - force menu
      console.log(`[WARN] Player ${name} reconnected but game ${state.currentGameId} no longer active. Returning to menu.`);
      state.phase = "menu";
      state.currentGameId = null;
      state.currentGameData = null;
      broadcastState();
    }
  });

  // HOST ACTIONS
  socket.on("host_select_game", (data) => {
    if (socket.id !== state.hostSocketId) return;

    const gameId = data?.gameId;
    const game = GAMES.find(g => g.id === gameId);

    if (!game) {
      socket.emit("host_error", "Invalid game selected.");
      return;
    }

    // Host can select any game regardless of player count
    launchGame(game);
  });

  socket.on("host_random_game", () => {
    if (socket.id !== state.hostSocketId) return;

    if (GAMES.length === 0) {
      socket.emit("host_error", "No games available.");
      return;
    }

    // Pick from ALL games, not just eligible ones
    const game = GAMES[Math.floor(Math.random() * GAMES.length)];
    launchGame(game);
  });

  socket.on("host_start_vote", () => {
    if (socket.id !== state.hostSocketId) return;

    if (GAMES.length === 0) {
      socket.emit("host_error", "No games available.");
      return;
    }

    state.phase = "voting";
    state.votes = {};
    state.votingDeadline = Date.now() + 30000; // 30 second voting window

    broadcastState();
    // Send ALL games for voting, not just eligible ones
    broadcastToAll("voting_started", {
      eligibleGames: GAMES,
      deadline: state.votingDeadline,
    });

    // Auto-resolve after 30 seconds
    setTimeout(() => {
      if (state.phase === "voting") {
        const game = resolveVote();
        if (game) {
          launchGame(game);
        } else {
          state.phase = "menu";
          broadcastState();
        }
      }
    }, 30000);
  });

  socket.on("host_resolve_vote", () => {
    if (socket.id !== state.hostSocketId) return;
    if (state.phase !== "voting") return;

    const game = resolveVote();
    if (game) {
      launchGame(game);
    } else {
      state.phase = "menu";
      broadcastState();
      socket.emit("host_error", "No valid game selected from votes.");
    }
  });

  socket.on("host_reset_session", async () => {
    if (socket.id !== state.hostSocketId) return;

    const mountedGameIds = Array.from(activeGames.keys());
    const targetGameIds = new Set(mountedGameIds);
    if (state.currentGameId) targetGameIds.add(state.currentGameId);

    state.phase = "menu";
    state.currentGameId = null;
    state.votes = {};
    state.votingDeadline = null;
    state.currentGameData = null;

    broadcastState();

    for (const gameId of targetGameIds) {
      await gracefulGameShutdown(gameId);
    }

    broadcastToAll("returned_to_menu", {});
    broadcastState();
  });

  // FIX 7: Updated to use graceful shutdown with acknowledgments
  socket.on("host_return_to_menu", async () => {
    if (socket.id !== state.hostSocketId) return;
    if (!state.currentGameId) return;

    await returnToMenuFromGame(state.currentGameId, "master_host_return");
  });

  socket.on("host_kick_player", (data) => {
    if (socket.id !== state.hostSocketId) return;
    if (state.phase !== "menu") {
      socket.emit("host_error", "Can only kick players from the menu.");
      return;
    }

    const playerKey = data?.playerKey;
    if (!playerKey || !state.players.has(playerKey)) return;

    const player = state.players.get(playerKey);
    if (player.socketId) {
      io.to(player.socketId).emit("kicked", { message: "You have been removed by the host." });
      const targetSocket = io.sockets.sockets.get(player.socketId);
      if (targetSocket) targetSocket.disconnect(true);
    }

    state.players.delete(playerKey);
    broadcastState();
  });

  // PRESET NAMES MANAGEMENT
  socket.on("host_toggle_preset_names", async () => {
    if (socket.id !== state.hostSocketId) return;

    const wasPreset = usePresetNames;
    usePresetNames = !usePresetNames;

    // If switching from custom to preset mode, force players with invalid names to reselect
    if (!wasPreset && usePresetNames && presetNames.length > 0) {
      const normalizedPresets = new Set(presetNames.map(n => n.toUpperCase()));

      for (const [key, p] of state.players.entries()) {
        if (!p.connected || !p.socketId) continue;

        if (!normalizedPresets.has(p.name.toUpperCase())) {
          io.to(p.socketId).emit("forceReselect", {
            reason: "Host enabled preset names. Please select a name from the list."
          });
          // Remove player so they can rejoin with a valid name
          state.players.delete(key);
        }
      }
    }

    saveSettings();
    broadcastState();

    // If game is active, send settings update to game via Socket.IO namespace
    if (state.phase === "game" && state.currentGameId) {
      const gameInstance = activeGames.get(state.currentGameId);
      if (gameInstance && gameInstance.namespace) {
        gameInstance.namespace.emit("settings_updated", {
          usePresetNames: usePresetNames,
          presetNames: presetNames
        });
        console.log('[DEBUG] Synced preset settings to active game');
      }
    }
  });

  socket.on("host_add_preset_name", async (data) => {
    if (socket.id !== state.hostSocketId) return;

    const name = (data?.name || "").trim().toUpperCase();
    if (!name) return;

    // Check for duplicates
    if (presetNames.some(n => n.toUpperCase() === name)) {
      socket.emit("host_error", "That name is already in the preset list.");
      return;
    }

    presetNames.push(name);
    saveSettings();
    broadcastState();

    // If game is active, send settings update to game via Socket.IO namespace
    if (state.phase === "game" && state.currentGameId) {
      const gameInstance = activeGames.get(state.currentGameId);
      if (gameInstance && gameInstance.namespace) {
        gameInstance.namespace.emit("settings_updated", {
          usePresetNames: usePresetNames,
          presetNames: presetNames
        });
        console.log('[DEBUG] Synced preset settings to active game (added name)');
      }
    }
  });

  socket.on("host_remove_preset_name", async (data) => {
    if (socket.id !== state.hostSocketId) return;

    const name = (data?.name || "").trim().toUpperCase();
    if (!name) return;

    presetNames = presetNames.filter(n => n.toUpperCase() !== name);
    saveSettings();
    broadcastState();

    // If game is active, send settings update to game via Socket.IO namespace
    if (state.phase === "game" && state.currentGameId) {
      const gameInstance = activeGames.get(state.currentGameId);
      if (gameInstance && gameInstance.namespace) {
        gameInstance.namespace.emit("settings_updated", {
          usePresetNames: usePresetNames,
          presetNames: presetNames
        });
        console.log('[DEBUG] Synced preset settings to active game (removed name)');
      }
    }
  });

  // GAME ENDED - Update winner statistics
  socket.on("game_ended", (data) => {
    // Games can emit this event with winner information
    const winners = data?.winners || [];
    if (winners.length === 0) return;

    // Load stats once, update all winners, save once (avoids race condition)
    const stats = loadStats();
    let updated = false;
    winners.forEach(winnerName => {
      if (stats[winnerName]) {
        stats[winnerName].wins++;
        updated = true;
      }
    });
    if (updated) {
      saveStats(stats);
    }
  });

  // PLAYER ACTIONS
  socket.on("player_vote", (data) => {
    if (state.phase !== "voting") return;

    const player = Array.from(state.players.values()).find(p => p.socketId === socket.id);
    if (!player) return;

    const gameId = data?.gameId;
    // Allow voting for any game
    if (!GAMES.find(g => g.id === gameId)) return;

    state.votes[player.key] = gameId;
    broadcastState();
  });

  // FIX 7: Player acknowledgment for graceful shutdown
  socket.on("player_ack_return_to_menu", (data) => {
    if (data && data.shutdownId) {
      handlePlayerAckReturnToMenu(data.shutdownId, socket.id);
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    if (socket.id === state.hostSocketId) {
      state.hostSocketId = null;
      state.hostDisconnectTime = Date.now();

      // Host disconnected during game - notify players but don't auto-return
      // Players and host stay connected indefinitely until host explicitly exits to launcher
      if (state.phase === "game") {
        console.log("[INFO] Host disconnected during game. Waiting for reconnection...");

        // Notify players that host disconnected (no countdown - wait indefinitely)
        io.emit("host_disconnected", {
          message: "Host disconnected. Waiting for host to reconnect..."
        });

        // Clear any existing recovery timer (if any from previous logic)
        if (state.hostRecoveryTimer) {
          clearTimeout(state.hostRecoveryTimer);
          state.hostRecoveryTimer = null;
        }
      }

      return;
    }

    const player = Array.from(state.players.values()).find(p => p.socketId === socket.id);
    if (player) {
      player.connected = false;
      player.lastSeen = Date.now(); // FIX 4: Track when player went offline
      broadcastState();
    }
  });
});

// ============ GAME MOUNTING ============

function unmountGame(gameId) {
  const gameInstance = activeGames.get(gameId);
  if (!gameInstance) return;

  console.log(`[DEBUG] Unmounting game: ${gameId}`);

  // Call cleanup function
  if (gameInstance.cleanup) {
    try {
      gameInstance.cleanup();
    } catch (e) {
      console.error(`[ERROR] Cleanup failed for ${gameId}:`, e.message);
    }
  }

  // Disconnect all sockets and destroy namespace completely
  if (gameInstance.namespace) {
    const nsName = `/game/${gameId}`;
    gameInstance.namespace.disconnectSockets(true); // force-close underlying connections
    gameInstance.namespace.removeAllListeners();

    // Remove namespace from Socket.IO internal registry so remount creates a fresh one
    if (io._nsps && io._nsps.delete) {
      io._nsps.delete(nsName);
      console.log(`[DEBUG] Removed Socket.IO namespace ${nsName}`);
    }
  }

  // Remove Express route to prevent stale routes accumulating
  if (gameInstance.router && app._router) {
    const before = app._router.stack.length;
    app._router.stack = app._router.stack.filter(
      layer => layer.handle !== gameInstance.router
    );
    console.log(`[DEBUG] Removed ${before - app._router.stack.length} Express route(s) for ${gameId}`);
  }

  // Remove from active games
  activeGames.delete(gameId);

  console.log(`[DEBUG] Game ${gameId} unmounted successfully`);
}

// FIX 7: Graceful shutdown - wait for player acknowledgments before unmounting
// FIX 8: Added shuttingDownGames guard to prevent double-shutdown
async function gracefulGameShutdown(gameId) {
  // Prevent concurrent shutdowns of the same game
  if (shuttingDownGames.has(gameId)) {
    console.log(`[DEBUG] Game ${gameId} is already shutting down, skipping`);
    return;
  }
  shuttingDownGames.add(gameId);

  const gameInstance = activeGames.get(gameId);
  if (!gameInstance || !gameInstance.namespace) {
    console.log(`[DEBUG] No active game instance for ${gameId}, unmounting directly`);
    unmountGame(gameId);
    shuttingDownGames.delete(gameId);
    return;
  }

  const shutdownId = `shutdown_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  let sockets;
  try {
    sockets = await gameInstance.namespace.fetchSockets();
  } catch (e) {
    console.log(`[DEBUG] Could not fetch sockets for ${gameId}, unmounting directly`);
    unmountGame(gameId);
    shuttingDownGames.delete(gameId);
    return;
  }

  const playerCount = sockets.length;
  console.log(`[DEBUG] Graceful shutdown for ${gameId}: ${playerCount} connected socket(s)`);

  if (playerCount === 0) {
    unmountGame(gameId);
    shuttingDownGames.delete(gameId);
    return;
  }

  return new Promise((resolve) => {
    const timeoutMs = 3000; // 3 second timeout for acknowledgments

    const shutdownState = {
      resolve,
      ackCount: 0,
      expectedCount: playerCount,
      ackedSocketIds: new Set(),
      gameId,
      timeout: setTimeout(() => {
        console.log(`[WARN] Graceful shutdown timeout for ${gameId}. ${shutdownState.ackCount}/${playerCount} acks received. Forcing unmount.`);
        pendingShutdowns.delete(shutdownId);
        unmountGame(gameId);
        shuttingDownGames.delete(gameId);
        resolve();
      }, timeoutMs)
    };

    pendingShutdowns.set(shutdownId, shutdownState);

    // Emit returned_to_menu with shutdownId for acknowledgment tracking
    gameInstance.namespace.emit("returned_to_menu", { shutdownId });
    console.log(`[DEBUG] Sent returned_to_menu to ${playerCount} player(s) with shutdownId: ${shutdownId}`);
  });
}

// FIX 7: Handle player acknowledgment of return_to_menu
function handlePlayerAckReturnToMenu(shutdownId, socketId = null) {
  const shutdownState = pendingShutdowns.get(shutdownId);
  if (!shutdownState) {
    console.log(`[DEBUG] Received ack for unknown/expired shutdownId: ${shutdownId}`);
    return;
  }

  if (socketId && shutdownState.ackedSocketIds.has(socketId)) {
    return;
  }
  if (socketId) {
    shutdownState.ackedSocketIds.add(socketId);
  }

  shutdownState.ackCount++;
  console.log(`[DEBUG] Ack received for ${shutdownState.gameId}: ${shutdownState.ackCount}/${shutdownState.expectedCount}`);

  if (shutdownState.ackCount >= shutdownState.expectedCount) {
    console.log(`[DEBUG] All players acknowledged for ${shutdownState.gameId}. Proceeding with unmount.`);
    clearTimeout(shutdownState.timeout);
    pendingShutdowns.delete(shutdownId);
    unmountGame(shutdownState.gameId);
    shuttingDownGames.delete(shutdownState.gameId);
    shutdownState.resolve();
  }
}

async function returnToMenuFromGame(gameId, reason = "unknown") {
  if (!gameId) return false;

  console.log(`[DEBUG] Returning to menu from game ${gameId} (${reason})`);

  if (state.phase !== "menu" || state.currentGameId || state.currentGameData) {
    state.phase = "menu";
    state.currentGameId = null;
    state.votes = {};
    state.currentGameData = null;
    broadcastState();
  }

  await gracefulGameShutdown(gameId);

  // Master namespace notification catches players already back on /players.
  broadcastToAll("returned_to_menu", {});
  broadcastState();
  return true;
}

// FIX 8: Cancel any pending graceful shutdown for a game (before re-mounting)
function cancelPendingShutdown(gameId) {
  for (const [shutdownId, shutdown] of pendingShutdowns.entries()) {
    if (shutdown.gameId === gameId) {
      clearTimeout(shutdown.timeout);
      pendingShutdowns.delete(shutdownId);
      shutdown.resolve();
      console.log(`[DEBUG] Cancelled pending shutdown ${shutdownId} for ${gameId}`);
      break;
    }
  }
  shuttingDownGames.delete(gameId);
}

async function mountGame(game) {
  const gameDir = path.join(GAMES_FOLDER, game.folder);
  const gamePath = path.join(gameDir, "server.js");

  // Sanity check: verify game file exists
  if (!fs.existsSync(gamePath)) {
    console.error(`[ERROR] Game server not found: ${gamePath}`);
    throw new Error(`Game file not found: ${game.name}`);
  }

  console.log(`[DEBUG] Mounting ${game.name} from ${gamePath}...`);

  // Clear require cache to support hot reload
  delete require.cache[require.resolve(gamePath)];

  // Dynamically load game module
  const gameModule = require(gamePath);

  // Check if game exports the init function
  if (typeof gameModule.init !== 'function') {
    throw new Error(`${game.name} does not export an init() function`);
  }

  // Create Socket.IO namespace for this game
  const namespace = io.of(`/game/${game.id}`);

  // Initialize game with namespace and config
  const gameInstance = gameModule.init({
    io: namespace,
    gamePath: gameDir,
    masterState: state,
    players: Array.from(state.players.values()).map(p => ({
      key: p.key,
      name: p.name,
      connected: p.connected,
    })),
    settings: {
      usePresetNames: usePresetNames,
      presetNames: presetNames
    }
  });

  // Mount game's Express router
  app.use(`/game/${game.id}`, gameInstance.router);

  // Store for cleanup (including router reference for Express route removal)
  activeGames.set(game.id, {
    module: gameModule,
    namespace: namespace,
    cleanup: gameInstance.cleanup,
    router: gameInstance.router
  });

  // FIX 8: Master-level intercept on game namespace for host_return_to_menu
  // When the game's host_return_to_menu fires, immediately update master state
  // to prevent the race condition where players reconnect to master before the host
  // and get bounced back into the game via launch_game.
  namespace.on('connection', (gameSocket) => {
    gameSocket.on('host_return_to_menu', () => {
      if ((state.phase === "game" && state.currentGameId === game.id) || activeGames.has(game.id)) {
        returnToMenuFromGame(game.id, "game_namespace_host_return");
      }
    });

    gameSocket.on('player_ack_return_to_menu', (data) => {
      if (data && data.shutdownId) {
        handlePlayerAckReturnToMenu(data.shutdownId, gameSocket.id);
      }
    });
  });

  console.log(`[DEBUG] ${game.name} mounted successfully on /game/${game.id}`);
}

async function launchGame(game) {
  console.log(`\n[DEBUG] launchGame called: id=${game.id}, folder=${game.folder}, name=${game.name}`);

  // FIX 5: Check mutex to prevent concurrent launches
  if (isLaunching) {
    console.log(`[WARN] Game launch already in progress. Ignoring duplicate request.`);
    if (state.hostSocketId) {
      const hostSocket = io.sockets.sockets.get(state.hostSocketId);
      if (hostSocket) {
        hostSocket.emit("host_error", "A game is already launching. Please wait...");
      }
    }
    return;
  }

  // FIX 5: Acquire mutex lock
  isLaunching = true;

  try {
    // Unmount any existing mounted games first. This keeps direct game switches
    // and stale namespaces from carrying old sockets into the next round.
    for (const mountedGameId of Array.from(activeGames.keys())) {
      cancelPendingShutdown(mountedGameId);
      unmountGame(mountedGameId);
    }

    // Mount the new game
    await mountGame(game);

    state.phase = "game";
    state.currentGameId = game.id;
    state.votes = {};

    const ip = getLocalIP();
    const hostUrl = `http://${ip}:${PORT}/game/${game.id}`;
    const playerUrl = `http://${ip}:${PORT}/game/${game.id}/players`;

    // Store game data for reconnecting players
    state.currentGameData = {
      game: game,
      hostUrl: hostUrl,
      playerUrl: playerUrl,
    };

    broadcastState();

    // Build player data for ALL players (online and offline)
    const playerData = Array.from(state.players.values()).map(p => ({
      key: p.key,
      name: p.name,
      connected: p.connected,
    }));

    // Tell host to redirect
    broadcastToHost("launch_game", {
      game: game,
      hostUrl: hostUrl,
      players: playerData,
    });

    // Tell players to redirect
    const connectedPlayers = getConnectedPlayers();
    connectedPlayers.forEach(p => {
      if (p.socketId) {
        io.to(p.socketId).emit("launch_game", {
          game: game,
          playerUrl: playerUrl,
          playerKey: p.key,
          playerName: p.name,
        });
      }
    });

    // Update stats: increment games played for all players
    Array.from(state.players.values()).forEach(p => {
      updatePlayerStats(p.name, false);
    });

    console.log(`[DEBUG] ${game.name} launched successfully! Clients redirected.`);

  } catch (err) {
    console.error(`[ERROR] Failed to launch ${game.name}:`, err.message);
    broadcastToHost("host_error", `Failed to start ${game.name}: ${err.message}`);
    state.phase = "menu";
    state.currentGameId = null;
    broadcastState();
  } finally {
    // FIX 5: Always release mutex lock
    isLaunching = false;
  }
}

// ============ START SERVER ============
console.log("Loading games from 'games' folder...");
GAMES = loadGames();

if (GAMES.length === 0) {
  console.warn("\nNo games detected! Make sure games are in the 'games' folder with valid game.json files.\n");
}

server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log("");
  console.log("=".repeat(50));
  console.log("  MASTER GAME LAUNCHER");
  console.log("=".repeat(50));
  console.log(`  Host Screen:   http://${ip}:${PORT}/`);
  console.log(`  Player Join:   http://${ip}:${PORT}/players`);
  console.log("=".repeat(50));
  console.log(`\nDetected ${GAMES.length} game(s):`);
  GAMES.forEach(g => {
    console.log(`  - ${g.name} (${g.minPlayers}-${g.maxPlayers} players)`);
  });
  console.log("");
});

// ============ FIX 4: PLAYER CLEANUP JOB ============
// Prune offline players after 24 hours to prevent memory leak
const PLAYER_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const CLEANUP_INTERVAL = 60 * 60 * 1000; // Run every hour

setInterval(() => {
  const now = Date.now();
  let prunedCount = 0;

  for (const [key, player] of state.players.entries()) {
    // Only prune if:
    // 1. Player is offline
    // 2. Last seen more than 24h ago
    // 3. No game in progress (preserve players during active game)
    if (!player.connected && state.phase !== "game" && (now - player.lastSeen) > PLAYER_TTL) {
      state.players.delete(key);
      prunedCount++;
    }
  }

  if (prunedCount > 0) {
    console.log(`[CLEANUP] Pruned ${prunedCount} stale player(s) from memory`);
    broadcastState();
  }
}, CLEANUP_INTERVAL);

console.log("[INFO] Player cleanup job started (runs hourly, 24h TTL)");

// ============ HOT-RELOAD GAMES ============
// Watch for changes in the games folder
const watcher = chokidar.watch(GAMES_FOLDER, {
  ignoreInitial: true,
  depth: 2,
  ignored: /node_modules/,
});

let reloadTimeout = null;

watcher.on("all", (event, filePath) => {
  // Only reload on relevant file changes
  if (filePath.endsWith("game.json") || filePath.endsWith("server.js")) {
    // Debounce: wait 500ms before reloading to avoid multiple triggers
    if (reloadTimeout) clearTimeout(reloadTimeout);
    reloadTimeout = setTimeout(() => {
      console.log(`\n[HOT-RELOAD] Game change detected: ${event} ${path.basename(filePath)}`);
      console.log("[HOT-RELOAD] Reloading games...");

      // Reload games list
      GAMES.length = 0;
      GAMES.push(...loadGames());

      console.log(`[HOT-RELOAD] Loaded ${GAMES.length} game(s)`);

      // Notify host of updated games
      broadcastToHost("games_updated", { games: GAMES });
      broadcastState();
    }, 500);
  }
});

console.log("[HOT-RELOAD] Watching games folder for changes...");
