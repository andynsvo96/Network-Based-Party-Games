const express = require('express');
const path = require('path');
const fs = require('fs');

// ---- Modular Export ----

module.exports.init = function(config) {
  const { io, gamePath, players: initialPlayers, settings: initialSettings } = config;
  const router = express.Router();

  router.use(express.json());

  // ============================================================================
  // GAME PHASES
  // ============================================================================
  const PHASES = {
    LOBBY: 'lobby',
    INTRO: 'intro',
    TEAM_SETUP: 'team_setup',
    CATEGORY_SELECT: 'category_select',
    GAMEPLAY: 'gameplay',
    ROUND_RESULT: 'round_result',
    RESULTS: 'results'
  };

  // ============================================================================
  // GAME STATE
  // ============================================================================
  let gameState = {
    phase: PHASES.LOBBY,
    selectedMode: null,
    currentRound: 0,
    currentWord: null,
    currentTeamIndex: 0,
    teams: [],

    // Fair catch-up / tie-breaker state
    catchUpPhase: false,           // true when trailing team is trying to catch up
    catchUpTeamIndex: null,        // index of the team trying to catch up
    leadingTeamIndex: null,        // index of the team that reached target first
    tieBreakerActive: false,       // true during continuous tie-breaker rounds

    // Pictionary drawer order (randomized, everyone draws once)
    pictionaryDrawerOrder: [],      // Shuffled array of player keys
    pictionaryTotalRounds: 0,       // Number of players at game start

    // Classic Solo actor order (randomized, everyone acts once)
    classicSoloActorOrder: [],      // Shuffled array of player keys
    classicSoloTotalRounds: 0,      // Number of players at game start

    settings: {
      selectedCategories: ['location', 'object', 'person', 'action'],
      soundEnabled: true,
      soundTimerTick: true,
      soundVolume: 0.8,

      // Charades Chain
      charadeLinesTimer: 90,
      charadeLinesWinTarget: 10,
      charadesLinesContinuousTieBreaker: false,  // if true, play until tie breaks; if false, tie ends game

      // Heads-Up
      headsUpTimer: 180,
      headsUpWinTarget: 10,
      headsUpAllowSkip: true,

      // Pictionary
      pictionaryTimer: 60,
      pictionaryPoints: [3, 2, 1],
      pictionaryHintsEnabled: true,
      pictionaryHintInterval: 10,

      // Classic
      classicTimer: 90,
      classicWinTarget: 10,
      classicMode: 'team',
      classicPenalty: true,
      classicSoloHintsEnabled: true,
      classicSoloHintInterval: 10,
      classicContinuousTieBreaker: true,

      // Preset Names
      usePresetNames: false,
      presetNames: []
    },

    roundState: {
      startTime: null,
      timerInterval: null,
      remainingSeconds: 0,
      actorKey: null,
      guesserKey: null,
      guesserKeys: [],
      starterKey: null,
      finisherKey: null,
      lineOrder: [],
      actorKeys: [],
      guesses: [],
      correctGuessers: [],
      drawingData: [],
      strokeHistory: [],
      redoStack: [],
      skipVotes: new Set(),
      hintsRevealed: 0,
      hintString: '',
      someoneGuessed: false,
      lastGuessedWord: null  // Track last correctly guessed word for heads-up mode
    },

    wordPool: [],
    usedWords: new Set(),
    allWords: {},
    introSlideIndex: 0,

    // Heads-Up team turn tracking
    headsUpTeamsPlayed: 0,
    headsUpTeamScores: [],
    headsUpCurrentRoundInSet: 0,
    headsUpTotalRoundsPerTeam: 0,
    headsUpActorHistory: { team1: [], team2: [] }
  };

  // ============================================================================
  // PLAYER MANAGEMENT (Session-based)
  // ============================================================================
  const playersByKey = new Map();
  const socketToKey = new Map();
  let hostSocketId = null;

  // Initialize players from launcher (includes offline players)
  if (initialPlayers && Array.isArray(initialPlayers)) {
    console.log('[Charades] Initializing with', initialPlayers.length, 'players from launcher');
    for (const p of initialPlayers) {
      if (!p.key || !p.name) continue;
      playersByKey.set(p.key, {
        key: p.key,
        name: p.name.toUpperCase().substring(0, 15),
        socketId: null,
        connected: p.connected || false,
        joinedSession: false,  // Never connected this session yet
        sessionPoints: 0
      });
    }
  }

  // Timer tracking for cleanup
  const activeTimers = [];

  function generatePlayerKey() {
    return 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  function getConnectedPlayers() {
    return Array.from(playersByKey.values()).filter(p => p.connected);
  }

  function getSessionPlayers() {
    return Array.from(playersByKey.values()).filter(p => p.joinedSession !== false);
  }

  function getAllPlayers() {
    return Array.from(playersByKey.values());
  }

  function getPlayerByKey(key) {
    return playersByKey.get(key);
  }

  function getPlayerBySocketId(socketId) {
    const key = socketToKey.get(socketId);
    return key ? playersByKey.get(key) : null;
  }

  // ============================================================================
  // SCORE PERSISTENCE
  // ============================================================================
  const SCORES_FILE = path.join(gamePath, 'playerScores.json');

  function loadPlayerScores() {
    try {
      if (fs.existsSync(SCORES_FILE)) {
        const data = fs.readFileSync(SCORES_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      console.error('[Charades] Error loading scores:', e);
    }
    return { players: {} };
  }

  function savePlayerScores(scores) {
    try {
      fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
    } catch (e) {
      console.error('[Charades] Error saving scores:', e);
    }
  }

  // ============================================================================
  // SETTINGS PERSISTENCE
  // ============================================================================
  const SETTINGS_FILE = path.join(gamePath, 'gameSettings.json');

  function loadGameSettings() {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      console.error('[Charades] Error loading settings:', e);
    }
    return null;
  }

  function saveGameSettings(settings) {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
      console.error('[Charades] Error saving settings:', e);
    }
  }

  // Load saved settings on startup
  const savedSettings = loadGameSettings();
  if (savedSettings) {
    gameState.settings = { ...gameState.settings, ...savedSettings };
    console.log('[Charades] Loaded saved settings from file');
  }

  function getPlayerLifetimeScores(playerKey) {
    const scores = loadPlayerScores();
    return scores.players[playerKey]?.scores || {
      charade_lines: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
      heads_up: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
      pictionary: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
      classic_team: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
      classic_individual: { wins: 0, gamesPlayed: 0, totalPoints: 0 }
    };
  }

  function updatePlayerScore(playerKey, playerName, mode, won, pointsEarned) {
    const scores = loadPlayerScores();
    if (!scores.players[playerKey]) {
      scores.players[playerKey] = {
        name: playerName,
        scores: {
          charade_lines: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
          heads_up: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
          pictionary: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
          classic_team: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
          classic_individual: { wins: 0, gamesPlayed: 0, totalPoints: 0 }
        },
        lastPlayed: new Date().toISOString()
      };
    }

    const modeKey = mode === 'classic' ?
      (gameState.settings.classicMode === 'team' ? 'classic_team' : 'classic_individual') :
      mode;

    if (!scores.players[playerKey].scores[modeKey]) {
      scores.players[playerKey].scores[modeKey] = { wins: 0, gamesPlayed: 0, totalPoints: 0 };
    }

    scores.players[playerKey].scores[modeKey].gamesPlayed++;
    scores.players[playerKey].scores[modeKey].totalPoints += pointsEarned;
    if (won) scores.players[playerKey].scores[modeKey].wins++;
    scores.players[playerKey].name = playerName;
    scores.players[playerKey].lastPlayed = new Date().toISOString();

    savePlayerScores(scores);
  }

  function resetAllScores() {
    savePlayerScores({ players: {} });
  }

  function getAllLifetimeScores() {
    const scores = loadPlayerScores();
    return scores.players || {};
  }

  function getConsolidatedLifetimeScores() {
    const scores = loadPlayerScores();
    const allPlayers = scores.players || {};

    // Group players by normalized name (uppercase)
    const byName = {};

    for (const [key, data] of Object.entries(allPlayers)) {
      const normalizedName = (data.name || '').toUpperCase();

      if (!byName[normalizedName]) {
        byName[normalizedName] = {
          name: data.name,
          keys: [key],
          scores: {
            charade_lines: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
            heads_up: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
            pictionary: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
            classic_team: { wins: 0, gamesPlayed: 0, totalPoints: 0 },
            classic_individual: { wins: 0, gamesPlayed: 0, totalPoints: 0 }
          },
          lastPlayed: data.lastPlayed
        };
      } else {
        byName[normalizedName].keys.push(key);
        if (data.lastPlayed > byName[normalizedName].lastPlayed) {
          byName[normalizedName].lastPlayed = data.lastPlayed;
        }
      }

      // Merge scores
      const merged = byName[normalizedName].scores;
      const source = data.scores || {};

      for (const mode of ['charade_lines', 'heads_up', 'pictionary', 'classic_team', 'classic_individual']) {
        if (source[mode]) {
          merged[mode].wins += source[mode].wins || 0;
          merged[mode].gamesPlayed += source[mode].gamesPlayed || 0;
          merged[mode].totalPoints += source[mode].totalPoints || 0;
        }
      }
    }

    return byName;
  }

  // ============================================================================
  // WORD LOADING
  // ============================================================================
  function loadWords() {
    const jsonPath = path.join(gamePath, 'words.json');
    try {
      const jsonData = fs.readFileSync(jsonPath, 'utf8');
      gameState.allWords = JSON.parse(jsonData);
      console.log('[Charades] Words loaded:', Object.keys(gameState.allWords).map(k => `${k}: ${gameState.allWords[k].length}`).join(', '));
    } catch (e) {
      console.error('[Charades] Error loading words:', e);
      // Fallback words
      gameState.allWords = {
        location: ['Beach', 'Library', 'Airport'],
        object: ['Umbrella', 'Guitar', 'Camera'],
        person: ['Chef', 'Doctor', 'Pirate'],
        action: ['Swimming', 'Dancing', 'Cooking']
      };
    }
  }

  function buildWordPool() {
    gameState.wordPool = [];
    for (const cat of gameState.settings.selectedCategories) {
      if (gameState.allWords[cat]) {
        gameState.wordPool.push(...gameState.allWords[cat]);
      }
    }
    // Shuffle
    for (let i = gameState.wordPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [gameState.wordPool[i], gameState.wordPool[j]] = [gameState.wordPool[j], gameState.wordPool[i]];
    }
  }

  function getNextWord() {
    // Filter out used words
    const available = gameState.wordPool.filter(w => !gameState.usedWords.has(w));
    if (available.length === 0) {
      // No more words available - return null to trigger game end
      return null;
    }
    const word = available[Math.floor(Math.random() * available.length)];
    gameState.usedWords.add(word);
    return word;
  }

  // ============================================================================
  // INTRO SLIDES
  // ============================================================================
  const INTRO_SLIDES = {
    charade_lines: [
      { title: 'CHARADES CHAIN', icon: '🔗', content: 'How to Play:\n\n• One player sees the word and acts it out\n• Each teammate watches the person before them\n• Pass the action down the line!\n• Last person guesses the word\n\nNo talking allowed! Use actions only.' },
      { title: 'Team Strategy', icon: '🎭', content: 'The Challenge:\n\n• The word gets distorted as it passes down\n• Each person adds their own interpretation\n• Communication through mime only\n• Hilarious misunderstandings guaranteed!\n\nStay focused and exaggerate your actions!' },
      { title: 'Ready to Play?', icon: '🏁', content: 'Game Setup:\n\n• Teams will be assigned automatically\n• First player sees the word\n• Timer starts when ready\n• First team to reach the target wins!\n\nLet\'s get started!' }
    ],
    heads_up: [
      { title: 'HEADS-UP', icon: '🎯', content: 'How to Play:\n\n• One teammate is the actor\n• All other teammates are guessers\n• Actor performs while guessers watch\n• Guessers type answers on their phones\n\nWork together to guess quickly!' },
      { title: 'Power in Numbers', icon: '👥', content: 'Team Dynamics:\n\n• Multiple guessers = faster answers\n• Work together to guess quickly\n• Vote to skip if word is too hard\n• 3 minutes per round\n\nThe more dramatic, the better!' },
      { title: 'Let\'s Begin!', icon: '🎬', content: 'Game Flow:\n\n• Teams take turns each round\n• Actor role rotates\n• Type guesses on your phone\n• First team to reach target wins!\n\nReady to guess?' }
    ],
    pictionary: [
      { title: 'PICTIONARY', icon: '🎨', content: 'How to Play:\n\n• One player draws on their phone\n• Drawing appears on the TV\n• Everyone else guesses\n• First 3 guessers get points: 3, 2, 1\n\nNo letters or numbers in your drawing!' },
      { title: 'Drawing Tips', icon: '🖌️', content: 'Master Artist Skills:\n\n• Use the color palette\n• Adjust brush size for details\n• Clear and redraw if needed\n• Hints revealed as time passes\n\nSimple shapes work best!' },
      { title: 'Start Drawing!', icon: '🏆', content: 'Competition Rules:\n\n• 60 seconds per round\n• Drawer earns +1 if guessed, -1 if not\n• Everyone gets a turn to draw\n• Speed and accuracy matter!\n\nLet the art battle begin!' }
    ],
    classic_team: [
      { title: 'CLASSIC TEAM', icon: '👥', content: 'How to Play:\n\n• One player acts for their team\n• Teammates try to guess\n• First correct guess scores a point\n• Teams take turns acting\n\nClassic charades rules apply!' },
      { title: 'Acting Guidelines', icon: '🎭', content: 'Charades Rules:\n\n• No talking or mouthing words\n• No pointing at objects in room\n• Use gestures and body language\n• Sound effects are NOT allowed\n\nPantomime perfection required!' },
      { title: 'Team Up!', icon: '🤝', content: 'Winning Strategy:\n\n• 90 seconds per round\n• Teams assigned randomly\n• Actor rotates each turn\n• First team to target wins!\n\nTime to show your skills!' }
    ],
    classic_individual: [
      { title: 'CLASSIC INDIVIDUAL', icon: '🏆', content: 'How to Play:\n\n• One player acts for everyone\n• All other players compete to guess\n• First 3 guessers get points: 3, 2, 1\n• Actor scores based on guesses\n\nEvery player for themselves!' },
      { title: 'Competitive Edge', icon: '⚡', content: 'Scoring System:\n\n• First 3 guessers get points: 3, 2, 1\n• Actor gets +1 if someone guesses\n• No correct guess? Actor loses 1 point!\n• Type fast to win\n\nSpeed typing is key!' },
      { title: 'Solo Challenge!', icon: '🎯', content: 'Race to Victory:\n\n• Timer per round\n• Highest points wins\n• Everyone acts in rotation\n• Act clearly to score!\n\nMay the best mime win!' }
    ]
  };

  function getIntroSlides() {
    if (gameState.selectedMode === 'classic') {
      return gameState.settings.classicMode === 'team' ? INTRO_SLIDES.classic_team : INTRO_SLIDES.classic_individual;
    }
    return INTRO_SLIDES[gameState.selectedMode] || INTRO_SLIDES.charade_lines;
  }

  // ============================================================================
  // TEAM MANAGEMENT
  // ============================================================================
  function createTeams() {
    const players = getSessionPlayers();
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const mid = Math.ceil(shuffled.length / 2);

    gameState.teams = [
      { id: 'team1', name: 'Team 1', playerKeys: shuffled.slice(0, mid).map(p => p.key), score: 0, actorIndex: 0, guesserIndex: 0, roundsPlayed: 0 },
      { id: 'team2', name: 'Team 2', playerKeys: shuffled.slice(mid).map(p => p.key), score: 0, actorIndex: 0, guesserIndex: 0, roundsPlayed: 0 }
    ];
  }

  function randomizeTeams() {
    const allPlayerKeys = gameState.teams.flatMap(t => t.playerKeys);
    const shuffled = [...allPlayerKeys].sort(() => Math.random() - 0.5);
    const mid = Math.ceil(shuffled.length / 2);

    gameState.teams[0].playerKeys = shuffled.slice(0, mid);
    gameState.teams[1].playerKeys = shuffled.slice(mid);
  }

  // ============================================================================
  // TIMER MANAGEMENT
  // ============================================================================
  function startTimer(seconds) {
    clearTimer();
    gameState.roundState.remainingSeconds = seconds;
    gameState.roundState.startTime = Date.now();

    gameState.roundState.timerInterval = setInterval(() => {
      gameState.roundState.remainingSeconds--;

      io.emit('timer_update', {
        remainingSeconds: gameState.roundState.remainingSeconds,
        totalSeconds: seconds
      });

      // Progressive hints for Pictionary and Classic Solo
      if (gameState.selectedMode === 'pictionary' && gameState.settings.pictionaryHintsEnabled) {
        checkAndRevealHint(seconds);
      } else if (gameState.selectedMode === 'classic' && gameState.settings.classicMode === 'individual' && gameState.settings.classicSoloHintsEnabled) {
        checkAndRevealHint(seconds);
      }

      if (gameState.roundState.remainingSeconds <= 0) {
        clearTimer();
        endRound(false);
      }
    }, 1000);
  }

  function clearTimer() {
    if (gameState.roundState.timerInterval) {
      clearInterval(gameState.roundState.timerInterval);
      gameState.roundState.timerInterval = null;
    }
    // Also clear prep interval if active
    if (gameState.roundState.prepInterval) {
      clearInterval(gameState.roundState.prepInterval);
      gameState.roundState.prepInterval = null;
    }
  }

  // ============================================================================
  // HINT SYSTEM (Pictionary)
  // ============================================================================
  function initHintString(word) {
    // NO letters revealed at start - all letters are underscores (except spaces)
    gameState.roundState.hintString = word.split('').map((c) => {
      if (c === ' ') return ' ';
      return '_';
    }).join(' ');
    gameState.roundState.hintsRevealed = 0;
  }

  function checkAndRevealHint(totalSeconds) {
    // Determine which mode's settings to use
    const isClassicSolo = gameState.selectedMode === 'classic' && gameState.settings.classicMode === 'individual';
    const hintsEnabled = isClassicSolo ? gameState.settings.classicSoloHintsEnabled : gameState.settings.pictionaryHintsEnabled;

    if (!hintsEnabled) return;

    const elapsed = totalSeconds - gameState.roundState.remainingSeconds;
    const halfTime = totalSeconds / 2;

    if (elapsed < halfTime) return;

    const timeSinceHalf = elapsed - halfTime;
    const interval = isClassicSolo ? gameState.settings.classicSoloHintInterval : gameState.settings.pictionaryHintInterval;
    const hintsToReveal = Math.floor(timeSinceHalf / interval) + 1;

    if (hintsToReveal > gameState.roundState.hintsRevealed) {
      revealMoreLetters(hintsToReveal);
    }
  }

  function revealMoreLetters(targetHints) {
    const word = gameState.currentWord.toUpperCase();
    const current = gameState.roundState.hintString.split(' ');

    // Count unrevealed positions (excluding spaces)
    const hiddenIndices = [];
    current.forEach((c, i) => {
      if (c === '_') hiddenIndices.push(i);
    });

    // Reveal some letters
    const toReveal = Math.min(targetHints - gameState.roundState.hintsRevealed, hiddenIndices.length);
    const shuffledHidden = hiddenIndices.sort(() => Math.random() - 0.5);

    for (let i = 0; i < toReveal; i++) {
      const idx = shuffledHidden[i];
      // Map hint index back to word index (accounting for spaces in hint string)
      const wordIdx = Math.floor(idx);
      if (wordIdx < word.length) {
        current[idx] = word[wordIdx];
      }
    }

    gameState.roundState.hintString = current.join(' ');
    gameState.roundState.hintsRevealed = targetHints;

    io.emit('hint_revealed', { hint: gameState.roundState.hintString });
  }

  // ============================================================================
  // GAME FLOW
  // ============================================================================
  function broadcastLobbyUpdate() {
    // Include ALL players (connected and offline) so offline players appear in list
    const players = getAllPlayers().map(p => ({
      key: p.key,
      name: p.name,
      connected: p.connected,
      joinedSession: p.joinedSession !== false,
      sessionPoints: p.sessionPoints || 0,
      lifetimeScores: getPlayerLifetimeScores(p.key)
    }));

    // Build leaderboard with CONSOLIDATED scores by name (case-insensitive)
    const consolidatedScores = getConsolidatedLifetimeScores();
    const leaderboardData = [];
    const seenNames = new Set();

    // Add current session players first (they have connection status)
    for (const p of players) {
      const normalizedName = p.name.toUpperCase();
      if (seenNames.has(normalizedName)) continue;
      seenNames.add(normalizedName);

      const consolidated = consolidatedScores[normalizedName];
      leaderboardData.push({
        key: p.key,
        name: p.name,
        connected: p.connected,
        joinedSession: true,
        scores: consolidated ? consolidated.scores : p.lifetimeScores
      });
    }

    // Add historical players not in current session (by name)
    for (const [normalizedName, data] of Object.entries(consolidatedScores)) {
      if (!seenNames.has(normalizedName)) {
        seenNames.add(normalizedName);
        leaderboardData.push({
          key: data.keys[0],
          name: data.name,
          connected: false,
          joinedSession: false,
          scores: data.scores
        });
      }
    }

    io.emit('lobby_update', {
      phase: gameState.phase,
      players,
      leaderboard: leaderboardData,
      selectedMode: gameState.selectedMode,
      settings: gameState.settings,
      teams: gameState.teams,
      availableCategories: Object.keys(gameState.allWords)
    });
  }

  function startGame(mode, categories, settings) {
    gameState.selectedMode = mode;
    gameState.settings = { ...gameState.settings, ...settings };
    gameState.settings.selectedCategories = categories;
    gameState.currentRound = 0;
    gameState.currentTeamIndex = 0;
    gameState.usedWords.clear();

    // Reset player session points
    for (const player of playersByKey.values()) {
      player.sessionPoints = 0;
    }

    buildWordPool();

    // For pictionary: set total rounds = player count, shuffle drawer order
    if (mode === 'pictionary') {
      const players = getSessionPlayers();
      gameState.pictionaryTotalRounds = players.length;
      gameState.pictionaryDrawerOrder = players
        .map(p => p.key)
        .sort(() => Math.random() - 0.5);
    }

    // For classic solo: set total rounds = player count, shuffle actor order
    if (mode === 'classic' && settings.classicMode === 'individual') {
      const players = getSessionPlayers();
      gameState.classicSoloTotalRounds = players.length;
      gameState.classicSoloActorOrder = players
        .map(p => p.key)
        .sort(() => Math.random() - 0.5);
    }

    // Start intro phase
    gameState.phase = PHASES.INTRO;
    gameState.introSlideIndex = 0;

    io.emit('introPhase', {
      slides: getIntroSlides(),
      currentSlide: 0,
      mode: gameState.selectedMode
    });
  }

  function skipIntro() {
    proceedAfterIntro();
  }

  function proceedAfterIntro() {
    const mode = gameState.selectedMode;

    // Team modes need team setup
    if (mode === 'charade_lines' || mode === 'heads_up' || (mode === 'classic' && gameState.settings.classicMode === 'team')) {
      createTeams();
      gameState.phase = PHASES.TEAM_SETUP;
      io.emit('team_setup_phase', {
        teams: gameState.teams.map(t => ({
          ...t,
          players: t.playerKeys.map(k => getPlayerByKey(k)).filter(Boolean)
        }))
      });
    } else {
      // Individual modes go straight to gameplay
      startNextRound();
    }
  }

  function confirmTeams() {
    startNextRound();
  }

  function startNextRound() {
    gameState.currentRound++;
    gameState.phase = PHASES.GAMEPLAY;
    gameState.currentWord = getNextWord();

    // Check if we ran out of words
    if (gameState.currentWord === null) {
      endGameWordsExhausted();
      return;
    }

    // Reset round state
    gameState.roundState = {
      ...gameState.roundState,
      startTime: Date.now(),
      guesses: [],
      correctGuessers: [],
      drawingData: [],
      strokeHistory: [],
      redoStack: [],
      skipVotes: new Set(),
      hintsRevealed: 0,
      hintString: '',
      someoneGuessed: false
    };

    // Setup based on mode
    switch (gameState.selectedMode) {
      case 'charade_lines':
        setupCharadeLinesRound();
        break;
      case 'heads_up':
        setupHeadsUpRound();
        break;
      case 'pictionary':
        setupPictionaryRound();
        break;
      case 'classic':
        if (gameState.settings.classicMode === 'team') {
          setupClassicTeamRound();
        } else {
          setupClassicIndividualRound();
        }
        break;
    }
  }

  // ============================================================================
  // CHARADES CHAIN MODE
  // ============================================================================
  function setupCharadeLinesRound() {
    const team = gameState.teams[gameState.currentTeamIndex];
    const playerKeys = team.playerKeys;

    // Track how many rounds this team has played (for rotation)
    const teamRound = team.roundsPlayed;
    team.roundsPlayed++;

    // Rotate players in line based on THIS TEAM's round count
    // This ensures each player cycles through all positions (starter → middle → finisher)
    // With 4 players: Round 0: [A,B,C,D], Round 1: [B,C,D,A], Round 2: [C,D,A,B], etc.
    const lineOrder = [...playerKeys];
    const rotations = teamRound % lineOrder.length;
    for (let i = 0; i < rotations; i++) {
      lineOrder.push(lineOrder.shift());
    }

    gameState.roundState.lineOrder = lineOrder;
    gameState.roundState.starterKey = lineOrder[0];
    gameState.roundState.finisherKey = lineOrder[lineOrder.length - 1];

    const timer = gameState.settings.charadeLinesTimer;
    const prepTime = gameState.settings.charadeLinesPrep || 0;

    // If no prep time, skip straight to gameplay
    if (prepTime <= 0) {
      startCharadeLinesGameplay(lineOrder, team, timer);
      return;
    }

    // Send prep phase data (no word revealed yet)
    for (const player of getSessionPlayers()) {
      const socket = io.sockets ? io.sockets.get(player.socketId) : null;
      if (!socket) continue;

      const isOnTeam = lineOrder.includes(player.key);
      const position = lineOrder.indexOf(player.key);

      let role = 'watcher';
      if (isOnTeam) {
        if (position === 0) {
          role = 'starter';
        } else if (position === lineOrder.length - 1) {
          role = 'finisher';
        } else {
          role = 'middle';
        }
      }

      socket.emit('prep_phase_started', {
        round: gameState.currentRound,
        mode: 'charade_lines',
        role,
        prepTime,
        teamName: team.name,
        lineOrder: lineOrder.map(k => getPlayerByKey(k)?.name || 'Unknown'),
        position: position >= 0 ? position + 1 : null,
        totalInLine: lineOrder.length
      });
    }

    // Send prep phase to host
    if (hostSocketId) {
      const hostSocket = io.sockets ? io.sockets.get(hostSocketId) : null;
      if (hostSocket) {
        hostSocket.emit('prep_phase_started_host', {
          round: gameState.currentRound,
          mode: 'charade_lines',
          prepTime,
          teamName: team.name,
          lineOrder: lineOrder.map(k => getPlayerByKey(k)?.name || 'Unknown'),
          scores: gameState.teams.map(t => ({
            name: t.name,
            score: t.score,
            players: t.playerKeys.map(k => getPlayerByKey(k)?.name || 'Unknown')
          }))
        });
      }
    }

    // Start prep countdown
    gameState.roundState.prepTimeRemaining = prepTime;
    gameState.roundState.prepInterval = setInterval(() => {
      gameState.roundState.prepTimeRemaining--;

      io.emit('prep_timer_update', {
        remainingSeconds: gameState.roundState.prepTimeRemaining
      });

      if (gameState.roundState.prepTimeRemaining <= 0) {
        clearInterval(gameState.roundState.prepInterval);
        gameState.roundState.prepInterval = null;
        startCharadeLinesGameplay(lineOrder, team, timer);
      }
    }, 1000);
  }

  // Start the actual charades chain gameplay after prep phase
  function startCharadeLinesGameplay(lineOrder, team, timer) {
    // Send role info and word to players
    for (const player of getSessionPlayers()) {
      const socket = io.sockets ? io.sockets.get(player.socketId) : null;
      if (!socket) continue;

      const isOnTeam = lineOrder.includes(player.key);
      const position = lineOrder.indexOf(player.key);

      let role = 'watcher';
      let canSeeWord = false;
      let canGuess = false;

      if (isOnTeam) {
        if (position === 0) {
          role = 'starter';
          canSeeWord = true;
        } else if (position === lineOrder.length - 1) {
          role = 'finisher';
          canGuess = true;
        } else {
          role = 'middle';
        }
      }

      socket.emit('round_started', {
        round: gameState.currentRound,
        mode: 'charade_lines',
        role,
        word: canSeeWord ? gameState.currentWord : null,
        canGuess,
        timer,
        teamName: team.name,
        lineOrder: lineOrder.map(k => getPlayerByKey(k)?.name || 'Unknown'),
        position: position >= 0 ? position + 1 : null,
        totalInLine: lineOrder.length
      });
    }

    // Send to host
    if (hostSocketId) {
      const hostSocket = io.sockets ? io.sockets.get(hostSocketId) : null;
      if (hostSocket) {
        hostSocket.emit('round_started_host', {
          round: gameState.currentRound,
          mode: 'charade_lines',
          word: gameState.currentWord,
          timer,
          teamName: team.name,
          lineOrder: lineOrder.map(k => getPlayerByKey(k)?.name || 'Unknown'),
          scores: gameState.teams.map(t => ({
            name: t.name,
            score: t.score,
            players: t.playerKeys.map(k => getPlayerByKey(k)?.name || 'Unknown')
          }))
        });
      }
    }

    startTimer(timer);
  }

  // ============================================================================
  // HEADS-UP MODE
  // ============================================================================
  function setupHeadsUpRound() {
    const team = gameState.teams[gameState.currentTeamIndex];
    const playerKeys = team.playerKeys;

    // Initialize heads-up tracking only on the very first round of the game
    if (gameState.currentRound === 1) {
      gameState.headsUpTeamsPlayed = 0;
      gameState.headsUpTeamScores = [];
      gameState.headsUpCurrentRoundInSet = 1;
      gameState.headsUpTotalRoundsPerTeam = playerKeys.length; // Each player gets to be actor once
      gameState.headsUpActorHistory = { team1: [], team2: [] };
      // Reset all team scores to 0 at game start
      for (const t of gameState.teams) {
        t.score = 0;
      }
      // Initialize game log ONLY at the very start of the game (not when team 2 starts)
      gameState.roundState.gameLog = { team1: [], team2: [] };
    }

    // Select actor - ensure each player gets one turn as actor
    const teamId = team.id;
    const usedActors = gameState.headsUpActorHistory[teamId] || [];
    const availableActors = playerKeys.filter(k => !usedActors.includes(k));

    let actorKey;
    if (availableActors.length > 0) {
      // Pick the next available actor who hasn't been actor yet
      actorKey = availableActors[0];
    } else {
      // Fallback: all players have been actor (shouldn't happen with proper round counting)
      actorKey = playerKeys[0];
    }

    // Record this player as having been actor
    if (!gameState.headsUpActorHistory[teamId]) {
      gameState.headsUpActorHistory[teamId] = [];
    }
    gameState.headsUpActorHistory[teamId].push(actorKey);

    // All other team members are guessers
    const guesserKeys = playerKeys.filter(k => k !== actorKey);

    gameState.roundState.actorKey = actorKey;
    gameState.roundState.guesserKeys = guesserKeys;
    gameState.roundState.skipVotes = new Set();
    gameState.roundState.lastGuessedWord = null;  // Reset for new round

    const timer = gameState.settings.headsUpTimer;

    // Send role info to each player
    for (const player of getSessionPlayers()) {
      const socket = io.sockets ? io.sockets.get(player.socketId) : null;
      if (!socket) continue;

      const isActor = player.key === actorKey;
      const isGuesser = guesserKeys.includes(player.key);

      let role = 'watcher';
      if (isActor) role = 'actor';
      else if (isGuesser) role = 'guesser';

      // Determine if player is on this team
      const isOnTeam = team.playerKeys.includes(player.key);
      socket.emit('round_started', {
        round: gameState.currentRound,
        mode: 'heads_up',
        role,
        word: isActor ? gameState.currentWord : null,
        canGuess: isGuesser,
        canSkipVote: isGuesser && gameState.settings.headsUpAllowSkip,
        timer,
        teamName: team.name,
        teamId: isOnTeam ? team.id : null,  // Send team ID for game log filtering
        actorName: getPlayerByKey(actorKey)?.name,
        guesserCount: guesserKeys.length
      });
    }

    // Send to host (hide word - only actor should know the word)
    if (hostSocketId) {
      const hostSocket = io.sockets ? io.sockets.get(hostSocketId) : null;
      if (hostSocket) {
        hostSocket.emit('round_started_host', {
          round: gameState.currentRound,
          mode: 'heads_up',
          word: null, // Hide word from host in heads-up
          timer,
          teamName: team.name,
          actorName: getPlayerByKey(actorKey)?.name,
          guesserNames: guesserKeys.map(k => getPlayerByKey(k)?.name || 'Unknown'),
          scores: gameState.teams.map(t => ({ name: t.name, score: t.score }))
        });
      }
    }

    startTimer(timer);
  }

  // ============================================================================
  // PICTIONARY MODE
  // ============================================================================
  function setupPictionaryRound() {
    // Use pre-shuffled drawer order (everyone draws exactly once)
    const drawerIndex = gameState.currentRound - 1;
    const drawerKey = gameState.pictionaryDrawerOrder[drawerIndex];
    const drawer = getPlayerByKey(drawerKey);

    // Handle missing drawer
    if (!drawer) {
      if (gameState.currentRound >= gameState.pictionaryTotalRounds) {
        endGame(getPictionaryWinnerByPoints());
        return;
      }
      startNextRound();
      return;
    }

    // Handle disconnected drawer — wait for host to skip or player to reconnect
    if (!drawer.connected) {
      gameState.waitingForOfflinePlayer = drawerKey;
      if (hostSocketId) {
        const hostSock = io.sockets ? io.sockets.get(hostSocketId) : null;
        if (hostSock) {
          hostSock.emit('waiting_for_offline_player', {
            playerKey: drawerKey,
            playerName: drawer.name,
            message: `${drawer.name} is offline. Waiting for reconnection...`
          });
        }
      }
      broadcastLobbyUpdate();
      return;
    }
    gameState.waitingForOfflinePlayer = null;

    gameState.roundState.actorKey = drawer.key;
    gameState.roundState.correctGuessers = [];
    gameState.roundState.strokeHistory = [];
    gameState.roundState.redoStack = [];

    initHintString(gameState.currentWord);

    const timer = gameState.settings.pictionaryTimer;

    // Send role info to each player
    for (const player of getSessionPlayers()) {
      const socket = io.sockets ? io.sockets.get(player.socketId) : null;
      if (!socket) continue;

      const isDrawer = player.key === drawer.key;

      socket.emit('round_started', {
        round: gameState.currentRound,
        mode: 'pictionary',
        role: isDrawer ? 'drawer' : 'guesser',
        word: isDrawer ? gameState.currentWord : null,
        canGuess: !isDrawer,
        canDraw: isDrawer,
        timer,
        drawerName: drawer.name,
        hint: gameState.roundState.hintString
      });
    }

    // Send to host (hide word in pictionary - host should not see answer)
    if (hostSocketId) {
      const hostSocket = io.sockets ? io.sockets.get(hostSocketId) : null;
      if (hostSocket) {
        hostSocket.emit('round_started_host', {
          round: gameState.currentRound,
          mode: 'pictionary',
          word: null, // Hide word from host in pictionary
          timer,
          drawerName: drawer.name,
          hint: gameState.roundState.hintString,
          scores: getSessionPlayers().map(p => ({ name: p.name, points: p.sessionPoints || 0, connected: p.connected }))
        });
      }
    }

    startTimer(timer);
  }

  // ============================================================================
  // CLASSIC MODE
  // ============================================================================
  function setupClassicTeamRound() {
    const team = gameState.teams[gameState.currentTeamIndex];
    const playerKeys = team.playerKeys;

    // Rotate actor
    const actorIndex = team.actorIndex % playerKeys.length;
    const actorKey = playerKeys[actorIndex];
    team.actorIndex++;

    gameState.roundState.actorKey = actorKey;

    const timer = gameState.settings.classicTimer;

    // Send role info to each player
    for (const player of getSessionPlayers()) {
      const socket = io.sockets ? io.sockets.get(player.socketId) : null;
      if (!socket) continue;

      const isActor = player.key === actorKey;
      const isOnTeam = playerKeys.includes(player.key);

      let role = 'watcher';
      let canGuess = false;

      if (isActor) {
        role = 'actor';
      } else if (isOnTeam) {
        role = 'guesser';
        canGuess = true;
      }

      socket.emit('round_started', {
        round: gameState.currentRound,
        mode: 'classic',
        variant: 'team',
        role,
        word: isActor ? gameState.currentWord : null,
        canGuess,
        timer,
        teamName: team.name,
        actorName: getPlayerByKey(actorKey)?.name
      });
    }

    // Send to host
    if (hostSocketId) {
      const hostSocket = io.sockets ? io.sockets.get(hostSocketId) : null;
      if (hostSocket) {
        hostSocket.emit('round_started_host', {
          round: gameState.currentRound,
          mode: 'classic',
          variant: 'team',
          word: gameState.currentWord,
          timer,
          teamName: team.name,
          actorName: getPlayerByKey(actorKey)?.name,
          scores: gameState.teams.map(t => ({ name: t.name, score: t.score }))
        });
      }
    }

    startTimer(timer);
  }

  function setupClassicIndividualRound() {
    // Use pre-shuffled actor order (everyone acts exactly once)
    const actorIndex = gameState.currentRound - 1;
    const actorKey = gameState.classicSoloActorOrder[actorIndex];
    const actor = getPlayerByKey(actorKey);

    // Handle missing actor
    if (!actor) {
      if (gameState.currentRound >= gameState.classicSoloTotalRounds) {
        endGame(getClassicSoloWinnerByPoints());
        return;
      }
      gameState.currentRound++;
      startNextRound();
      return;
    }

    // Handle disconnected actor — wait for host to skip or player to reconnect
    if (!actor.connected) {
      gameState.waitingForOfflinePlayer = actorKey;
      if (hostSocketId) {
        const hostSock = io.sockets ? io.sockets.get(hostSocketId) : null;
        if (hostSock) {
          hostSock.emit('waiting_for_offline_player', {
            playerKey: actorKey,
            playerName: actor.name,
            message: `${actor.name} is offline. Waiting for reconnection...`
          });
        }
      }
      broadcastLobbyUpdate();
      return;
    }
    gameState.waitingForOfflinePlayer = null;

    gameState.roundState.actorKey = actor.key;
    gameState.roundState.correctGuessers = []; // Track correct guessers for ranked scoring

    // Initialize hints for Classic Solo (like Pictionary)
    initHintString(gameState.currentWord);

    const timer = gameState.settings.classicTimer;

    // Send role info to each player
    for (const player of getSessionPlayers()) {
      const socket = io.sockets ? io.sockets.get(player.socketId) : null;
      if (!socket) continue;

      const isActor = player.key === actor.key;

      socket.emit('round_started', {
        round: gameState.currentRound,
        mode: 'classic',
        variant: 'individual',
        role: isActor ? 'actor' : 'guesser',
        word: isActor ? gameState.currentWord : null,
        canGuess: !isActor,
        timer,
        actorName: actor.name,
        hint: gameState.roundState.hintString  // Send hint to guessers
      });
    }

    // Send to host (hide word - everyone can see the host screen)
    if (hostSocketId) {
      const hostSocket = io.sockets ? io.sockets.get(hostSocketId) : null;
      if (hostSocket) {
        hostSocket.emit('round_started_host', {
          round: gameState.currentRound,
          mode: 'classic',
          variant: 'individual',
          word: null,  // Hide word from host screen
          timer,
          actorName: actor.name,
          hint: gameState.roundState.hintString,  // Show hint instead
          scores: getSessionPlayers().map(p => ({ name: p.name, points: p.sessionPoints || 0, connected: p.connected }))
        });
      }
    }

    startTimer(timer);
  }

  // ============================================================================
  // GUESS HANDLING
  // ============================================================================
  function handleGuess(playerKey, guess) {
    const player = getPlayerByKey(playerKey);
    if (!player) return { correct: false };

    const normalizedGuess = guess.trim().toLowerCase();
    const normalizedWord = gameState.currentWord.toLowerCase();
    const correct = normalizedGuess === normalizedWord;

    // Save the word before handleCorrectGuess potentially changes it (heads-up mode)
    const guessedWord = gameState.currentWord;

    gameState.roundState.guesses.push({
      playerKey,
      playerName: player.name,
      guess,
      correct,
      timestamp: Date.now()
    });

    if (correct) {
      handleCorrectGuess(playerKey, player);
    }

    return { correct, word: correct ? guessedWord : null };
  }

  function handleCorrectGuess(playerKey, player) {
    const mode = gameState.selectedMode;

    switch (mode) {
      case 'charade_lines':
        // Only finisher can guess - team gets a point
        if (playerKey === gameState.roundState.finisherKey) {
          const team = gameState.teams[gameState.currentTeamIndex];
          team.score++;
          io.emit('guess_submitted', {
            playerName: player.name,
            correct: true,
            word: gameState.currentWord,
            teamName: team.name,
            newScore: team.score
          });
          endRound(true);
        }
        break;

      case 'heads_up':
        // Team gets a point, move to next word
        if (gameState.roundState.guesserKeys.includes(playerKey)) {
          // Save the correctly guessed word before moving to next
          gameState.roundState.lastGuessedWord = gameState.currentWord;

          const team = gameState.teams[gameState.currentTeamIndex];
          team.score++;

          // Track correct guess in game log
          const teamId = team.id;
          if (!gameState.roundState.gameLog) gameState.roundState.gameLog = {};
          if (!gameState.roundState.gameLog[teamId]) gameState.roundState.gameLog[teamId] = [];
          gameState.roundState.gameLog[teamId].push({ word: gameState.currentWord, type: 'correct' });
          io.emit('game_log_update', { teamId, entry: { word: gameState.currentWord, type: 'correct' } });

          io.emit('guess_submitted', {
            playerName: player.name,
            correct: true,
            word: gameState.currentWord,
            teamName: team.name,
            newScore: team.score
          });
          // Get next word (don't end round)
          nextWordHeadsUp();
        }
        break;

      case 'pictionary':
        // First 3 correct guessers get points
        if (!gameState.roundState.correctGuessers.includes(playerKey)) {
          const position = gameState.roundState.correctGuessers.length;
          if (position < 3) {
            const points = gameState.settings.pictionaryPoints[position];
            player.sessionPoints = (player.sessionPoints || 0) + points;
            gameState.roundState.correctGuessers.push(playerKey);

            // Notify everyone about the correct guess
            io.emit('guess_submitted', {
              playerName: player.name,
              correct: true,
              position: position + 1,
              points,
              word: position === 0 ? null : undefined // Only reveal word on 3rd guess
            });

            // Send personal message to correct guesser to disable their input
            const playerSocket = io.sockets ? io.sockets.get(player.socketId) : null;
            if (playerSocket) {
              playerSocket.emit('you_guessed_correctly', {
                position: position + 1,
                points
              });
            }

            // End round after 3 correct guesses
            if (gameState.roundState.correctGuessers.length >= 3) {
              endRound(true);
            }
          }
        }
        break;

      case 'classic':
        if (gameState.settings.classicMode === 'team') {
          // Team mode - team gets point
          const team = gameState.teams[gameState.currentTeamIndex];
          team.score++;
          io.emit('guess_submitted', {
            playerName: player.name,
            correct: true,
            word: gameState.currentWord,
            teamName: team.name,
            newScore: team.score
          });
          endRound(true);
        } else {
          // Individual mode - ranked scoring like pictionary (3/2/1 points)
          if (!gameState.roundState.correctGuessers.includes(playerKey)) {
            const position = gameState.roundState.correctGuessers.length;
            if (position < 3) {
              const points = [3, 2, 1][position];
              player.sessionPoints = (player.sessionPoints || 0) + points;
              gameState.roundState.correctGuessers.push(playerKey);

              // Notify everyone about the correct guess
              io.emit('guess_submitted', {
                playerName: player.name,
                correct: true,
                position: position + 1,
                points,
                word: position === 0 ? null : undefined
              });

              // Send personal message to disable input
              const playerSocket = io.sockets ? io.sockets.get(player.socketId) : null;
              if (playerSocket) {
                playerSocket.emit('you_guessed_correctly', {
                  position: position + 1,
                  points
                });
              }

              // End round after 3 correct guesses
              if (gameState.roundState.correctGuessers.length >= 3) {
                endRound(true);
              }
            }
          }
        }
        break;
    }
  }

  function nextWordHeadsUp() {
    gameState.currentWord = getNextWord();
    gameState.roundState.skipVotes = new Set();

    // Check if words ran out
    if (gameState.currentWord === null) {
      // End the round and trigger game end check
      endRound(false);
      return;
    }

    // Notify actor of new word (single actor in heads-up mode)
    const actor = getPlayerByKey(gameState.roundState.actorKey);
    if (actor) {
      const socket = io.sockets ? io.sockets.get(actor.socketId) : null;
      if (socket) {
        socket.emit('new_word', { word: gameState.currentWord });
      }
    }

    // Notify host with the correctly guessed word (not the next word)
    // This prevents showing upcoming words on the TV screen
    if (hostSocketId) {
      const hostSocket = io.sockets ? io.sockets.get(hostSocketId) : null;
      if (hostSocket) {
        hostSocket.emit('correct_guess_display', { word: gameState.roundState.lastGuessedWord });
      }
    }

    // Notify guessers that word changed (without revealing the word)
    // This allows the guessers to skip again
    for (const guesserKey of gameState.roundState.guesserKeys) {
      const guesser = getPlayerByKey(guesserKey);
      if (guesser) {
        const guesserSocket = io.sockets ? io.sockets.get(guesser.socketId) : null;
        if (guesserSocket) {
          guesserSocket.emit('word_changed', {
            message: 'New word ready!'
          });
        }
      }
    }
  }

  // ============================================================================
  // SKIP VOTING (Heads-Up)
  // ============================================================================
  function handleSkipVote(playerKey) {
    if (gameState.selectedMode !== 'heads_up') return;
    if (!gameState.roundState.guesserKeys.includes(playerKey)) return;

    gameState.roundState.skipVotes.add(playerKey);

    const votesNeeded = Math.ceil(gameState.roundState.guesserKeys.length / 2);
    const currentVotes = gameState.roundState.skipVotes.size;

    io.emit('skip_vote_update', {
      votes: currentVotes,
      needed: votesNeeded,
      voterName: getPlayerByKey(playerKey)?.name
    });

    if (currentVotes >= votesNeeded) {
      // Track skipped word in game log
      const team = gameState.teams[gameState.currentTeamIndex];
      const teamId = team.id;
      if (!gameState.roundState.gameLog) gameState.roundState.gameLog = {};
      if (!gameState.roundState.gameLog[teamId]) gameState.roundState.gameLog[teamId] = [];
      gameState.roundState.gameLog[teamId].push({ word: gameState.currentWord, type: 'skipped' });
      io.emit('game_log_update', { teamId, entry: { word: gameState.currentWord, type: 'skipped' } });

      io.emit('word_skipped', { word: gameState.currentWord });
      nextWordHeadsUp();
    }
  }

  // Guesser can skip directly in Heads-Up (no voting needed)
  function handleGuesserSkip(playerKey) {
    if (gameState.selectedMode !== 'heads_up') return;
    if (!gameState.roundState.guesserKeys.includes(playerKey)) return;

    const guesser = getPlayerByKey(playerKey);

    // Track skipped word in game log
    const team = gameState.teams[gameState.currentTeamIndex];
    const teamId = team.id;
    if (!gameState.roundState.gameLog) gameState.roundState.gameLog = {};
    if (!gameState.roundState.gameLog[teamId]) gameState.roundState.gameLog[teamId] = [];
    gameState.roundState.gameLog[teamId].push({ word: gameState.currentWord, type: 'skipped' });
    io.emit('game_log_update', { teamId, entry: { word: gameState.currentWord, type: 'skipped' } });

    io.emit('word_skipped', {
      word: gameState.currentWord,
      skippedBy: 'guesser',
      guesserName: guesser?.name || 'Guesser'
    });
    nextWordHeadsUp();
  }

  // Forfeit round (Classic modes, Pictionary) - actor gives up
  function handleForfeit(playerKey) {
    const mode = gameState.selectedMode;

    // Only actor can forfeit
    if (playerKey !== gameState.roundState.actorKey) return;

    // Only allowed in classic and pictionary modes
    if (mode !== 'classic' && mode !== 'pictionary') return;

    // Apply penalty to actor
    const actor = getPlayerByKey(playerKey);
    if (actor) {
      actor.sessionPoints = Math.max(0, (actor.sessionPoints || 0) - 1);
    }

    io.emit('round_forfeited', {
      actorName: actor?.name,
      word: gameState.currentWord
    });

    endRound(false);
  }

  // ============================================================================
  // DRAWING (Pictionary)
  // ============================================================================

  // Helper to broadcast drawing events to host and all non-drawer players
  function broadcastDrawingEvent(eventName, data, excludeDrawer = true) {
    // Send to host
    if (hostSocketId) {
      const hostSocket = io.sockets ? io.sockets.get(hostSocketId) : null;
      if (hostSocket) {
        hostSocket.emit(eventName, data);
      }
    }

    // Send to all players except the drawer
    for (const player of getSessionPlayers()) {
      if (excludeDrawer && player.key === gameState.roundState.actorKey) continue;
      const socket = io.sockets ? io.sockets.get(player.socketId) : null;
      if (socket) {
        socket.emit(eventName, data);
      }
    }
  }

  function handleDrawPoint(playerKey, point) {
    if (gameState.selectedMode !== 'pictionary') return;
    if (playerKey !== gameState.roundState.actorKey) return;

    broadcastDrawingEvent('drawing_point', point);
  }

  function handleDrawPoints(playerKey, points) {
    if (gameState.selectedMode !== 'pictionary') return;
    if (playerKey !== gameState.roundState.actorKey) return;
    if (!Array.isArray(points) || points.length === 0) return;

    broadcastDrawingEvent('drawing_points', points);
  }

  function handleStrokeComplete(playerKey, stroke) {
    if (gameState.selectedMode !== 'pictionary') return;
    if (playerKey !== gameState.roundState.actorKey) return;

    gameState.roundState.strokeHistory.push(stroke);
    gameState.roundState.redoStack = [];

    broadcastDrawingEvent('stroke_complete', stroke);
  }

  function handleClearCanvas(playerKey) {
    if (gameState.selectedMode !== 'pictionary') return;
    if (playerKey !== gameState.roundState.actorKey) return;

    gameState.roundState.strokeHistory = [];
    gameState.roundState.redoStack = [];

    broadcastDrawingEvent('canvas_cleared', {});
  }

  function handleUndo(playerKey) {
    if (gameState.selectedMode !== 'pictionary') return;
    if (playerKey !== gameState.roundState.actorKey) return;

    if (gameState.roundState.strokeHistory.length > 0) {
      const stroke = gameState.roundState.strokeHistory.pop();
      gameState.roundState.redoStack.push(stroke);

      broadcastDrawingEvent('drawing_undo', {});
    }
  }

  function handleRedo(playerKey) {
    if (gameState.selectedMode !== 'pictionary') return;
    if (playerKey !== gameState.roundState.actorKey) return;

    if (gameState.roundState.redoStack.length > 0) {
      const stroke = gameState.roundState.redoStack.pop();
      gameState.roundState.strokeHistory.push(stroke);

      broadcastDrawingEvent('drawing_redo', stroke);
    }
  }

  // ============================================================================
  // ROUND END
  // ============================================================================
  function endRound(success) {
    clearTimer();

    const mode = gameState.selectedMode;

    // Heads-up mode: track team completion and switch teams
    if (mode === 'heads_up') {
      const currentTeam = gameState.teams[gameState.currentTeamIndex];
      const playersPerTeam = currentTeam.playerKeys.length;
      const currentRoundInSet = gameState.headsUpCurrentRoundInSet || 1;

      // Check if current team has more rounds (not all players have been guesser yet)
      if (currentRoundInSet < playersPerTeam) {
        // More rounds for current team - continue with next guesser
        gameState.headsUpCurrentRoundInSet++;

        // Show brief round transition
        io.emit('heads_up_round_complete', {
          roundInSet: currentRoundInSet,
          totalRounds: playersPerTeam,
          teamScore: currentTeam.score,
          teamName: currentTeam.name
        });

        // Start next round after brief delay
        const timer = setTimeout(() => {
          startNextRound();
        }, 3000); // 3 second pause between rounds
        activeTimers.push(timer);
        return;
      }

      // Team's set of rounds complete (all players have been guesser)
      gameState.headsUpTeamScores[gameState.currentTeamIndex] = currentTeam.score;
      gameState.headsUpTeamsPlayed++;

      // Check if all teams have played all their rounds
      if (gameState.headsUpTeamsPlayed >= gameState.teams.length) {
        // All teams have played - end the game
        endHeadsUpGame();
        return;
      }

      // More teams need to play - switch to next team
      gameState.phase = PHASES.ROUND_RESULT;
      const nextTeamIndex = (gameState.currentTeamIndex + 1) % gameState.teams.length;
      const nextTeam = gameState.teams[nextTeamIndex];

      // Emit team complete event with transition info
      io.emit('heads_up_team_complete', {
        teamComplete: currentTeam.name,
        teamScore: currentTeam.score,
        nextTeam: nextTeam.name,
        gameLog: gameState.roundState.gameLog || {},
        roundsPlayed: playersPerTeam,
        scores: gameState.teams.map(t => ({
          name: t.name,
          score: t.score,
          hasPlayed: gameState.headsUpTeamScores[gameState.teams.indexOf(t)] !== undefined,
          players: t.playerKeys.map(k => getPlayerByKey(k)?.name || 'Unknown')
        }))
      });

      // After delay, start next team's turn
      const timer = setTimeout(() => {
        if (gameState.phase === PHASES.ROUND_RESULT) {
          // Switch to next team
          gameState.currentTeamIndex = nextTeamIndex;

          // Reset the next team's score to 0 for their turn (fair start)
          gameState.teams[nextTeamIndex].score = 0;

          // Reset used words so next team gets same word pool
          gameState.usedWords.clear();

          // Reset round counter for new team
          gameState.headsUpCurrentRoundInSet = 1;

          // Reset actor history for new team
          gameState.headsUpActorHistory[nextTeam.id] = [];

          // Start new round for next team
          startNextRound();
        }
      }, 5000); // 5 second transition
      activeTimers.push(timer);
      return;
    }

    // Handle individual mode actor points - +1 if someone guessed, -1 if no one did
    if (mode === 'classic' && gameState.settings.classicMode === 'individual') {
      const actor = getPlayerByKey(gameState.roundState.actorKey);
      if (actor) {
        if (gameState.roundState.correctGuessers.length > 0) {
          actor.sessionPoints = (actor.sessionPoints || 0) + 1;
        } else if (gameState.settings.classicPenalty) {
          actor.sessionPoints = Math.max(0, (actor.sessionPoints || 0) - 1);
        }
      }
    }

    // Pictionary: Drawer gets +1 if someone guessed, -1 if no one guessed
    if (mode === 'pictionary') {
      const drawer = getPlayerByKey(gameState.roundState.actorKey);
      if (drawer) {
        if (gameState.roundState.correctGuessers.length > 0) {
          drawer.sessionPoints = (drawer.sessionPoints || 0) + 1;
        } else {
          drawer.sessionPoints = Math.max(0, (drawer.sessionPoints || 0) - 1);
        }
      }
    }

    // Check win condition
    const winner = checkWinCondition();

    if (winner) {
      endGame(winner);
      return;
    }

    // Handle catch-up phase failure (charade_lines mode)
    if (mode === 'charade_lines' && gameState.catchUpPhase) {
      // Check if catch-up team just played and failed to score
      if (gameState.currentTeamIndex === gameState.catchUpTeamIndex && !success) {
        // Catch-up team failed to tie - leading team wins
        const leadingTeam = gameState.teams[gameState.leadingTeamIndex];
        console.log(`[Charades] Catch-up failed: ${leadingTeam.name} wins`);
        gameState.catchUpPhase = false;
        endGame({ type: 'team', name: leadingTeam.name, score: leadingTeam.score });
        return;
      }
    }

    // Handle tie-breaker failure (charade_lines mode)
    if (mode === 'charade_lines' && gameState.tieBreakerActive) {
      // In tie-breaker, if current team didn't score, they lose
      if (!success) {
        const winningTeamIndex = (gameState.currentTeamIndex + 1) % gameState.teams.length;
        const winningTeam = gameState.teams[winningTeamIndex];
        console.log(`[Charades] Tie-breaker: ${winningTeam.name} wins`);
        gameState.tieBreakerActive = false;
        endGame({ type: 'team', name: winningTeam.name, score: winningTeam.score, tieBreakerWin: true });
        return;
      }
    }

    // Handle catch-up phase failure (classic team mode)
    if (mode === 'classic' && gameState.settings.classicMode === 'team' && gameState.catchUpPhase) {
      if (gameState.currentTeamIndex === gameState.catchUpTeamIndex && !success) {
        const leadingTeam = gameState.teams[gameState.leadingTeamIndex];
        console.log(`[Charades] Classic: Catch-up failed - ${leadingTeam.name} wins`);
        gameState.catchUpPhase = false;
        endGame({ type: 'team', name: leadingTeam.name, score: leadingTeam.score });
        return;
      }
    }

    // Handle tie-breaker failure (classic team mode)
    if (mode === 'classic' && gameState.settings.classicMode === 'team' && gameState.tieBreakerActive) {
      if (!success) {
        const winningTeamIndex = (gameState.currentTeamIndex + 1) % gameState.teams.length;
        const winningTeam = gameState.teams[winningTeamIndex];
        console.log(`[Charades] Classic: Tie-breaker - ${winningTeam.name} wins`);
        gameState.tieBreakerActive = false;
        endGame({ type: 'team', name: winningTeam.name, score: winningTeam.score, tieBreakerWin: true });
        return;
      }
    }

    // Show round result briefly, then proceed
    gameState.phase = PHASES.ROUND_RESULT;

    // For heads-up mode, show last guessed word if available; otherwise show current word
    const displayWord = (mode === 'heads_up' && gameState.roundState.lastGuessedWord)
      ? gameState.roundState.lastGuessedWord
      : gameState.currentWord;

    const resultData = {
      round: gameState.currentRound,
      success,
      word: displayWord,
      mode
    };

    if (mode === 'charade_lines' || mode === 'heads_up' || (mode === 'classic' && gameState.settings.classicMode === 'team')) {
      resultData.scores = gameState.teams.map(t => ({
        name: t.name,
        score: t.score,
        players: t.playerKeys.map(k => getPlayerByKey(k)?.name || 'Unknown')
      }));

      // Add catch-up / tie-breaker phase indicators for charade_lines and classic team
      if (mode === 'charade_lines' || (mode === 'classic' && gameState.settings.classicMode === 'team')) {
        if (gameState.catchUpPhase) {
          resultData.catchUpPhase = true;
          resultData.catchUpTeam = gameState.teams[gameState.catchUpTeamIndex].name;
          resultData.leadingTeam = gameState.teams[gameState.leadingTeamIndex].name;
        }
        if (gameState.tieBreakerActive) {
          resultData.tieBreakerActive = true;
        }
      }

      // Alternate teams
      gameState.currentTeamIndex = (gameState.currentTeamIndex + 1) % gameState.teams.length;
    } else {
      resultData.scores = getSessionPlayers().map(p => ({ name: p.name, points: p.sessionPoints || 0, connected: p.connected }));
    }

    // For pictionary and classic solo, include who guessed correctly with rankings
    if (mode === 'pictionary' || (mode === 'classic' && gameState.settings.classicMode === 'individual')) {
      const pointsConfig = mode === 'pictionary' ? gameState.settings.pictionaryPoints : [3, 2, 1];
      resultData.correctGuessers = gameState.roundState.correctGuessers.map((key, idx) => {
        const player = getPlayerByKey(key);
        return {
          name: player?.name || 'Unknown',
          position: idx + 1,
          points: pointsConfig[idx] || 0
        };
      });
    }

    io.emit('round_ended', resultData);

    // Auto-proceed to next round after delay
    const timer = setTimeout(() => {
      if (gameState.phase === PHASES.ROUND_RESULT) {
        startNextRound();
      }
    }, 3000);
    activeTimers.push(timer);
  }

  // ============================================================================
  // WIN CONDITION
  // ============================================================================
  function checkWinCondition() {
    const mode = gameState.selectedMode;
    const settings = gameState.settings;

    switch (mode) {
      case 'charade_lines':
        return checkCharadeLinesWinCondition();

      case 'heads_up':
        // Heads-up mode uses timer-based ending, not points target
        // Winner is determined when timer expires in endHeadsUpGame()
        return null;

      case 'pictionary':
        // Game ends when all rounds complete (everyone drew once)
        if (gameState.currentRound >= gameState.pictionaryTotalRounds) {
          return getPictionaryWinnerByPoints();
        }
        return null;

      case 'classic':
        if (settings.classicMode === 'team') {
          return checkClassicTeamWinCondition();
        } else {
          // Game ends when all rounds complete (everyone acted once) - like Pictionary
          if (gameState.currentRound >= gameState.classicSoloTotalRounds) {
            return getClassicSoloWinnerByPoints();
          }
          return null;
        }
    }

    return null;
  }

  // Pictionary winner determination - highest points wins
  function getPictionaryWinnerByPoints() {
    const players = getSessionPlayers()
      .sort((a, b) => (b.sessionPoints || 0) - (a.sessionPoints || 0));

    if (players.length === 0) {
      return { type: 'none', name: 'No Winner', points: 0 };
    }

    const winner = players[0];
    return {
      type: 'player',
      name: winner.name,
      points: winner.sessionPoints || 0,
      key: winner.key
    };
  }

  // Classic Solo winner determination - highest points wins (like Pictionary)
  function getClassicSoloWinnerByPoints() {
    const players = getSessionPlayers()
      .sort((a, b) => (b.sessionPoints || 0) - (a.sessionPoints || 0));

    if (players.length === 0) {
      return { type: 'none', name: 'No Winner', points: 0 };
    }

    const winner = players[0];
    return {
      type: 'player',
      name: winner.name,
      points: winner.sessionPoints || 0,
      key: winner.key
    };
  }

  // Charades Chain win condition with fair catch-up and tie-breaker support
  function checkCharadeLinesWinCondition() {
    const settings = gameState.settings;
    const target = settings.charadeLinesWinTarget;

    // During tie-breaker mode, game continues until one team fails to score
    // Win is determined in endRound when a team fails
    if (gameState.tieBreakerActive) {
      return null;
    }

    // During catch-up phase, check if catch-up team has tied
    if (gameState.catchUpPhase) {
      const catchUpTeam = gameState.teams[gameState.catchUpTeamIndex];
      const leadingTeam = gameState.teams[gameState.leadingTeamIndex];

      // Check if catch-up team tied (or exceeded - shouldn't happen but handle it)
      if (catchUpTeam.score >= target) {
        if (settings.charadesLinesContinuousTieBreaker) {
          // Enter continuous tie-breaker mode
          gameState.catchUpPhase = false;
          gameState.tieBreakerActive = true;
          console.log('[Charades] Entering tie-breaker mode');
          return null; // Continue playing
        } else {
          // Game ends in a tie
          return {
            type: 'tie',
            score: catchUpTeam.score,
            teams: [gameState.teams[0].name, gameState.teams[1].name]
          };
        }
      }
      // Catch-up team hasn't reached target yet, game continues (or fails in endRound)
      return null;
    }

    // Normal gameplay - check if either team reached target
    for (let i = 0; i < gameState.teams.length; i++) {
      const team = gameState.teams[i];
      if (team.score >= target) {
        const otherTeamIndex = (i + 1) % gameState.teams.length;
        const otherTeam = gameState.teams[otherTeamIndex];

        // Check if other team qualifies for catch-up (exactly 1 point behind)
        if (otherTeam.score === target - 1) {
          // Enter catch-up phase - give other team a chance
          gameState.catchUpPhase = true;
          gameState.catchUpTeamIndex = otherTeamIndex;
          gameState.leadingTeamIndex = i;
          console.log(`[Charades] Catch-up phase: ${otherTeam.name} gets a chance to tie`);
          return null; // Don't end game yet
        }

        // No catch-up needed - this team wins outright
        return { type: 'team', name: team.name, score: team.score };
      }
    }

    return null;
  }

  // Classic Team win condition with fair catch-up and tie-breaker support
  function checkClassicTeamWinCondition() {
    const settings = gameState.settings;
    const target = settings.classicWinTarget;

    // During tie-breaker mode, game continues until one team fails to score
    if (gameState.tieBreakerActive) {
      return null;
    }

    // During catch-up phase, check if catch-up team has tied
    if (gameState.catchUpPhase) {
      const catchUpTeam = gameState.teams[gameState.catchUpTeamIndex];

      if (catchUpTeam.score >= target) {
        if (settings.classicContinuousTieBreaker) {
          // Enter continuous tie-breaker mode
          gameState.catchUpPhase = false;
          gameState.tieBreakerActive = true;
          console.log('[Charades] Classic: Entering tie-breaker mode');
          return null;
        } else {
          // Game ends in a tie
          return {
            type: 'tie',
            score: catchUpTeam.score,
            teams: [gameState.teams[0].name, gameState.teams[1].name]
          };
        }
      }
      return null;
    }

    // Normal gameplay - check if either team reached target
    for (let i = 0; i < gameState.teams.length; i++) {
      const team = gameState.teams[i];
      if (team.score >= target) {
        const otherTeamIndex = (i + 1) % gameState.teams.length;
        const otherTeam = gameState.teams[otherTeamIndex];

        // Check if other team qualifies for catch-up (exactly 1 point behind)
        if (otherTeam.score === target - 1) {
          gameState.catchUpPhase = true;
          gameState.catchUpTeamIndex = otherTeamIndex;
          gameState.leadingTeamIndex = i;
          console.log(`[Charades] Classic: Catch-up phase - ${otherTeam.name} gets a chance to tie`);
          return null;
        }

        // No catch-up needed - this team wins outright
        return { type: 'team', name: team.name, score: team.score };
      }
    }

    return null;
  }

  // ============================================================================
  // GAME END
  // ============================================================================

  // Heads-Up mode specific game end - timer-based, highest score wins
  function endHeadsUpGame() {
    clearTimer();
    gameState.phase = PHASES.RESULTS;

    // Use saved scores from headsUpTeamScores for proper comparison
    // (scores are saved at the end of each team's turn)
    const teamsWithScores = gameState.teams.map((team, index) => ({
      ...team,
      finalScore: gameState.headsUpTeamScores[index] !== undefined
        ? gameState.headsUpTeamScores[index]
        : team.score
    }));

    // Sort teams by final score (highest first)
    const sortedTeams = [...teamsWithScores].sort((a, b) => b.finalScore - a.finalScore);

    let winner;
    let isTie = false;

    // Check for tie
    if (sortedTeams.length >= 2 && sortedTeams[0].finalScore === sortedTeams[1].finalScore) {
      isTie = true;
      winner = { type: 'tie', score: sortedTeams[0].finalScore };
    } else {
      winner = { type: 'team', name: sortedTeams[0].name, score: sortedTeams[0].finalScore };
    }

    // Update persistent scores for all players
    for (const teamWithScore of teamsWithScores) {
      const isWinner = !isTie && teamWithScore.name === winner.name;
      for (const key of teamWithScore.playerKeys) {
        const player = getPlayerByKey(key);
        if (player) {
          updatePlayerScore(key, player.name, 'heads_up', isWinner, teamWithScore.finalScore);
        }
      }
    }

    // Prepare final results
    const finalScores = teamsWithScores.map(t => ({
      name: t.name,
      score: t.finalScore,
      isWinner: !isTie && t.name === winner.name,
      players: t.playerKeys.map(k => getPlayerByKey(k)?.name || 'Unknown')
    }));

    io.emit('game_over', {
      winner,
      finalScores,
      mode: 'heads_up',
      totalRounds: gameState.currentRound,
      isTie,
      gameLog: gameState.roundState.gameLog || {},
      teamsPlayed: gameState.headsUpTeamsPlayed
    });

    // Reset heads-up tracking for next game
    gameState.headsUpTeamsPlayed = 0;
    gameState.headsUpTeamScores = [];
  }

  function endGame(winner) {
    clearTimer();
    gameState.phase = PHASES.RESULTS;

    const mode = gameState.selectedMode;

    // Reset catch-up / tie-breaker state
    gameState.catchUpPhase = false;
    gameState.catchUpTeamIndex = null;
    gameState.leadingTeamIndex = null;
    gameState.tieBreakerActive = false;

    // Handle tie outcome (no score updates - neither team wins or loses)
    if (winner.type === 'tie') {
      const finalScores = gameState.teams.map(t => ({
        name: t.name,
        score: t.score,
        isTied: true,
        players: t.playerKeys.map(k => getPlayerByKey(k)?.name || 'Unknown')
      }));

      io.emit('game_over', {
        winner,
        finalScores,
        mode,
        totalRounds: gameState.currentRound,
        isTie: true
      });
      return;
    }

    // Update persistent scores
    if (winner.type === 'team') {
      // Find winning team players
      const winningTeam = gameState.teams.find(t => t.name === winner.name);
      const losingTeam = gameState.teams.find(t => t.name !== winner.name);

      if (winningTeam) {
        for (const key of winningTeam.playerKeys) {
          const player = getPlayerByKey(key);
          if (player) {
            updatePlayerScore(key, player.name, mode, true, winningTeam.score);
          }
        }
      }
      if (losingTeam) {
        for (const key of losingTeam.playerKeys) {
          const player = getPlayerByKey(key);
          if (player) {
            updatePlayerScore(key, player.name, mode, false, losingTeam.score);
          }
        }
      }
    } else {
      // Individual mode
      for (const player of getSessionPlayers()) {
        const won = player.key === winner.key;
        updatePlayerScore(player.key, player.name, mode, won, player.sessionPoints || 0);
      }
    }

    // Prepare final results
    let finalScores;
    if (winner.type === 'team') {
      finalScores = gameState.teams.map(t => ({
        name: t.name,
        score: t.score,
        isWinner: t.name === winner.name,
        players: t.playerKeys.map(k => getPlayerByKey(k)?.name || 'Unknown')
      }));
    } else {
      finalScores = getSessionPlayers()
        .map(p => ({
          name: p.name,
          points: p.sessionPoints || 0,
          isWinner: p.key === winner.key
        }))
        .sort((a, b) => b.points - a.points);
    }

    io.emit('game_over', {
      winner,
      finalScores,
      mode,
      totalRounds: gameState.currentRound
    });
  }

  function endGameWordsExhausted() {
    clearTimer();
    gameState.phase = PHASES.RESULTS;

    const mode = gameState.selectedMode;

    // Determine winner based on highest score
    let winner = null;

    if (mode === 'charade_lines' || mode === 'heads_up' || (mode === 'classic' && gameState.settings.classicMode === 'team')) {
      // Team mode - find team with highest score
      const sortedTeams = [...gameState.teams].sort((a, b) => b.score - a.score);
      if (sortedTeams.length > 0) {
        const topTeam = sortedTeams[0];
        winner = { type: 'team', name: topTeam.name, score: topTeam.score };
      }
    } else {
      // Individual mode - find player with highest score
      const sortedPlayers = getSessionPlayers().sort((a, b) => (b.sessionPoints || 0) - (a.sessionPoints || 0));
      if (sortedPlayers.length > 0) {
        const topPlayer = sortedPlayers[0];
        winner = { type: 'player', name: topPlayer.name, points: topPlayer.sessionPoints || 0, key: topPlayer.key };
      }
    }

    if (!winner) {
      // Fallback if no winner can be determined
      winner = { type: 'none', name: 'No Winner' };
    }

    // Prepare final scores
    let finalScores;
    if (winner.type === 'team') {
      finalScores = gameState.teams.map(t => ({
        name: t.name,
        score: t.score,
        isWinner: t.name === winner.name,
        players: t.playerKeys.map(k => getPlayerByKey(k)?.name || 'Unknown')
      }));
    } else {
      finalScores = getSessionPlayers()
        .map(p => ({
          name: p.name,
          points: p.sessionPoints || 0,
          isWinner: p.key === winner.key
        }))
        .sort((a, b) => b.points - a.points);
    }

    io.emit('game_over', {
      winner,
      finalScores,
      mode,
      totalRounds: gameState.currentRound - 1, // Subtract 1 since we incremented before checking
      wordsExhausted: true
    });
  }

  function resetToLobby() {
    clearTimer();
    gameState.phase = PHASES.LOBBY;
    gameState.selectedMode = null;
    gameState.currentRound = 0;
    gameState.teams = [];
    gameState.usedWords.clear();

    // Reset heads-up tracking
    gameState.headsUpTeamsPlayed = 0;
    gameState.headsUpTeamScores = [];

    // Reset catch-up / tie-breaker state
    gameState.catchUpPhase = false;
    gameState.catchUpTeamIndex = null;
    gameState.leadingTeamIndex = null;
    gameState.tieBreakerActive = false;

    // Reset game log for new game (ensures history is cleared on Play Again)
    gameState.roundState.gameLog = { team1: [], team2: [] };

    for (const player of playersByKey.values()) {
      player.sessionPoints = 0;
    }

    broadcastLobbyUpdate();
  }

  function restartGame() {
    // Preserve mode and settings (they're already in gameState)
    const mode = gameState.selectedMode;
    const categories = gameState.settings.selectedCategories;
    const settings = { classicMode: gameState.settings.classicMode };

    if (!mode) {
      console.log('[Charades] Cannot restart - no mode selected');
      resetToLobby();
      return;
    }

    // Clear timer
    clearTimer();

    // Reset game state
    gameState.currentRound = 0;
    gameState.currentTeamIndex = 0;
    gameState.teams = [];
    gameState.usedWords.clear();

    // Reset heads-up tracking
    gameState.headsUpTeamsPlayed = 0;
    gameState.headsUpTeamScores = [];

    // Reset catch-up / tie-breaker state
    gameState.catchUpPhase = false;
    gameState.catchUpTeamIndex = null;
    gameState.leadingTeamIndex = null;
    gameState.tieBreakerActive = false;

    // Reset game log
    gameState.roundState.gameLog = { team1: [], team2: [] };

    // Reset player session points
    for (const player of playersByKey.values()) {
      player.sessionPoints = 0;
    }

    // Call startGame with preserved mode/settings
    startGame(mode, categories, settings);

    console.log('[Charades] Game restarted with mode:', mode);
  }

  // ============================================================================
  // SOCKET.IO EVENTS
  // ============================================================================
  io.on('connection', (socket) => {
    console.log('[Charades] Connection:', socket.id);

    // Host registration
    socket.on('registerHost', () => {
      hostSocketId = socket.id;
      console.log('[Charades] Host registered:', socket.id);
      broadcastLobbyUpdate();
    });

    // Player registration
    socket.on('registerPlayer', (payload, callback) => {
      const { name, playerKey, launcherKey, launcherName } = payload;
      const key = playerKey || launcherKey || generatePlayerKey();
      const playerName = (name || launcherName || 'Player').toUpperCase().substring(0, 15);

      // Validate against preset names if enabled
      if (gameState.settings.usePresetNames && gameState.settings.presetNames.length > 0) {
        const normalizedPresets = gameState.settings.presetNames.map(n => n.toUpperCase());
        if (!normalizedPresets.includes(playerName)) {
          callback({ ok: false, error: 'Please select a name from the preset list.' });
          socket.emit('player_error', 'Please select a name from the preset list.');
          socket.emit('join_rejected', { reason: 'Please select a name from the preset list.' });
          return;
        }
      }

      let existing = playersByKey.get(key);

      if (existing) {
        // Reconnection
        existing.socketId = socket.id;
        existing.connected = true;
        existing.joinedSession = true;  // Now connected this session
        existing.name = playerName;
        socketToKey.set(socket.id, key);

        callback({ ok: true, name: existing.name, key, reconnected: true });
      } else {
        // New player
        const newPlayer = {
          key,
          name: playerName,
          socketId: socket.id,
          connected: true,
          joinedSession: true,  // Connected this session
          sessionPoints: 0
        };
        playersByKey.set(key, newPlayer);
        socketToKey.set(socket.id, key);

        callback({ ok: true, name: playerName, key, reconnected: false });
      }

      console.log('[Charades] Player registered:', playerName, key);

      // If this player was being waited on (offline turn), resume their turn
      if (gameState.waitingForOfflinePlayer === key) {
        gameState.waitingForOfflinePlayer = null;
        if (gameState.selectedMode === 'pictionary') {
          setupPictionaryRound();
        } else if (gameState.selectedMode === 'classic' && gameState.settings.classicMode !== 'team') {
          setupClassicIndividualRound();
        }
      }

      broadcastLobbyUpdate();
    });

    // Disconnect
    socket.on('disconnect', () => {
      const key = socketToKey.get(socket.id);
      if (key) {
        const player = playersByKey.get(key);
        if (player) {
          player.connected = false;
          player.socketId = null;
          console.log('[Charades] Player disconnected:', player.name);
        }
        socketToKey.delete(socket.id);
      }

      if (socket.id === hostSocketId) {
        hostSocketId = null;
        console.log('[Charades] Host disconnected');
        // Notify all players that host disconnected
        io.emit('hostDisconnected');
      }

      broadcastLobbyUpdate();
    });

    // Host: Start game
    socket.on('host_start_game', ({ mode, categories, settings }) => {
      if (socket.id !== hostSocketId) return;

      // Min-player check uses ALL registered players (including offline)
      const allPlayers = getAllPlayers();
      if (allPlayers.length < 2) {
        socket.emit('error_message', { message: 'Need at least 2 players registered to start.' });
        return;
      }

      // Count all session players (including offline who joined this session)
      const sessionPlayers = getAllPlayers();
      if (sessionPlayers.length < 2) {
        socket.emit('error_message', { message: 'Need at least 2 players to start.' });
        return;
      }

      // Heads-Up mode requires even number of players for balanced teams
      if (mode === 'heads_up') {
        if (sessionPlayers.length % 2 !== 0) {
          socket.emit('error_message', {
            message: 'Heads-Up mode requires an even number of players for balanced teams.'
          });
          return;
        }
        if (sessionPlayers.length < 4) {
          socket.emit('error_message', {
            message: 'Heads-Up mode requires at least 4 players (2 per team).'
          });
          return;
        }
      }

      startGame(mode, categories, settings);
    });

    // Host: Skip intro
    socket.on('host_skip_intro', () => {
      if (socket.id !== hostSocketId) return;
      skipIntro();
    });

    // Host: Randomize teams
    socket.on('host_randomize_teams', () => {
      if (socket.id !== hostSocketId) return;
      randomizeTeams();
      io.emit('team_setup_phase', {
        teams: gameState.teams.map(t => ({
          ...t,
          players: t.playerKeys.map(k => getPlayerByKey(k)).filter(Boolean)
        }))
      });
    });

    // Host: Update teams
    socket.on('host_update_teams', ({ teams }) => {
      if (socket.id !== hostSocketId) return;
      gameState.teams = teams;
      io.emit('team_setup_phase', {
        teams: gameState.teams.map(t => ({
          ...t,
          players: t.playerKeys.map(k => getPlayerByKey(k)).filter(Boolean)
        }))
      });
    });

    // Host: Confirm teams
    socket.on('host_confirm_teams', () => {
      if (socket.id !== hostSocketId) return;
      confirmTeams();
    });

    // Host: End game early
    socket.on('host_end_game', () => {
      if (socket.id !== hostSocketId) return;
      resetToLobby();
    });

    // Host: Skip offline player's turn
    socket.on('host_skip_turn', () => {
      if (socket.id !== hostSocketId) return;
      if (gameState.waitingForOfflinePlayer) {
        gameState.waitingForOfflinePlayer = null;
        // Advance past the offline player
        if (gameState.selectedMode === 'pictionary') {
          if (gameState.currentRound >= gameState.pictionaryTotalRounds) {
            endGame(getPictionaryWinnerByPoints());
          } else {
            startNextRound();
          }
        } else if (gameState.selectedMode === 'classic' && gameState.settings.classicMode !== 'team') {
          if (gameState.currentRound >= gameState.classicSoloTotalRounds) {
            endGame(getClassicSoloWinnerByPoints());
          } else {
            gameState.currentRound++;
            startNextRound();
          }
        }
      }
    });

    // Host: Reset game
    socket.on('host_reset_game', () => {
      if (socket.id !== hostSocketId) return;
      resetToLobby();
    });

    // Host: Play Again (restart same mode)
    socket.on('host_play_again', () => {
      if (socket.id !== hostSocketId) return;
      restartGame();
    });

    // Host: Return to launcher
    socket.on('host_return_to_menu', () => {
      if (socket.id !== hostSocketId) return;
      resetToLobby();
      io.emit('returned_to_menu');
    });

    // Host: Update settings
    socket.on('host_update_settings', (settings) => {
      if (socket.id !== hostSocketId) return;
      gameState.settings = { ...gameState.settings, ...settings };
      saveGameSettings(gameState.settings);
      io.emit('settings_updated', gameState.settings);
    });

    // Host: Reset all scores
    socket.on('host_reset_all_scores', () => {
      if (socket.id !== hostSocketId) return;
      resetAllScores();
      io.emit('scores_reset');
      broadcastLobbyUpdate();
    });

    // Host: Kick player
    socket.on('kickPlayer', ({ playerKey }) => {
      if (socket.id !== hostSocketId) return;
      const player = playersByKey.get(playerKey);
      if (player) {
        const playerSocket = io.sockets ? io.sockets.get(player.socketId) : null;
        if (playerSocket) {
          playerSocket.emit('kicked');
        }
        playersByKey.delete(playerKey);
        socketToKey.delete(player.socketId);
        console.log('[Charades] Player kicked:', player.name);
        broadcastLobbyUpdate();
      }
    });

    // Player: Submit guess
    socket.on('player_guess', ({ guess }, callback) => {
      const key = socketToKey.get(socket.id);
      if (!key) return callback({ correct: false, error: 'Not registered' });

      const result = handleGuess(key, guess);
      callback(result);
    });

    // Player: Vote to skip (Heads-Up actors)
    socket.on('player_vote_skip', () => {
      const key = socketToKey.get(socket.id);
      if (key) handleSkipVote(key);
    });

    // Player: Guesser skip (Heads-Up guesser)
    socket.on('guesser_skip', () => {
      const key = socketToKey.get(socket.id);
      if (key) handleGuesserSkip(key);
    });

    // Player: Forfeit round (Classic/Pictionary actor)
    socket.on('forfeit_round', () => {
      const key = socketToKey.get(socket.id);
      if (key) handleForfeit(key);
    });

    // Player: Drawing events (Pictionary)
    socket.on('player_draw_point', (point) => {
      const key = socketToKey.get(socket.id);
      if (key) handleDrawPoint(key, point);
    });

    socket.on('player_draw_points', (data) => {
      const key = socketToKey.get(socket.id);
      const points = Array.isArray(data) ? data : data?.points;
      if (key) handleDrawPoints(key, points);
    });

    socket.on('player_stroke_complete', (stroke) => {
      const key = socketToKey.get(socket.id);
      if (key) handleStrokeComplete(key, stroke);
    });

    socket.on('player_clear_canvas', () => {
      const key = socketToKey.get(socket.id);
      if (key) handleClearCanvas(key);
    });

    socket.on('player_undo', () => {
      const key = socketToKey.get(socket.id);
      if (key) handleUndo(key);
    });

    socket.on('player_redo', () => {
      const key = socketToKey.get(socket.id);
      if (key) handleRedo(key);
    });

    // Get current game state (for reconnection)
    socket.on('getGameState', (callback) => {
      callback({
        phase: gameState.phase,
        selectedMode: gameState.selectedMode,
        settings: gameState.settings
      });
    });
  });

  // ============================================================================
  // EXPRESS ROUTES
  // ============================================================================
  // Serve shared assets from parent directory
  router.use('/shared', express.static(path.join(gamePath, '..', '..', 'shared')));
  router.use(express.static(gamePath));

  router.get('/', (req, res) => res.redirect('./host'));
  router.get('/host', (req, res) => res.sendFile(path.join(gamePath, 'index.html')));
  router.get('/player', (req, res) => res.sendFile(path.join(gamePath, 'player.html')));
  router.get('/players', (req, res) => res.sendFile(path.join(gamePath, 'player.html')));

  // API endpoint to receive initial player list from launcher (including offline players)
  router.post('/api/init-players', (req, res) => {
    const { players, settings } = req.body || {};
    if (!Array.isArray(players)) {
      return res.status(400).json({ error: 'Invalid players array' });
    }

    console.log('[Charades][INIT] Received', players.length, 'players from launcher');

    // Store preset settings if provided
    if (settings) {
      gameState.settings.usePresetNames = settings.usePresetNames || false;
      gameState.settings.presetNames = settings.presetNames || [];
    }

    for (const p of players) {
      if (!p.key || !p.name) continue;

      // Only add if not already registered
      if (!playersByKey.has(p.key)) {
        playersByKey.set(p.key, {
          key: p.key,
          name: p.name.toUpperCase().substring(0, 15),
          socketId: null,
          connected: false,
          sessionPoints: 0
        });
      }
    }

    broadcastLobbyUpdate();
    res.json({ ok: true, count: players.length });
  });

  router.post("/api/update-settings", express.json(), (req, res) => {
    const { usePresetNames, presetNames } = req.body || {};

    // Update the game's preset settings variables
    if (usePresetNames !== undefined) {
      gameState.settings.usePresetNames = usePresetNames;
    }
    if (presetNames !== undefined) {
      gameState.settings.presetNames = presetNames;
    }

    console.log("[Charades][API] Updated preset settings:", { usePresetNames, presetNames: presetNames?.length || 0 });
    res.status(200).json({ success: true });
  });

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  loadWords();

  // ============================================================================
  // CLEANUP FUNCTION
  // ============================================================================
  function cleanup() {
    clearTimer();

    // Clear all active timers
    for (const timer of activeTimers) {
      clearTimeout(timer);
    }
    activeTimers.length = 0;

    // Reset state
    playersByKey.clear();
    socketToKey.clear();
    hostSocketId = null;
    gameState.phase = PHASES.LOBBY;
    gameState.teams = [];
    gameState.usedWords.clear();

    console.log('[Charades] Cleanup completed');
  }

  return { router, cleanup };
};
