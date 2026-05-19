// server.js - Jeopardy Multiplayer Buzzer Server
// Exported as a module for the master game launcher

const express = require('express');
const path = require('path');

module.exports.init = function(config) {
  const { io, gamePath, players: initialPlayers, settings } = config;

  // ---------- Router Setup ----------
  const router = express.Router();

  router.get('/', (req, res) => res.sendFile(path.join(gamePath, 'index.html')));
  router.get('/player', (req, res) => res.sendFile(path.join(gamePath, 'player.html')));
  router.get('/players', (req, res) => res.sendFile(path.join(gamePath, 'player.html')));

  // Avoid noisy favicon 404s in the console
  router.get('/favicon.ico', (req, res) => res.status(204).end());

  // Simple ping endpoint (for debugging)
  router.get('/ping', (req, res) => res.send('ok'));

  // Serve static files
  router.use(express.static(gamePath));
  router.use(express.json());

  // ---------- Game State ----------
  let hostId = null;

  // Player persistence (so temporary disconnects don't kick players out)
  // key -> { name, socketId, connected, lastSeen }
  const playersByKey = new Map();
  // socketId -> key
  const socketToKey = new Map();

  let buzzerOpen = false;
  let buzzWinner = null;

  // Timed buzzer settings (host controlled)
  let buzzerMode = 'auto';     // auto | timed | manual
  let buzzerDelaySeconds = 3;  // used when mode === 'timed'
  let buzzerDelayTimeout = null;
  let buzzerCountdownInterval = null;

  // Preset names settings (host controlled)
  let presetNamesEnabled = settings?.usePresetNames || false;
  let presetNames = Array.isArray(settings?.presetNames)
    ? settings.presetNames.map(n => normalizeName(n)).filter(n => n)
    : [];
  let usedPresetNames = new Set();

  // ---------- Helpers ----------
  function normalizeName(raw) {
    return String(raw || '').trim().toUpperCase();
  }

  // Letters + spaces only (A-Z and space)
  function isValidName(name) {
    const n = normalizeName(name);
    return n.length > 0 && /^[A-Z ]+$/.test(n);
  }

  function isNameTaken(name, exceptKey = null) {
    const n = normalizeName(name);
    for (const [k, p] of playersByKey.entries()) {
      if (exceptKey && k === exceptKey) continue;
      if (p && p.name === n) return true;
    }
    return false;
  }

  function broadcastPlayers() {
    // Include connected + recently-disconnected players (until TTL cleanup)
    const names = Array.from(playersByKey.values()).map(p => p.name);
    io.emit('playersUpdated', names);

    // Send detailed player info to host (includes keys for kick functionality)
    if (hostId) {
      const playersWithKeys = Array.from(playersByKey.entries()).map(([key, p]) => ({
        key,
        name: p.name,
        connected: p.connected,
        joinedSession: p.joinedSession !== false  // Default to true for backwards compatibility
      }));
      io.to(hostId).emit('playersDetailedUpdate', playersWithKeys);
    }
  }

  function clearBuzzerTimers() {
    if (buzzerDelayTimeout) {
      clearTimeout(buzzerDelayTimeout);
      buzzerDelayTimeout = null;
    }
    if (buzzerCountdownInterval) {
      clearInterval(buzzerCountdownInterval);
      buzzerCountdownInterval = null;
    }
  }

  function beginQuestion() {
    clearBuzzerTimers();
    buzzerOpen = false;
    buzzWinner = null;

    io.emit('questionSelected');

    if (buzzerMode === 'timed' && Number.isFinite(buzzerDelaySeconds) && buzzerDelaySeconds > 0) {
      let remaining = Math.max(0, Math.min(60, Math.floor(buzzerDelaySeconds)));

      io.emit('buzzerCountdown', { remaining });

      buzzerCountdownInterval = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) io.emit('buzzerCountdown', { remaining });
      }, 1000);

      buzzerDelayTimeout = setTimeout(() => {
        clearBuzzerTimers();
        buzzerOpen = true;
        io.emit('questionStarted');
        console.log(`Question started; buzzers open (after ${buzzerDelaySeconds}s delay)`);
      }, remaining * 1000);
    } else {
      buzzerOpen = true;
      io.emit('questionStarted');
      console.log('Question started; buzzers open');
    }
  }

  function endQuestion() {
    clearBuzzerTimers();
    buzzerOpen = false;
    buzzWinner = null;
    io.emit('questionEnded');
    console.log('Question ended; buzzers closed');
  }

  function upsertPlayer(payload, socket, callback) {
    const isObj = payload && typeof payload === 'object';
    const rawName = isObj ? payload.name : payload;
    const rawKey  = isObj ? (payload.playerKey || payload.key) : null;

    const name = normalizeName(rawName);
    const key = String(rawKey || '').trim() || socket.id; // fallback key if client doesn't send one

    if (!name) {
      if (callback) callback({ ok: false, error: 'Name is required.' });
      return;
    }
    if (!isValidName(name)) {
      if (callback) callback({ ok: false, error: 'Special characters are not allowed.' });
      return;
    }

    // If preset names are enabled, validate against the preset list
    if (presetNamesEnabled && presetNames.length > 0) {
      if (!presetNames.includes(name)) {
        if (callback) callback({ ok: false, error: 'Please select a name from the preset list.' });
        return;
      }
      // Check if name is already in use (for preset names)
      if (usedPresetNames.has(name)) {
        // Allow same player to reconnect with same name
        const existing = playersByKey.get(key);
        if (!existing || existing.name !== name) {
          if (callback) callback({ ok: false, error: 'This name is already taken. Choose another.' });
          return;
        }
      }
    } else {
      // Standard name taken check for non-preset mode
      if (isNameTaken(name, key)) {
        if (callback) callback({ ok: false, error: 'That name is already taken. Please choose another one.' });
        return;
      }
    }

    const now = Date.now();
    const existing = playersByKey.get(key);
    if (existing) {
      // If changing name in preset mode, update used names
      if (presetNamesEnabled && existing.name !== name) {
        usedPresetNames.delete(existing.name);
        usedPresetNames.add(name);
      }
      existing.name = name;
      existing.socketId = socket.id;
      existing.connected = true;
      existing.joinedSession = true;  // Now connected this session
      existing.lastSeen = now;
      playersByKey.set(key, existing);
    } else {
      playersByKey.set(key, {
        name,
        socketId: socket.id,
        connected: true,
        joinedSession: true,  // Connected this session
        lastSeen: now,
      });
      // Track preset name usage
      if (presetNamesEnabled) {
        usedPresetNames.add(name);
      }
    }

    socketToKey.set(socket.id, key);

    if (callback) callback({ ok: true, name });
    broadcastPlayers();

    // Sync current game state to reconnecting player
    if (buzzerOpen) {
      socket.emit('questionStarted');
    } else if (buzzerDelayTimeout) {
      socket.emit('questionSelected');
    }
  }

  // ---------- Socket.IO ----------
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('registerHost', () => {
      hostId = socket.id;
      buzzerOpen = false;
      buzzWinner = null;
      clearBuzzerTimers();
      socket.emit('hostRegistered');
      broadcastPlayers();
      console.log('Host registered:', hostId);
    });

    socket.on('setBuzzerSettings', (settings = {}) => {
      if (socket.id !== hostId) return;
      const mode = String(settings.mode || '').toLowerCase();
      if (mode === 'auto' || mode === 'manual' || mode === 'timed') buzzerMode = mode;

      const d = parseInt(settings.delaySeconds, 10);
      if (Number.isFinite(d)) buzzerDelaySeconds = Math.max(0, Math.min(60, d));

      console.log('Buzzer settings:', { buzzerMode, buzzerDelaySeconds });
    });

    socket.on('setPresetNames', (settings = {}) => {
      if (socket.id !== hostId) return;

      presetNamesEnabled = Boolean(settings.enabled);
      presetNames = Array.isArray(settings.names) ? settings.names.map(n => normalizeName(n)).filter(n => n) : [];

      // Reset used names when preset names are updated
      usedPresetNames.clear();

      // Rebuild used names from current players
      if (presetNamesEnabled) {
        for (const [, p] of playersByKey.entries()) {
          if (p && p.name && presetNames.includes(p.name)) {
            usedPresetNames.add(p.name);
          }
        }
      }

      console.log('Preset names settings:', { presetNamesEnabled, presetNames: presetNames.length, usedCount: usedPresetNames.size });

      // Broadcast preset names to all players
      io.emit('presetNamesUpdated', { enabled: presetNamesEnabled, names: presetNames, usedNames: Array.from(usedPresetNames) });
    });

    socket.on('registerPlayer', (payload, cb) => upsertPlayer(payload, socket, cb));
    socket.on('joinGame', (payload, cb) => upsertPlayer(payload, socket, cb));

    socket.on('getPresetNames', (cb) => {
      if (cb && typeof cb === 'function') {
        cb({ enabled: presetNamesEnabled, names: presetNames, usedNames: Array.from(usedPresetNames) });
      }
    });

    // Host kicks a player (only allowed when no question is active)
    socket.on('kickPlayer', ({ playerKey }) => {
      if (socket.id !== hostId) return;
      if (!playerKey || !playersByKey.has(playerKey)) return;

      // Only allow kick when no question is active (lobby-like state)
      if (buzzerOpen || buzzWinner) {
        socket.emit('hostError', { message: 'Cannot kick players during an active question.' });
        return;
      }

      const p = playersByKey.get(playerKey);
      const sockId = p.socketId;

      // Notify the kicked player if they're connected
      if (sockId) {
        io.to(sockId).emit('kicked', {
          message: 'You have been removed from the game by the host.'
        });
        // Disconnect their socket
        const targetSocket = io.sockets?.get(sockId);
        if (targetSocket) targetSocket.disconnect(true);
      }

      // Free preset name if applicable
      if (presetNamesEnabled && p.name) {
        usedPresetNames.delete(p.name);
      }

      // Remove player completely
      playersByKey.delete(playerKey);
      if (sockId) socketToKey.delete(sockId);

      console.log('Player kicked:', p.name);

      broadcastPlayers();
      if (presetNamesEnabled) {
        io.emit('presetNamesUpdated', {
          enabled: presetNamesEnabled,
          names: presetNames,
          usedNames: Array.from(usedPresetNames)
        });
      }
    });

    socket.on('startQuestion', () => {
      if (socket.id !== hostId) return;
      beginQuestion();
    });

    socket.on('endQuestion', () => {
      if (socket.id !== hostId) return;
      endQuestion();
    });

    socket.on('host_return_to_menu', () => {
      if (socket.id !== hostId) return;
      // Clear any running timers first
      clearBuzzerTimers();
      // Broadcast to all players to return to launcher
      io.emit('returned_to_menu', {});
    });

    // Intro phase handlers
    socket.on('host_start_with_intro', () => {
      if (socket.id !== hostId) return;
      io.emit('introPhase', {
        gameName: 'Jeopardy',
        slides: [
          { title: 'How to Play', content: 'Pick a selection of questions from different categories and point values. First player to tap the buzzer wins the right to answer.' },
          { title: 'Risk Factor', content: 'Answer questions correctly to earn points. Answer incorrectly and lose points. So buzz carefully!' },
          { title: 'Winner takes all', content: 'The player with the most points at the end wins! Players with tied points enter the bonus stage.' }
        ]
      });
    });

    socket.on('host_skip_intro', () => {
      if (socket.id !== hostId) return;
      io.emit('introEnded');
    });

    socket.on('buzz', (callback) => {
      const key = socketToKey.get(socket.id);
      const player = key ? playersByKey.get(key) : null;

      if (!player) {
        if (callback) callback({ ok: false, error: 'You are not registered.' });
        return;
      }

      if (!buzzerOpen) {
        if (callback) callback({ ok: false, error: 'Buzzers are closed.' });
        socket.emit('buzzRejected', { winner: buzzWinner || null });
        return;
      }

      if (!buzzWinner) {
        buzzerOpen = false;
        buzzWinner = player.name;
        console.log('Buzz winner:', player.name);

        socket.emit('buzzAccepted', { name: player.name });
        if (callback) callback({ ok: true, first: true, name: player.name });

        if (hostId) {
          io.to(hostId).emit('buzzWinner', { name: player.name, socketId: socket.id });
        }

        socket.broadcast.emit('buzzLocked', { winner: player.name });
      } else {
        if (callback) callback({ ok: false, first: false, name: buzzWinner });
        socket.emit('buzzRejected', { winner: buzzWinner });
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);

      // Mark player as disconnected but keep them for a while (reconnect-friendly)
      const key = socketToKey.get(socket.id);
      if (key) {
        socketToKey.delete(socket.id);
        const p = playersByKey.get(key);
        if (p) {
          p.connected = false;
          p.lastSeen = Date.now();
          p.socketId = null;
          playersByKey.set(key, p);

          // Don't free preset name on disconnect — player is still logically in session
          // Preset names are only freed when a player is kicked

          broadcastPlayers();
        }
      }

      const wasHost = (socket.id === hostId);
      if (wasHost) {
        console.log('Host disconnected.');
        hostId = null;
        buzzerOpen = false;
        buzzWinner = null;
        clearBuzzerTimers();
        io.emit('hostDisconnected');
      }
    });
  });

  // API endpoint to receive initial player list from launcher (including offline players)
  router.post('/api/init-players', (req, res) => {
    const { players, settings: initSettings } = req.body || {};
    if (!Array.isArray(players)) {
      return res.status(400).json({ error: 'Invalid players array' });
    }

    console.log('[INIT] Received', players.length, 'players from launcher');

    // Store preset settings if provided
    if (initSettings) {
      presetNamesEnabled = initSettings.usePresetNames || false;
      presetNames = Array.isArray(initSettings.presetNames)
        ? initSettings.presetNames.map(n => normalizeName(n)).filter(n => n)
        : [];
    }

    for (const p of players) {
      if (!p.key || !p.name) continue;
      if (playersByKey.has(p.key)) continue;

      playersByKey.set(p.key, {
        name: normalizeName(p.name),
        socketId: null,
        connected: false,
        joinedSession: false,  // Never connected this session
        lastSeen: Date.now(),
      });
    }

    broadcastPlayers();
    res.json({ ok: true, count: players.length });
  });

  router.post("/api/update-settings", (req, res) => {
    const { usePresetNames, presetNames: newPresetNames } = req.body || {};

    // Update the game's preset settings variables
    if (usePresetNames !== undefined) {
      presetNamesEnabled = usePresetNames;
    }
    if (newPresetNames !== undefined) {
      presetNames = Array.isArray(newPresetNames)
        ? newPresetNames.map(n => normalizeName(n)).filter(n => n)
        : [];
    }

    console.log("[API] Updated preset settings:", { usePresetNames, presetNames: presetNames?.length || 0 });
    res.status(200).json({ success: true });
  });

  // Cleanup function
  function cleanup() {
    console.log('[Jeopardy] Cleaning up...');
    clearBuzzerTimers();
    playersByKey.clear();
    socketToKey.clear();
    hostId = null;
    buzzerOpen = false;
    buzzWinner = null;
  }

  // Initialize with any players passed from launcher
  if (Array.isArray(initialPlayers)) {
    for (const p of initialPlayers) {
      if (!p.key || !p.name) continue;
      playersByKey.set(p.key, {
        name: normalizeName(p.name),
        socketId: null,
        connected: false,
        joinedSession: false,  // Never connected this session
        lastSeen: Date.now(),
      });
    }
  }

  console.log('[Jeopardy] Game initialized');

  return { router, cleanup };
};
