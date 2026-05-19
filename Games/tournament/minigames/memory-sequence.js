// memory-sequence.js - Memory Sequence Mini-Game
// Remember emoji positions and select them correctly

const MiniGameBase = require('./minigame-base');

class MemorySequence extends MiniGameBase {
  constructor(config) {
    super(config);

    this.REVEAL_TIME = (config.settings.memoryRevealTime || 5) * 1000; // Convert to ms

    this.state = {
      boardSize: 3, // Start with 3x3
      emojiPositions: {}, // { position: emoji }
      currentPlayerKey: this.player1.key,
      mistakes: {
        [this.player1.key]: 0,
        [this.player2.key]: 0
      },
      consecutiveMistakes: {
        [this.player1.key]: 0,
        [this.player2.key]: 0
      },
      revealedPositions: {
        [this.player1.key]: [],
        [this.player2.key]: []
      },
      phase: 'reveal', // 'reveal' or 'playing'
      roundNumber: 1
    };

    this.EMOJIS = ['🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥝', '🥥', '🍍', '🥭', '🍏', '🍐', '🥑', '🍆', '🥔', '🥕', '🌽', '🌶️', '🥒', '🥬', '🍅'];
  }

  async start() {
    console.log(`[MemorySequence] Starting match: ${this.player1.name} vs ${this.player2.name}`);

    this.gameActive = true;

    // Register socket handlers
    this.registerSocketHandlers();

    // Generate first board
    this.generateBoard();

    // Emit initial state
    this.emitToBothPlayers('memory:start', {
      boardSize: this.state.boardSize,
      revealTime: this.REVEAL_TIME
    });

    // Start reveal phase
    this.startRevealPhase();
  }

