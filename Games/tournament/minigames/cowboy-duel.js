// cowboy-duel.js - Cowboy Duel Mini-Game
// Wait for "FIRE!" signal, then tap first to win. Tap early = misfire = lose.

const MiniGameBase = require('./minigame-base');

class CowboyDuel extends MiniGameBase {
  constructor(config) {
    super(config);

    this.state = {
      roundsWon: {
        [this.player1.key]: 0,
        [this.player2.key]: 0
      },
      currentRound: 0,
      roundActive: false,
      signalTime: null,
      responses: {
        [this.player1.key]: null,
        [this.player2.key]: null
      }
    };

    this.ROUNDS_TO_WIN = 3;
    this.MIN_WAIT_MS = (config.settings.cowboyMinWaitSeconds || 3) * 1000;
    this.MAX_WAIT_MS = this.MIN_WAIT_MS + 2000; // Add 2 seconds random
  }

  async start() {
    console.log(`[CowboyDuel] Starting match: ${this.player1.name} vs ${this.player2.name}`);

    this.gameActive = true;

    // Register socket handlers
    this.registerSocketHandlers();

    // Emit initial state
    this.emitToBothPlayers('cowboy:start', {
      roundsToWin: this.ROUNDS_TO_WIN,
      minWaitSeconds: this.MIN_WAIT_MS / 1000
    });

    // Start first round
    this.setTimeout(() => {
      this.startRound();
    }, 2000);

  }

