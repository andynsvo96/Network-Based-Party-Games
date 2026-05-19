const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");

// ---- Modular Export ----

module.exports.init = function(config) {
  const { io, gamePath, players: initialPlayers, settings: initialSettings } = config;
  const router = express.Router();

  // ---- Static + routes ----

  router.use(express.static(gamePath));
  router.use(express.json());

  router.get("/", (req, res) => {
    res.sendFile(path.join(gamePath, "index.html"));
  });

  router.get("/player", (req, res) => {
    res.sendFile(path.join(gamePath, "player.html"));
  });

  router.get("/players", (req, res) => {
    res.sendFile(path.join(gamePath, "player.html"));
  });

  router.get("/hostinfo", (req, res) => {
    const lanIp = getLocalIPv4();
    const joinBase = lanIp ? `http://${lanIp}:${req.get("host").split(':')[1] || 80}` : `${req.protocol}://${req.get("host")}`;
    res.json({ joinBase });
  });

  router.get('/favicon.ico', (req, res) => res.status(204).end());

  // ---- Load Pre-made Content from XML ----

  const contentFile = path.join(gamePath, "truthdare.xml");
  const premadeContent = loadPremadeContent(contentFile);

  function loadPremadeContent(filePath) {
    const result = { truths: [], dares: [] };
    try {
      const xml = fs.readFileSync(filePath, "utf8");

      // Parse truths
      const truthRegex = /<truth\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/truth>/g;
      let match;
      while ((match = truthRegex.exec(xml)) !== null) {
        result.truths.push({
          id: match[1],
          text: match[2].trim(),
          claimedBy: null,
          used: false
        });
      }

      // Parse dares
      const dareRegex = /<dare\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/dare>/g;
      while ((match = dareRegex.exec(xml)) !== null) {
        result.dares.push({
          id: match[1],
          text: match[2].trim(),
          claimedBy: null,
          used: false
        });
      }

      console.log(`[TruthOrDare] Loaded ${result.truths.length} truths and ${result.dares.length} dares`);
    } catch (err) {
      console.error("[TruthOrDare] Failed to load truthdare.xml:", err.message);
    }
    return result;
  }

  // ---- State ----

  const players = new Map(); // id -> {id, name, score, connected, socketId}
  let hostSocket = null;

  // Initialize players from launcher (includes offline players)
  if (initialPlayers && Array.isArray(initialPlayers)) {
    console.log('[TruthOrDare] Initializing with', initialPlayers.length, 'players from launcher');
    for (const p of initialPlayers) {
      if (!p.key || !p.name) continue;
      players.set(p.key, {
        id: p.key,
        name: p.name.toUpperCase(),
        score: 0,
        connected: p.connected || false,
        socketId: null
      });
    }
  }

  const gameState = {
    phase: "lobby", // lobby | intro | submission | playing | results
    settings: {
      targetScore: 20,
      anonymousMode: false,
      submissionTimeSeconds: 60,
      preparationTimeSeconds: 90,
      dealersChoiceChance: 5,
      showPremadeInGame: true,
      usePresetNames: false,
      presetNames: [],
    },
    turnQueue: [],
    turnIndex: 0,
    turnHistory: [],
    submissionDeadline: null,
    preparationDeadline: null,
  };

  // Content pools
  const contentPools = {
    playerTruths: [],  // { id, text, authorId, authorName, targetId, targetName, used: false, submittedAt }
    playerDares: [],
    premadeTruths: [], // Reset from premadeContent on each game
    premadeDares: [],
  };

  // Current turn state
  let currentTurn = null;

  // Per-player randomization for pre-made content
  const playerPremadeOrder = new Map();
  // playerId -> { truthIndices: [array], dareIndices: [array] }

  // Statistics
  const stats = {
    truthsCompleted: {},
    daresCompleted: {},
    refusals: {},
    contentSubmitted: {},
    contentUsed: {},
    timesTargeted: {},
  };

  // Timers for cleanup
  const activeTimers = [];

  // ---- Helper functions ----

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function getLocalIPv4() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }
    return null;
  }

  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  function generatePlayerPremadeOrder(playerId) {
    const truthIndices = [...Array(contentPools.premadeTruths.length).keys()];
    const dareIndices = [...Array(contentPools.premadeDares.length).keys()];

    shuffle(truthIndices);
    shuffle(dareIndices);

    playerPremadeOrder.set(playerId, { truthIndices, dareIndices });
  }

  function getPlayersArray(connectedOnly = false) {
    let arr = Array.from(players.values());
    if (connectedOnly) {
      arr = arr.filter(p => p.connected);
    }
    arr.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      const sa = a.score || 0;
      const sb = b.score || 0;
      if (sb !== sa) return sb - sa;
      return (a.name || "").localeCompare(b.name || "");
    });
    return arr.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      connected: p.connected,
    }));
  }

  function getConnectedPlayerCount() {
    return Array.from(players.values()).filter(p => p.connected).length;
  }

  function getTotalPlayerCount() {
    return players.size;
  }

  function getPlayerName(playerId) {
    const player = players.get(playerId);
    return player ? player.name : "Unknown";
  }

  function resetContentPools() {
    contentPools.playerTruths = [];
    contentPools.playerDares = [];
    contentPools.premadeTruths = premadeContent.truths.map(t => ({ ...t, claimedBy: null, used: false }));
    contentPools.premadeDares = premadeContent.dares.map(d => ({ ...d, claimedBy: null, used: false }));
  }

  function resetStats() {
    stats.truthsCompleted = {};
    stats.daresCompleted = {};
    stats.refusals = {};
    stats.contentSubmitted = {};
    stats.contentUsed = {};
    stats.timesTargeted = {};
  }

  function resetToLobby() {
    gameState.phase = "lobby";
    gameState.turnQueue = [];
    gameState.turnIndex = 0;
    gameState.turnHistory = [];
    gameState.submissionDeadline = null;
    gameState.preparationDeadline = null;
    currentTurn = null;
    playerPremadeOrder.clear();

    // Reset scores
    for (const player of players.values()) {
      player.score = 0;
    }

    resetContentPools();
    resetStats();
    broadcastGameState();
  }

  // ---- Broadcasting ----

  function broadcastGameState() {
    const state = {
      phase: gameState.phase,
      settings: gameState.settings,
      players: getPlayersArray(),
      currentTurn: currentTurn ? {
        playerId: currentTurn.playerId,
        playerName: getPlayerName(currentTurn.playerId),
        status: currentTurn.status,
        spin1Result: currentTurn.spin1Result,
        spin2Result: currentTurn.spin2Result,
        isDealersChoice: currentTurn.isDealersChoice,
        challenge: currentTurn.challenge ? {
          type: currentTurn.challenge.type,
          text: currentTurn.challenge.text,
          authorName: gameState.settings.anonymousMode ? null : currentTurn.challenge.authorName,
          isTargeted: currentTurn.challenge.isTargeted,
        } : null,
      } : null,
      submissionDeadline: gameState.submissionDeadline,
      preparationDeadline: gameState.preparationDeadline,
      turnHistory: gameState.turnHistory.slice(-10).reverse(),
    };
    io.emit("gameState", state);
  }

  function broadcastContentCounts() {
    const counts = {};
    for (const player of players.values()) {
      const truths = contentPools.playerTruths.filter(c => c.authorId === player.id).length;
      const dares = contentPools.playerDares.filter(c => c.authorId === player.id).length;
      const claimed = contentPools.premadeTruths.filter(c => c.claimedBy === player.id).length +
                      contentPools.premadeDares.filter(c => c.claimedBy === player.id).length;
      counts[player.id] = { submitted: truths + dares, claimed };
    }
    io.emit("contentCounts", counts);
  }

  function sendHostState() {
    if (!hostSocket) return;
    hostSocket.emit("hostState", {
      phase: gameState.phase,
      settings: gameState.settings,
      players: getPlayersArray(),
      premadeTruthsRemaining: contentPools.premadeTruths.filter(c => !c.used && !c.claimedBy).length,
      premadeDaresRemaining: contentPools.premadeDares.filter(c => !c.used && !c.claimedBy).length,
    });
  }

  // ---- Phase Management ----

  function transitionToPhase(newPhase) {
    gameState.phase = newPhase;

    switch (newPhase) {
      case "intro":
        startPreparationPhase();
        break;

      case "submission":
        startSubmissionPhase();
        break;

      case "playing":
        startPlayingPhase();
        break;

      case "results":
        showGameResults();
        break;

      case "lobby":
        resetToLobby();
        break;
    }

    broadcastGameState();
  }

  function startPreparationPhase() {
    resetContentPools();
    resetStats();

    const duration = gameState.settings.preparationTimeSeconds * 1000;
    gameState.preparationDeadline = Date.now() + duration;

    // Define slides once to use for both host and players
    const slides = [
      { title: "Spin the Bottle", content: "Take turns spinning the bottle! The first spin determines whose content you might get, the second reveals Truth or Dare!" },
      { title: "Create Content", content: "Before the game starts, you can submit your own Truths and Dares - target specific players or make them for anyone!" },
      { title: "Score Points", content: "Complete a Dare for +2 points, a Truth for +1 point. Refuse and lose 1 point (minimum 0). First to the target score wins!" }
    ];

    // Emit to host with intro slides + timer
    io.emit("preparationPhase", {
      slides,
      deadline: gameState.preparationDeadline,
      duration: gameState.settings.preparationTimeSeconds
    });

    // Send personalized randomized pre-made lists to each player (same as submission phase)
    for (const player of players.values()) {
      if (!player.connected) continue;

      // Generate randomization if not exists
      if (!playerPremadeOrder.has(player.id)) {
        generatePlayerPremadeOrder(player.id);
      }

      const order = playerPremadeOrder.get(player.id);

      // Map indices to actual content in random order, filter unclaimed
      const randomizedTruths = order.truthIndices
        .map(idx => contentPools.premadeTruths[idx])
        .filter(c => !c.claimedBy)
        .map(c => ({ id: c.id, text: c.text }));

      const randomizedDares = order.dareIndices
        .map(idx => contentPools.premadeDares[idx])
        .filter(c => !c.claimedBy)
        .map(c => ({ id: c.id, text: c.text }));

      // Send to specific player socket with slides included
      const playerSocket = io.sockets ? io.sockets.get(player.socketId) : null;
      if (playerSocket) {
        playerSocket.emit('preparationPhasePlayer', {
          slides,
          deadline: gameState.preparationDeadline,
          duration: gameState.settings.preparationTimeSeconds,
          players: getPlayersArray(),
          premadeTruths: randomizedTruths,
          premadeDares: randomizedDares,
        });
      }
    }

    // Auto-transition to playing phase after timer
    const timer = setTimeout(() => {
      if (gameState.phase === "intro") {
        transitionToPhase("playing");
      }
    }, duration + 500);
    activeTimers.push(timer);
  }

  function startSubmissionPhase() {
    resetContentPools();
    resetStats();

    const duration = gameState.settings.submissionTimeSeconds * 1000;
    gameState.submissionDeadline = Date.now() + duration;

    // Send personalized randomized pre-made lists to each player
    for (const player of players.values()) {
      if (!player.connected) continue;

      // Generate randomization if not exists
      if (!playerPremadeOrder.has(player.id)) {
        generatePlayerPremadeOrder(player.id);
      }

      const order = playerPremadeOrder.get(player.id);

      // Map indices to actual content in random order, filter unclaimed
      const randomizedTruths = order.truthIndices
        .map(idx => contentPools.premadeTruths[idx])
        .filter(c => !c.claimedBy)
        .map(c => ({ id: c.id, text: c.text }));

      const randomizedDares = order.dareIndices
        .map(idx => contentPools.premadeDares[idx])
        .filter(c => !c.claimedBy)
        .map(c => ({ id: c.id, text: c.text }));

      // Send to specific player socket
      const playerSocket = io.sockets ? io.sockets.get(player.socketId) : null;
      if (playerSocket) {
        playerSocket.emit('submissionPhase', {
          deadline: gameState.submissionDeadline,
          duration: gameState.settings.submissionTimeSeconds,
          players: getPlayersArray(),
          premadeTruths: randomizedTruths,
          premadeDares: randomizedDares,
        });
      }
    }

    // Auto-transition after timer
    const timer = setTimeout(() => {
      if (gameState.phase === "submission") {
        transitionToPhase("playing");
      }
    }, duration + 500);
    activeTimers.push(timer);
  }

  function startPlayingPhase() {
    // Initialize turn order — include all players (including offline)
    const allPlayers = Array.from(players.values());
    shuffle(allPlayers);
    gameState.turnQueue = allPlayers.map(p => p.id);
    gameState.turnIndex = 0;

    startNextTurn();
  }

  function startNextTurn() {
    // Check win conditions
    const winner = checkWinCondition();
    if (winner) {
      transitionToPhase("results");
      return;
    }

    if (!hasContentRemaining()) {
      transitionToPhase("results");
      return;
    }

    // Get next player
    if (gameState.turnQueue.length === 0) {
      transitionToPhase("results");
      return;
    }

    const playerId = gameState.turnQueue[gameState.turnIndex];

    // If player no longer exists (kicked), advance index and try next
    const player = players.get(playerId);
    if (!player) {
      gameState.turnIndex = (gameState.turnIndex + 1) % gameState.turnQueue.length;
      startNextTurn();
      return;
    }

    // If player is offline, notify host and wait — do NOT advance index
    if (!player.connected) {
      if (getConnectedPlayerCount() === 0) {
        return;
      }
      gameState.waitingForOfflinePlayer = playerId;
      if (hostSocket) {
        hostSocket.emit("waiting_for_offline_player", {
          playerKey: playerId,
          playerName: player.name,
          message: `${player.name} is offline. Waiting for reconnection...`
        });
      }
      broadcastGameState();
      return;
    }

    // Player is online — advance index past them
    gameState.waitingForOfflinePlayer = null;
    gameState.turnIndex = (gameState.turnIndex + 1) % gameState.turnQueue.length;

    // Reshuffle after full cycle
    if (gameState.turnIndex === 0) {
      shuffle(gameState.turnQueue);
    }

    // Initialize turn
    const isDealersChoice = Math.random() * 100 < gameState.settings.dealersChoiceChance;

    currentTurn = {
      playerId,
      spin1Result: null,
      spin2Result: null,
      isDealersChoice,
      challenge: null,
      status: "spinning1",
      spinOptions: buildSpinOptions(playerId),
    };

    io.emit("turnStarted", {
      playerId,
      playerName: player.name,
      spinOptions: currentTurn.spinOptions,
      anonymousMode: gameState.settings.anonymousMode,
      showPremadeInGame: gameState.settings.showPremadeInGame,
    });

    // Send personalized pre-made lists to waiting players
    if (gameState.settings.showPremadeInGame) {
      for (const p of players.values()) {
        if (!p.connected || p.id === playerId) continue;

        const order = playerPremadeOrder.get(p.id);
        if (!order) continue;

        // Send only UNCLAIMED items in random order
        const randomizedTruths = order.truthIndices
          .map(idx => contentPools.premadeTruths[idx])
          .filter(c => !c.claimedBy)
          .map(c => ({ id: c.id, text: c.text }));

        const randomizedDares = order.dareIndices
          .map(idx => contentPools.premadeDares[idx])
          .filter(c => !c.claimedBy)
          .map(c => ({ id: c.id, text: c.text }));

        const playerSocket = io.sockets ? io.sockets.get(p.socketId) : null;
        if (playerSocket) {
          playerSocket.emit('waitingPremadeLists', {
            premadeTruths: randomizedTruths,
            premadeDares: randomizedDares,
          });
        }
      }
    }

    broadcastGameState();
  }

  function buildSpinOptions(currentPlayerId) {
    const options = [];
    const eligible = Array.from(players.values()).filter(p => p.id !== currentPlayerId);

    if (gameState.settings.anonymousMode) {
      // In anonymous mode, options are just TRUTH and DARE
      return [
        { type: "type", id: "truth", name: "TRUTH" },
        { type: "type", id: "dare", name: "DARE" },
      ];
    }

    // Build weighted options - players with more content appear more often
    eligible.forEach(p => {
      let weight = 1;
      const unusedTruths = contentPools.playerTruths.filter(c => c.authorId === p.id && !c.used).length;
      const unusedDares = contentPools.playerDares.filter(c => c.authorId === p.id && !c.used).length;
      weight += unusedTruths + unusedDares;

      for (let i = 0; i < weight; i++) {
        options.push({ type: "player", id: p.id, name: p.name });
      }
    });

    // Add "Random" option
    options.push({ type: "random", id: "random", name: "RANDOM" });

    return options;
  }

  function executeSpin1(result) {
    if (!currentTurn || currentTurn.status !== "spinning1") return;

    currentTurn.spin1Result = result;

    if (gameState.settings.anonymousMode) {
      // In anonymous mode, spin1 result IS the truth/dare type
      currentTurn.spin2Result = result.id === "truth" ? "truth" : "dare";
      currentTurn.status = "selecting";
      selectChallenge();
    } else {
      currentTurn.status = "spinning2";
    }

    io.emit("spin1Complete", {
      result,
      isDealersChoice: currentTurn.isDealersChoice,
      anonymousMode: gameState.settings.anonymousMode,
    });

    broadcastGameState();
  }

  function executeSpin2(truthOrDare) {
    if (!currentTurn || currentTurn.status !== "spinning2") return;

    currentTurn.spin2Result = truthOrDare;
    currentTurn.status = "selecting";

    io.emit("spin2Complete", { result: truthOrDare });

    selectChallenge();
  }

  function selectChallenge() {
    if (!currentTurn) return;

    const type = currentTurn.spin2Result;
    const source = currentTurn.spin1Result;
    const targetPlayerId = currentTurn.playerId;

    let challenge = null;

    if (gameState.settings.anonymousMode) {
      // Anonymous mode: prioritize targeted content, then any content
      challenge = selectChallengeAnonymous(type, targetPlayerId);
    } else if (source.type === "player") {
      // Normal mode: select from specific player's content
      challenge = selectChallengeFromPlayer(source.id, type, targetPlayerId);
    } else {
      // Random: select from pre-made
      challenge = selectFromPremade(type);
    }

    if (!challenge) {
      // Fallback
      challenge = {
        id: "fallback",
        text: type === "truth"
          ? "Tell us your most embarrassing moment"
          : "Do your best dance move for 30 seconds",
        type,
        authorId: null,
        authorName: null,
        isTargeted: false,
        isPremade: true,
      };
    }

    currentTurn.challenge = challenge;
    currentTurn.status = "challenge";

    // Track times targeted
    if (challenge.isTargeted) {
      stats.timesTargeted[targetPlayerId] = (stats.timesTargeted[targetPlayerId] || 0) + 1;
    }

    io.emit("challengeRevealed", {
      playerId: currentTurn.playerId,
      playerName: getPlayerName(currentTurn.playerId),
      challenge: {
        type: challenge.type,
        text: challenge.text,
        authorName: gameState.settings.anonymousMode ? null : challenge.authorName,
        isTargeted: challenge.isTargeted,
      },
    });

    broadcastGameState();
  }

  function selectChallengeAnonymous(type, targetPlayerId) {
    const pool = type === "truth" ? contentPools.playerTruths : contentPools.playerDares;

    // Priority 1: Any targeted content for this player
    const targeted = pool.filter(c => c.targetId === targetPlayerId && !c.used);
    if (targeted.length > 0) {
      targeted.sort((a, b) => a.submittedAt - b.submittedAt);
      const selected = targeted[0];
      selected.used = true;
      if (selected.authorId) {
        stats.contentUsed[selected.authorId] = (stats.contentUsed[selected.authorId] || 0) + 1;
      }
      return {
        id: selected.id,
        text: selected.text,
        type,
        authorId: null,
        authorName: null,
        isTargeted: true,
        isPremade: false,
      };
    }

    // Priority 2: Any non-targeted player content
    const nonTargeted = pool.filter(c => !c.targetId && !c.used);
    if (nonTargeted.length > 0) {
      const selected = nonTargeted[Math.floor(Math.random() * nonTargeted.length)];
      selected.used = true;
      if (selected.authorId) {
        stats.contentUsed[selected.authorId] = (stats.contentUsed[selected.authorId] || 0) + 1;
      }
      return {
        id: selected.id,
        text: selected.text,
        type,
        authorId: null,
        authorName: null,
        isTargeted: false,
        isPremade: false,
      };
    }

    // Priority 3: Pre-made
    return selectFromPremade(type);
  }

  function selectChallengeFromPlayer(authorId, type, targetPlayerId) {
    const pool = type === "truth" ? contentPools.playerTruths : contentPools.playerDares;

    // Priority 1: Targeted content for this player from this author
    const targeted = pool.filter(c => c.authorId === authorId && c.targetId === targetPlayerId && !c.used);
    if (targeted.length > 0) {
      const selected = targeted[0];
      selected.used = true;
      stats.contentUsed[authorId] = (stats.contentUsed[authorId] || 0) + 1;
      return {
        id: selected.id,
        text: selected.text,
        type,
        authorId: selected.authorId,
        authorName: selected.authorName,
        isTargeted: true,
        isPremade: false,
      };
    }

    // Priority 2: Non-targeted content from this author
    const nonTargeted = pool.filter(c => c.authorId === authorId && !c.targetId && !c.used);
    if (nonTargeted.length > 0) {
      const selected = nonTargeted[Math.floor(Math.random() * nonTargeted.length)];
      selected.used = true;
      stats.contentUsed[authorId] = (stats.contentUsed[authorId] || 0) + 1;
      return {
        id: selected.id,
        text: selected.text,
        type,
        authorId: selected.authorId,
        authorName: selected.authorName,
        isTargeted: false,
        isPremade: false,
      };
    }

    // Priority 3: Any non-targeted player content
    const anyNonTargeted = pool.filter(c => !c.targetId && !c.used);
    if (anyNonTargeted.length > 0) {
      const selected = anyNonTargeted[Math.floor(Math.random() * anyNonTargeted.length)];
      selected.used = true;
      if (selected.authorId) {
        stats.contentUsed[selected.authorId] = (stats.contentUsed[selected.authorId] || 0) + 1;
      }
      return {
        id: selected.id,
        text: selected.text,
        type,
        authorId: selected.authorId,
        authorName: selected.authorName,
        isTargeted: false,
        isPremade: false,
      };
    }

    // Priority 4: Pre-made
    return selectFromPremade(type);
  }

  function selectFromPremade(type) {
    const pool = type === "truth" ? contentPools.premadeTruths : contentPools.premadeDares;
    const available = pool.filter(c => !c.used);

    if (available.length === 0) {
      return null;
    }

    const selected = available[Math.floor(Math.random() * available.length)];
    selected.used = true;

    return {
      id: selected.id,
      text: selected.text,
      type,
      authorId: null,
      authorName: null,
      isTargeted: false,
      isPremade: true,
    };
  }

  function handleTurnCompletion(completed) {
    if (!currentTurn || currentTurn.status !== "challenge") return;

    const player = players.get(currentTurn.playerId);
    if (!player) return;

    const challenge = currentTurn.challenge;
    const type = currentTurn.spin2Result;
    let pointChange = 0;

    if (completed) {
      pointChange = type === "dare" ? 2 : 1;
      player.score = (player.score || 0) + pointChange;

      if (type === "truth") {
        stats.truthsCompleted[player.id] = (stats.truthsCompleted[player.id] || 0) + 1;
      } else {
        stats.daresCompleted[player.id] = (stats.daresCompleted[player.id] || 0) + 1;
      }
    } else {
      // Different penalties: truth = -1, dare = -2
      pointChange = type === "dare" ? -2 : -1;
      const penalty = Math.abs(pointChange);
      player.score = Math.max(0, (player.score || 0) - penalty);
      stats.refusals[player.id] = (stats.refusals[player.id] || 0) + 1;
    }

    // Add to history
    gameState.turnHistory.push({
      playerId: player.id,
      playerName: player.name,
      type,
      challengeText: challenge.text,
      authorName: gameState.settings.anonymousMode ? null : challenge.authorName,
      isTargeted: challenge.isTargeted,
      targetPlayerId: challenge.targetId || null,
      completed,
      pointChange,
      newScore: player.score,
      timestamp: Date.now(),
    });

    io.emit("turnComplete", {
      playerId: player.id,
      playerName: player.name,
      completed,
      type,
      pointChange,
      newScore: player.score,
      challengeText: challenge.text,
      isTargeted: challenge.isTargeted,
      targetPlayerId: challenge.targetId || null,
    });

    currentTurn = null;
    broadcastGameState();

    // Start next turn after delay
    const timer = setTimeout(() => startNextTurn(), 2000);
    activeTimers.push(timer);
  }

  function checkWinCondition() {
    const targetScore = gameState.settings.targetScore;
    for (const player of players.values()) {
      if ((player.score || 0) >= targetScore) {
        return player;
      }
    }
    return null;
  }

  function hasContentRemaining() {
    const unusedPlayerTruths = contentPools.playerTruths.filter(c => !c.used).length;
    const unusedPlayerDares = contentPools.playerDares.filter(c => !c.used).length;
    const unusedPremadeTruths = contentPools.premadeTruths.filter(c => !c.used).length;
    const unusedPremadeDares = contentPools.premadeDares.filter(c => !c.used).length;

    const totalTruths = unusedPlayerTruths + unusedPremadeTruths;
    const totalDares = unusedPlayerDares + unusedPremadeDares;

    return totalTruths > 0 && totalDares > 0;
  }

  function showGameResults() {
    const playersArr = getPlayersArray();
    const sorted = [...playersArr].sort((a, b) => b.score - a.score);
    const winner = sorted[0];

    // Calculate superlatives
    const superlatives = [];

    const mostDaring = findMaxStat(stats.daresCompleted);
    if (mostDaring) {
      superlatives.push({
        title: "Most Daring",
        emoji: "🔥",
        playerId: mostDaring.id,
        playerName: mostDaring.name,
        value: stats.daresCompleted[mostDaring.id],
      });
    }

    const truthSeeker = findMaxStat(stats.truthsCompleted);
    if (truthSeeker) {
      superlatives.push({
        title: "Truth Seeker",
        emoji: "🔍",
        playerId: truthSeeker.id,
        playerName: truthSeeker.name,
        value: stats.truthsCompleted[truthSeeker.id],
      });
    }

    const partyPooper = findMaxStat(stats.refusals);
    if (partyPooper && stats.refusals[partyPooper.id] > 0) {
      superlatives.push({
        title: "Party Pooper",
        emoji: "🐔",
        playerId: partyPooper.id,
        playerName: partyPooper.name,
        value: stats.refusals[partyPooper.id],
      });
    }

    const contentCreator = findMaxStat(stats.contentSubmitted);
    if (contentCreator) {
      superlatives.push({
        title: "Content Creator",
        emoji: "✍️",
        playerId: contentCreator.id,
        playerName: contentCreator.name,
        value: stats.contentSubmitted[contentCreator.id],
      });
    }

    const popularAuthor = findMaxStat(stats.contentUsed);
    if (popularAuthor) {
      superlatives.push({
        title: "Popular Author",
        emoji: "⭐",
        playerId: popularAuthor.id,
        playerName: popularAuthor.name,
        value: stats.contentUsed[popularAuthor.id],
      });
    }

    const mostTargeted = findMaxStat(stats.timesTargeted);
    if (mostTargeted && stats.timesTargeted[mostTargeted.id] > 0) {
      superlatives.push({
        title: "Hot Seat",
        emoji: "🎯",
        playerId: mostTargeted.id,
        playerName: mostTargeted.name,
        value: stats.timesTargeted[mostTargeted.id],
      });
    }

    io.emit("gameResults", {
      winner: winner ? { id: winner.id, name: winner.name, score: winner.score } : null,
      leaderboard: sorted,
      superlatives,
      totalRounds: gameState.turnHistory.length,
      stats: {
        totalTruths: Object.values(stats.truthsCompleted).reduce((a, b) => a + b, 0),
        totalDares: Object.values(stats.daresCompleted).reduce((a, b) => a + b, 0),
        totalRefusals: Object.values(stats.refusals).reduce((a, b) => a + b, 0),
      },
    });
  }

  function findMaxStat(statObj) {
    let maxId = null;
    let maxVal = 0;
    for (const [id, val] of Object.entries(statObj)) {
      if (val > maxVal) {
        maxVal = val;
        maxId = id;
      }
    }
    if (!maxId) return null;
    const player = players.get(maxId);
    return player ? { id: maxId, name: player.name } : null;
  }

  // ---- Socket handling ----

  io.on("connection", (socket) => {
    let isHost = false;
    let socketPlayerId = null;

    // Send current state
    socket.emit("gameState", {
      phase: gameState.phase,
      settings: gameState.settings,
      players: getPlayersArray(),
    });

    // ---- Host Events ----

    socket.on("hostJoin", () => {
      isHost = true;
      hostSocket = socket;
      sendHostState();
      broadcastGameState();
    });

    socket.on("host_return_to_menu", () => {
      if (socket !== hostSocket) return;
      resetToLobby();
      io.emit("returned_to_menu", {});
    });

    socket.on("updateSettings", (changes) => {
      if (!isHost) return;

      // Prevent settings changes during active game
      if (gameState.phase !== 'lobby') {
        socket.emit('errorMessage', {
          message: 'Cannot change settings while game is in progress'
        });
        return;
      }

      Object.assign(gameState.settings, changes);
      broadcastGameState();
      sendHostState();
    });

    socket.on("startGame", () => {
      if (!isHost) return;

      // Min-player check uses ALL registered players (including offline)
      if (getTotalPlayerCount() < 2) {
        socket.emit("errorMessage", { message: "Need at least 2 players registered to start" });
        return;
      }

      // But need at least 1 connected to actually play
      if (getConnectedPlayerCount() < 1) {
        socket.emit("errorMessage", { message: "Need at least 1 connected player to start" });
        return;
      }

      transitionToPhase("intro");
    });

    socket.on("host_start_from_preparation", () => {
      if (!isHost) return;
      if (gameState.phase === "intro") {
        transitionToPhase("playing");
      }
    });

    socket.on("host_end_preparation", () => {
      if (!isHost) return;
      if (gameState.phase === "intro") {
        // Return to main menu
        resetToLobby();
        io.emit("returned_to_menu", {});
      }
    });

    socket.on("skipSubmission", () => {
      if (!isHost) return;
      if (gameState.phase === "submission") {
        transitionToPhase("playing");
      }
    });

    socket.on("triggerSpin1", (result) => {
      if (!isHost) return;
      executeSpin1(result);
    });

    socket.on("triggerSpin2", (result) => {
      if (!isHost) return;
      executeSpin2(result);
    });

    socket.on("completeTurn", ({ completed }) => {
      if (!isHost) return;
      handleTurnCompletion(completed);
    });

    socket.on("skipPlayer", () => {
      if (!isHost) return;
      if (currentTurn) {
        currentTurn = null;
        broadcastGameState();
        startNextTurn();
      }
    });

    // Host skips an offline player's turn
    socket.on("host_skip_turn", () => {
      if (!isHost) return;
      if (gameState.waitingForOfflinePlayer) {
        gameState.waitingForOfflinePlayer = null;
        // Advance past the skipped player
        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.turnQueue.length;
        startNextTurn();
      }
    });

    socket.on("endGame", () => {
      if (!isHost) return;
      transitionToPhase("results");
    });

    socket.on("playAgain", () => {
      if (!isHost) return;
      resetToLobby();
    });

    socket.on("kickPlayer", (targetId) => {
      if (!isHost) return;
      const player = players.get(targetId);
      if (player) {
        players.delete(targetId);
        io.emit("playerKicked", { playerId: targetId, playerName: player.name });
        broadcastGameState();
      }
    });

    // ---- Player Events ----

    socket.on("registerPlayer", ({ playerId: incomingId, name }) => {
      const cleanName = (name || "").trim().toUpperCase().slice(0, 12);
      if (!cleanName) {
        socket.emit("registrationError", { message: "Name is required" });
        return;
      }

      // Check preset names if enabled
      if (gameState.settings.usePresetNames && gameState.settings.presetNames.length > 0) {
        if (!gameState.settings.presetNames.includes(cleanName)) {
          socket.emit("registrationError", { message: "Please select a name from the list" });
          return;
        }
      }

      // Check for duplicate names
      for (const [id, p] of players) {
        if (p.name === cleanName && id !== incomingId) {
          socket.emit("registrationError", { message: "Name already taken" });
          return;
        }
      }

      let player;
      if (incomingId && players.has(incomingId)) {
        // Reconnecting player
        player = players.get(incomingId);
        player.name = cleanName;
        player.connected = true;
        player.socketId = socket.id;
        socketPlayerId = incomingId;
      } else {
        // New player
        socketPlayerId = makeId();
        player = {
          id: socketPlayerId,
          name: cleanName,
          score: 0,
          connected: true,
          socketId: socket.id,
        };
        players.set(socketPlayerId, player);
      }

      socket.emit("playerRegistered", { playerId: socketPlayerId, name: cleanName });

      // If this player was being waited on (offline turn), resume their turn
      // Index hasn't moved past them, so startNextTurn will pick them up
      if (gameState.waitingForOfflinePlayer === socketPlayerId) {
        gameState.waitingForOfflinePlayer = null;
        startNextTurn();
      }

      broadcastGameState();
      sendHostState();

      // If reconnecting during preparation phase, send prep state
      if (gameState.phase === "intro" && gameState.preparationDeadline) {
        // Generate randomization if not exists
        if (!playerPremadeOrder.has(socketPlayerId)) {
          generatePlayerPremadeOrder(socketPlayerId);
        }

        const order = playerPremadeOrder.get(socketPlayerId);

        // Map indices to actual content in random order, filter unclaimed
        const randomizedTruths = order.truthIndices
          .map(idx => contentPools.premadeTruths[idx])
          .filter(c => !c.claimedBy)
          .map(c => ({ id: c.id, text: c.text }));

        const randomizedDares = order.dareIndices
          .map(idx => contentPools.premadeDares[idx])
          .filter(c => !c.claimedBy)
          .map(c => ({ id: c.id, text: c.text }));

        socket.emit('preparationPhasePlayer', {
          deadline: gameState.preparationDeadline,
          duration: gameState.settings.preparationTimeSeconds,
          players: getPlayersArray(),
          premadeTruths: randomizedTruths,
          premadeDares: randomizedDares,
        });
      }
    });

    socket.on("submitContent", ({ type, text, targetId }) => {
      if (!socketPlayerId) return;

      // Can't submit during your own turn
      if (currentTurn && currentTurn.playerId === socketPlayerId && gameState.phase === "playing") {
        socket.emit("submissionError", { message: "Cannot submit during your own turn" });
        return;
      }

      // Allow during intro (preparation), submission, or playing phases
      if (gameState.phase !== "intro" && gameState.phase !== "submission" && gameState.phase !== "playing") {
        return;
      }

      const cleanText = (text || "").trim().slice(0, 200);
      if (!cleanText) return;

      const player = players.get(socketPlayerId);
      const targetPlayer = targetId ? players.get(targetId) : null;

      const content = {
        id: makeId(),
        text: cleanText,
        authorId: socketPlayerId,
        authorName: player ? player.name : "Unknown",
        targetId: targetId || null,
        targetName: targetPlayer ? targetPlayer.name : null,
        used: false,
        submittedAt: Date.now(),
      };

      if (type === "truth") {
        contentPools.playerTruths.push(content);
      } else if (type === "dare") {
        contentPools.playerDares.push(content);
      }

      stats.contentSubmitted[socketPlayerId] = (stats.contentSubmitted[socketPlayerId] || 0) + 1;

      socket.emit("contentSubmitted", {
        id: content.id,
        type,
        text: content.text,
        targetName: content.targetName
      });
      broadcastContentCounts();
    });

    socket.on("claimPremade", ({ type, contentId, targetId }) => {
      if (!socketPlayerId) return;

      // Allow claiming during intro (preparation), submission, AND playing phases
      if (gameState.phase !== "intro" && gameState.phase !== "submission" && gameState.phase !== "playing") {
        return;
      }

      // Prevent claiming during own turn
      if (gameState.phase === "playing" && currentTurn && currentTurn.playerId === socketPlayerId) {
        socket.emit("claimError", { message: "Cannot claim during your own turn" });
        return;
      }

      const pool = type === "truth" ? contentPools.premadeTruths : contentPools.premadeDares;
      const item = pool.find(c => c.id === contentId);

      if (!item || item.claimedBy) {
        socket.emit("claimError", { message: "Content not available" });
        return;
      }

      // Mark as claimed with targeting info
      item.claimedBy = socketPlayerId;
      item.targetId = targetId || null;

      // Add author info only if not already set (preserve original author for premade content)
      if (!item.authorId) {
        const author = players.get(socketPlayerId);
        item.authorId = socketPlayerId;
        item.authorName = author ? author.name : "Unknown";
      }

      if (targetId) {
        const targetPlayer = players.get(targetId);
        item.targetName = targetPlayer ? targetPlayer.name : null;
      }

      socket.emit("claimSuccess", {
        type,
        contentId,
        text: item.text,
        targetName: item.targetName
      });
      io.emit("premadeClaimed", { type, contentId, claimedBy: socketPlayerId });
      broadcastContentCounts();
    });

    socket.on("dealersChoice", ({ choice }) => {
      if (!currentTurn) return;
      if (currentTurn.playerId !== socketPlayerId) return;
      if (!currentTurn.isDealersChoice) return;
      if (currentTurn.status !== "spinning2") return;

      executeSpin2(choice);
    });

    socket.on("disconnect", () => {
      if (isHost && hostSocket && hostSocket.id === socket.id) {
        hostSocket = null;
      }

      if (socketPlayerId && players.has(socketPlayerId)) {
        const player = players.get(socketPlayerId);
        player.connected = false;
        player.socketId = null;
        broadcastGameState();
      }
    });
  });

  // API endpoint to receive initial player list from launcher (including offline players)
  router.post('/api/init-players', (req, res) => {
    const { players: playersArray, settings: initSettings } = req.body || {};
    if (!Array.isArray(playersArray)) {
      return res.status(400).json({ error: 'Invalid players array' });
    }

    console.log('[TruthOrDare][INIT] Received', playersArray.length, 'players from launcher');

    // Store preset settings if provided
    if (initSettings) {
      gameState.settings.usePresetNames = initSettings.usePresetNames || false;
      gameState.settings.presetNames = Array.isArray(initSettings.presetNames)
        ? initSettings.presetNames.map(n => (n || '').trim().toUpperCase().slice(0, 12)).filter(n => n.length > 0)
        : [];
    }

    for (const p of playersArray) {
      if (!p.key || !p.name) continue;
      if (players.has(p.key)) continue;

      players.set(p.key, {
        id: p.key,
        name: (p.name || '').trim().toUpperCase().slice(0, 12),
        score: 0,
        connected: false,
        socketId: null,
      });
    }

    broadcastGameState();
    res.json({ ok: true, count: playersArray.length });
  });

  router.post("/api/update-settings", express.json(), (req, res) => {
    const { usePresetNames, presetNames } = req.body || {};

    // Update the game's preset settings variables
    if (usePresetNames !== undefined) {
      gameState.settings.usePresetNames = usePresetNames;
    }
    if (presetNames !== undefined) {
      gameState.settings.presetNames = Array.isArray(presetNames)
        ? presetNames.map(n => (n || '').trim().toUpperCase().slice(0, 12)).filter(n => n.length > 0)
        : [];
    }

    console.log("[TruthOrDare][API] Updated preset settings:", { usePresetNames, presetNames: presetNames?.length || 0 });
    res.status(200).json({ success: true });
  });

  // ---- Cleanup function ----

  function cleanup() {
    // Clear all timers
    for (const timer of activeTimers) {
      clearTimeout(timer);
    }
    activeTimers.length = 0;

    // Reset state
    players.clear();
    hostSocket = null;
    currentTurn = null;
    playerPremadeOrder.clear();
    resetContentPools();
    resetStats();

    console.log("[TruthOrDare] Cleanup completed");
  }

  return { router, cleanup };
};