  registerSocketHandlers() {
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'memory:select', (data) => this.handleSelect(this.player1.key, data));
    }

    if (this.socket2) {
      this.registerEvent(this.socket2, 'memory:select', (data) => this.handleSelect(this.player2.key, data));
    }
  }

  generateBoard() {
    const totalPositions = this.state.boardSize * this.state.boardSize;
    this.state.emojiPositions = {};

    // Randomly assign emojis to positions
    const shuffledEmojis = [...this.EMOJIS].sort(() => Math.random() - 0.5);

    for (let i = 0; i < totalPositions; i++) {
      this.state.emojiPositions[i] = shuffledEmojis[i % this.EMOJIS.length];
    }

    console.log(`[MemorySequence] Generated ${this.state.boardSize}x${this.state.boardSize} board`);
  }

  startRevealPhase() {
    this.state.phase = 'reveal';
    this.state.revealedPositions[this.player1.key] = [];
    this.state.revealedPositions[this.player2.key] = [];

    console.log(`[MemorySequence] Round ${this.state.roundNumber}: Revealing board for ${this.REVEAL_TIME}ms`);

    // Send reveal to both players
    this.emitToBothPlayers('memory:reveal', {
      boardSize: this.state.boardSize,
      emojiPositions: this.state.emojiPositions,
      revealTime: this.REVEAL_TIME,
      roundNumber: this.state.roundNumber
    });

    // Send to spectators
    this.emitToSpectators('memory:reveal', {
      player1: this.player1.name,
      player2: this.player2.name,
      boardSize: this.state.boardSize,
      emojiPositions: this.state.emojiPositions,
      roundNumber: this.state.roundNumber
    });

    // After reveal time, start playing phase
    this.setTimeout(() => {
      this.startPlayingPhase();
    }, this.REVEAL_TIME);
  }

  startPlayingPhase() {
    this.state.phase = 'playing';

    console.log(`[MemorySequence] Playing phase started. ${this.getPlayerName(this.state.currentPlayerKey)} goes first`);

    // Hide emojis, players must remember
    this.emitToBothPlayers('memory:play', {
      currentPlayer: this.getPlayerName(this.state.currentPlayerKey)
    });

    this.broadcastTurnUpdate();
  }

  handleSelect(playerKey, data) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    if (this.state.phase !== 'playing') {
      console.log(`[MemorySequence] ${this.getPlayerName(playerKey)} tried to select during reveal phase`);
      return;
    }

    if (playerKey !== this.state.currentPlayerKey) {
      console.log(`[MemorySequence] ${this.getPlayerName(playerKey)} tried to select out of turn`);
      return;
    }

    const { position } = data;

    // Validate position
    const totalPositions = this.state.boardSize * this.state.boardSize;
    if (position < 0 || position >= totalPositions) {
      console.log(`[MemorySequence] Invalid position: ${position}`);
      return;
    }

    // Check if already revealed by this player
    if (this.state.revealedPositions[playerKey].includes(position)) {
      this.emitToPlayer(playerKey, 'memory:already_revealed', {
        position: position
      });
      return;
    }

    // Reveal the emoji at this position
    const emoji = this.state.emojiPositions[position];
    this.state.revealedPositions[playerKey].push(position);

    console.log(`[MemorySequence] ${this.getPlayerName(playerKey)} selected position ${position}: ${emoji}`);

    // Broadcast selection
    this.emitToPlayer(playerKey, 'memory:selected', {
      position: position,
      emoji: emoji,
      revealedPositions: this.state.revealedPositions[playerKey]
    });

    this.emitToSpectators('memory:selected', {
      player: this.getPlayerName(playerKey),
      position: position,
      emoji: emoji
    });

    // Check if correct (not already revealed by opponent)
    const opponentKey = this.getOpponentKey(playerKey);
    const isCorrect = !this.state.revealedPositions[opponentKey].includes(position);

    if (isCorrect) {
      // Correct selection!
      this.state.consecutiveMistakes[playerKey] = 0;

      this.emitToPlayer(playerKey, 'memory:correct', {
        position: position,
        emoji: emoji
      });

      this.emitToSpectators('memory:correct', {
        player: this.getPlayerName(playerKey),
        position: position
      });

      // Check if all positions revealed
      const allPositions = this.state.boardSize * this.state.boardSize;
      const totalRevealed = this.state.revealedPositions[playerKey].length + this.state.revealedPositions[opponentKey].length;

      if (totalRevealed >= allPositions) {
        // Tie - increase board size
        this.handleTie();
      } else {
        // Continue, same player's turn
        this.broadcastTurnUpdate();
      }

    } else {
      // Mistake - selected position already revealed by opponent
      this.state.mistakes[playerKey]++;
      this.state.consecutiveMistakes[playerKey]++;

      console.log(`[MemorySequence] ${this.getPlayerName(playerKey)} made a mistake (${this.state.consecutiveMistakes[playerKey]} consecutive)`);

      this.emitToPlayer(playerKey, 'memory:mistake', {
        position: position,
        consecutiveMistakes: this.state.consecutiveMistakes[playerKey]
      });

      this.emitToSpectators('memory:mistake', {
        player: this.getPlayerName(playerKey),
        position: position,
        consecutiveMistakes: this.state.consecutiveMistakes[playerKey]
      });

      // Check if player loses (2 consecutive mistakes)
      if (this.state.consecutiveMistakes[playerKey] >= 2) {
        this.endGame(opponentKey);
        return;
      }

      // Switch turns
      this.state.currentPlayerKey = opponentKey;
      this.broadcastTurnUpdate();
    }
  }

  broadcastTurnUpdate() {
    const currentPlayer = this.getPlayerName(this.state.currentPlayerKey);

    this.emitToPlayer(this.player1.key, 'memory:turn', {
      yourTurn: this.state.currentPlayerKey === this.player1.key,
      currentPlayer: currentPlayer,
      yourRevealed: this.state.revealedPositions[this.player1.key].length,
      opponentRevealed: this.state.revealedPositions[this.player2.key].length
    });

    this.emitToPlayer(this.player2.key, 'memory:turn', {
      yourTurn: this.state.currentPlayerKey === this.player2.key,
      currentPlayer: currentPlayer,
      yourRevealed: this.state.revealedPositions[this.player2.key].length,
      opponentRevealed: this.state.revealedPositions[this.player1.key].length
    });

    this.emitToSpectators('memory:turn', {
      currentPlayer: currentPlayer,
      player1Revealed: this.state.revealedPositions[this.player1.key].length,
      player2Revealed: this.state.revealedPositions[this.player2.key].length
    });
  }

  handleTie() {
    console.log(`[MemorySequence] Round ${this.state.roundNumber} tied - all positions revealed`);

    // Increase board size: 3x3 -> 4x4 -> 5x5 -> 5x5 (stay at 5x5)
    if (this.state.boardSize === 3) {
      this.state.boardSize = 4;
    } else if (this.state.boardSize === 4) {
      this.state.boardSize = 5;
    }
    // else stay at 5x5

    this.state.roundNumber++;

    // Notify players
    this.emitToBothPlayers('memory:tie', {
      message: 'All positions revealed! Increasing board size...',
      newBoardSize: this.state.boardSize,
      roundNumber: this.state.roundNumber
    });

    this.emitToSpectators('memory:tie', {
      newBoardSize: this.state.boardSize,
      roundNumber: this.state.roundNumber
    });

    // Generate new board and restart
    this.setTimeout(() => {
      this.generateBoard();
      this.startRevealPhase();
    }, 3000);
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;
    const loserKey = this.getOpponentKey(winnerKey);

    console.log(`[MemorySequence] Match ended. Winner: ${this.getPlayerName(winnerKey)} (Loser made 2 consecutive mistakes)`);

    // Notify players
    this.emitToPlayer(winnerKey, 'memory:end', {
      result: 'win',
      roundsPlayed: this.state.roundNumber,
      yourMistakes: this.state.mistakes[winnerKey],
      opponentMistakes: this.state.mistakes[loserKey]
    });

    this.emitToPlayer(loserKey, 'memory:end', {
      result: 'lose',
      reason: '2 consecutive mistakes',
      roundsPlayed: this.state.roundNumber,
      yourMistakes: this.state.mistakes[loserKey],
      opponentMistakes: this.state.mistakes[winnerKey]
    });

    // Notify spectators
    this.emitToSpectators('memory:end', {
      winner: this.getPlayerName(winnerKey),
      loser: this.getPlayerName(loserKey),
      roundsPlayed: this.state.roundNumber
    });

    // Declare winner to tournament
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'memory-sequence',
      player1: {
        name: this.player1.name,
        revealed: this.state.revealedPositions[this.player1.key].length,
        mistakes: this.state.mistakes[this.player1.key],
        consecutiveMistakes: this.state.consecutiveMistakes[this.player1.key]
      },
      player2: {
        name: this.player2.name,
        revealed: this.state.revealedPositions[this.player2.key].length,
        mistakes: this.state.mistakes[this.player2.key],
        consecutiveMistakes: this.state.consecutiveMistakes[this.player2.key]
      },
      boardSize: this.state.boardSize,
      phase: this.state.phase,
      currentPlayer: this.getPlayerName(this.state.currentPlayerKey),
      roundNumber: this.state.roundNumber,
      active: this.gameActive
    };
  }
}

module.exports = MemorySequence;
