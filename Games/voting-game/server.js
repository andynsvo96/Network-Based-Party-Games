// server.js - The Voting Game (reconnect-friendly)
// Exported as a module for the master game launcher

const express = require('express');
const path = require('path');
const fs = require('fs');

module.exports.init = function(config) {
  const { io, gamePath, players: initialPlayers, settings } = config;

  // --- Router Setup ---
  const router = express.Router();

  router.use(express.static(gamePath));
  router.use(express.json());

  // Optional: silence favicon console noise
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

  // --- Reconnect retention ---
  const HOST_KEY = '__HOST__';

  // Game State
  let gameState = 'SETUP_HOST';
  let players = new Map();        // key -> { key, name, votes, isHost, socketId, connected, lastSeen }
  let socketIdToKey = new Map();  // socket.id -> key

  let currentQuestion = null;
  let questions = [];
  let usedQuestions = new Set();
  let maxVotesToWin = 5;
  let votesCastThisRound = {};    // key -> votedName (playerKey)
  let isAnonymous = true;

  // Advance settings
  let autoAdvance = true;
  let advanceDelay = 5; // seconds
  let advanceTimer = null;

  // Preset names settings
  let usePresetNames = settings?.usePresetNames || false;
  let presetNames = Array.isArray(settings?.presetNames)
    ? settings.presetNames.map(n => normalizeName(n)).filter(n => n)
    : [];

  // Persist last game over payload so reconnecting players can be synced
  let lastGameOverPayload = null;

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

  function getPlayerNames(nonHostOnly = false) {
    return Array.from(players.values())
      .filter(p => nonHostOnly ? !p.isHost : true)
      .map(p => p.name);
  }

  function getPlayerListPayload() {
    return getNonHostPlayers()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => ({ key: p.key, name: p.name, connected: !!p.connected }));
  }

  function getConnectedNonHostCount() {
    return getNonHostPlayers().filter(p => p.connected).length;
  }

  function getAllNonHostCount() {
    return getNonHostPlayers().length;
  }

  function getEligibleVoterKeys() {
    // Eligible if currently connected OR already voted this round (so their vote still counts)
    const votedKeys = new Set(Object.keys(votesCastThisRound || {}));
    return getNonHostPlayers()
      .filter(p => p.connected || votedKeys.has(p.key))
      .map(p => p.key);
  }

  function getCurrentLeaderboard() {
    return getNonHostPlayers()
      .sort((a, b) => b.votes - a.votes)
      .map(p => ({ name: p.name, votes: p.votes }));
  }

  function loadQuestions(callback) {
    try {
      const data = fs.readFileSync(path.join(gamePath, 'questions.txt'), 'utf8');
      questions = data.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      callback(null, questions.length);
    } catch (e) {
      console.error('Failed to load questions.txt:', e.message);
      callback(e, 0);
    }
  }

  function startAdvanceTimer() {
    clearInterval(advanceTimer);
    let timeLeft = advanceDelay;

    io.emit('timerUpdate', timeLeft);

    advanceTimer = setInterval(() => {
      timeLeft--;
      io.emit('timerUpdate', timeLeft);

      if (timeLeft <= 0) {
        clearInterval(advanceTimer);
        advanceTimer = null;
        startGameRound();
      }
    }, 1000);
  }

  function clearAdvanceTimer() {
    clearInterval(advanceTimer);
    advanceTimer = null;
  }

  function syncPlayerState(socket, playerKey) {
    // Called after join/rejoin so the player lands back on the right screen
    if (gameState === 'GAME_ROUND' && currentQuestion) {
      socket.emit('newRoundPlayer', {
        question: currentQuestion,
        playersToVote: getPlayerNames(true),
        isAnonymous
      });

      if (votesCastThisRound[playerKey]) {
        socket.emit('voteCastSuccess', votesCastThisRound[playerKey]);
      }
    } else if (gameState === 'GAME_OVER' && lastGameOverPayload) {
      socket.emit('gameOver', lastGameOverPayload);
    }
  }

  // --- Game Logic ---
  function startGame() {
    gameState = 'GAME_ROUND';
    lastGameOverPayload = null;
    for (const p of players.values()) {
      if (p && !p.isHost) p.votes = 0;
    }
    usedQuestions.clear();
    startGameRound();
  }

  function startGameRound() {
    clearAdvanceTimer();

    const available = questions.filter(q => !usedQuestions.has(q));
    if (available.length === 0) {
      endGame('No questions left.');
      return;
    }

    currentQuestion = available[Math.floor(Math.random() * available.length)];
    usedQuestions.add(currentQuestion);
    votesCastThisRound = {};

    const nonHostNames = getPlayerNames(true);
    const leaderboard = getCurrentLeaderboard();
    const eligibleCount = getEligibleVoterKeys().length;

    io.emit('newRoundHost', {
      question: currentQuestion,
      players: nonHostNames,
      leaderboard,
      totalEligible: eligibleCount,
      total: nonHostNames.length
    });

    io.emit('newRoundPlayer', {
      question: currentQuestion,
      playersToVote: nonHostNames,
      isAnonymous
    });
  }

  function endRound() {
    clearAdvanceTimer();

    const voteCounts = {};
    const nonHostPlayers = getPlayerNames(true);
    nonHostPlayers.forEach(name => (voteCounts[name] = 0));

    Object.values(votesCastThisRound).forEach(votedName => {
      voteCounts[votedName] = (voteCounts[votedName] || 0) + 1;
    });

    let roundWinner = null;
    let maxVotes = 0;
    let winners = [];

    Object.entries(voteCounts).forEach(([name, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        roundWinner = name;
        winners = [name];
      } else if (count === maxVotes && count > 0) {
        winners.push(name);
        roundWinner = null;
      }
    });

    if (roundWinner && winners.length === 1) {
      // Find player by name
      for (const p of players.values()) {
        if (p && !p.isHost && p.name === roundWinner) {
          p.votes++;
          break;
        }
      }
    } else {
      roundWinner = null;
    }

    const leaderboard = getCurrentLeaderboard();
    const gameWinner = leaderboard.find(p => p.votes >= maxVotesToWin);

    io.emit('roundResults', {
      roundWinner,
      leaderboard,
      allVotes: votesCastThisRound,
      gameWinner: gameWinner ? gameWinner.name : null,
      isAnonymous,
      autoAdvanceSetting: autoAdvance
    });

    if (gameWinner) {
      setTimeout(() => endGame(gameWinner.name), 4000);
    } else if (autoAdvance) {
      startAdvanceTimer();
    }
  }

  function endGame(winnerName = null) {
    clearAdvanceTimer();
    gameState = 'GAME_OVER';

    const finalLeaderboard = getCurrentLeaderboard();
    if (!winnerName && finalLeaderboard.length) winnerName = finalLeaderboard[0].name;

    lastGameOverPayload = { winner: winnerName, leaderboard: finalLeaderboard };
    io.emit('gameOver', lastGameOverPayload);
  }

  function resetGameKeepPlayers() {
    clearAdvanceTimer();
    gameState = 'SETUP_PLAYERS';
    currentQuestion = null;
    usedQuestions.clear();
    votesCastThisRound = {};
    lastGameOverPayload = null;

    for (const p of players.values()) {
      if (p && !p.isHost) p.votes = 0;
    }

    io.emit('gameResetKeepPlayer');
  }

  function resetGame() {
    clearAdvanceTimer();
    gameState = 'SETUP_HOST';
    players = new Map();
    socketIdToKey = new Map();
    currentQuestion = null;
    usedQuestions.clear();
    votesCastThisRound = {};
    lastGameOverPayload = null;

    io.emit('gameReset');
  }

  // --- Socket.IO Communication ---
  io.on('connection', (socket) => {
    // Host assignment: first active connection becomes host
    const host = getHost();
    const hostConnected = !!(host && host.connected);

    // FIX: Also verify host's socket is actually still alive in the namespace
    // This handles the race condition where a new connection arrives before
    // the old socket's disconnect event is processed
    let hostSocketAlive = false;
    if (hostConnected && host.socketId) {
      hostSocketAlive = io.sockets.has(host.socketId);
    }

    if (!hostConnected || !hostSocketAlive) {
      // Clean up stale host socket mapping if it exists
      if (host && host.socketId) {
        socketIdToKey.delete(host.socketId);
      }
      const now = Date.now();
      players.set(HOST_KEY, {
        key: HOST_KEY,
        name: 'HOST',
        votes: 0,
        isHost: true,
        socketId: socket.id,
        connected: true,
        lastSeen: now,
      });
      socketIdToKey.set(socket.id, HOST_KEY);

      loadQuestions((err, count) => {
        if (err) {
          socket.emit('hostSetupError', 'Could not load questions. Check questions.txt');
        } else {
          socket.emit('hostSetupSuccess', {
            questionCount: count,
            maxVotes: maxVotesToWin,
            isAnonymous,
            autoAdvance,
            advanceDelay
          });
          // Send list shortly after to populate UI
          setTimeout(() => socket.emit('playerListUpdate', getPlayerListPayload()), 100);
        }
      });

      if (gameState === 'SETUP_HOST') gameState = 'SETUP_PLAYERS';
    }

    // Non-host connection: push current status
    socket.emit('gameStatus', { state: gameState });
    socket.emit('leaderboardUpdate', getCurrentLeaderboard());
    if (gameState === 'SETUP_PLAYERS') {
      socket.emit('playerListUpdate', getPlayerListPayload());
    }

    // --- Host Re-registration (handles reconnection race condition) ---
    socket.on('registerHost', () => {
      // Already registered as host on this socket
      if (socketIdToKey.get(socket.id) === HOST_KEY) return;

      // Clean up old host socket mapping
      const oldHost = getHost();
      if (oldHost && oldHost.socketId) {
        socketIdToKey.delete(oldHost.socketId);
      }

      players.set(HOST_KEY, {
        key: HOST_KEY,
        name: 'HOST',
        votes: 0,
        isHost: true,
        socketId: socket.id,
        connected: true,
        lastSeen: Date.now(),
      });
      socketIdToKey.set(socket.id, HOST_KEY);

      loadQuestions((err, count) => {
        if (err) {
          socket.emit('hostSetupError', 'Could not load questions. Check questions.txt');
        } else {
          socket.emit('hostSetupSuccess', {
            questionCount: count,
            maxVotes: maxVotesToWin,
            isAnonymous,
            autoAdvance,
            advanceDelay
          });
          setTimeout(() => socket.emit('playerListUpdate', getPlayerListPayload()), 100);
        }
      });

      if (gameState === 'SETUP_HOST') gameState = 'SETUP_PLAYERS';
    });

    // --- Host Events ---
    socket.on('playAgain', () => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY) {
        resetGameKeepPlayers();

        socket.emit('hostSetupSuccess', {
          questionCount: questions.length,
          maxVotes: maxVotesToWin,
          isAnonymous,
          autoAdvance,
          advanceDelay
        });

        io.emit('playerListUpdate', getPlayerListPayload());
      }
    });

    socket.on('setAdvanceMode', ({ auto, delay }) => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY && gameState === 'SETUP_PLAYERS') {
        autoAdvance = !!auto;
        advanceDelay = Math.max(2, parseInt(delay, 10) || 5);
      }
    });

    socket.on('setMaxVotes', (val) => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY && gameState === 'SETUP_PLAYERS') {
        maxVotesToWin = Math.max(1, parseInt(val, 10) || 1);
      }
    });

    socket.on('setAnonymous', (val) => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY && gameState === 'SETUP_PLAYERS') {
        isAnonymous = !!val;
      }
    });

    socket.on('togglePresetNames', () => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY && gameState === 'SETUP_PLAYERS') {
        const wasPreset = usePresetNames;
        usePresetNames = !usePresetNames;
        io.emit('presetNamesUpdate', { usePresetNames, presetNames });

        // If switching from custom to preset mode, force players with invalid names to reselect
        if (!wasPreset && usePresetNames && presetNames.length > 0) {
          const presetNamesUpper = new Set(presetNames.map(n => normalizeName(n)));

          for (const p of players.values()) {
            if (p.isHost || !p.connected || !p.socketId) continue;

            if (!presetNamesUpper.has(normalizeName(p.name))) {
              // Player has a custom name not in preset list - force reselect
              io.to(p.socketId).emit('forceReselect', {
                reason: 'Host enabled preset names. Please select a name from the list.'
              });
              // Remove player so they can rejoin with a valid name
              socketIdToKey.delete(p.socketId);
              players.delete(p.key);
            }
          }
          io.emit('playerListUpdate', getPlayerListPayload());
        }
      }
    });

    socket.on('addPresetName', (data) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY || gameState !== 'SETUP_PLAYERS') return;

      const name = normalizeName(data?.name);
      if (!name) return;

      // Check for duplicates (case-insensitive)
      const isDuplicate = presetNames.some(n => normalizeName(n) === name);
      if (isDuplicate) {
        socket.emit('hostError', 'That name is already in the preset list.');
        return;
      }

      presetNames.push(name);
      io.emit('presetNamesUpdate', { usePresetNames, presetNames });
    });

    socket.on('removePresetName', (data) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY || gameState !== 'SETUP_PLAYERS') return;

      const name = normalizeName(data?.name);
      if (!name) return;

      presetNames = presetNames.filter(n => normalizeName(n) !== name);
      io.emit('presetNamesUpdate', { usePresetNames, presetNames });
    });

    socket.on('kickPlayer', ({ playerKey }) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;

      // Only allow kick during setup phase (not during active game)
      if (gameState !== 'SETUP_PLAYERS') {
        socket.emit('hostError', 'You can only kick players during the setup phase, not during an active game.');
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
      emitToHost('playerListUpdate', getPlayerListPayload());
      io.emit('playerListUpdate', getPlayerListPayload());
    });

    socket.on('endGameManual', () => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY && gameState !== 'SETUP_HOST') {
        endGame();
      }
    });

    socket.on('host_return_to_menu', () => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY) {
        // Clear any running timers first
        clearAdvanceTimer();
        // Broadcast to all players FIRST so they redirect before server is killed
        io.emit('returned_to_menu', {});
        // Let main server handle cleanup via cleanup() function
      }
    });

    socket.on('startGame', (data) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) {
        socket.emit('hostError', 'Session error: not recognized as host. Please refresh the page.');
        return;
      }

      if (gameState !== 'SETUP_PLAYERS') {
        socket.emit('hostError', 'Cannot start game from current state.');
        return;
      }

      // Min-player check uses ALL registered non-host players (including offline)
      if (getAllNonHostCount() < 2) {
        socket.emit('hostError', 'Need at least 2 players registered to start (Host does not vote).');
        return;
      }

      // But need at least 1 connected to actually play
      if (getConnectedNonHostCount() < 1) {
        socket.emit('hostError', 'Need at least 1 connected player to start.');
        return;
      }

      maxVotesToWin = Math.max(1, parseInt(data?.maxVotes, 10) || 1);
      isAnonymous = !!data?.isAnonymous;
      autoAdvance = !!data?.autoAdvance;
      advanceDelay = Math.max(2, parseInt(data?.advanceDelay, 10) || 5);

      // Go to intro phase first
      gameState = 'INTRO';
      io.emit('introPhase', {
        gameName: 'The Voting Game',
        slides: [
          {
            title: 'How to Play',
            content: 'Answer questions about who in the group is "Most Likely To..." by voting for a player. The player with the most votes gets a point!'
          },
          {
            title: 'Voting',
            content: 'When a question appears, vote for the player you think best fits the description. All players vote at the same time. Votes can be anonymous or revealed!'
          },
          {
            title: 'Winning',
            content: 'The first player to reach the target score wins the game! Have fun learning what your friends really think about each other!'
          }
        ]
      });
    });

    socket.on('host_skip_intro', () => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) {
        socket.emit('hostError', 'Session error: not recognized as host. Please refresh the page.');
        return;
      }
      if (gameState === 'INTRO') {
        startGame();
      }
    });

    socket.on('nextQuestion', () => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY && gameState === 'GAME_ROUND' && !autoAdvance) {
        const eligible = getEligibleVoterKeys();
        const votedEligibleCount = eligible.filter(k => votesCastThisRound[k]).length;

        if (eligible.length > 0 && votedEligibleCount === eligible.length) startGameRound();
        else socket.emit('hostError', 'Cannot advance: Waiting for all votes from connected players.');
      }
    });

    // --- Player Events ---
    socket.on('joinGame', (payload) => {
      // supports old string payload for backwards compatibility
      const nameRaw = (typeof payload === 'string') ? payload : payload?.name;
      let playerKey = (typeof payload === 'object' && payload?.playerKey) ? String(payload.playerKey) : null;

      const normalizedName = normalizeName(nameRaw);
      if (!playerKey) playerKey = `k_${socket.id}`; // fallback

      // Don't allow joining before host is ready
      if (gameState === 'SETUP_HOST') {
        socket.emit('joinError', 'Host is not ready yet.');
        return;
      }

      // Rejoin path (allowed during game)
      const existing = players.get(playerKey);
      if (existing && !existing.isHost) {
        existing.connected = true;
        existing.socketId = socket.id;
        existing.lastSeen = Date.now();
        socketIdToKey.set(socket.id, playerKey);

        socket.emit('joinSuccess', { name: existing.name, playerKey });
        emitToHost('playerListUpdate', getPlayerListPayload());
        syncPlayerState(socket, playerKey);
        return;
      }

      // New join only during setup
      if (gameState !== 'SETUP_PLAYERS') {
        socket.emit('joinError', 'Game already started. Please wait for the next game.');
        return;
      }

      if (!normalizedName || normalizedName.length === 0) {
        socket.emit('joinError', 'Name cannot be empty.');
        return;
      }
      if (normalizedName.length > 15) {
        socket.emit('joinError', 'Name is too long (max 15 chars).');
        return;
      }

      // If preset names mode is enabled, validate that the name is from the preset list
      if (usePresetNames && presetNames.length > 0) {
        const isValidPreset = presetNames.some(preset => normalizeName(preset) === normalizedName);

        if (!isValidPreset) {
          socket.emit('joinError', 'Please select a name from the preset list.');
          return;
        }
      }

      // Duplicate name check (case-insensitive, includes offline players, allow reconnection)
      const nameTaken = getNonHostPlayers().some(p =>
        p.name === normalizedName && p.key !== playerKey
      );
      if (nameTaken) {
        socket.emit('joinError', 'That name is already taken. Please choose another one.');
        socket.emit('player_error', 'That name is already taken. Please choose another one.');
        socket.emit('join_rejected', { reason: 'That name is already taken. Please choose another one.' });
        return;
      }

      const now = Date.now();
      players.set(playerKey, {
        key: playerKey,
        name: normalizedName,
        votes: 0,
        isHost: false,
        socketId: socket.id,
        connected: true,
        lastSeen: now,
      });
      socketIdToKey.set(socket.id, playerKey);

      socket.emit('joinSuccess', { name: normalizedName, playerKey });
      io.emit('playerListUpdate', getPlayerListPayload());
    });

    socket.on('castVote', (votedPlayerName) => {
      const voterKey = socketIdToKey.get(socket.id);
      const voter = voterKey ? players.get(voterKey) : null;

      if (gameState !== 'GAME_ROUND' || !voter || voter.isHost) {
        socket.emit('voteCastError', 'Not in a voting round.');
        return;
      }
      if (votesCastThisRound[voterKey]) {
        socket.emit('voteCastError', 'You already voted.');
        return;
      }

      const playerNames = getPlayerNames(true);
      if (!playerNames.includes(votedPlayerName)) {
        socket.emit('voteCastError', 'Invalid vote.');
        return;
      }

      votesCastThisRound[voterKey] = votedPlayerName;
      socket.emit('voteCastSuccess', votedPlayerName);

      const eligible = getEligibleVoterKeys();
      const votedEligibleCount = eligible.filter(k => votesCastThisRound[k]).length;

      emitToHost('updateHostVotes', {
        voterName: voter.name,
        votedName: isAnonymous ? 'ANONYMOUS' : votedPlayerName,
        count: votedEligibleCount,
        total: eligible.length,
      });

      if (eligible.length > 0 && votedEligibleCount === eligible.length) {
        endRound();
      }
    });

    // --- Disconnect handling ---
    socket.on('disconnect', () => {
      const key = socketIdToKey.get(socket.id);
      if (!key) return;

      socketIdToKey.delete(socket.id);
      const p = players.get(key);
      if (!p) return;

      if (p.isHost) {
        // Only mark host as disconnected if this is still the current host socket.
        // If a newer socket has already taken over (reconnection race), skip clearing.
        if (p.socketId === socket.id || p.socketId === null) {
          p.connected = false;
          p.socketId = null;
          p.lastSeen = Date.now();
        }

        // Broadcast player list update to show host disconnected
        io.emit('playerListUpdate', getPlayerListPayload());
        return;
      }

      // Keep player record so they can rejoin
      p.connected = false;
      p.socketId = null;
      p.lastSeen = Date.now();

      io.emit('playerListUpdate', getPlayerListPayload());

      // If round is waiting, dropping an offline voter may allow round to complete
      if (gameState === 'GAME_ROUND') {
        const eligible = getEligibleVoterKeys();
        const votedEligibleCount = eligible.filter(k => votesCastThisRound[k]).length;
        if (eligible.length > 0 && votedEligibleCount === eligible.length) endRound();
      }
    });
  });

  // API endpoint to receive initial player list from launcher (including offline players)
  router.post('/api/init-players', (req, res) => {
    const { players: playersArray, settings: initSettings } = req.body || {};
    if (!Array.isArray(playersArray)) {
      return res.status(400).json({ error: 'Invalid players array' });
    }

    console.log('[INIT] Received', playersArray.length, 'players from launcher');

    // Store preset settings if provided
    if (initSettings) {
      usePresetNames = initSettings.usePresetNames || false;
      presetNames = Array.isArray(initSettings.presetNames)
        ? initSettings.presetNames.map(n => normalizeName(n)).filter(n => n)
        : [];
    }

    for (const p of playersArray) {
      if (!p.key || !p.name) continue;
      if (p.key === HOST_KEY) continue;  // Don't add host as player
      if (players.has(p.key)) continue;

      players.set(p.key, {
        key: p.key,
        name: normalizeName(p.name),
        votes: 0,
        isHost: false,
        socketId: null,
        connected: false,
        lastSeen: Date.now(),
      });
    }

    io.emit('playerListUpdate', getPlayerListPayload());
    res.json({ ok: true, count: playersArray.length });
  });

  router.post("/api/update-settings", (req, res) => {
    const { usePresetNames: newUsePresetNames, presetNames: newPresetNames } = req.body || {};

    // Update the game's preset settings variables
    if (newUsePresetNames !== undefined) {
      usePresetNames = newUsePresetNames;
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
    console.log('[Voting Game] Cleaning up...');
    clearAdvanceTimer();
    players.clear();
    socketIdToKey.clear();
    gameState = 'SETUP_HOST';
    currentQuestion = null;
    usedQuestions.clear();
    votesCastThisRound = {};
    lastGameOverPayload = null;
  }

  // Initialize with any players passed from launcher
  if (Array.isArray(initialPlayers)) {
    for (const p of initialPlayers) {
      if (!p.key || !p.name) continue;
      if (p.key === HOST_KEY) continue;
      players.set(p.key, {
        key: p.key,
        name: normalizeName(p.name),
        votes: 0,
        isHost: false,
        socketId: null,
        connected: false,
        lastSeen: Date.now(),
      });
    }
  }

  console.log('[Voting Game] Game initialized');

  return { router, cleanup };
};
