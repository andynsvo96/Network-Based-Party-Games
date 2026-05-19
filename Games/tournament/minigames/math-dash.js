// math-dash.js - Math Dash Mini-Game
// Answer math questions correctly to reach target score first

const MiniGameBase = require('./minigame-base');

class MathDash extends MiniGameBase {
  constructor(config) {
    super(config);

    this.POINTS_TO_WIN = config.settings.mathDashPointsToWin || 10;

    this.state = {
      scores: {
        [this.player1.key]: 0,
        [this.player2.key]: 0
      },
      consecutiveCorrect: {
        [this.player1.key]: 0,
        [this.player2.key]: 0
      },
      currentQuestions: {
        [this.player1.key]: null,
        [this.player2.key]: null
      }
    };

    this.OPERATIONS = ['+', '-', '*', '/'];
  }

  async start() {
    console.log(`[MathDash] Starting match: ${this.player1.name} vs ${this.player2.name}`);

    this.gameActive = true;

    // Register socket handlers
    this.registerSocketHandlers();

    // Emit initial state
    this.emitToBothPlayers('mathdash:start', {
      pointsToWin: this.POINTS_TO_WIN
    });

    // Send first questions
    this.sendNewQuestion(this.player1.key);
    this.sendNewQuestion(this.player2.key);

  }

