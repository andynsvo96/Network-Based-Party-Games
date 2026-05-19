// server.js - Spin the Wheel Game
// Exported as a module for the master game launcher

const express = require('express');
const path = require('path');
const fs = require('fs');

module.exports.init = function(config) {
  const { io, gamePath, players: initialPlayers, settings } = config;

  // --- Ensure presets directory and default preset exist ---
  const presetsDir = path.join(gamePath, 'presets');
  try {
    fs.mkdirSync(presetsDir, { recursive: true });
  } catch (e) {
    console.error('[Spin the Wheel] Failed to create presets directory:', e);
  }
  const defaultPresetPath = path.join(presetsDir, 'default.json');
  if (!fs.existsSync(defaultPresetPath)) {
    const defaultPreset = {
      title: "Default",
      words: [
        { text: "Jump", weight: 20 },
        { text: "Sing", weight: 20 },
        { text: "Dance", weight: 15 },
        { text: "Run", weight: 15 },
        { text: "Swim", weight: 10 },
        { text: "Fly", weight: 10 },
        { text: "Crawl", weight: 5 },
        { text: "Spin", weight: 5 }
      ],
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString()
    };
    try {
      fs.writeFileSync(defaultPresetPath, JSON.stringify(defaultPreset, null, 2));
      console.log('[Spin the Wheel] Created default preset');
    } catch (e) {
      console.error('[Spin the Wheel] Failed to create default preset:', e);
    }
  }

  // --- Router Setup ---
  const router = express.Router();

  router.use(express.static(gamePath));
  router.use(express.json());

  router.get('/favicon.ico', (req, res) => res.sendStatus(204));

  router.get('/', (req, res) => {
    res.sendFile(path.join(gamePath, 'index.html'));
  });

  router.get('/join', (req, res) => {
    res.sendFile(path.join(gamePath, 'player.html'));
  });

  router.get('/players', (req, res) => {
    res.sendFile(path.join(gamePath, 'player.html'));
  });

  // --- Constants ---
  const HOST_KEY = '__HOST__';
  const PHASES = {
    LOBBY: 'LOBBY',
    INTRO: 'INTRO',
    MAIN_GAME: 'MAIN_GAME',
    GAME_OVER: 'GAME_OVER'
  };

  // --- Game State ---
  let gameState = {
    phase: PHASES.LOBBY,
    currentPreset: null,         // { title, words: [{text, weight}] }
    availableWords: [],          // Current pool (eliminates if setting enabled)
    usedWords: new Set(),        // Track removed words
    lastSelectedWord: null,
    isSpinning: false,
    currentTurnKey: null,        // Whose turn to spin
    turnOrder: [],               // Array of player keys
    eligiblePlayers: new Set(),  // Players who were in game at start (includes offline)
    settings: {
      choiceElimination: true,   // Default ON
      controlMode: 'host',       // 'host' | 'host_and_players' | 'players'
      chooseNextSpinner: false   // When ON, spinner/host picks who goes next
    },
    awaitingNextSpinnerChoice: false,
    lastSpinnerKey: null
  };

  let players = new Map();       // key -> player object
  let socketIdToKey = new Map(); // socket.id -> key

  // Initialize players from launcher (includes offline players)
  if (initialPlayers && Array.isArray(initialPlayers)) {
    console.log('[Spin the Wheel] Initializing with', initialPlayers.length, 'players from launcher');
    for (const p of initialPlayers) {
      if (!p.key || !p.name) continue;
      players.set(p.key, {
        key: p.key,
        name: normalizeName(p.name),
        socketId: null,
        connected: false,
        isHost: false,
        lastSeen: Date.now()
      });
    }
  }

  // Last payloads for reconnection
  let lastGameOverPayload = null;

  // --- Utility Functions ---
  function normalizeName(name) {
    return String(name || '').toUpperCase().trim();
  }

  function getHost() {
    const h = players.get(HOST_KEY);
    return (h && h.isHost) ? h : null;
  }

  function getHostSocketId() {
    const h = getHost();
    return (h && h.connected && h.socketId) ? h.socketId : null;
  }

  function emitToHost(evt, payload) {
    const sid = getHostSocketId();
    if (sid) io.to(sid).emit(evt, payload);
  }

  function getNonHostPlayers() {
    return Array.from(players.values()).filter(p => p && !p.isHost);
  }

  function getConnectedNonHostPlayers() {
    return getNonHostPlayers().filter(p => p.connected);
  }

  function getPlayerListPayload() {
    return getNonHostPlayers()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => ({
        key: p.key,
        name: p.name,
        connected: !!p.connected
      }));
  }

  // --- Preset Management ---
  function listPresets(callback) {
    const presetsDir = path.join(gamePath, 'presets');
    fs.readdir(presetsDir, (err, files) => {
      if (err) {
        return callback(err, []);
      }
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      callback(null, jsonFiles);
    });
  }

  function loadPreset(filename, callback) {
    const presetPath = path.join(gamePath, 'presets', filename);
    fs.readFile(presetPath, 'utf8', (err, data) => {
      if (err) {
        return callback(err, null);
      }
      try {
        const preset = JSON.parse(data);
        const validation = validatePreset(preset);
        if (!validation.valid) {
          return callback(new Error(validation.error), null);
        }
        preset.filename = filename;
        callback(null, preset);
      } catch (e) {
        callback(e, null);
      }
    });
  }

  function validatePreset(preset) {
    if (!preset.title || preset.title.trim() === '') {
      return { valid: false, error: 'Preset title is required' };
    }

    if (!preset.words || preset.words.length === 0) {
      return { valid: false, error: 'Preset must have at least one word' };
    }

    const totalWeight = preset.words.reduce((sum, w) => sum + (w.weight || 0), 0);
    if (Math.abs(totalWeight - 100) > 0.01) {
      return { valid: false, error: `Weights must total 100% (currently ${totalWeight.toFixed(1)}%)` };
    }

    return { valid: true };
  }

  function savePreset(preset, callback) {
    const validation = validatePreset(preset);
    if (!validation.valid) {
      return callback(new Error(validation.error));
    }

    // Sanitize filename
    const filename = preset.title.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') + '.json';

    const presetPath = path.join(gamePath, 'presets', filename);

    preset.lastModified = new Date().toISOString();
    if (!preset.createdAt) {
      preset.createdAt = preset.lastModified;
    }

    fs.writeFile(presetPath, JSON.stringify(preset, null, 2), (err) => {
      if (err) return callback(err);
      callback(null, filename);
    });
  }

  function deletePreset(filename, callback) {
    // Don't allow deleting default.json
    if (filename === 'default.json') {
      return callback(new Error('Cannot delete default preset'));
    }

    const presetPath = path.join(gamePath, 'presets', filename);
    fs.unlink(presetPath, callback);
  }

  // --- Turn Management ---
  function initializeTurnOrder() {
    if (gameState.settings.controlMode === 'host') {
      gameState.turnOrder = [HOST_KEY];
      gameState.currentTurnKey = HOST_KEY;
    } else if (gameState.settings.controlMode === 'players') {
      gameState.turnOrder = getNonHostPlayers().map(p => p.key);
      if (gameState.settings.chooseNextSpinner && gameState.turnOrder.length > 0) {
        // Random first spinner when chooseNextSpinner is enabled in players-only mode
        const randomIndex = Math.floor(Math.random() * gameState.turnOrder.length);
        gameState.currentTurnKey = gameState.turnOrder[randomIndex];
      } else {
        gameState.currentTurnKey = gameState.turnOrder[0] || null;
      }
    } else { // 'host_and_players'
      gameState.turnOrder = [HOST_KEY, ...getNonHostPlayers().map(p => p.key)];
      gameState.currentTurnKey = HOST_KEY;
    }

    // Mark all players in turn order as "eligible" (treat offline players at game start as online)
    gameState.eligiblePlayers = new Set(gameState.turnOrder);
    gameState.awaitingNextSpinnerChoice = false;
    gameState.lastSpinnerKey = null;
  }

  function advanceTurn() {
    if (gameState.turnOrder.length === 0) return;

    const currentIndex = gameState.turnOrder.indexOf(gameState.currentTurnKey);
    const nextIndex = (currentIndex + 1) % gameState.turnOrder.length;
    gameState.currentTurnKey = gameState.turnOrder[nextIndex];

    const currentPlayer = players.get(gameState.currentTurnKey);
    const isConnected = currentPlayer?.connected || false;

    io.emit('turnChange', {
      currentTurnKey: gameState.currentTurnKey,
      playerName: currentPlayer?.name || 'Unknown',
      isConnected
    });

    // If player is offline, show waiting message but DON'T auto-skip
    if (!isConnected) {
      io.emit('waitingForPlayer', {
        playerKey: gameState.currentTurnKey,
        playerName: currentPlayer?.name
      });
    }
  }

  // --- Weighted Randomization ---
  function selectWeightedWord(words) {
    if (!words || words.length === 0) return null;

    // Filter out disabled words
    const activeWords = words.filter(w => !w.disabled);
    if (activeWords.length === 0) return null;

    // Build cumulative ranges
    let cumulative = 0;
    const ranges = activeWords.map(word => {
      const start = cumulative;
      cumulative += word.weight;
      return { word, start, end: cumulative };
    });

    // Random number in [0, totalWeight)
    const random = Math.random() * cumulative;

    // Find matching range
    for (const range of ranges) {
      if (random >= range.start && random < range.end) {
        return range.word;
      }
    }

    return activeWords[0]; // Fallback
  }

  function performSpin() {
    if (gameState.availableWords.length === 0) {
      return null;
    }

    const selectedWord = selectWeightedWord(gameState.availableWords);
    // Don't disable here - defer until after animation completes
    // to avoid race conditions with client-side rendering
    gameState.lastSelectedWord = selectedWord;
    return selectedWord;
  }

  // Called after animation completes to disable the selected word
  function finalizeSpinResult(selectedWord) {
    if (gameState.settings.choiceElimination) {
      const wordInList = gameState.availableWords.find(w => w.text === selectedWord.text);
      if (wordInList) wordInList.disabled = true;
      gameState.usedWords.add(selectedWord.text);

      // Check if all words are disabled
      const activeWords = gameState.availableWords.filter(w => !w.disabled);
      if (activeWords.length === 0) {
        gameState.phase = PHASES.GAME_OVER;
      }
    }
  }

  function resetWheel() {
    if (gameState.currentPreset) {
      gameState.availableWords = JSON.parse(JSON.stringify(gameState.currentPreset.words));
      gameState.usedWords.clear();
      gameState.phase = PHASES.MAIN_GAME;
      gameState.lastSelectedWord = null;
      gameState.isSpinning = false;
      gameState.awaitingNextSpinnerChoice = false;
      gameState.lastSpinnerKey = null;
    }
  }

  // --- Socket.IO Connection Handler ---
  io.on('connection', (socket) => {
    console.log(`[Spin the Wheel] New connection: ${socket.id}`);

    // Send current game state to newly connected socket
    socket.emit('gameState', {
      phase: gameState.phase,
      currentPreset: gameState.currentPreset,
      availableWords: gameState.availableWords,
      settings: gameState.settings,
      currentTurnKey: gameState.currentTurnKey,
      turnOrder: gameState.turnOrder
    });

    // --- Host Registration ---
    socket.on('registerHost', () => {
      console.log(`[Spin the Wheel] Host registering: ${socket.id}`);

      // Clean up old host mapping if exists
      const oldHost = getHost();
      if (oldHost && oldHost.socketId) {
        socketIdToKey.delete(oldHost.socketId);
      }

      // Set up host entry (reuse existing or create new)
      if (oldHost) {
        oldHost.socketId = socket.id;
        oldHost.connected = true;
        oldHost.lastSeen = Date.now();
      } else {
        players.set(HOST_KEY, {
          key: HOST_KEY,
          name: 'HOST',
          isHost: true,
          socketId: socket.id,
          connected: true,
          lastSeen: Date.now()
        });
      }
      socketIdToKey.set(socket.id, HOST_KEY);

      listPresets((err, presets) => {
        const presetList = presets || [];

        // Auto-load default preset if no preset is currently loaded
        if (!gameState.currentPreset && presetList.includes('default.json')) {
          loadPreset('default.json', (loadErr, preset) => {
            if (!loadErr && preset) {
              gameState.currentPreset = preset;
              gameState.availableWords = JSON.parse(JSON.stringify(preset.words));
            }
            socket.emit('hostSetupSuccess', {
              presets: presetList,
              settings: gameState.settings,
              currentPreset: gameState.currentPreset
            });
            setTimeout(() => {
              socket.emit('playerListUpdate', getPlayerListPayload());
            }, 100);
          });
        } else {
          socket.emit('hostSetupSuccess', {
            presets: presetList,
            settings: gameState.settings,
            currentPreset: gameState.currentPreset
          });
          setTimeout(() => {
            socket.emit('playerListUpdate', getPlayerListPayload());
          }, 100);
        }
      });
    });

    // --- Player Join ---
    socket.on('joinGame', ({ playerKey, name }) => {
      console.log(`[Spin the Wheel] Join attempt: ${name} (${playerKey})`);

      const normalizedName = normalizeName(name);

      // Check if rejoining existing player
      const existing = players.get(playerKey);
      if (existing && !existing.isHost) {
        existing.connected = true;
        existing.socketId = socket.id;
        existing.lastSeen = Date.now();
        socketIdToKey.set(socket.id, playerKey);

        socket.emit('joinSuccess', { name: existing.name, playerKey });
        io.emit('playerListUpdate', getPlayerListPayload());

        // Sync game state
        socket.emit('gameState', {
          phase: gameState.phase,
          currentPreset: gameState.currentPreset,
          availableWords: gameState.availableWords,
          settings: gameState.settings,
          currentTurnKey: gameState.currentTurnKey,
          turnOrder: gameState.turnOrder,
          lastSelectedWord: gameState.lastSelectedWord
        });

        // If it's their turn and game is active, notify them
        if (gameState.phase === PHASES.MAIN_GAME && gameState.currentTurnKey === playerKey) {
          socket.emit('yourTurn', { canSpin: true });
        }

        console.log(`[Spin the Wheel] Player rejoined: ${existing.name}`);
        return;
      }

      // Only allow new joins during LOBBY phase
      if (gameState.phase !== PHASES.LOBBY) {
        socket.emit('joinError', 'Game already started. Please wait for next game.');
        return;
      }

      // Validate name
      if (normalizedName.length === 0 || normalizedName.length > 15) {
        socket.emit('joinError', 'Invalid name. Must be 1-15 characters.');
        return;
      }

      // Check duplicate names
      const nameTaken = getNonHostPlayers().some(p => p.name === normalizedName && p.key !== playerKey);
      if (nameTaken) {
        socket.emit('joinError', 'Name already taken.');
        return;
      }

      // Create new player
      players.set(playerKey, {
        key: playerKey,
        name: normalizedName,
        socketId: socket.id,
        connected: true,
        isHost: false,
        lastSeen: Date.now()
      });
      socketIdToKey.set(socket.id, playerKey);

      socket.emit('joinSuccess', { name: normalizedName, playerKey });
      io.emit('playerListUpdate', getPlayerListPayload());

      console.log(`[Spin the Wheel] New player joined: ${normalizedName}`);
    });

    // --- Preset Operations ---
    socket.on('loadPreset', ({ filename }, callback) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) {
        if (callback) callback({ success: false, error: 'Not authorized' });
        return;
      }

      loadPreset(filename, (err, preset) => {
        if (err) {
          console.error('[Spin the Wheel] Load preset error:', err);
          if (callback) callback({ success: false, error: err.message });
          return;
        }

        gameState.currentPreset = preset;
        gameState.availableWords = JSON.parse(JSON.stringify(preset.words));
        gameState.usedWords.clear();

        io.emit('presetLoaded', { preset });
        if (callback) callback({ success: true, preset });

        console.log(`[Spin the Wheel] Preset loaded: ${preset.title}`);
      });
    });

    socket.on('savePreset', ({ preset }, callback) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) {
        if (callback) callback({ success: false, error: 'Not authorized' });
        return;
      }

      savePreset(preset, (err, filename) => {
        if (err) {
          console.error('[Spin the Wheel] Save preset error:', err);
          if (callback) callback({ success: false, error: err.message });
          return;
        }

        if (callback) callback({ success: true, filename });

        // Refresh preset list
        listPresets((err, presets) => {
          io.emit('presetsUpdated', { presets: presets || [] });
        });

        console.log(`[Spin the Wheel] Preset saved: ${filename}`);
      });
    });

    socket.on('deletePreset', ({ filename }, callback) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) {
        if (callback) callback({ success: false, error: 'Not authorized' });
        return;
      }

      deletePreset(filename, (err) => {
        if (err) {
          console.error('[Spin the Wheel] Delete preset error:', err);
          if (callback) callback({ success: false, error: err.message });
          return;
        }

        if (callback) callback({ success: true });

        // Refresh preset list
        listPresets((err, presets) => {
          io.emit('presetsUpdated', { presets: presets || [] });
        });

        console.log(`[Spin the Wheel] Preset deleted: ${filename}`);
      });
    });

    // --- Settings Update ---
    socket.on('updateSettings', (newSettings) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY || gameState.phase !== PHASES.LOBBY) return;

      if (newSettings.choiceElimination !== undefined) {
        gameState.settings.choiceElimination = !!newSettings.choiceElimination;
      }
      if (newSettings.controlMode !== undefined) {
        const validModes = ['host', 'host_and_players', 'players'];
        if (validModes.includes(newSettings.controlMode)) {
          gameState.settings.controlMode = newSettings.controlMode;
        }
      }
      if (newSettings.chooseNextSpinner !== undefined) {
        gameState.settings.chooseNextSpinner = !!newSettings.chooseNextSpinner;
      }

      io.emit('settingsUpdate', gameState.settings);
      console.log('[Spin the Wheel] Settings updated:', gameState.settings);
    });

    // --- Start Game ---
    socket.on('startGame', () => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) {
        socket.emit('gameError', 'Not authorized');
        return;
      }

      if (gameState.phase !== PHASES.LOBBY) {
        socket.emit('gameError', 'Cannot start from current state');
        return;
      }

      if (!gameState.currentPreset || gameState.availableWords.length === 0) {
        socket.emit('gameError', 'Please load a preset first');
        return;
      }

      // No minimum player requirement for this game!
      console.log('[Spin the Wheel] Starting game (no min players required)');

      gameState.phase = PHASES.INTRO;
      io.emit('introPhase');
    });

    // --- Skip Intro ---
    socket.on('skipIntro', () => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;

      if (gameState.phase === PHASES.INTRO) {
        gameState.phase = PHASES.MAIN_GAME;
        initializeTurnOrder();

        const firstPlayer = players.get(gameState.currentTurnKey);
        io.emit('mainGamePhase', {
          availableWords: gameState.availableWords,
          currentTurnKey: gameState.currentTurnKey,
          playerName: firstPlayer?.name || 'Host',
          turnOrder: gameState.turnOrder,
          settings: gameState.settings
        });

        // Notify current player it's their turn
        const currentPlayer = players.get(gameState.currentTurnKey);
        if (currentPlayer && currentPlayer.connected && currentPlayer.socketId) {
          io.to(currentPlayer.socketId).emit('yourTurn', { canSpin: true });
        } else if (currentPlayer && !currentPlayer.connected) {
          io.emit('waitingForPlayer', {
            playerKey: gameState.currentTurnKey,
            playerName: currentPlayer.name
          });
        }

        console.log('[Spin the Wheel] Main game started');
      }
    });

    // --- Request Spin ---
    socket.on('requestSpin', ({ playerKey }) => {
      console.log(`[Spin the Wheel] Spin request from ${playerKey}`);

      // Phase check
      if (gameState.phase !== PHASES.MAIN_GAME) {
        socket.emit('spinError', 'Game is not in progress');
        return;
      }

      // Spin in progress check
      if (gameState.isSpinning) {
        socket.emit('spinError', 'Spin already in progress');
        return;
      }

      // Awaiting next spinner selection check
      if (gameState.awaitingNextSpinnerChoice) {
        socket.emit('spinError', 'Waiting for next spinner selection');
        return;
      }

      // Words available check
      if (gameState.availableWords.length === 0) {
        socket.emit('spinError', 'No words remaining');
        return;
      }

      // Control mode check
      if (gameState.settings.controlMode === 'host' && playerKey !== HOST_KEY) {
        socket.emit('spinError', 'Only host can spin in this mode');
        return;
      }

      if (gameState.settings.controlMode === 'players' && playerKey === HOST_KEY) {
        socket.emit('spinError', 'Players-only mode');
        return;
      }

      // Turn check (but allow if player is eligible even if offline - they just reconnected)
      if (playerKey !== gameState.currentTurnKey) {
        socket.emit('spinError', 'Not your turn');
        return;
      }

      // Eligible check
      if (!gameState.eligiblePlayers.has(playerKey)) {
        socket.emit('spinError', 'Not eligible to spin');
        return;
      }

      // All checks passed, perform spin
      gameState.isSpinning = true;
      const selectedWord = performSpin();
      if (!selectedWord) {
        socket.emit('spinError', 'Failed to select word');
        return;
      }

      // Emit spin start to all clients
      io.emit('spinStart', {
        selectedWord,
        spinner: playerKey,
        spinnerName: players.get(playerKey)?.name || 'Unknown'
      });

      // After animation duration + buffer to account for network latency
      setTimeout(() => {
        gameState.isSpinning = false;

        // Disable the word AFTER animation completes (not before)
        finalizeSpinResult(selectedWord);

        io.emit('spinResult', {
          word: selectedWord,
          availableWords: gameState.availableWords,
          remainingWords: gameState.availableWords.length,
          usedWords: Array.from(gameState.usedWords)
        });

        // Check game over
        if (gameState.phase === PHASES.GAME_OVER) {
          lastGameOverPayload = {
            reason: 'no_words_left',
            lastWord: selectedWord,
            usedWords: Array.from(gameState.usedWords)
          };
          io.emit('gameOver', lastGameOverPayload);
        } else if (gameState.settings.chooseNextSpinner && gameState.settings.controlMode !== 'host') {
          // chooseNextSpinner mode: let the spinner (and host) pick next
          gameState.awaitingNextSpinnerChoice = true;
          gameState.lastSpinnerKey = playerKey;

          const eligibleList = gameState.turnOrder
            .filter(k => gameState.eligiblePlayers.has(k))
            .map(k => {
              const p = players.get(k);
              return { key: k, name: p?.name || 'Unknown', connected: !!p?.connected };
            });

          io.emit('chooseNextSpinner', {
            chooserKey: playerKey,
            eligiblePlayers: eligibleList
          });
        } else {
          // Normal sequential turn advancement
          if (gameState.settings.controlMode !== 'host') {
            advanceTurn();
          }

          // Notify next player it's their turn
          const nextPlayer = players.get(gameState.currentTurnKey);
          if (nextPlayer && nextPlayer.connected && nextPlayer.socketId) {
            io.to(nextPlayer.socketId).emit('yourTurn', { canSpin: true });
          } else if (nextPlayer && !nextPlayer.connected) {
            io.emit('waitingForPlayer', {
              playerKey: gameState.currentTurnKey,
              playerName: nextPlayer.name
            });
          }
        }
      }, 3000);

      console.log(`[Spin the Wheel] Spun: ${selectedWord.text}`);
    });

    // --- Select Next Spinner (chooseNextSpinner mode) ---
    socket.on('selectNextSpinner', ({ selectedPlayerKey }) => {
      const key = socketIdToKey.get(socket.id);
      if (!key) return;

      if (!gameState.awaitingNextSpinnerChoice) {
        socket.emit('spinError', 'Not currently choosing next spinner');
        return;
      }

      // Only the last spinner or the host can choose
      if (key !== gameState.lastSpinnerKey && key !== HOST_KEY) {
        socket.emit('spinError', 'Not authorized to choose next spinner');
        return;
      }

      // Validate the selected player is eligible
      if (!gameState.eligiblePlayers.has(selectedPlayerKey)) {
        socket.emit('spinError', 'Selected player is not eligible');
        return;
      }

      gameState.awaitingNextSpinnerChoice = false;
      gameState.lastSpinnerKey = null;
      gameState.currentTurnKey = selectedPlayerKey;

      const selectedPlayer = players.get(selectedPlayerKey);
      const isConnected = selectedPlayer?.connected || false;

      io.emit('turnChange', {
        currentTurnKey: selectedPlayerKey,
        playerName: selectedPlayer?.name || 'Unknown',
        isConnected
      });

      if (isConnected && selectedPlayer.socketId) {
        io.to(selectedPlayer.socketId).emit('yourTurn', { canSpin: true });
      } else if (!isConnected) {
        io.emit('waitingForPlayer', {
          playerKey: selectedPlayerKey,
          playerName: selectedPlayer?.name
        });
      }

      console.log(`[Spin the Wheel] Next spinner selected: ${selectedPlayer?.name || selectedPlayerKey}`);
    });

    // --- Force Skip Turn ---
    socket.on('forceSkipTurn', () => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;

      if (gameState.phase === PHASES.MAIN_GAME) {
        // Also clear chooseNextSpinner state if active
        gameState.awaitingNextSpinnerChoice = false;
        gameState.lastSpinnerKey = null;
        advanceTurn();
        console.log('[Spin the Wheel] Turn force skipped by host');
      }
    });

    // --- Kick Player ---
    socket.on('kickPlayer', ({ playerKey }) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;

      // Only allow kick during LOBBY phase
      if (gameState.phase !== PHASES.LOBBY) {
        socket.emit('gameError', 'You can only kick players during the lobby phase.');
        return;
      }

      if (!playerKey || !players.has(playerKey)) return;
      if (playerKey === HOST_KEY) return; // Can't kick the host

      const player = players.get(playerKey);
      const sockId = player.socketId;

      // Emit kicked event to player
      if (sockId) {
        io.to(sockId).emit('kicked', { message: 'You have been removed from the game by the host.' });
        const targetSocket = io.sockets?.get(sockId);
        if (targetSocket) targetSocket.disconnect(true);
        socketIdToKey.delete(sockId);
      }

      // Remove player from list
      players.delete(playerKey);

      // Broadcast updated player list
      io.emit('playerListUpdate', getPlayerListPayload());

      console.log(`[Spin the Wheel] Player kicked: ${player.name}`);
    });

    // --- Reset Wheel ---
    socket.on('resetWheel', () => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;

      resetWheel();
      io.emit('wheelReset', {
        availableWords: gameState.availableWords,
        phase: gameState.phase
      });

      console.log('[Spin the Wheel] Wheel reset');
    });

    // --- Return to Lobby ---
    socket.on('returnToLobby', () => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;

      gameState.phase = PHASES.LOBBY;
      gameState.isSpinning = false;
      gameState.availableWords = gameState.currentPreset ?
        JSON.parse(JSON.stringify(gameState.currentPreset.words)) : [];
      gameState.usedWords.clear();
      gameState.lastSelectedWord = null;
      gameState.currentTurnKey = null;
      gameState.turnOrder = [];
      gameState.eligiblePlayers.clear();
      gameState.awaitingNextSpinnerChoice = false;
      gameState.lastSpinnerKey = null;

      io.emit('lobbyPhase', {
        players: getPlayerListPayload(),
        currentPreset: gameState.currentPreset,
        settings: gameState.settings
      });

      console.log('[Spin the Wheel] Returned to lobby');
    });

    // --- Handle Graceful Shutdown (returned to menu from master server) ---
    socket.on('returned_to_menu', (data) => {
      const key = socketIdToKey.get(socket.id);
      if (!key) return;

      const p = players.get(key);
      if (!p) return;

      // Mark player as offline but keep in game state for reconnection
      p.connected = false;
      p.socketId = null;
      p.lastSeen = Date.now();

      socketIdToKey.delete(socket.id);

      io.emit('playerListUpdate', getPlayerListPayload());

      console.log(`[Spin the Wheel] Player returned to menu: ${p.name}`);
    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
      const key = socketIdToKey.get(socket.id);
      if (!key) return;

      socketIdToKey.delete(socket.id);
      const p = players.get(key);
      if (!p) return;

      p.connected = false;
      p.socketId = null;
      p.lastSeen = Date.now();

      if (key === HOST_KEY) {
        io.emit('hostDisconnected');
      }

      io.emit('playerListUpdate', getPlayerListPayload());

      // If it was their turn, emit waiting message
      if (!p.isHost && gameState.phase === PHASES.MAIN_GAME && gameState.currentTurnKey === key) {
        io.emit('waitingForPlayer', {
          playerKey: key,
          playerName: p.name
        });
      }

      console.log(`[Spin the Wheel] ${p.isHost ? 'Host' : 'Player'} disconnected: ${p.name}`);
    });
  });

  // --- Cleanup Function ---
  function cleanup() {
    console.log('[Spin the Wheel] Cleaning up game instance');
    players.clear();
    socketIdToKey.clear();
  }

  return { router, cleanup };
};
