// tap-race.js - Tap Race Mini-Game
// Players tap as fast as possible to push a tug-of-war bar to their side

const MiniGameBase = require('./minigame-base');

class TapRace extends MiniGameBase {
  constructor(config) {
    super(config);

    this.state = {
      progress: 0,        // -100 (player2 wins) to +100 (player1 wins)
      player1Taps: 0,
      player2Taps: 0,
      startTime: null
    };

    this.TARGET_PROGRESS = 100;  // Win threshold
    this.TAP_VALUE = 2;          // Progress per tap
  }

  async start() {
    console.log(`[TapRace] Starting match: ${this.player1.name} vs ${this.player2.name}`);

    this.gameActive = true;
    this.state.startTime = Date.now();

    // Register socket handlers
    this.registerSocketHandlers();

    // Emit initial state to both players
    this.emitToPlayer(this.player1.key, 'taprace:start', {
      opponentName: this.player2.name,
      targetProgress: this.TARGET_PROGRESS,
      tapValue: this.TAP_VALUE
    });

    this.emitToPlayer(this.player2.key, 'taprace:start', {
      opponentName: this.player1.name,
      targetProgress: this.TARGET_PROGRESS,
      tapValue: this.TAP_VALUE
    });

    // Emit spectator view
    this.emitToSpectators('taprace:spectate', {
      player1: this.player1.name,
      player2: this.player2.name,
      progress: this.state.progress
    });

  }

  registerSocketHandlers() {
    // Get socket references
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'taprace:tap', () => this.handleTap(this.player1.key));
    }

    if (this.socket2) {
      this.registerEvent(this.socket2, 'taprace:tap', () => this.handleTap(this.player2.key));
    }
  }

  handleTap(playerKey) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    // Update tap count and progress
    if (playerKey === this.player1.key) {
      this.state.player1Taps++;
      this.state.progress += this.TAP_VALUE;
    } else {
      this.state.player2Taps++;
      this.state.progress -= this.TAP_VALUE;
    }

    // Clamp progress to valid range
    this.state.progress = Math.max(-this.TARGET_PROGRESS, Math.min(this.TARGET_PROGRESS, this.state.progress));

    // Broadcast progress update
    this.broadcastUpdate();

    // Check win condition
    if (this.state.progress >= this.TARGET_PROGRESS) {
      this.endGame(this.player1.key);
    } else if (this.state.progress <= -this.TARGET_PROGRESS) {
      this.endGame(this.player2.key);
    }
  }

  broadcastUpdate() {
    // Send to player 1
    this.emitToPlayer(this.player1.key, 'taprace:update', {
      progress: this.state.progress,
      yourTaps: this.state.player1Taps,
      opponentTaps: this.state.player2Taps
    });

    // Send to player 2
    this.emitToPlayer(this.player2.key, 'taprace:update', {
      progress: -this.state.progress,  // Flip for player 2's perspective
      yourTaps: this.state.player2Taps,
      opponentTaps: this.state.player1Taps
    });

    // Send to spectators
    this.emitToSpectators('taprace:update', {
      progress: this.state.progress,
      player1Taps: this.state.player1Taps,
      player2Taps: this.state.player2Taps,
      player1Name: this.player1.name,
      player2Name: this.player2.name
    });
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;

    const duration = Date.now() - this.state.startTime;
    const loserKey = this.getOpponentKey(winnerKey);
    const winnerTaps = winnerKey === this.player1.key ? this.state.player1Taps : this.state.player2Taps;
    const loserTaps = winnerKey === this.player1.key ? this.state.player2Taps : this.state.player1Taps;

    console.log(`[TapRace] Game ended. Winner: ${this.getPlayerName(winnerKey)} with ${winnerTaps} taps in ${duration}ms`);

    // Notify winner
    this.emitToPlayer(winnerKey, 'taprace:end', {
      result: 'win',
      yourTaps: winnerTaps,
      opponentTaps: loserTaps,
      duration: duration
    });

    // Notify loser
    this.emitToPlayer(loserKey, 'taprace:end', {
      result: 'lose',
      yourTaps: loserTaps,
      opponentTaps: winnerTaps,
      duration: duration
    });

    // Notify spectators
    this.emitToSpectators('taprace:end', {
      winner: this.getPlayerName(winnerKey),
      loser: this.getPlayerName(loserKey),
      winnerTaps: winnerTaps,
      loserTaps: loserTaps,
      duration: duration
    });

    // Declare winner to tournament system
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'taprace',
      player1: {
        name: this.player1.name,
        taps: this.state.player1Taps
      },
      player2: {
        name: this.player2.name,
        taps: this.state.player2Taps
      },
      progress: this.state.progress,
      active: this.gameActive,
      winner: this.winner ? this.getPlayerName(this.winner) : null
    };
  }
}

module.exports = TapRace;
