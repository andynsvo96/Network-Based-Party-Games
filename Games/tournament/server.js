// server.js - Mini Games Tournament
// Elimination-style tournament featuring 10 distinct mini-games

const express = require('express');
const path = require('path');
const fs = require('fs');

module.exports.init = function(config) {
  const { io, gamePath, players: initialPlayers, settings: initialSettings } = config;

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
    LOBBY: 'lobby',
    INTRO: 'intro',
    BRACKET: 'bracket',
    MINI_GAME: 'mini_game',
    ROUND_COMPLETE: 'round_complete',
    SHOWDOWN: 'showdown',
    GAME_OVER: 'game_over'
  };

  // Mini-game registry
  const MINI_GAMES = {
    'tap-race': require('./minigames/tap-race'),
    'cowboy-duel': require('./minigames/cowboy-duel'),
    'tic-tac-toe': require('./minigames/tic-tac-toe'),
    'math-dash': require('./minigames/math-dash'),
    'whack-a-mole': require('./minigames/whack-a-mole'),
    'connect-four': require('./minigames/connect-four'),
    'memory-sequence': require('./minigames/memory-sequence'),
    'battleship': require('./minigames/battleship'),
    'minesweeper': require('./minigames/minesweeper'),
    'blackjack': require('./minigames/blackjack')
  };

  const MINI_GAME_NAMES = {
    'connect-four': 'Connect Four',
    'tic-tac-toe': 'Tic Tac Toe',
    'tap-race': 'Tap Race',
    'whack-a-mole': 'Whack-a-Mole',
    'battleship': 'Battleship',
    'cowboy-duel': 'Cowboy Duel',
    'memory-sequence': 'Memory Sequence',
    'math-dash': 'Math Dash',
    'minesweeper': 'Minesweeper',
    'blackjack': 'Blackjack'
  };

  // --- Game State ---
  let gameState = {
    phase: PHASES.LOBBY,

    // Tournament structure
    bracket: {
      rounds: [],           // Array of rounds, each round = array of matches
      currentRound: 0,      // 0-indexed
      totalRounds: 0        // Calculated from player count (log2)
    },

    // Match management
    currentMatches: [],     // Array of active match objects
    miniGameInstances: new Map(),  // matchId -> mini-game instance

    // Mini-game selection
    selectedGame: null,     // Current mini-game name

    // Voting system
    voting: {
      active: false,
      votes: {},            // playerKey -> gameName
      eligibleVoters: [],   // Array of eliminated player keys
      availableGames: []    // Array of enabled game names
    },

    // Player tracking
    activePlayers: [],      // Players still in tournament
    eliminatedPlayers: [],  // { playerKey, eliminatedRound, placement }

    // Settings
    settings: {
      votingEnabled: true,
      enabledGames: [],
      ticTacToeWins: 3,
      whackMolePopupDuration: 0.5,
      whackMoleScoreLead: 5,
      cowboyMinWaitSeconds: 3,
      memoryRevealTime: 5,
      mathDashPointsToWin: 10,
      minesweeperBombCount: 1
    },

    introSlideIndex: 0
  };

  // Player management
  const playersByKey = new Map(); // key -> player object
  const socketToKey = new Map();  // socketId -> key
  let hostSocketId = null;

  // Cached payloads for reconnection
  let lastIntroPayload = null;
  let lastBracketPayload = null;
  let lastGameOverPayload = null;

  // Timers and intervals
  const activeTimers = [];
  const activeIntervals = [];

  // --- Utility Functions ---

  function normalizeName(name) {
    return String(name || '').toUpperCase().trim();
  }

  function generateKey() {
    return `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  function generateMatchId() {
    return `match_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  function getHost() {
    const h = playersByKey.get(HOST_KEY);
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
    return Array.from(playersByKey.values()).filter(p => p && !p.isHost);
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
        connected: !!p.connected,
        isEliminated: p.isEliminated || false,
        placement: p.placement || null
      }));
  }

  function broadcastPlayerList() {
    const payload = { players: getPlayerListPayload() };
    io.emit('players:update', payload);
  }

  // --- Settings Management ---

  function loadSettings() {
    try {
      const raw = fs.readFileSync(path.join(gamePath, 'gameSettings.json'), 'utf8');
      const loaded = JSON.parse(raw);
      gameState.settings = { ...gameState.settings, ...loaded };
      console.log('[Tournament] Settings loaded:', gameState.settings);
    } catch (e) {
      console.log('[Tournament] No settings file found, using defaults');
    }
  }

  function saveSettings() {
    try {
      fs.writeFileSync(
        path.join(gamePath, 'gameSettings.json'),
        JSON.stringify(gameState.settings, null, 2),
        'utf8'
      );
      console.log('[Tournament] Settings saved');
    } catch (e) {
      console.error('[Tournament] Failed to save settings:', e);
    }
  }

  // --- Score Management ---

  function loadLifetimeScores() {
    try {
      const raw = fs.readFileSync(path.join(gamePath, 'playerScores.json'), 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return { players: {} };
    }
  }

  function saveLifetimeScores(scores) {
    try {
      fs.writeFileSync(
        path.join(gamePath, 'playerScores.json'),
        JSON.stringify(scores, null, 2),
        'utf8'
      );
    } catch (e) {
      console.error('[Tournament] Failed to save scores:', e);
    }
  }

  function updateLifetimeScore(playerKey, placement) {
    const scores = loadLifetimeScores();
    const player = playersByKey.get(playerKey);
    if (!player) return;

    if (!scores.players[playerKey]) {
      scores.players[playerKey] = {
        name: player.name,
        wins: 0,
        gamesPlayed: 0,
        secondPlace: 0,
        totalPlacements: {},
        lastPlayed: new Date().toISOString()
      };
    }

    const playerScore = scores.players[playerKey];
    playerScore.name = player.name;  // Update name if changed
    playerScore.gamesPlayed++;
    playerScore.lastPlayed = new Date().toISOString();

    if (placement === 1) playerScore.wins++;
    if (placement === 2) playerScore.secondPlace++;

    playerScore.totalPlacements[placement] = (playerScore.totalPlacements[placement] || 0) + 1;

    saveLifetimeScores(scores);
  }

  function getLeaderboard() {
    const scores = loadLifetimeScores();
    const allPlayers = getNonHostPlayers();

    return allPlayers.map(player => {
      const stats = scores.players[player.key] || {
        wins: 0,
        gamesPlayed: 0,
        secondPlace: 0
      };

      return {
        key: player.key,
        name: player.name,
        connected: player.connected,
        wins: stats.wins,
        gamesPlayed: stats.gamesPlayed,
        secondPlace: stats.secondPlace
      };
    })
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.secondPlace !== a.secondPlace) return b.secondPlace - a.secondPlace;
      return a.name.localeCompare(b.name);
    });
  }

  // --- Bracket Management ---

  function generateBracket(playerKeys) {
    const playerCount = playerKeys.length;

    // Validate even number
    if (playerCount % 2 !== 0) {
      throw new Error('Tournament requires even number of players');
    }

    if (playerCount < 2 || playerCount > 16) {
      throw new Error('Tournament requires 2-16 players');
    }

    // Calculate rounds: log2(playerCount)
    const totalRounds = Math.log2(playerCount);

    // Shuffle players randomly for first round pairing
    const shuffled = [...playerKeys].sort(() => Math.random() - 0.5);

    // Create first round matches
    const firstRound = [];
    for (let i = 0; i < shuffled.length; i += 2) {
      firstRound.push({
        matchId: generateMatchId(),
        player1Key: shuffled[i],
        player2Key: shuffled[i + 1],
        winner: null,
        loser: null,
        status: 'pending'  // pending, active, complete
      });
    }

    // Initialize bracket structure
    const bracket = {
      rounds: [firstRound],
      currentRound: 0,
      totalRounds: totalRounds
    };

    // Pre-generate empty subsequent rounds
    for (let r = 1; r < totalRounds; r++) {
      const matchesInRound = Math.pow(2, totalRounds - r - 1);
      bracket.rounds.push(
        Array(matchesInRound).fill(null).map(() => ({
          matchId: generateMatchId(),
          player1Key: null,
          player2Key: null,
          winner: null,
          loser: null,
          status: 'pending'
        }))
      );
    }

    return bracket;
  }

  function getBracketPayload() {
    return {
      rounds: gameState.bracket.rounds.map(round =>
        round.map(match => ({
          matchId: match.matchId,
          player1: match.player1Key ? {
            key: match.player1Key,
            name: playersByKey.get(match.player1Key)?.name || 'Unknown'
          } : null,
          player2: match.player2Key ? {
            key: match.player2Key,
            name: playersByKey.get(match.player2Key)?.name || 'Unknown'
          } : null,
          winner: match.winner,
          status: match.status
        }))
      ),
      currentRound: gameState.bracket.currentRound,
      totalRounds: gameState.bracket.totalRounds,
      currentGame: gameState.selectedGame,
      currentGameName: gameState.selectedGame ? MINI_GAME_NAMES[gameState.selectedGame] : null
    };
  }

  // --- Tournament Flow Functions ---

  function selectRandomGame() {
    const enabled = gameState.settings.enabledGames;
    if (enabled.length === 0) return null;
    return enabled[Math.floor(Math.random() * enabled.length)];
  }

  function startTournament() {
    console.log('[Tournament] Starting tournament...');

    const nonHostPlayers = getNonHostPlayers();
    const playerKeys = nonHostPlayers.map(p => p.key);

    try {
      // Generate bracket
      gameState.bracket = generateBracket(playerKeys);
      gameState.activePlayers = [...playerKeys];
      gameState.eliminatedPlayers = [];

      console.log(`[Tournament] Bracket generated for ${playerKeys.length} players`);
      console.log(`[Tournament] Total rounds: ${gameState.bracket.totalRounds}`);

      // Select random game for first round
      gameState.selectedGame = selectRandomGame();
      console.log(`[Tournament] First game: ${gameState.selectedGame}`);

      // Transition to intro phase
      gameState.phase = PHASES.INTRO;
      io.emit('phase:update', { phase: PHASES.INTRO });

      // Cache intro payload
      lastIntroPayload = { phase: PHASES.INTRO };

      // Auto-advance to bracket after 15 seconds (3 slides × 5s each)
      const introTimer = setTimeout(() => {
        if (gameState.phase === PHASES.INTRO) {
          gameState.phase = PHASES.BRACKET;
          io.emit('phase:update', { phase: PHASES.BRACKET });
          io.emit('bracket:update', getBracketPayload());

          // Start first round after short delay
          setTimeout(() => {
            startRound();
          }, 2000);
        }
      }, 15000);
      activeTimers.push(introTimer);

    } catch (error) {
      console.error('[Tournament] Error starting tournament:', error);
      emitToHost('error', { message: error.message });
    }
  }

  function startRound() {
    console.log(`[Tournament] Starting round ${gameState.bracket.currentRound + 1}`);

    const currentRound = gameState.bracket.currentRound;
    const matches = gameState.bracket.rounds[currentRound];

    // Check if this is the finals (showdown)
    if (currentRound === gameState.bracket.totalRounds - 1) {
      gameState.phase = PHASES.SHOWDOWN;

      const finalMatch = matches[0];
      const player1 = playersByKey.get(finalMatch.player1Key);
      const player2 = playersByKey.get(finalMatch.player2Key);

      io.emit('showdown:start', {
        player1: { key: player1.key, name: player1.name },
        player2: { key: player2.key, name: player2.name },
        gameName: MINI_GAME_NAMES[gameState.selectedGame],
        gameId: gameState.selectedGame
      });

      // Start match after 5 second showdown intro
      const showdownTimer = setTimeout(() => {
        executeMatch(finalMatch);
      }, 5000);
      activeTimers.push(showdownTimer);

    } else {
      // Regular round - execute all matches
      gameState.phase = PHASES.MINI_GAME;
      io.emit('phase:update', { phase: PHASES.MINI_GAME });

      matches.forEach(match => {
        executeMatch(match);
      });
    }
  }

  function executeMatch(match) {
    console.log(`[Tournament] Executing match: ${match.matchId}`);

    match.status = 'active';

    const player1 = playersByKey.get(match.player1Key);
    const player2 = playersByKey.get(match.player2Key);

    if (!player1 || !player2) {
      console.error('[Tournament] Missing players for match:', match.matchId);
      return;
    }

    // Update player current match
    player1.currentMatchId = match.matchId;
    player2.currentMatchId = match.matchId;

    // Notify players that their match is starting
    if (player1.connected && player1.socketId) {
      io.to(player1.socketId).emit('match:start', {
        matchId: match.matchId,
        opponentName: player2.name,
        gameName: MINI_GAME_NAMES[gameState.selectedGame],
        gameId: gameState.selectedGame
      });
    }

    if (player2.connected && player2.socketId) {
      io.to(player2.socketId).emit('match:start', {
        matchId: match.matchId,
        opponentName: player1.name,
        gameName: MINI_GAME_NAMES[gameState.selectedGame],
        gameId: gameState.selectedGame
      });
    }

    // Create mini-game instance
    const GameClass = MINI_GAMES[gameState.selectedGame];

    if (!GameClass) {
      // Game not implemented yet - simulate with random winner
      console.warn(`[Tournament] Mini-game ${gameState.selectedGame} not implemented yet, simulating...`);
      const matchTimer = setTimeout(() => {
        const winner = Math.random() < 0.5 ? match.player1Key : match.player2Key;
        handleMatchComplete(match.matchId, winner);
      }, 10000);
      activeTimers.push(matchTimer);
      return;
    }

    try {
      const miniGame = new GameClass({
        io,
        matchId: match.matchId,
        player1: {
          key: player1.key,
          name: player1.name,
          socketId: player1.socketId
        },
        player2: {
          key: player2.key,
          name: player2.name,
          socketId: player2.socketId
        },
        settings: gameState.settings,
        onComplete: (winnerKey) => {
          handleMatchComplete(match.matchId, winnerKey);
        }
      });

      // Store instance for cleanup
      gameState.miniGameInstances.set(match.matchId, miniGame);

      // Start the mini-game
      miniGame.start();

      console.log(`[Tournament] Match ${match.matchId} started: ${player1.name} vs ${player2.name} playing ${gameState.selectedGame}`);

    } catch (error) {
      console.error(`[Tournament] Error starting mini-game:`, error);
      // Fallback to random winner
      const matchTimer = setTimeout(() => {
        const winner = Math.random() < 0.5 ? match.player1Key : match.player2Key;
        handleMatchComplete(match.matchId, winner);
      }, 5000);
      activeTimers.push(matchTimer);
    }
  }

  function handleMatchComplete(matchId, winnerKey) {
    console.log(`[Tournament] Match complete: ${matchId}, winner: ${winnerKey}`);

    const currentRound = gameState.bracket.currentRound;
    const match = gameState.bracket.rounds[currentRound].find(m => m.matchId === matchId);

    if (!match) {
      console.error('[Tournament] Match not found:', matchId);
      return;
    }

    match.winner = winnerKey;
    match.loser = match.player1Key === winnerKey ? match.player2Key : match.player1Key;
    match.status = 'complete';

    // Clear player current match
    const player1 = playersByKey.get(match.player1Key);
    const player2 = playersByKey.get(match.player2Key);
    if (player1) player1.currentMatchId = null;
    if (player2) player2.currentMatchId = null;

    // Cleanup mini-game instance
    const miniGame = gameState.miniGameInstances.get(matchId);
    if (miniGame && miniGame.cleanup) {
      miniGame.cleanup().catch(err => console.error('[Tournament] Mini-game cleanup error:', err));
      gameState.miniGameInstances.delete(matchId);
    }

    // Notify players of result
    if (player1 && player1.connected && player1.socketId) {
      io.to(player1.socketId).emit('match:result', {
        winner: winnerKey === player1.key,
        winnerName: playersByKey.get(winnerKey)?.name
      });
    }

    if (player2 && player2.connected && player2.socketId) {
      io.to(player2.socketId).emit('match:result', {
        winner: winnerKey === player2.key,
        winnerName: playersByKey.get(winnerKey)?.name
      });
    }

    // Update bracket display
    io.emit('bracket:update', getBracketPayload());

    // Check if all matches in round are complete
    const allComplete = gameState.bracket.rounds[currentRound].every(m => m.status === 'complete');

    if (allComplete) {
      console.log(`[Tournament] Round ${currentRound + 1} complete`);

      // Show round complete phase
      gameState.phase = PHASES.ROUND_COMPLETE;

      const roundResults = gameState.bracket.rounds[currentRound].map(m => ({
        player1Name: playersByKey.get(m.player1Key)?.name,
        player2Name: playersByKey.get(m.player2Key)?.name,
        winnerName: playersByKey.get(m.winner)?.name
      }));

      io.emit('round:complete', {
        roundNumber: currentRound + 1,
        matches: roundResults
      });

      // Advance to next round after delay
      const advanceTimer = setTimeout(() => {
        advanceToNextRound();
      }, 5000);
      activeTimers.push(advanceTimer);
    }
  }

  function advanceToNextRound() {
    console.log('[Tournament] Advancing to next round...');

    const currentRound = gameState.bracket.currentRound;
    const currentMatches = gameState.bracket.rounds[currentRound];

    // Get losers from this round
    const losers = currentMatches.map(m => m.loser);

    // Assign placements to eliminated players
    assignPlacements(losers, currentRound);

    // Mark losers as eliminated
    losers.forEach(loserKey => {
      const player = playersByKey.get(loserKey);
      if (player) {
        player.isEliminated = true;

        // Notify eliminated player
        if (player.connected && player.socketId) {
          io.to(player.socketId).emit('eliminated', {
            placement: player.placement,
            round: currentRound + 1
          });
        }
      }
    });

    // Update active players list
    gameState.activePlayers = gameState.activePlayers.filter(key => !losers.includes(key));

    // Check if tournament is over (only 1 player left)
    if (gameState.activePlayers.length === 1) {
      endTournament();
      return;
    }

    // Advance to next round
    gameState.bracket.currentRound++;
    const nextRound = gameState.bracket.currentRound;
    const nextMatches = gameState.bracket.rounds[nextRound];
    const winners = currentMatches.map(m => m.winner);

    // Populate next round matches with winners
    for (let i = 0; i < nextMatches.length; i++) {
      nextMatches[i].player1Key = winners[i * 2];
      nextMatches[i].player2Key = winners[i * 2 + 1];
      nextMatches[i].status = 'pending';
    }

    console.log(`[Tournament] Advanced to round ${nextRound + 1}`);

    // Add eliminated players to voting pool
    gameState.voting.eligibleVoters.push(...losers);

    // Initiate voting or select random game
    if (gameState.settings.votingEnabled && gameState.voting.eligibleVoters.length > 0) {
      initiateVoting();
    } else {
      // No voting - select random game and start next round
      gameState.selectedGame = selectRandomGame();
      console.log(`[Tournament] Random game selected: ${gameState.selectedGame}`);

      gameState.phase = PHASES.BRACKET;
      io.emit('phase:update', { phase: PHASES.BRACKET });
      io.emit('bracket:update', getBracketPayload());

      const startTimer = setTimeout(() => {
        startRound();
      }, 3000);
      activeTimers.push(startTimer);
    }
  }

  function assignPlacements(eliminatedPlayerKeys, eliminatedRound) {
    const totalRounds = gameState.bracket.totalRounds;
    const roundsRemaining = totalRounds - eliminatedRound - 1;

    let placementStart;
    if (roundsRemaining === 0) {
      // Finals loser = 2nd place
      placementStart = 2;
    } else {
      // Calculate placement based on rounds remaining
      placementStart = Math.pow(2, roundsRemaining) + 1;
    }

    eliminatedPlayerKeys.forEach((playerKey, idx) => {
      const player = playersByKey.get(playerKey);
      if (player) {
        player.eliminatedRound = eliminatedRound + 1; // 1-indexed
        player.placement = placementStart; // All players eliminated in same round get same placement

        gameState.eliminatedPlayers.push({
          playerKey,
          eliminatedRound: eliminatedRound + 1,
          placement: placementStart
        });

        console.log(`[Tournament] ${player.name} placed ${placementStart} (eliminated round ${eliminatedRound + 1})`);
      }
    });
  }

  function initiateVoting() {
    console.log('[Tournament] Initiating voting...');

    gameState.voting.active = true;
    gameState.voting.votes = {};
    gameState.voting.availableGames = gameState.settings.enabledGames;

    // Emit voting to all eliminated players
    gameState.voting.eligibleVoters.forEach(voterKey => {
      const player = playersByKey.get(voterKey);
      if (player && player.connected && player.socketId) {
        io.to(player.socketId).emit('voting:start', {
          games: gameState.voting.availableGames.map(id => ({
            id,
            name: MINI_GAME_NAMES[id]
          }))
        });
      }
    });

    // Emit voting status to host
    updateVotingStatus();
  }

  function updateVotingStatus() {
    const voters = gameState.voting.eligibleVoters.map(key => {
      const p = playersByKey.get(key);
      return {
        key: key,
        name: p?.name || 'Unknown',
        voted: !!gameState.voting.votes[key],
        connected: p?.connected || false
      };
    });

    emitToHost('voting:status', {
      totalVoters: gameState.voting.eligibleVoters.length,
      votesReceived: Object.keys(gameState.voting.votes).length,
      voters: voters
    });
  }

  function checkVotingComplete() {
    const totalVoters = gameState.voting.eligibleVoters.length;
    const votesReceived = Object.keys(gameState.voting.votes).length;

    console.log(`[Tournament] Voting progress: ${votesReceived}/${totalVoters}`);

    if (votesReceived === totalVoters) {
      tallyVotes();
    }
  }

  function tallyVotes() {
    console.log('[Tournament] Tallying votes...');

    const voteCounts = {};

    Object.values(gameState.voting.votes).forEach(gameName => {
      voteCounts[gameName] = (voteCounts[gameName] || 0) + 1;
    });

    // Find game(s) with most votes
    let maxVotes = 0;
    let winningGames = [];

    Object.entries(voteCounts).forEach(([game, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        winningGames = [game];
      } else if (count === maxVotes) {
        winningGames.push(game);
      }
    });

    // If tie, randomly select from tied games
    const selectedGame = winningGames[Math.floor(Math.random() * winningGames.length)];

    gameState.selectedGame = selectedGame;
    gameState.voting.active = false;

    console.log(`[Tournament] Voting complete. Selected: ${selectedGame}`, voteCounts);

    // Show voting results
    io.emit('voting:results', {
      selectedGame: selectedGame,
      selectedGameName: MINI_GAME_NAMES[selectedGame],
      voteCounts: voteCounts
    });

    // Proceed to next round after delay
    const nextRoundTimer = setTimeout(() => {
      gameState.phase = PHASES.BRACKET;
      io.emit('phase:update', { phase: PHASES.BRACKET });
      io.emit('bracket:update', getBracketPayload());

      const startTimer = setTimeout(() => {
        startRound();
      }, 2000);
      activeTimers.push(startTimer);
    }, 4000);
    activeTimers.push(nextRoundTimer);
  }

  function endTournament() {
    console.log('[Tournament] Ending tournament...');

    gameState.phase = PHASES.GAME_OVER;

    // Winner is the last active player
    const winnerKey = gameState.activePlayers[0];
    const winner = playersByKey.get(winnerKey);

    if (winner) {
      winner.placement = 1;
      updateLifetimeScore(winnerKey, 1);
      console.log(`[Tournament] Winner: ${winner.name}`);
    }

    // Update lifetime scores for all players
    gameState.eliminatedPlayers.forEach(ep => {
      updateLifetimeScore(ep.playerKey, ep.placement);
    });

    // Prepare final standings
    const allPlayers = [winnerKey, ...gameState.eliminatedPlayers.map(ep => ep.playerKey)];

    const standings = allPlayers.map(key => {
      const player = playersByKey.get(key);
      return {
        key: key,
        name: player?.name || 'Unknown',
        placement: player?.placement || 999,
        eliminatedRound: player?.eliminatedRound || null
      };
    }).sort((a, b) => a.placement - b.placement);

    const gameOverPayload = {
      phase: PHASES.GAME_OVER,
      winner: {
        key: winnerKey,
        name: winner?.name || 'Unknown'
      },
      standings: standings
    };

    // Cache for reconnections
    lastGameOverPayload = gameOverPayload;

    // Emit to all players
    io.emit('tournament:end', gameOverPayload);

    // Notify each player of their placement
    allPlayers.forEach(key => {
      const player = playersByKey.get(key);
      if (player && player.connected && player.socketId) {
        io.to(player.socketId).emit('phase:update', {
          phase: PHASES.GAME_OVER,
          placement: player.placement
        });
      }
    });
  }

  // --- Socket.IO Connection Handler ---

  io.on('connection', (socket) => {
    console.log('[Tournament] Client connected:', socket.id);

    // --- Host Registration ---
    socket.on('registerHost', () => {
      console.log('[Tournament] Host registering:', socket.id);

      // Clean up old host mapping if exists
      const oldHost = playersByKey.get(HOST_KEY);
      if (oldHost && oldHost.socketId) {
        socketToKey.delete(oldHost.socketId);
      }

      // Set up host entry (reuse existing or create new)
      if (oldHost) {
        oldHost.socketId = socket.id;
        oldHost.connected = true;
      } else {
        playersByKey.set(HOST_KEY, {
          key: HOST_KEY,
          name: 'HOST',
          socketId: socket.id,
          connected: true,
          isHost: true,
          isEliminated: false,
          placement: null,
          currentMatchId: null
        });
      }

      socketToKey.set(socket.id, HOST_KEY);
      hostSocketId = socket.id;

      // Send current state
      socket.emit('phase:update', {
        phase: gameState.phase,
        leaderboard: getLeaderboard(),
        enabledGames: gameState.settings.enabledGames
      });
      socket.emit('players:update', { players: getPlayerListPayload() });

      console.log('[Tournament] Host registered successfully');
    });

    // --- Player Registration ---
    socket.on('registerPlayer', (data, callback) => {
      const name = normalizeName(data?.name || '');
      let playerKey = data?.playerKey || null;

      if (!name) {
        if (callback) callback({ ok: false, error: 'Name is required' });
        return;
      }

      // Check for existing player (reconnection)
      let player = playerKey ? playersByKey.get(playerKey) : null;
      const isReconnecting = !!player;

      if (isReconnecting) {
        // Reconnecting player
        console.log(`[Tournament] Player reconnecting: ${player.name}`);
        player.socketId = socket.id;
        player.connected = true;
        player.name = name;  // Allow name update
        socketToKey.set(socket.id, playerKey);
      } else {
        // Check for name collision
        const takenByOther = getNonHostPlayers().some(p =>
          p.name === name && p.key !== playerKey
        );

        if (takenByOther) {
          if (callback) callback({ ok: false, error: 'That name is already taken' });
          return;
        }

        // New player
        playerKey = generateKey();
        player = {
          key: playerKey,
          name: name,
          socketId: socket.id,
          connected: true,
          isHost: false,
          isEliminated: false,
          placement: null,
          currentMatchId: null
        };

        playersByKey.set(playerKey, player);
        socketToKey.set(socket.id, playerKey);

        console.log(`[Tournament] New player joined: ${name}`);
      }

      // Send response
      if (callback) {
        callback({
          ok: true,
          playerKey: playerKey,
          reconnected: isReconnecting,
          phase: gameState.phase
        });
      }

      // Sync player with current game state
      if (gameState.phase === PHASES.LOBBY) {
        socket.emit('phase:update', {
          phase: gameState.phase,
          leaderboard: getLeaderboard()
        });
      }

      // Broadcast updated player list
      broadcastPlayerList();
    });

    // --- Settings Update ---
    socket.on('settings:update', (data) => {
      const playerKey = socketToKey.get(socket.id);
      const player = playersByKey.get(playerKey);

      // Only host can update settings
      if (!player || !player.isHost) return;

      console.log('[Tournament] Updating settings:', data);

      if (data.votingEnabled !== undefined) {
        gameState.settings.votingEnabled = !!data.votingEnabled;
      }

      if (data.enabledGames !== undefined && Array.isArray(data.enabledGames)) {
        // Ensure at least one game is enabled
        if (data.enabledGames.length > 0) {
          gameState.settings.enabledGames = data.enabledGames;
        }
      }

      if (data.ticTacToeWins !== undefined) {
        gameState.settings.ticTacToeWins = Math.max(1, Math.min(5, data.ticTacToeWins));
      }

      if (data.whackMolePopupDuration !== undefined) {
        gameState.settings.whackMolePopupDuration = Math.max(0.3, Math.min(1.0, data.whackMolePopupDuration));
      }

      if (data.whackMoleScoreLead !== undefined) {
        gameState.settings.whackMoleScoreLead = Math.max(3, Math.min(10, data.whackMoleScoreLead));
      }

      if (data.cowboyMinWaitSeconds !== undefined) {
        gameState.settings.cowboyMinWaitSeconds = Math.max(2, Math.min(5, data.cowboyMinWaitSeconds));
      }

      if (data.memoryRevealTime !== undefined) {
        gameState.settings.memoryRevealTime = Math.max(3, Math.min(10, data.memoryRevealTime));
      }

      if (data.mathDashPointsToWin !== undefined) {
        const validValues = [10, 13, 16, 19, 22];
        if (validValues.includes(data.mathDashPointsToWin)) {
          gameState.settings.mathDashPointsToWin = data.mathDashPointsToWin;
        }
      }

      if (data.minesweeperBombCount !== undefined) {
        gameState.settings.minesweeperBombCount = Math.max(1, Math.min(5, data.minesweeperBombCount));
      }

      saveSettings();

      // Broadcast updated settings
      io.emit('settings:updated', gameState.settings);
    });

    // --- Tournament Control ---
    socket.on('host:start_tournament', () => {
      const playerKey = socketToKey.get(socket.id);
      const player = playersByKey.get(playerKey);

      // Only host can start
      if (!player || !player.isHost) return;

      const nonHostPlayers = getNonHostPlayers();

      // Validate player count
      if (nonHostPlayers.length < 2) {
        emitToHost('error', { message: 'Need at least 2 players to start tournament' });
        return;
      }

      if (nonHostPlayers.length % 2 !== 0) {
        emitToHost('error', { message: 'Need an even number of players for tournament' });
        return;
      }

      if (gameState.settings.enabledGames.length === 0) {
        emitToHost('error', { message: 'At least one mini-game must be enabled' });
        return;
      }

      startTournament();
    });

    socket.on('host:end_game', () => {
      const playerKey = socketToKey.get(socket.id);
      const player = playersByKey.get(playerKey);

      // Only host can end game
      if (!player || !player.isHost) return;

      endTournament();
    });

    socket.on('host:return_to_lobby', () => {
      const playerKey = socketToKey.get(socket.id);
      const player = playersByKey.get(playerKey);

      // Only host can return to lobby
      if (!player || !player.isHost) return;

      console.log('[Tournament] Host returning to lobby');

      // Clean up active mini-game instances
      if (gameState.miniGameInstances) {
        gameState.miniGameInstances.forEach(game => {
          if (game && game.cleanup) game.cleanup();
        });
        gameState.miniGameInstances.clear();
      }

      // Clear timers and intervals
      activeTimers.forEach(clearTimeout);
      activeIntervals.forEach(clearInterval);
      activeTimers.length = 0;
      activeIntervals.length = 0;

      // Reset tournament state
      gameState.phase = PHASES.LOBBY;
      gameState.bracket = { rounds: [], currentRound: 0, totalRounds: 0 };
      gameState.currentMatches = [];
      gameState.selectedGame = null;
      gameState.voting = { active: false, votes: {}, eligibleVoters: [], availableGames: [] };
      gameState.activePlayers = [];
      gameState.eliminatedPlayers = [];
      gameState.introSlideIndex = 0;

      // Reset all players' tournament-specific state
      playersByKey.forEach(p => {
        p.eliminated = false;
        p.placement = null;
        p.eliminatedRound = null;
      });

      // Notify all clients to return to lobby
      io.emit('phase:update', { phase: PHASES.LOBBY });
      broadcastPlayerList();
    });

    socket.on('host:skip_intro', () => {
      const playerKey = socketToKey.get(socket.id);
      const player = playersByKey.get(playerKey);

      // Only host can skip intro
      if (!player || !player.isHost) return;

      if (gameState.phase === PHASES.INTRO) {
        gameState.phase = PHASES.BRACKET;
        io.emit('phase:update', { phase: PHASES.BRACKET });
        io.emit('bracket:update', getBracketPayload());

        // Start first round
        setTimeout(() => {
          startRound();
        }, 2000);
      }
    });

    // --- Voting ---
    socket.on('vote:submit', (data) => {
      const playerKey = socketToKey.get(socket.id);
      if (!playerKey) return;

      const player = playersByKey.get(playerKey);
      if (!player || !player.isEliminated) return;

      if (!gameState.voting.active) {
        console.log('[Tournament] Vote ignored - voting not active');
        return;
      }

      const { gameName } = data;
      if (!gameState.voting.availableGames.includes(gameName)) {
        console.log('[Tournament] Invalid game voted:', gameName);
        return;
      }

      // Record vote
      gameState.voting.votes[playerKey] = gameName;
      console.log(`[Tournament] ${player.name} voted for ${gameName}`);

      // Update host with voting status
      updateVotingStatus();

      // Check if all votes received
      checkVotingComplete();
    });

    // --- Kick Player ---
    socket.on('kickPlayer', ({ playerKey }) => {
      const key = socketToKey.get(socket.id);
      if (key !== HOST_KEY) return; // Only host can kick

      // Only allow kick during LOBBY phase
      if (gameState.phase !== PHASES.LOBBY) {
        emitToHost('error', { message: 'You can only kick players during the lobby phase.' });
        return;
      }

      // Validate player
      if (!playerKey || !playersByKey.has(playerKey) || playerKey === HOST_KEY) return;

      const player = playersByKey.get(playerKey);

      // Notify and disconnect target
      if (player.socketId) {
        io.to(player.socketId).emit('kicked', {
          message: 'You have been removed from the game by the host.'
        });
        const targetSocket = io.sockets.get(player.socketId);
        if (targetSocket) targetSocket.disconnect(true);
        socketToKey.delete(player.socketId);
      }

      // Remove from players
      playersByKey.delete(playerKey);

      // Broadcast update
      broadcastPlayerList();

      console.log(`[Tournament] Player kicked: ${player.name}`);
    });

    // --- Handle Graceful Shutdown (returned to menu from master server) ---
    socket.on('returned_to_menu', (data) => {
      const playerKey = socketToKey.get(socket.id);
      if (!playerKey) return;

      const player = playersByKey.get(playerKey);
      if (!player) return;

      // Mark player as offline but keep in game state for reconnection
      player.connected = false;
      player.socketId = null;

      socketToKey.delete(socket.id);

      if (player.isHost) {
        hostSocketId = null;
        console.log('[Tournament] Host returned to menu');
      } else {
        console.log(`[Tournament] Player returned to menu: ${player.name}`);
      }

      broadcastPlayerList();
    });

    // --- Disconnection ---
    socket.on('disconnect', () => {
      console.log('[Tournament] Client disconnected:', socket.id);

      const playerKey = socketToKey.get(socket.id);
      if (!playerKey) return;

      const player = playersByKey.get(playerKey);
      if (!player) return;

      // Mark as offline but keep in game
      player.connected = false;
      player.socketId = null;
      socketToKey.delete(socket.id);

      if (player.isHost) {
        hostSocketId = null;
        console.log('[Tournament] Host disconnected');
      } else {
        console.log(`[Tournament] Player disconnected: ${player.name}`);
      }

      // Broadcast updated player list
      broadcastPlayerList();
    });
  });

  // --- Initialization ---
  console.log('[Tournament] Initializing...');

  // Load settings
  loadSettings();

  // Initialize host if provided
  if (initialPlayers && initialPlayers.length > 0) {
    initialPlayers.forEach(p => {
      const player = {
        key: p.key,
        name: normalizeName(p.name),
        socketId: null,
        connected: p.connected || false,
        isHost: false,
        isEliminated: false,
        placement: null,
        currentMatchId: null
      };
      playersByKey.set(p.key, player);
    });
    console.log(`[Tournament] Initialized with ${initialPlayers.length} players`);
  }

  // --- Cleanup ---
  function cleanup() {
    console.log('[Tournament] Cleaning up...');

    // Clear all mini-game instances
    if (gameState.miniGameInstances) {
      gameState.miniGameInstances.forEach(game => {
        if (game && game.cleanup) game.cleanup();
      });
      gameState.miniGameInstances.clear();
    }

    // Clear timers and intervals
    activeTimers.forEach(clearTimeout);
    activeIntervals.forEach(clearInterval);
    activeTimers.length = 0;
    activeIntervals.length = 0;

    // Remove all socket listeners
    io.removeAllListeners();
  }

  return {
    router,
    cleanup
  };
};
