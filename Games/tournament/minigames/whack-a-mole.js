// whack-a-mole.js - Whack-a-Mole Mini-Game
// Tap popups as fast as possible to score points

const MiniGameBase = require('./minigame-base');

class WhackAMole extends MiniGameBase {
  constructor(config) {
    super(config);

    this.POPUP_DURATION = (config.settings.whackMolePopupDuration || 0.5) * 1000; // Convert to ms
    this.SCORE_LEAD = config.settings.whackMoleScoreLead || 5;
    this.MAX_SIMULTANEOUS = 3;
    this.SPAWN_INTERVAL = 800; // Spawn new popup every 800ms

    this.state = {
      scores: {
        [this.player1.key]: 0,
        [this.player2.key]: 0
      },
      activeTargets: {
        [this.player1.key]: [], // Array of { id, gridPosition, spawnTime, expiryTime }
        [this.player2.key]: []
      },
      targetIdCounter: 0
    };
  }

  async start() {
    console.log(`[WhackAMole] Starting match: ${this.player1.name} vs ${this.player2.name}`);

    this.gameActive = true;

    // Register socket handlers
    this.registerSocketHandlers();

    // Emit initial state
    this.emitToBothPlayers('whackmole:start', {
      popupDuration: this.POPUP_DURATION,
      scoreLead: this.SCORE_LEAD
    });

    // Start spawning targets for both players
    this.startSpawning();

  }

  registerSocketHandlers() {
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'whackmole:hit', (data) => this.handleHit(this.player1.key, data));
    }

    if (this.socket2) {
      this.registerEvent(this.socket2, 'whackmole:hit', (data) => this.handleHit(this.player2.key, data));
    }
  }

  startSpawning() {
    // Spawn targets periodically for both players
    const spawnInterval = this.setInterval(() => {
      if (!this.gameActive) return;

      this.spawnTarget(this.player1.key);
      this.spawnTarget(this.player2.key);
    }, this.SPAWN_INTERVAL);
  }

  spawnTarget(playerKey) {
    if (!this.validateGameActive()) return;

    const activeTargets = this.state.activeTargets[playerKey];

    // Don't spawn if already at max
    if (activeTargets.length >= this.MAX_SIMULTANEOUS) return;

    // Generate random grid position (3x3 grid, positions 0-8)
    const gridPosition = Math.floor(Math.random() * 9);

    const now = Date.now();
    const target = {
      id: this.state.targetIdCounter++,
      gridPosition: gridPosition,
      spawnTime: now,
      expiryTime: now + this.POPUP_DURATION
    };

    activeTargets.push(target);

    // Emit target to player
    this.emitToPlayer(playerKey, 'whackmole:target', {
      targetId: target.id,
      gridPosition: target.gridPosition,
      duration: this.POPUP_DURATION
    });

    // Emit to spectators
    this.emitToSpectators('whackmole:target', {
      player: this.getPlayerName(playerKey),
      gridPosition: target.gridPosition
    });

    // Auto-remove target after duration
    this.setTimeout(() => {
      this.removeTarget(playerKey, target.id, false);
    }, this.POPUP_DURATION);
  }

  removeTarget(playerKey, targetId, wasHit) {
    const activeTargets = this.state.activeTargets[playerKey];
    const index = activeTargets.findIndex(t => t.id === targetId);

    if (index === -1) return; // Already removed

    activeTargets.splice(index, 1);

    if (!wasHit) {
      // Target expired without being hit - emit miss event
      this.emitToPlayer(playerKey, 'whackmole:miss', {
        targetId: targetId
      });
    }
  }

  handleHit(playerKey, data) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    const { targetId } = data;
    const activeTargets = this.state.activeTargets[playerKey];
    const target = activeTargets.find(t => t.id === targetId);

    if (!target) {
      console.log(`[WhackAMole] ${this.getPlayerName(playerKey)} hit invalid target ${targetId}`);
      return;
    }

    // Calculate reaction time
    const reactionTime = Date.now() - target.spawnTime;

    // Valid hit!
    this.state.scores[playerKey]++;
    console.log(`[WhackAMole] ${this.getPlayerName(playerKey)} hit target ${targetId} in ${reactionTime}ms, score: ${this.state.scores[playerKey]}`);

    // Remove target
    this.removeTarget(playerKey, targetId, true);

    // Emit success to player
    this.emitToPlayer(playerKey, 'whackmole:hit_success', {
      targetId: targetId,
      score: this.state.scores[playerKey],
      reactionTime: reactionTime,
      opponentScore: this.state.scores[this.getOpponentKey(playerKey)]
    });

    // Emit to spectators
    this.emitToSpectators('whackmole:hit_success', {
      player: this.getPlayerName(playerKey),
      score: this.state.scores[playerKey],
      player1Score: this.state.scores[this.player1.key],
      player2Score: this.state.scores[this.player2.key]
    });

    // Check win condition
    const opponentScore = this.state.scores[this.getOpponentKey(playerKey)];
    const scoreDiff = this.state.scores[playerKey] - opponentScore;

    if (scoreDiff >= this.SCORE_LEAD) {
      this.endGame(playerKey);
    }
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;
    const loserKey = this.getOpponentKey(winnerKey);

    console.log(`[WhackAMole] Match ended. Winner: ${this.getPlayerName(winnerKey)} (${this.state.scores[winnerKey]}-${this.state.scores[loserKey]})`);

    // Notify players
    this.emitToPlayer(winnerKey, 'whackmole:end', {
      result: 'win',
      finalScore: this.state.scores[winnerKey],
      opponentScore: this.state.scores[loserKey]
    });

    this.emitToPlayer(loserKey, 'whackmole:end', {
      result: 'lose',
      finalScore: this.state.scores[loserKey],
      opponentScore: this.state.scores[winnerKey]
    });

    // Notify spectators
    this.emitToSpectators('whackmole:end', {
      winner: this.getPlayerName(winnerKey),
      winnerScore: this.state.scores[winnerKey],
      loserScore: this.state.scores[loserKey]
    });

    // Declare winner to tournament
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'whack-a-mole',
      player1: {
        name: this.player1.name,
        score: this.state.scores[this.player1.key],
        activeTargets: this.state.activeTargets[this.player1.key].length
      },
      player2: {
        name: this.player2.name,
        score: this.state.scores[this.player2.key],
        activeTargets: this.state.activeTargets[this.player2.key].length
      },
      scoreLead: this.SCORE_LEAD,
      active: this.gameActive
    };
  }
}

module.exports = WhackAMole;