  registerSocketHandlers() {
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'cowboy:tap', () => this.handleTap(this.player1.key));
    }
    if (this.socket2) {
      this.registerEvent(this.socket2, 'cowboy:tap', () => this.handleTap(this.player2.key));
    }
  }

  startRound() {
    if (!this.gameActive) return;

    this.state.currentRound++;
    this.state.roundActive = true;
    this.state.signalTime = null;
    this.state.responses = {
      [this.player1.key]: null,
      [this.player2.key]: null
    };

    console.log(`[CowboyDuel] Starting round ${this.state.currentRound}`);

    // Notify players to wait
    this.emitToBothPlayers('cowboy:round_start', {
      roundNumber: this.state.currentRound,
      message: 'Wait for the signal...'
    });

    // Random delay before fire signal
    const waitTime = this.MIN_WAIT_MS + Math.random() * (this.MAX_WAIT_MS - this.MIN_WAIT_MS);

    this.setTimeout(() => {
      if (!this.state.roundActive) return;

      this.state.signalTime = Date.now();
      console.log(`[CowboyDuel] FIRE signal at ${this.state.signalTime}`);

      // Send FIRE signal
      this.emitToBothPlayers('cowboy:fire_signal', {
        message: 'FIRE!',
        timestamp: this.state.signalTime
      });

      // Auto-resolve after 3 seconds if no one taps
      this.setTimeout(() => {
        if (this.state.roundActive &&
            !this.state.responses[this.player1.key] &&
            !this.state.responses[this.player2.key]) {
          console.log(`[CowboyDuel] No one tapped, restarting round`);
          this.startRound();
        }
      }, 3000);
    }, waitTime);
  }

  handleTap(playerKey) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;
    if (!this.state.roundActive) return;

    // Already responded
    if (this.state.responses[playerKey] !== null) return;

    const tapTime = Date.now();
    const opponentKey = this.getOpponentKey(playerKey);

    // Check if signal has been sent
    if (this.state.signalTime === null) {
      // Tapped before signal = MISFIRE = instant lose
      console.log(`[CowboyDuel] ${this.getPlayerName(playerKey)} misfired!`);

      this.state.responses[playerKey] = { time: tapTime, misfire: true };
      this.state.roundActive = false;

      // Notify misfire
      this.emitToPlayer(playerKey, 'cowboy:misfire', {
        message: 'MISFIRE! You shot too early!'
      });

      this.emitToPlayer(opponentKey, 'cowboy:opponent_misfire', {
        message: `${this.getPlayerName(playerKey)} misfired!`
      });

      // Opponent wins round
      this.resolveRound(opponentKey);
      return;
    }

    // Valid tap after signal - first to fire wins instantly
    const reactionTime = tapTime - this.state.signalTime;
    this.state.responses[playerKey] = { time: tapTime, reactionTime: reactionTime, misfire: false };
    this.state.roundActive = false;

    console.log(`[CowboyDuel] ${this.getPlayerName(playerKey)} tapped at ${reactionTime}ms - wins the round!`);

    // Notify opponent that this player fired first (disable their button)
    this.emitToPlayer(opponentKey, 'cowboy:opponent_fired', {
      message: `${this.getPlayerName(playerKey)} fired first!`
    });

    // First to fire wins the round
    this.resolveRound(playerKey);
  }

  resolveRound(winnerKey) {
    const loserKey = this.getOpponentKey(winnerKey);
    this.state.roundsWon[winnerKey]++;

    const winnerResponse = this.state.responses[winnerKey];
    const loserResponse = this.state.responses[loserKey];

    console.log(`[CowboyDuel] Round ${this.state.currentRound} winner: ${this.getPlayerName(winnerKey)}`);

    // Notify players
    this.emitToPlayer(winnerKey, 'cowboy:round_result', {
      result: 'win',
      yourTime: winnerResponse?.reactionTime || null,
      opponentTime: loserResponse?.reactionTime || null,
      roundsWon: this.state.roundsWon[winnerKey],
      roundsNeeded: this.ROUNDS_TO_WIN
    });

    this.emitToPlayer(loserKey, 'cowboy:round_result', {
      result: 'lose',
      yourTime: loserResponse?.reactionTime || null,
      opponentTime: winnerResponse?.reactionTime || null,
      roundsWon: this.state.roundsWon[loserKey],
      roundsNeeded: this.ROUNDS_TO_WIN
    });

    // Notify spectators
    this.emitToSpectators('cowboy:round_result', {
      winner: this.getPlayerName(winnerKey),
      winnerTime: winnerResponse?.reactionTime || 'instant',
      loser: this.getPlayerName(loserKey),
      loserTime: loserResponse?.reactionTime || 'misfire',
      score: `${this.state.roundsWon[this.player1.key]}-${this.state.roundsWon[this.player2.key]}`
    });

    // Check if match is over
    if (this.state.roundsWon[winnerKey] >= this.ROUNDS_TO_WIN) {
      this.endGame(winnerKey);
    } else {
      // Start next round
      this.setTimeout(() => {
        this.startRound();
      }, 3000);
    }
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;
    const loserKey = this.getOpponentKey(winnerKey);

    console.log(`[CowboyDuel] Match ended. Winner: ${this.getPlayerName(winnerKey)} (${this.state.roundsWon[winnerKey]}-${this.state.roundsWon[loserKey]})`);

    // Notify players
    this.emitToPlayer(winnerKey, 'cowboy:end', {
      result: 'win',
      finalScore: `${this.state.roundsWon[winnerKey]}-${this.state.roundsWon[loserKey]}`,
      roundsWon: this.state.roundsWon[winnerKey],
      opponentRoundsWon: this.state.roundsWon[loserKey]
    });

    this.emitToPlayer(loserKey, 'cowboy:end', {
      result: 'lose',
      finalScore: `${this.state.roundsWon[loserKey]}-${this.state.roundsWon[winnerKey]}`,
      roundsWon: this.state.roundsWon[loserKey],
      opponentRoundsWon: this.state.roundsWon[winnerKey]
    });

    // Notify spectators
    this.emitToSpectators('cowboy:end', {
      winner: this.getPlayerName(winnerKey),
      loser: this.getPlayerName(loserKey),
      finalScore: `${this.state.roundsWon[winnerKey]}-${this.state.roundsWon[loserKey]}`
    });

    // Declare winner to tournament
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'cowboy-duel',
      player1: {
        name: this.player1.name,
        roundsWon: this.state.roundsWon[this.player1.key]
      },
      player2: {
        name: this.player2.name,
        roundsWon: this.state.roundsWon[this.player2.key]
      },
      currentRound: this.state.currentRound,
      roundActive: this.state.roundActive,
      roundsToWin: this.ROUNDS_TO_WIN,
      active: this.gameActive
    };
  }
}

module.exports = CowboyDuel;
