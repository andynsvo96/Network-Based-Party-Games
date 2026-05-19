// server.js - Trivia Party Game (reconnect-friendly)
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
    QUESTION: 'QUESTION',
    REVEAL: 'REVEAL',
    BONUS_STAGE: 'BONUS_STAGE',
    GAME_OVER: 'GAME_OVER'
  };

  const QUESTION_TYPES = {
    MULTIPLE_CHOICE: 'multiple_choice',
    TRUE_FALSE: 'true_false',
    NUMBER_RANGE: 'number_range',
    TEXT_INPUT: 'text_input',
    MULTIPLE_CORRECT: 'multiple_correct',
    OPINION: 'opinion'
  };

  // --- Game State ---
  let gamePhase = PHASES.LOBBY;
  let players = new Map();        // key -> player object
  let socketIdToKey = new Map();  // socket.id -> key

  // Questions
  let allQuestions = [];          // All questions from XML
  let categories = [];            // Available categories
  let questionPool = [];          // Filtered questions for current game
  let usedQuestionIds = new Set();
  let currentQuestion = null;
  let currentQuestionIndex = 0;
  let totalQuestionsForGame = 10;

  // Timer
  let timerEnabled = false;
  let timerSeconds = 30;
  let timerRemaining = 0;
  let timerInterval = null;

  // Round State
  let roundAnswers = new Map();   // playerKey -> { answer, timestamp }
  let timedOutPlayers = new Set();

  // Bonus Stage
  let bonusState = {
    active: false,
    tiedPlayers: [],
    eliminatedPlayers: [],
    bonusAnswers: new Map()
  };

  // Settings
  let gameSettings = {
    questionCount: 10,
    timerEnabled: false,
    timerSeconds: 30,
    penaltyEnabled: false,
    selectedCategories: [],       // Empty = all
    selectedTypes: Object.values(QUESTION_TYPES),
    usePresetNames: settings?.usePresetNames || false,
    presetNames: Array.isArray(settings?.presetNames)
      ? settings.presetNames.map(n => normalizeName(n)).filter(n => n)
      : []
  };

  // Last payloads for reconnection
  let lastGameOverPayload = null;
  let lastRevealPayload = null;

  // Lifetime scores file
  const SCORES_FILE = path.join(gamePath, 'playerScores.json');

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
    const lifetimeScores = loadLifetimeScores();
    return getNonHostPlayers()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => ({
        key: p.key,
        name: p.name,
        connected: !!p.connected,
        score: p.score || 0,
        lifetimeWins: lifetimeScores.players[p.key]?.wins || 0
      }));
  }

  function getCurrentLeaderboard() {
    return getNonHostPlayers()
      .sort((a, b) => b.score - a.score)
      .map(p => ({ key: p.key, name: p.name, score: p.score, connected: p.connected }));
  }

  function getEligiblePlayerKeys() {
    const answeredKeys = new Set(roundAnswers.keys());
    return getNonHostPlayers()
      .filter(p => p.connected || answeredKeys.has(p.key))
      .map(p => p.key);
  }

  // --- Lifetime Scores ---
  function loadLifetimeScores() {
    try {
      if (fs.existsSync(SCORES_FILE)) {
        return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
      }
    } catch (e) {
      console.error('[Trivia] Error loading scores:', e);
    }
    return { players: {} };
  }

  function saveLifetimeScores(scores) {
    try {
      fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
    } catch (e) {
      console.error('[Trivia] Error saving scores:', e);
    }
  }

  function recordWin(playerKey, playerName) {
    const scores = loadLifetimeScores();
    if (!scores.players[playerKey]) {
      scores.players[playerKey] = { name: playerName, wins: 0, gamesPlayed: 0, lastPlayed: null };
    }
    scores.players[playerKey].wins++;
    scores.players[playerKey].gamesPlayed++;
    scores.players[playerKey].name = playerName;
    scores.players[playerKey].lastPlayed = new Date().toISOString();
    saveLifetimeScores(scores);
  }

  function recordParticipation(playerKey, playerName) {
    const scores = loadLifetimeScores();
    if (!scores.players[playerKey]) {
      scores.players[playerKey] = { name: playerName, wins: 0, gamesPlayed: 0, lastPlayed: null };
    }
    scores.players[playerKey].gamesPlayed++;
    scores.players[playerKey].name = playerName;
    scores.players[playerKey].lastPlayed = new Date().toISOString();
    saveLifetimeScores(scores);
  }

  function wipeAllScores() {
    saveLifetimeScores({ players: {} });
  }

  // --- XML Question Loading ---
  function loadQuestions(callback) {
    const xmlPath = path.join(gamePath, 'questions.xml');
    try {
      const xmlData = fs.readFileSync(xmlPath, 'utf8');
      const result = parseXML(xmlData);
      allQuestions = result.questions;
      categories = result.categories;
      callback(null, { questionCount: allQuestions.length, categories });
    } catch (e) {
      console.error('[Trivia] Failed to load questions:', e.message);
      callback(e, null);
    }
  }

  function parseXML(xmlData) {
    const questions = [];
    const cats = [];

    // Simple XML parsing (no external dependencies)
    const categoryRegex = /<category[^>]*id="([^"]*)"[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/category>/g;
    let catMatch;

    while ((catMatch = categoryRegex.exec(xmlData)) !== null) {
      const catId = catMatch[1];
      const catName = catMatch[2];
      const catContent = catMatch[3];

      cats.push({ id: catId, name: catName });

      const questionRegex = /<question[^>]*id="([^"]*)"[^>]*type="([^"]*)"[^>]*>([\s\S]*?)<\/question>/g;
      let qMatch;

      while ((qMatch = questionRegex.exec(catContent)) !== null) {
        const qId = qMatch[1];
        const qType = qMatch[2];
        const qContent = qMatch[3];

        const textMatch = qContent.match(/<text>([\s\S]*?)<\/text>/);
        const answerMatch = qContent.match(/<answer>([\s\S]*?)<\/answer>/);
        const acceptableMatch = qContent.match(/<acceptable>([\s\S]*?)<\/acceptable>/);
        const mediaMatch = qContent.match(/<media[^>]*type="([^"]*)"[^>]*src="([^"]*)"[^>]*\/>/);

        const options = [];
        const optionRegex = /<option([^>]*)>([\s\S]*?)<\/option>/g;
        let optMatch;
        while ((optMatch = optionRegex.exec(qContent)) !== null) {
          const isCorrect = optMatch[1].includes('correct="true"');
          const optText = optMatch[2].trim();
          options.push({ text: optText, correct: isCorrect });
        }

        questions.push({
          id: qId,
          type: qType,
          categoryId: catId,
          categoryName: catName,
          text: textMatch ? textMatch[1].trim() : '',
          answer: answerMatch ? answerMatch[1].trim() : null,
          acceptable: acceptableMatch ? acceptableMatch[1].split(',').map(s => s.trim()) : [],
          options: options,
          media: mediaMatch ? { type: mediaMatch[1], src: mediaMatch[2] } : null
        });
      }
    }

    return { questions, categories: cats };
  }

  // --- Question Pool Management ---
  function buildQuestionPool() {
    let filtered = allQuestions;

    // Filter by categories
    if (gameSettings.selectedCategories.length > 0) {
      filtered = filtered.filter(q => gameSettings.selectedCategories.includes(q.categoryId));
    }

    // Filter by types
    if (gameSettings.selectedTypes.length > 0) {
      filtered = filtered.filter(q => gameSettings.selectedTypes.includes(q.type));
    }

    // Shuffle
    questionPool = shuffleArray([...filtered]);
    usedQuestionIds.clear();
  }

  function getNextQuestion() {
    const available = questionPool.filter(q => !usedQuestionIds.has(q.id));
    if (available.length === 0) return null;
    const question = available[Math.floor(Math.random() * available.length)];
    usedQuestionIds.add(question.id);
    return question;
  }

  function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // --- Timer Functions ---
  function startTimer(seconds) {
    clearTimer();
    timerRemaining = seconds;
    io.emit('timerUpdate', { remaining: timerRemaining });

    timerInterval = setInterval(() => {
      timerRemaining--;
      io.emit('timerUpdate', { remaining: timerRemaining });

      if (timerRemaining <= 0) {
        clearTimer();
        handleTimerExpired();
      }
    }, 1000);
  }

  function clearTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function handleTimerExpired() {
    // Mark all players who haven't answered as timed out
    const eligible = getEligiblePlayerKeys();
    eligible.forEach(key => {
      if (!roundAnswers.has(key)) {
        timedOutPlayers.add(key);
      }
    });

    if (bonusState.active) {
      processBonusRound();
    } else {
      processRoundEnd();
    }
  }

  // --- Scoring ---
  function calculateScores(question, answers) {
    const results = [];
    const answersArray = Array.from(answers.entries());

    switch (question.type) {
      case QUESTION_TYPES.MULTIPLE_CHOICE:
      case QUESTION_TYPES.TRUE_FALSE: {
        const correctAnswer = question.type === QUESTION_TYPES.MULTIPLE_CHOICE
          ? question.options.find(o => o.correct)?.text
          : question.answer;

        answersArray.forEach(([playerKey, data]) => {
          const isCorrect = data.answer === correctAnswer ||
            (question.type === QUESTION_TYPES.TRUE_FALSE &&
             data.answer?.toLowerCase() === correctAnswer?.toLowerCase());
          const points = isCorrect ? 1 : (gameSettings.penaltyEnabled ? -1 : 0);
          results.push({ playerKey, correct: isCorrect, points, answer: data.answer });
        });
        break;
      }

      case QUESTION_TYPES.NUMBER_RANGE: {
        const target = parseFloat(question.answer);
        const guesses = answersArray.map(([playerKey, data]) => ({
          playerKey,
          guess: parseFloat(data.answer),
          diff: Math.abs(target - parseFloat(data.answer)),
          answer: data.answer
        }));

        if (guesses.length > 0) {
          const minDiff = Math.min(...guesses.map(g => isNaN(g.diff) ? Infinity : g.diff));
          guesses.forEach(g => {
            const isCorrect = !isNaN(g.diff) && g.diff === minDiff;
            results.push({
              playerKey: g.playerKey,
              correct: isCorrect,
              points: isCorrect ? 1 : (gameSettings.penaltyEnabled ? -1 : 0),
              answer: g.answer,
              diff: g.diff
            });
          });
        }
        break;
      }

      case QUESTION_TYPES.TEXT_INPUT: {
        answersArray.forEach(([playerKey, data]) => {
          const isCorrect = fuzzyMatch(data.answer, question.answer, question.acceptable);
          const points = isCorrect ? 1 : (gameSettings.penaltyEnabled ? -1 : 0);
          results.push({ playerKey, correct: isCorrect, points, answer: data.answer });
        });
        break;
      }

      case QUESTION_TYPES.MULTIPLE_CORRECT: {
        const correctOptions = new Set(question.options.filter(o => o.correct).map(o => o.text));
        const allOptions = new Set(question.options.map(o => o.text));

        answersArray.forEach(([playerKey, data]) => {
          const selected = Array.isArray(data.answer) ? new Set(data.answer) : new Set();

          let correctCount = 0;
          let incorrectCount = 0;

          selected.forEach(s => {
            if (correctOptions.has(s)) {
              correctCount++;
            } else if (allOptions.has(s)) {
              incorrectCount++;
            }
          });

          // +0.5 per correct, -0.5 per incorrect, floor to integer, minimum 0
          const rawScore = (correctCount * 0.5) - (incorrectCount * 0.5);
          const points = Math.max(0, Math.floor(rawScore));

          results.push({
            playerKey: playerKey,
            correct: points > 0,
            points: points,
            answer: data.answer,
            correctCount: correctCount,
            incorrectCount: incorrectCount
          });
        });
        break;
      }

      case QUESTION_TYPES.OPINION: {
        // Tally votes
        const votes = {};
        answersArray.forEach(([_, data]) => {
          votes[data.answer] = (votes[data.answer] || 0) + 1;
        });

        const maxVotes = Math.max(0, ...Object.values(votes));
        const majorityOptions = Object.entries(votes)
          .filter(([_, count]) => count === maxVotes)
          .map(([option, _]) => option);

        answersArray.forEach(([playerKey, data]) => {
          const isWinner = majorityOptions.includes(data.answer);
          results.push({
            playerKey,
            correct: isWinner,
            points: isWinner ? 1 : 0, // No penalty for opinion
            answer: data.answer,
            voteCount: votes[data.answer] || 0
          });
        });
        break;
      }
    }

    return results;
  }

  function fuzzyMatch(input, correctAnswer, acceptable = []) {
    if (!input || !correctAnswer) return false;

    const normalize = (s) => String(s).toLowerCase().trim()
      .replace(/[^a-z0-9]/g, '')
      .replace(/\s+/g, '');

    const normalizedInput = normalize(input);
    const normalizedCorrect = normalize(correctAnswer);

    if (normalizedInput === normalizedCorrect) return true;

    for (const alt of acceptable) {
      if (normalizedInput === normalize(alt)) return true;
    }

    // Levenshtein distance tolerance
    const distance = levenshteinDistance(normalizedInput, normalizedCorrect);
    const maxAllowed = Math.min(2, Math.floor(normalizedCorrect.length * 0.2));
    if (distance <= maxAllowed) return true;

    return false;
  }

  function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  // --- Game Flow ---
  function startGame() {
    // Reset scores
    for (const p of players.values()) {
      if (p && !p.isHost) {
        p.score = 0;
        p.correctAnswers = 0;
        p.totalAnswered = 0;
      }
    }

    // Record participation
    getNonHostPlayers().forEach(p => {
      recordParticipation(p.key, p.name);
    });

    buildQuestionPool();
    totalQuestionsForGame = Math.min(gameSettings.questionCount, questionPool.length);
    currentQuestionIndex = 0;
    lastGameOverPayload = null;
    bonusState = { active: false, tiedPlayers: [], eliminatedPlayers: [], bonusAnswers: new Map() };

    gamePhase = PHASES.QUESTION;
    startNextQuestion();
  }

  function startNextQuestion() {
    clearTimer();
    roundAnswers.clear();
    timedOutPlayers.clear();
    lastRevealPayload = null;

    currentQuestionIndex++;
    currentQuestion = getNextQuestion();

    if (!currentQuestion) {
      checkForBonusOrEnd();
      return;
    }

    // Shuffle options once for consistent order between host and players
    if (currentQuestion.options) {
      currentQuestion.shuffledOptions = shuffleArray([...currentQuestion.options]);
    }

    gamePhase = PHASES.QUESTION;

    const questionPayload = sanitizeQuestionForHost(currentQuestion);
    const playerQuestionPayload = sanitizeQuestionForPlayer(currentQuestion);

    io.emit('newQuestion', {
      question: questionPayload,
      questionIndex: currentQuestionIndex,
      totalQuestions: totalQuestionsForGame,
      leaderboard: getCurrentLeaderboard(),
      timerEnabled: gameSettings.timerEnabled,
      timerSeconds: gameSettings.timerSeconds
    });

    io.emit('newQuestionPlayer', {
      question: playerQuestionPayload,
      questionIndex: currentQuestionIndex,
      totalQuestions: totalQuestionsForGame,
      timerEnabled: gameSettings.timerEnabled,
      timerSeconds: gameSettings.timerSeconds
    });

    if (gameSettings.timerEnabled) {
      startTimer(gameSettings.timerSeconds);
    }
  }

  function sanitizeQuestionForHost(q) {
    // Use pre-shuffled options if available for consistent order
    const options = q.shuffledOptions || q.options;
    return {
      id: q.id,
      type: q.type,
      categoryName: q.categoryName,
      text: q.text,
      options: options ? options.map(o => ({ text: o.text, correct: o.correct })) : null,
      answer: q.answer,
      media: q.media
    };
  }

  function sanitizeQuestionForPlayer(q) {
    // Don't reveal correct answers to players
    // Use pre-shuffled options if available for consistent order
    const options = q.shuffledOptions || q.options;
    return {
      id: q.id,
      type: q.type,
      categoryName: q.categoryName,
      text: q.text,
      options: options ? options.map(o => ({ text: o.text })) : null,
      media: q.media
    };
  }

  function processRoundEnd() {
    clearTimer();
    gamePhase = PHASES.REVEAL;

    // Add timed out players as wrong
    timedOutPlayers.forEach(key => {
      if (!roundAnswers.has(key)) {
        roundAnswers.set(key, { answer: null, timedOut: true });
      }
    });

    const results = calculateScores(currentQuestion, roundAnswers);

    // Apply scores
    results.forEach(r => {
      const player = players.get(r.playerKey);
      if (player && !player.isHost) {
        player.score = Math.max(0, (player.score || 0) + r.points);
        player.totalAnswered = (player.totalAnswered || 0) + 1;
        if (r.correct) player.correctAnswers = (player.correctAnswers || 0) + 1;
      }
    });

    // Build results payload
    const correctAnswer = getCorrectAnswer(currentQuestion);
    const playerResults = results.map(r => {
      const player = players.get(r.playerKey);
      return {
        playerKey: r.playerKey,
        playerName: player?.name || 'Unknown',
        answer: r.answer,
        correct: r.correct,
        points: r.points,
        timedOut: timedOutPlayers.has(r.playerKey)
      };
    });

    // Store payload for reconnection
    lastRevealPayload = {
      correctAnswer,
      question: currentQuestion,
      results: playerResults,
      leaderboard: getCurrentLeaderboard(),
      questionIndex: currentQuestionIndex,
      totalQuestions: totalQuestionsForGame
    };

    io.emit('revealAnswer', lastRevealPayload);

    // Check if more questions or end game
    if (currentQuestionIndex >= totalQuestionsForGame) {
      setTimeout(() => checkForBonusOrEnd(), 4000);
    }
  }

  function getCorrectAnswer(q) {
    switch (q.type) {
      case QUESTION_TYPES.MULTIPLE_CHOICE:
        return q.options.find(o => o.correct)?.text || null;
      case QUESTION_TYPES.TRUE_FALSE:
      case QUESTION_TYPES.NUMBER_RANGE:
      case QUESTION_TYPES.TEXT_INPUT:
        return q.answer;
      case QUESTION_TYPES.MULTIPLE_CORRECT:
        return q.options.filter(o => o.correct).map(o => o.text);
      case QUESTION_TYPES.OPINION:
        return 'Majority wins!';
      default:
        return q.answer;
    }
  }

  function checkForBonusOrEnd() {
    const leaderboard = getCurrentLeaderboard();
    if (leaderboard.length === 0) {
      endGame(null);
      return;
    }

    const topScore = leaderboard[0].score;
    const tiedForFirst = leaderboard.filter(p => p.score === topScore);

    if (tiedForFirst.length > 1) {
      startBonusStage(tiedForFirst.map(p => p.key));
    } else {
      endGame(tiedForFirst[0].key);
    }
  }

  // --- Bonus Stage ---
  function startBonusStage(tiedPlayerKeys) {
    gamePhase = PHASES.BONUS_STAGE;
    bonusState = {
      active: true,
      tiedPlayers: [...tiedPlayerKeys],
      eliminatedPlayers: [],
      bonusAnswers: new Map()
    };

    io.emit('bonusStageStart', {
      players: tiedPlayerKeys.map(k => {
        const p = players.get(k);
        return { key: k, name: p?.name || 'Unknown' };
      }),
      message: 'SUDDEN DEATH! Answer correctly to survive!'
    });

    setTimeout(() => startBonusQuestion(), 3000);
  }

  function startBonusQuestion() {
    clearTimer();
    bonusState.bonusAnswers.clear();
    timedOutPlayers.clear();

    currentQuestion = getNextQuestion();
    if (!currentQuestion) {
      // No more questions - tied players share win
      endGameWithTie(bonusState.tiedPlayers);
      return;
    }

    // Shuffle options once for consistent order between host and players
    if (currentQuestion.options) {
      currentQuestion.shuffledOptions = shuffleArray([...currentQuestion.options]);
    }

    const playerQuestionPayload = sanitizeQuestionForPlayer(currentQuestion);

    // Only send to bonus stage players
    bonusState.tiedPlayers.forEach(playerKey => {
      const player = players.get(playerKey);
      if (player && player.socketId) {
        io.to(player.socketId).emit('bonusQuestion', {
          question: playerQuestionPayload,
          remainingPlayers: bonusState.tiedPlayers.length,
          timerEnabled: gameSettings.timerEnabled,
          timerSeconds: gameSettings.timerSeconds
        });
      }
    });

    // Host sees the question too
    emitToHost('bonusQuestionHost', {
      question: sanitizeQuestionForHost(currentQuestion),
      remainingPlayers: bonusState.tiedPlayers.map(k => players.get(k)?.name || 'Unknown'),
      timerEnabled: gameSettings.timerEnabled,
      timerSeconds: gameSettings.timerSeconds
    });

    if (gameSettings.timerEnabled) {
      startTimer(gameSettings.timerSeconds);
    }
  }

  function processBonusRound() {
    clearTimer();

    // Add timed out players
    bonusState.tiedPlayers.forEach(key => {
      if (!bonusState.bonusAnswers.has(key)) {
        bonusState.bonusAnswers.set(key, { answer: null, timedOut: true });
        timedOutPlayers.add(key);
      }
    });

    const results = calculateScores(currentQuestion, bonusState.bonusAnswers);
    const correctPlayers = results.filter(r => r.correct).map(r => r.playerKey);
    const wrongPlayers = results.filter(r => !r.correct).map(r => r.playerKey);

    // Elimination logic
    if (correctPlayers.length === 0) {
      // All wrong - continue (no elimination)
    } else if (correctPlayers.length === bonusState.tiedPlayers.length) {
      // All correct - continue (no elimination)
    } else {
      // Some correct, some wrong - eliminate wrong players
      wrongPlayers.forEach(pk => {
        bonusState.eliminatedPlayers.push(pk);
        bonusState.tiedPlayers = bonusState.tiedPlayers.filter(k => k !== pk);
      });
    }

    const correctAnswer = getCorrectAnswer(currentQuestion);

    io.emit('bonusStageUpdate', {
      correctAnswer,
      results: results.map(r => ({
        playerKey: r.playerKey,
        playerName: players.get(r.playerKey)?.name || 'Unknown',
        correct: r.correct,
        answer: r.answer,
        eliminated: bonusState.eliminatedPlayers.includes(r.playerKey),
        timedOut: timedOutPlayers.has(r.playerKey)
      })),
      remainingPlayers: bonusState.tiedPlayers.map(k => ({
        key: k,
        name: players.get(k)?.name || 'Unknown'
      })),
      eliminatedPlayers: bonusState.eliminatedPlayers.map(k => ({
        key: k,
        name: players.get(k)?.name || 'Unknown'
      }))
    });

    // Check for winner
    if (bonusState.tiedPlayers.length === 1) {
      setTimeout(() => endGame(bonusState.tiedPlayers[0]), 3000);
    } else if (bonusState.tiedPlayers.length === 0) {
      // Everyone eliminated somehow - last eliminated shares win
      endGameWithTie(bonusState.eliminatedPlayers.slice(-wrongPlayers.length));
    } else {
      setTimeout(() => startBonusQuestion(), 3000);
    }
  }

  function endGameWithTie(winnerKeys) {
    gamePhase = PHASES.GAME_OVER;
    clearTimer();
    bonusState.active = false;

    // Record wins for all tied winners
    winnerKeys.forEach(key => {
      const player = players.get(key);
      if (player) recordWin(key, player.name);
    });

    const leaderboard = getCurrentLeaderboard();
    const winners = winnerKeys.map(k => {
      const p = players.get(k);
      return { key: k, name: p?.name || 'Unknown', score: p?.score || 0 };
    });

    const playerStats = getNonHostPlayers().map(p => ({
      key: p.key,
      name: p.name,
      score: p.score || 0,
      correctAnswers: p.correctAnswers || 0,
      totalAnswered: p.totalAnswered || 0
    }));

    lastGameOverPayload = {
      winners,
      isTie: true,
      leaderboard,
      playerStats,
      bonusStageParticipants: bonusState.eliminatedPlayers.concat(bonusState.tiedPlayers)
    };

    io.emit('gameOver', lastGameOverPayload);
  }

  function endGame(winnerKey) {
    gamePhase = PHASES.GAME_OVER;
    clearTimer();
    bonusState.active = false;

    const winner = winnerKey ? players.get(winnerKey) : null;
    if (winner) {
      recordWin(winnerKey, winner.name);
    }

    const leaderboard = getCurrentLeaderboard();
    const playerStats = getNonHostPlayers().map(p => ({
      key: p.key,
      name: p.name,
      score: p.score || 0,
      correctAnswers: p.correctAnswers || 0,
      totalAnswered: p.totalAnswered || 0
    }));

    lastGameOverPayload = {
      winner: winner ? { key: winnerKey, name: winner.name, score: winner.score || 0 } : null,
      isTie: false,
      leaderboard,
      playerStats,
      bonusStageParticipants: bonusState.eliminatedPlayers.concat(bonusState.tiedPlayers)
    };

    io.emit('gameOver', lastGameOverPayload);
  }

  function resetGameKeepPlayers() {
    clearTimer();
    gamePhase = PHASES.LOBBY;
    currentQuestion = null;
    currentQuestionIndex = 0;
    usedQuestionIds.clear();
    roundAnswers.clear();
    timedOutPlayers.clear();
    lastGameOverPayload = null;
    lastRevealPayload = null;
    bonusState = { active: false, tiedPlayers: [], eliminatedPlayers: [], bonusAnswers: new Map() };

    for (const p of players.values()) {
      if (p && !p.isHost) {
        p.score = 0;
        p.correctAnswers = 0;
        p.totalAnswered = 0;
      }
    }

    io.emit('gameResetKeepPlayer');
    io.emit('playerListUpdate', getPlayerListPayload());
  }

  function resetToLobby() {
    clearTimer();
    gamePhase = PHASES.LOBBY;
    currentQuestion = null;
    currentQuestionIndex = 0;
    roundAnswers.clear();
    timedOutPlayers.clear();
    bonusState = { active: false, tiedPlayers: [], eliminatedPlayers: [], bonusAnswers: new Map() };
  }

  // --- Player State Sync ---
  function syncPlayerState(socket, playerKey) {
    const player = players.get(playerKey);
    if (!player) return;

    switch (gamePhase) {
      case PHASES.LOBBY:
        socket.emit('lobbyState', {
          players: getPlayerListPayload(),
          settings: gameSettings,
          categories,
          questionTypes: Object.values(QUESTION_TYPES)
        });
        break;

      case PHASES.INTRO:
        socket.emit('introPhase', getIntroSlides());
        break;

      case PHASES.QUESTION:
        if (currentQuestion) {
          const hasAnswered = roundAnswers.has(playerKey);
          socket.emit('questionState', {
            question: sanitizeQuestionForPlayer(currentQuestion),
            questionIndex: currentQuestionIndex,
            totalQuestions: totalQuestionsForGame,
            hasAnswered,
            timerEnabled: gameSettings.timerEnabled,
            timerRemaining
          });
        }
        break;

      case PHASES.REVEAL:
        if (lastRevealPayload) {
          // Send full reveal payload so player sees their personal result
          socket.emit('revealAnswer', lastRevealPayload);
        } else {
          // Fallback if payload not available
          socket.emit('revealState', {
            correctAnswer: getCorrectAnswer(currentQuestion),
            leaderboard: getCurrentLeaderboard()
          });
        }
        break;

      case PHASES.BONUS_STAGE:
        const inBonusStage = bonusState.tiedPlayers.includes(playerKey);
        socket.emit('bonusStageState', {
          active: inBonusStage,
          remainingPlayers: bonusState.tiedPlayers.map(k => players.get(k)?.name || 'Unknown'),
          eliminated: bonusState.eliminatedPlayers.includes(playerKey)
        });
        // If player is in bonus stage and there's a current question, send it
        if (inBonusStage && currentQuestion && !bonusState.bonusAnswers.has(playerKey)) {
          socket.emit('bonusQuestion', {
            question: sanitizeQuestionForPlayer(currentQuestion),
            remainingPlayers: bonusState.tiedPlayers.length,
            timerEnabled: gameSettings.timerEnabled,
            timerSeconds: gameSettings.timerSeconds
          });
        }
        break;

      case PHASES.GAME_OVER:
        if (lastGameOverPayload) {
          socket.emit('gameOver', lastGameOverPayload);
        }
        break;
    }
  }

  function getIntroSlides() {
    return {
      gameName: 'Trivia Party',
      slides: [
        {
          title: 'How to Play',
          content: 'Answer trivia questions on your device. Be fast and accurate to score points!'
        },
        {
          title: 'Question Types',
          content: 'Multiple choice, true/false, number guessing, text input, select all correct, and opinion questions!'
        },
        {
          title: 'Winning',
          content: 'The player with the most points wins! Ties lead to a SUDDEN DEATH bonus round!'
        }
      ]
    };
  }

  // --- Socket.IO Communication ---
  io.on('connection', (socket) => {
    socket.emit('gameStatus', { phase: gamePhase });
    socket.emit('leaderboardUpdate', getCurrentLeaderboard());

    // --- Host Events ---
    socket.on('registerHost', () => {
      if (socketIdToKey.get(socket.id) === HOST_KEY) return;

      const oldHost = getHost();
      if (oldHost && oldHost.socketId && socketIdToKey.get(oldHost.socketId) === HOST_KEY) {
        socketIdToKey.delete(oldHost.socketId);
      }

      players.set(HOST_KEY, {
        key: HOST_KEY,
        name: 'HOST',
        score: 0,
        isHost: true,
        socketId: socket.id,
        connected: true,
        lastSeen: Date.now()
      });
      socketIdToKey.set(socket.id, HOST_KEY);

      loadQuestions((err, data) => {
        if (err) {
          socket.emit('hostSetupError', 'Could not load questions. Check questions.xml');
        } else {
          socket.emit('hostSetupSuccess', {
            questionCount: data.questionCount,
            categories: data.categories,
            questionTypes: Object.values(QUESTION_TYPES),
            settings: gameSettings,
            lifetimeScores: loadLifetimeScores()
          });
          setTimeout(() => socket.emit('playerListUpdate', getPlayerListPayload()), 100);
        }
      });
    });

    socket.on('updateSettings', (newSettings) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY || gamePhase !== PHASES.LOBBY) return;

      if (newSettings.questionCount !== undefined) {
        gameSettings.questionCount = Math.max(1, Math.min(newSettings.questionCount, allQuestions.length));
      }
      if (newSettings.timerEnabled !== undefined) {
        gameSettings.timerEnabled = !!newSettings.timerEnabled;
      }
      if (newSettings.timerSeconds !== undefined) {
        gameSettings.timerSeconds = Math.max(5, Math.min(300, newSettings.timerSeconds));
      }
      if (newSettings.penaltyEnabled !== undefined) {
        gameSettings.penaltyEnabled = !!newSettings.penaltyEnabled;
      }
      if (newSettings.selectedCategories !== undefined) {
        gameSettings.selectedCategories = newSettings.selectedCategories;
      }
      if (newSettings.selectedTypes !== undefined) {
        gameSettings.selectedTypes = newSettings.selectedTypes;
      }

      io.emit('settingsUpdate', gameSettings);
    });

    socket.on('startGame', (data) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) {
        socket.emit('hostError', 'Not recognized as host.');
        return;
      }

      if (gamePhase !== PHASES.LOBBY) {
        socket.emit('hostError', 'Cannot start game from current state.');
        return;
      }

      const nonHostCount = getNonHostPlayers().length;
      if (nonHostCount < 2) {
        socket.emit('hostError', 'Need at least 2 players to start.');
        return;
      }

      if (getConnectedNonHostPlayers().length < 1) {
        socket.emit('hostError', 'Need at least 1 connected player to start.');
        return;
      }

      // Apply any last-minute settings
      if (data?.settings) {
        Object.assign(gameSettings, data.settings);
      }

      // Validate question count
      buildQuestionPool();
      if (questionPool.length === 0) {
        socket.emit('hostError', 'No questions available with current settings. Try selecting more categories or question types.');
        return;
      }

      gameSettings.questionCount = Math.min(gameSettings.questionCount, questionPool.length);

      // Go to intro
      gamePhase = PHASES.INTRO;
      io.emit('introPhase', getIntroSlides());
    });

    socket.on('host_skip_intro', () => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;
      if (gamePhase === PHASES.INTRO) {
        startGame();
      }
    });

    socket.on('nextQuestion', () => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;

      if (gamePhase === PHASES.REVEAL && currentQuestionIndex < totalQuestionsForGame) {
        startNextQuestion();
      }
    });

    socket.on('revealAnswer', () => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;

      if (gamePhase === PHASES.QUESTION && !gameSettings.timerEnabled) {
        processRoundEnd();
      }
    });

    socket.on('endGameManual', () => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY && gamePhase !== PHASES.LOBBY) {
        resetGameKeepPlayers();
        socket.emit('hostSetupSuccess', {
          questionCount: allQuestions.length,
          categories,
          questionTypes: Object.values(QUESTION_TYPES),
          settings: gameSettings,
          lifetimeScores: loadLifetimeScores()
        });
      }
    });

    socket.on('playAgain', () => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY) {
        resetGameKeepPlayers();
        socket.emit('hostSetupSuccess', {
          questionCount: allQuestions.length,
          categories,
          questionTypes: Object.values(QUESTION_TYPES),
          settings: gameSettings,
          lifetimeScores: loadLifetimeScores()
        });
      }
    });

    socket.on('kickPlayer', ({ playerKey }) => {
      const key = socketIdToKey.get(socket.id);
      if (key !== HOST_KEY) return;

      if (gamePhase !== PHASES.LOBBY) {
        socket.emit('hostError', 'Can only kick players during lobby.');
        return;
      }

      if (!playerKey || !players.has(playerKey) || playerKey === HOST_KEY) return;

      const player = players.get(playerKey);
      if (player.socketId) {
        io.to(player.socketId).emit('kicked', { message: 'You have been removed by the host.' });
        const targetSocket = io.sockets?.get(player.socketId);
        if (targetSocket) targetSocket.disconnect(true);
        socketIdToKey.delete(player.socketId);
      }

      players.delete(playerKey);
      io.emit('playerListUpdate', getPlayerListPayload());
    });

    socket.on('wipeLifetimeScores', () => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY) {
        wipeAllScores();
        io.emit('playerListUpdate', getPlayerListPayload());
        socket.emit('scoresWiped');
      }
    });

    socket.on('host_return_to_menu', () => {
      const key = socketIdToKey.get(socket.id);
      if (key === HOST_KEY) {
        resetToLobby();
        io.emit('returned_to_menu', {});
      }
    });

    // --- Player Events ---
    socket.on('joinGame', (payload) => {
      const nameRaw = (typeof payload === 'string') ? payload : payload?.name;
      let playerKey = (typeof payload === 'object' && payload?.playerKey) ? String(payload.playerKey) : null;
      const normalizedName = normalizeName(nameRaw);
      if (!playerKey) playerKey = `k_${socket.id}`;

      // Rejoin path
      const existing = players.get(playerKey);
      if (existing && !existing.isHost) {
        existing.connected = true;
        existing.socketId = socket.id;
        existing.lastSeen = Date.now();
        socketIdToKey.set(socket.id, playerKey);

        socket.emit('joinSuccess', { name: existing.name, playerKey });
        io.emit('playerListUpdate', getPlayerListPayload());
        syncPlayerState(socket, playerKey);
        return;
      }

      // New join only during lobby
      if (gamePhase !== PHASES.LOBBY) {
        socket.emit('joinError', 'Game already started. Please wait for the next game.');
        return;
      }

      if (!normalizedName || normalizedName.length === 0) {
        socket.emit('joinError', 'Name cannot be empty.');
        return;
      }
      if (normalizedName.length > 15) {
        socket.emit('joinError', 'Name too long (max 15 chars).');
        return;
      }

      // Preset names validation
      if (gameSettings.usePresetNames && gameSettings.presetNames.length > 0) {
        const isValidPreset = gameSettings.presetNames.some(p => normalizeName(p) === normalizedName);
        if (!isValidPreset) {
          socket.emit('joinError', 'Please select a name from the preset list.');
          return;
        }
      }

      // Duplicate check
      const nameTaken = getNonHostPlayers().some(p => p.name === normalizedName && p.key !== playerKey);
      if (nameTaken) {
        socket.emit('joinError', 'Name already taken.');
        return;
      }

      players.set(playerKey, {
        key: playerKey,
        name: normalizedName,
        score: 0,
        correctAnswers: 0,
        totalAnswered: 0,
        isHost: false,
        socketId: socket.id,
        connected: true,
        lastSeen: Date.now()
      });
      socketIdToKey.set(socket.id, playerKey);

      socket.emit('joinSuccess', { name: normalizedName, playerKey });
      io.emit('playerListUpdate', getPlayerListPayload());
    });

    socket.on('submitAnswer', (data) => {
      const playerKey = socketIdToKey.get(socket.id);
      const player = playerKey ? players.get(playerKey) : null;

      if (!player || player.isHost) {
        socket.emit('answerError', 'Not a valid player.');
        return;
      }

      if (gamePhase === PHASES.BONUS_STAGE && bonusState.active) {
        if (!bonusState.tiedPlayers.includes(playerKey)) {
          socket.emit('answerError', 'You are not in the bonus stage.');
          return;
        }
        if (bonusState.bonusAnswers.has(playerKey)) {
          socket.emit('answerError', 'Already answered.');
          return;
        }
        bonusState.bonusAnswers.set(playerKey, { answer: data.answer, timestamp: Date.now() });
        socket.emit('answerAccepted', { answer: data.answer });

        // Check if all bonus players answered
        const allAnswered = bonusState.tiedPlayers.every(k => bonusState.bonusAnswers.has(k));
        if (allAnswered) {
          processBonusRound();
        } else {
          emitToHost('bonusAnswerUpdate', {
            answeredCount: bonusState.bonusAnswers.size,
            total: bonusState.tiedPlayers.length
          });
        }
        return;
      }

      if (gamePhase !== PHASES.QUESTION) {
        socket.emit('answerError', 'Not accepting answers right now.');
        return;
      }

      if (roundAnswers.has(playerKey)) {
        socket.emit('answerError', 'Already answered.');
        return;
      }

      roundAnswers.set(playerKey, { answer: data.answer, timestamp: Date.now() });
      socket.emit('answerAccepted', { answer: data.answer });

      // Notify host
      const eligible = getEligiblePlayerKeys();
      emitToHost('answerUpdate', {
        playerKey: playerKey,
        playerName: player.name,
        answeredCount: roundAnswers.size,
        total: eligible.length
      });

      // Check if all answered
      const allAnswered = eligible.every(k => roundAnswers.has(k));
      if (allAnswered) {
        processRoundEnd();
      }
    });

    socket.on('player_ack_return_to_menu', () => {
      // Acknowledgment from player
    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
      const key = socketIdToKey.get(socket.id);
      if (!key) return;

      socketIdToKey.delete(socket.id);
      const p = players.get(key);
      if (!p) return;

      if (p.isHost) {
        if (p.socketId === socket.id || p.socketId === null) {
          p.connected = false;
          p.socketId = null;
          p.lastSeen = Date.now();
        }
        io.emit('hostDisconnected');
        io.emit('playerListUpdate', getPlayerListPayload());
        return;
      }

      p.connected = false;
      p.socketId = null;
      p.lastSeen = Date.now();

      io.emit('playerListUpdate', getPlayerListPayload());

      // Check if round can complete
      if (gamePhase === PHASES.QUESTION) {
        const eligible = getEligiblePlayerKeys();
        const allAnswered = eligible.every(k => roundAnswers.has(k));
        if (allAnswered && eligible.length > 0) processRoundEnd();
      }

      // Check bonus stage
      if (gamePhase === PHASES.BONUS_STAGE && bonusState.active) {
        const allAnswered = bonusState.tiedPlayers.every(k => bonusState.bonusAnswers.has(k));
        if (allAnswered) processBonusRound();
      }
    });
  });

  // --- API Endpoints ---
  router.post('/api/init-players', (req, res) => {
    const { players: playersArray, settings: initSettings } = req.body || {};
    if (!Array.isArray(playersArray)) {
      return res.status(400).json({ error: 'Invalid players array' });
    }

    console.log('[Trivia] Received', playersArray.length, 'players from launcher');

    if (initSettings) {
      gameSettings.usePresetNames = initSettings.usePresetNames || false;
      gameSettings.presetNames = Array.isArray(initSettings.presetNames)
        ? initSettings.presetNames.map(n => normalizeName(n)).filter(n => n)
        : [];
    }

    for (const p of playersArray) {
      if (!p.key || !p.name) continue;
      if (p.key === HOST_KEY) continue;
      if (players.has(p.key)) continue;

      players.set(p.key, {
        key: p.key,
        name: normalizeName(p.name),
        score: 0,
        correctAnswers: 0,
        totalAnswered: 0,
        isHost: false,
        socketId: null,
        connected: false,
        lastSeen: Date.now()
      });
    }

    io.emit('playerListUpdate', getPlayerListPayload());
    res.json({ ok: true, count: playersArray.length });
  });

  router.post('/api/update-settings', (req, res) => {
    const { usePresetNames, presetNames } = req.body || {};

    if (usePresetNames !== undefined) {
      gameSettings.usePresetNames = usePresetNames;
    }
    if (presetNames !== undefined) {
      gameSettings.presetNames = Array.isArray(presetNames)
        ? presetNames.map(n => normalizeName(n)).filter(n => n)
        : [];
    }

    console.log('[Trivia] Updated settings:', { usePresetNames: gameSettings.usePresetNames });
    res.json({ success: true });
  });

  // --- Cleanup ---
  function cleanup() {
    console.log('[Trivia] Cleaning up...');
    clearTimer();
    players.clear();
    socketIdToKey.clear();
    gamePhase = PHASES.LOBBY;
    currentQuestion = null;
    currentQuestionIndex = 0;
    usedQuestionIds.clear();
    roundAnswers.clear();
    timedOutPlayers.clear();
    lastGameOverPayload = null;
    lastRevealPayload = null;
    bonusState = { active: false, tiedPlayers: [], eliminatedPlayers: [], bonusAnswers: new Map() };
  }

  // Initialize with players from launcher
  if (Array.isArray(initialPlayers)) {
    for (const p of initialPlayers) {
      if (!p.key || !p.name) continue;
      if (p.key === HOST_KEY) continue;
      players.set(p.key, {
        key: p.key,
        name: normalizeName(p.name),
        score: 0,
        correctAnswers: 0,
        totalAnswered: 0,
        isHost: false,
        socketId: null,
        connected: false,
        lastSeen: Date.now()
      });
    }
  }

  console.log('[Trivia] Game initialized');

  return { router, cleanup };
};