  registerSocketHandlers() {
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'mathdash:answer', (data) => this.handleAnswer(this.player1.key, data));
    }

    if (this.socket2) {
      this.registerEvent(this.socket2, 'mathdash:answer', (data) => this.handleAnswer(this.player2.key, data));
    }
  }

  getDifficulty(playerKey) {
    const consecutive = this.state.consecutiveCorrect[playerKey];
    if (consecutive >= 9) return 4; // Difficulty 4 for last question
    if (consecutive >= 6) return 3;
    if (consecutive >= 3) return 2;
    return 1;
  }

  generateQuestion(difficulty) {
    switch (difficulty) {
      case 1:
        return this.generateDifficulty1();
      case 2:
        return this.generateDifficulty2();
      case 3:
        return this.generateDifficulty3();
      case 4:
        return this.generateDifficulty4();
      default:
        return this.generateDifficulty1();
    }
  }

  generateDifficulty1() {
    // One operation: a op b
    const a = this.randomInt(1, 12);
    const b = this.randomInt(1, 12);
    const op = this.randomOperation();

    let expression, answer;

    if (op === '/') {
      // For division, ensure clean result
      const result = this.randomInt(1, 12);
      expression = `${result * b} ${op} ${b}`;
      answer = result;
    } else {
      expression = `${a} ${op} ${b}`;
      answer = this.evaluate(`${a} ${op} ${b}`);
    }

    return { expression, answer, difficulty: 1 };
  }

  generateDifficulty2() {
    // Two operations: a op1 b op2 c
    const a = this.randomInt(1, 10);
    const b = this.randomInt(1, 10);
    const c = this.randomInt(1, 10);
    const op1 = this.randomOperation();
    const op2 = this.randomOperation();

    const expression = `${a} ${op1} ${b} ${op2} ${c}`;
    const answer = Math.round(this.evaluate(expression));

    return { expression, answer, difficulty: 2 };
  }

  generateDifficulty3() {
    // Three operations: a op1 b op2 c op3 d
    const a = this.randomInt(1, 8);
    const b = this.randomInt(1, 8);
    const c = this.randomInt(1, 8);
    const d = this.randomInt(1, 8);
    const op1 = this.randomOperation();
    const op2 = this.randomOperation();
    const op3 = this.randomOperation();

    const expression = `${a} ${op1} ${b} ${op2} ${c} ${op3} ${d}`;
    const answer = Math.round(this.evaluate(expression));

    return { expression, answer, difficulty: 3 };
  }

  generateDifficulty4() {
    // Three operations with parentheses: (a op1 b) op2 c op3 d
    const a = this.randomInt(1, 8);
    const b = this.randomInt(1, 8);
    const c = this.randomInt(1, 8);
    const d = this.randomInt(1, 8);
    const op1 = this.randomOperation();
    const op2 = this.randomOperation();
    const op3 = this.randomOperation();

    const expression = `(${a} ${op1} ${b}) ${op2} ${c} ${op3} ${d}`;
    const answer = Math.round(this.evaluate(expression));

    return { expression, answer, difficulty: 4 };
  }

  randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  randomOperation() {
    return this.OPERATIONS[Math.floor(Math.random() * this.OPERATIONS.length)];
  }

  evaluate(expression) {
    // Safe evaluation using Function constructor
    try {
      // Replace × with * and ÷ with /
      const sanitized = expression.replace(/×/g, '*').replace(/÷/g, '/');
      return Function(`"use strict"; return (${sanitized})`)();
    } catch (e) {
      console.error('[MathDash] Error evaluating:', expression, e);
      return 0;
    }
  }

  sendNewQuestion(playerKey) {
    const difficulty = this.getDifficulty(playerKey);
    const question = this.generateQuestion(difficulty);

    this.state.currentQuestions[playerKey] = question;

    console.log(`[MathDash] Sending to ${this.getPlayerName(playerKey)}: ${question.expression} = ${question.answer} (Difficulty ${difficulty})`);

    this.emitToPlayer(playerKey, 'mathdash:question', {
      question: question.expression,
      difficulty: difficulty,
      score: this.state.scores[playerKey],
      opponentScore: this.state.scores[this.getOpponentKey(playerKey)]
    });
  }

  handleAnswer(playerKey, data) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    const { answer } = data;
    const currentQuestion = this.state.currentQuestions[playerKey];

    if (!currentQuestion) {
      console.log(`[MathDash] No current question for ${this.getPlayerName(playerKey)}`);
      return;
    }

    const userAnswer = parseFloat(answer);
    const correctAnswer = currentQuestion.answer;
    const isCorrect = Math.abs(userAnswer - correctAnswer) < 0.01; // Allow small floating point errors

    console.log(`[MathDash] ${this.getPlayerName(playerKey)} answered ${userAnswer}, correct: ${correctAnswer}, is correct: ${isCorrect}`);

    if (isCorrect) {
      // Correct answer
      this.state.scores[playerKey]++;
      this.state.consecutiveCorrect[playerKey]++;

      this.emitToPlayer(playerKey, 'mathdash:correct', {
        score: this.state.scores[playerKey],
        consecutiveCorrect: this.state.consecutiveCorrect[playerKey]
      });

      // Notify spectators
      this.emitToSpectators('mathdash:correct', {
        player: this.getPlayerName(playerKey),
        score: this.state.scores[playerKey],
        question: currentQuestion.expression
      });

      // Check for win
      if (this.state.scores[playerKey] >= this.POINTS_TO_WIN) {
        this.endGame(playerKey);
        return;
      }

      // Send new question
      this.sendNewQuestion(playerKey);

    } else {
      // Incorrect answer
      this.state.scores[playerKey] = Math.max(0, this.state.scores[playerKey] - 1);
      this.state.consecutiveCorrect[playerKey] = 0;

      this.emitToPlayer(playerKey, 'mathdash:incorrect', {
        correctAnswer: correctAnswer,
        score: this.state.scores[playerKey],
        penalty: -1
      });

      // Notify spectators
      this.emitToSpectators('mathdash:incorrect', {
        player: this.getPlayerName(playerKey),
        question: currentQuestion.expression,
        correctAnswer: correctAnswer,
        score: this.state.scores[playerKey]
      });

      // Send new question
      this.sendNewQuestion(playerKey);
    }

    // Broadcast score update
    this.broadcastScores();
  }

  broadcastScores() {
    this.emitToSpectators('mathdash:scores', {
      player1: {
        name: this.player1.name,
        score: this.state.scores[this.player1.key]
      },
      player2: {
        name: this.player2.name,
        score: this.state.scores[this.player2.key]
      },
      targetScore: this.POINTS_TO_WIN
    });
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;
    const loserKey = this.getOpponentKey(winnerKey);

    console.log(`[MathDash] Match ended. Winner: ${this.getPlayerName(winnerKey)} (${this.state.scores[winnerKey]}-${this.state.scores[loserKey]})`);

    // Notify players
    this.emitToPlayer(winnerKey, 'mathdash:end', {
      result: 'win',
      finalScore: this.state.scores[winnerKey],
      opponentScore: this.state.scores[loserKey]
    });

    this.emitToPlayer(loserKey, 'mathdash:end', {
      result: 'lose',
      finalScore: this.state.scores[loserKey],
      opponentScore: this.state.scores[winnerKey]
    });

    // Notify spectators
    this.emitToSpectators('mathdash:end', {
      winner: this.getPlayerName(winnerKey),
      winnerScore: this.state.scores[winnerKey],
      loserScore: this.state.scores[loserKey]
    });

    // Declare winner to tournament
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'math-dash',
      player1: {
        name: this.player1.name,
        score: this.state.scores[this.player1.key],
        consecutiveCorrect: this.state.consecutiveCorrect[this.player1.key]
      },
      player2: {
        name: this.player2.name,
        score: this.state.scores[this.player2.key],
        consecutiveCorrect: this.state.consecutiveCorrect[this.player2.key]
      },
      targetScore: this.POINTS_TO_WIN,
      active: this.gameActive
    };
  }
}

module.exports = MathDash;
