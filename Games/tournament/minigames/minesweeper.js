// minesweeper.js - Minesweeper Mini-Game
// Shared board, defuse bombs, avoid clearing bombs

const MiniGameBase = require('./minigame-base');

class Minesweeper extends MiniGameBase {
  constructor(config) {
    super(config);

    this.GRID_SIZE = 5;
    this.NUM_BOMBS = config.settings.minesweeperBombCount || 1;

    this.state = {
      board: [], // 5x5 grid with numbers (Manhattan distance to nearest bomb)
      bombPositions: [], // Array of {row, col}
      revealedTiles: [], // Array of {row, col}
      bombsDefused: {
        [this.player1.key]: 0,
        [this.player2.key]: 0
      },
      currentPlayerKey: this.player1.key,
      gameNumber: 1,
      moveHistory: []
    };
  }

  async start() {
    console.log(`[Minesweeper] Starting match: ${this.player1.name} vs ${this.player2.name} (${this.NUM_BOMBS} bomb${this.NUM_BOMBS > 1 ? 's' : ''})`);

    this.gameActive = true;

    // Register socket handlers
    this.registerSocketHandlers();

    // Generate board
    this.generateBoard();

    // Emit initial state
    this.emitToBothPlayers('minesweeper:start', {
      gridSize: this.GRID_SIZE,
      numBombs: this.NUM_BOMBS,
      board: this.getBoardForPlayers(),
      currentPlayer: this.getPlayerName(this.state.currentPlayerKey)
    });

    this.emitToSpectators('minesweeper:start', {
      player1: this.player1.name,
      player2: this.player2.name,
      gridSize: this.GRID_SIZE,
      numBombs: this.NUM_BOMBS
    });

    this.broadcastTurnUpdate();
  }

  registerSocketHandlers() {
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'minesweeper:action', (data) => this.handleAction(this.player1.key, data));
    }

    if (this.socket2) {
      this.registerEvent(this.socket2, 'minesweeper:action', (data) => this.handleAction(this.player2.key, data));
    }
  }

  generateBoard() {
    // Create empty board
    this.state.board = [];
    for (let row = 0; row < this.GRID_SIZE; row++) {
      this.state.board[row] = new Array(this.GRID_SIZE).fill(0);
    }

    // Place bombs randomly
    this.state.bombPositions = [];
    const positions = [];
    for (let row = 0; row < this.GRID_SIZE; row++) {
      for (let col = 0; col < this.GRID_SIZE; col++) {
        positions.push({ row, col });
      }
    }

    // Shuffle and select bomb positions
    positions.sort(() => Math.random() - 0.5);
    for (let i = 0; i < this.NUM_BOMBS; i++) {
      this.state.bombPositions.push(positions[i]);
    }

    // Calculate Manhattan distances to nearest bomb for each tile
    for (let row = 0; row < this.GRID_SIZE; row++) {
      for (let col = 0; col < this.GRID_SIZE; col++) {
        // Check if this is a bomb
        const isBomb = this.state.bombPositions.some(b => b.row === row && b.col === col);
        if (isBomb) {
          this.state.board[row][col] = -1; // -1 indicates bomb
        } else {
          // Calculate distance to nearest bomb
          let minDistance = Infinity;
          for (const bomb of this.state.bombPositions) {
            const distance = Math.abs(row - bomb.row) + Math.abs(col - bomb.col);
            minDistance = Math.min(minDistance, distance);
          }
          this.state.board[row][col] = minDistance;
        }
      }
    }

    this.state.revealedTiles = [];

    console.log(`[Minesweeper] Generated board with ${this.NUM_BOMBS} bomb(s) at:`, this.state.bombPositions);
  }

  getBoardForPlayers() {
    // Return board with unrevealed tiles hidden
    const playerBoard = [];
    for (let row = 0; row < this.GRID_SIZE; row++) {
      playerBoard[row] = [];
      for (let col = 0; col < this.GRID_SIZE; col++) {
        const isRevealed = this.state.revealedTiles.some(t => t.row === row && t.col === col);
        if (isRevealed) {
          const value = this.state.board[row][col];
          playerBoard[row][col] = value === -1 ? 'B' : value; // 'B' for bomb
        } else {
          playerBoard[row][col] = '?'; // Hidden
        }
      }
    }
    return playerBoard;
  }

  handleAction(playerKey, data) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    if (playerKey !== this.state.currentPlayerKey) {
      console.log(`[Minesweeper] ${this.getPlayerName(playerKey)} tried to act out of turn`);
      return;
    }

    const { row, col, action } = data; // action: 'clear' or 'defuse'

    // Validate coordinates
    if (row < 0 || row >= this.GRID_SIZE || col < 0 || col >= this.GRID_SIZE) {
      this.emitToPlayer(playerKey, 'minesweeper:error', {
        message: 'Invalid coordinates'
      });
      return;
    }

    // Check if already revealed
    const alreadyRevealed = this.state.revealedTiles.some(t => t.row === row && t.col === col);
    if (alreadyRevealed) {
      this.emitToPlayer(playerKey, 'minesweeper:error', {
        message: 'Tile already revealed'
      });
      return;
    }

    // Check what's at this position
    const tileValue = this.state.board[row][col];
    const isBomb = tileValue === -1;

    console.log(`[Minesweeper] ${this.getPlayerName(playerKey)} ${action}s (${row}, ${col}) - ${isBomb ? 'BOMB' : 'safe (distance ' + tileValue + ')'}`);

    // Reveal tile
    this.state.revealedTiles.push({ row, col });

    // Record move
    this.state.moveHistory.push({
      playerKey: playerKey,
      row: row,
      col: col,
      action: action,
      isBomb: isBomb
    });

    if (action === 'clear') {
      if (isBomb) {
        // Cleared a bomb - LOSE instantly
        this.handlePlayerLoss(playerKey, 'cleared_bomb', row, col);
      } else {
        // Cleared safe tile - switch turns
        this.emitToPlayer(playerKey, 'minesweeper:clear_success', {
          row: row,
          col: col,
          distance: tileValue,
          board: this.getBoardForPlayers()
        });

        this.emitToPlayer(this.getOpponentKey(playerKey), 'minesweeper:opponent_clear', {
          row: row,
          col: col,
          distance: tileValue,
          board: this.getBoardForPlayers()
        });

        this.emitToSpectators('minesweeper:clear', {
          player: this.getPlayerName(playerKey),
          row: row,
          col: col,
          distance: tileValue
        });

        // Switch turns
        this.state.currentPlayerKey = this.getOpponentKey(playerKey);

        this.setTimeout(() => {
          this.broadcastTurnUpdate();
        }, 1000);
      }

    } else if (action === 'defuse') {
      if (isBomb) {
        // Defused a bomb - gain 1 point, continue playing
        this.state.bombsDefused[playerKey]++;

        console.log(`[Minesweeper] ${this.getPlayerName(playerKey)} defused a bomb! (${this.state.bombsDefused[playerKey]}/${this.NUM_BOMBS})`);

        this.emitToPlayer(playerKey, 'minesweeper:defuse_success', {
          row: row,
          col: col,
          bombsDefused: this.state.bombsDefused[playerKey],
          board: this.getBoardForPlayers()
        });

        this.emitToPlayer(this.getOpponentKey(playerKey), 'minesweeper:opponent_defuse', {
          row: row,
          col: col,
          opponentBombsDefused: this.state.bombsDefused[playerKey],
          board: this.getBoardForPlayers()
        });

        this.emitToSpectators('minesweeper:defuse', {
          player: this.getPlayerName(playerKey),
          row: row,
          col: col,
          bombsDefused: this.state.bombsDefused[playerKey]
        });

        // Check win conditions
        if (this.NUM_BOMBS === 1) {
          // 1 bomb: first to defuse wins
          this.setTimeout(() => {
            this.endGame(playerKey);
          }, 2000);
        } else {
          // Multiple bombs: check if all bombs defused
          const totalDefused = this.state.bombsDefused[this.player1.key] + this.state.bombsDefused[this.player2.key];
          if (totalDefused >= this.NUM_BOMBS) {
            // All bombs defused - determine winner
            this.setTimeout(() => {
              this.resolveMultiBombGame();
            }, 2000);
          } else {
            // Continue playing, same player's turn
            this.setTimeout(() => {
              this.broadcastTurnUpdate();
            }, 1500);
          }
        }

      } else {
        // Defused safe tile - LOSE instantly
        this.handlePlayerLoss(playerKey, 'defused_safe', row, col);
      }
    }
  }

  handlePlayerLoss(playerKey, reason, row, col) {
    const winnerKey = this.getOpponentKey(playerKey);

    console.log(`[Minesweeper] ${this.getPlayerName(playerKey)} LOST (${reason} at ${row},${col})`);

    this.emitToPlayer(playerKey, 'minesweeper:lose', {
      reason: reason,
      row: row,
      col: col,
      board: this.getBoardForPlayers()
    });

    this.emitToPlayer(winnerKey, 'minesweeper:opponent_lose', {
      reason: reason,
      row: row,
      col: col,
      board: this.getBoardForPlayers()
    });

    this.emitToSpectators('minesweeper:lose', {
      loser: this.getPlayerName(playerKey),
      reason: reason,
      row: row,
      col: col
    });

    this.setTimeout(() => {
      this.endGame(winnerKey);
    }, 2000);
  }

  resolveMultiBombGame() {
    const p1Defused = this.state.bombsDefused[this.player1.key];
    const p2Defused = this.state.bombsDefused[this.player2.key];

    console.log(`[Minesweeper] All ${this.NUM_BOMBS} bombs defused. P1=${p1Defused}, P2=${p2Defused}`);

    if (p1Defused > p2Defused) {
      this.endGame(this.player1.key);
    } else if (p2Defused > p1Defused) {
      this.endGame(this.player2.key);
    } else {
      // Tie - restart with new board
      this.handleTie();
    }
  }

  handleTie() {
    console.log(`[Minesweeper] Game ${this.state.gameNumber} tied (${this.state.bombsDefused[this.player1.key]}-${this.state.bombsDefused[this.player2.key]}), restarting...`);

    this.state.gameNumber++;

    this.emitToBothPlayers('minesweeper:tie', {
      message: 'Tie! Restarting with new board...',
      gameNumber: this.state.gameNumber
    });

    this.emitToSpectators('minesweeper:tie', {
      gameNumber: this.state.gameNumber
    });

    // Reset for new board
    this.setTimeout(() => {
      this.state.bombsDefused[this.player1.key] = 0;
      this.state.bombsDefused[this.player2.key] = 0;
      this.state.moveHistory = [];
      // Alternate starting player
      this.state.currentPlayerKey = this.state.currentPlayerKey === this.player1.key
        ? this.player2.key
        : this.player1.key;

      this.generateBoard();

      this.emitToBothPlayers('minesweeper:restart', {
        board: this.getBoardForPlayers(),
        gameNumber: this.state.gameNumber,
        firstPlayer: this.getPlayerName(this.state.currentPlayerKey)
      });

      this.broadcastTurnUpdate();
    }, 3000);
  }

  broadcastTurnUpdate() {
    const currentPlayer = this.getPlayerName(this.state.currentPlayerKey);

    this.emitToPlayer(this.player1.key, 'minesweeper:turn', {
      yourTurn: this.state.currentPlayerKey === this.player1.key,
      currentPlayer: currentPlayer,
      yourBombsDefused: this.state.bombsDefused[this.player1.key],
      opponentBombsDefused: this.state.bombsDefused[this.player2.key],
      board: this.getBoardForPlayers()
    });

    this.emitToPlayer(this.player2.key, 'minesweeper:turn', {
      yourTurn: this.state.currentPlayerKey === this.player2.key,
      currentPlayer: currentPlayer,
      yourBombsDefused: this.state.bombsDefused[this.player2.key],
      opponentBombsDefused: this.state.bombsDefused[this.player1.key],
      board: this.getBoardForPlayers()
    });

    this.emitToSpectators('minesweeper:turn', {
      currentPlayer: currentPlayer,
      player1BombsDefused: this.state.bombsDefused[this.player1.key],
      player2BombsDefused: this.state.bombsDefused[this.player2.key]
    });
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;
    const loserKey = this.getOpponentKey(winnerKey);

    console.log(`[Minesweeper] Match ended. Winner: ${this.getPlayerName(winnerKey)} (${this.state.bombsDefused[winnerKey]}-${this.state.bombsDefused[loserKey]})`);

    // Notify players
    this.emitToPlayer(winnerKey, 'minesweeper:end', {
      result: 'win',
      bombsDefused: this.state.bombsDefused[winnerKey],
      opponentBombsDefused: this.state.bombsDefused[loserKey],
      gamesPlayed: this.state.gameNumber
    });

    this.emitToPlayer(loserKey, 'minesweeper:end', {
      result: 'lose',
      bombsDefused: this.state.bombsDefused[loserKey],
      opponentBombsDefused: this.state.bombsDefused[winnerKey],
      gamesPlayed: this.state.gameNumber
    });

    // Notify spectators
    this.emitToSpectators('minesweeper:end', {
      winner: this.getPlayerName(winnerKey),
      winnerBombsDefused: this.state.bombsDefused[winnerKey],
      loserBombsDefused: this.state.bombsDefused[loserKey],
      gamesPlayed: this.state.gameNumber
    });

    // Declare winner to tournament
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'minesweeper',
      player1: {
        name: this.player1.name,
        bombsDefused: this.state.bombsDefused[this.player1.key]
      },
      player2: {
        name: this.player2.name,
        bombsDefused: this.state.bombsDefused[this.player2.key]
      },
      currentPlayer: this.getPlayerName(this.state.currentPlayerKey),
      numBombs: this.NUM_BOMBS,
      gameNumber: this.state.gameNumber,
      board: this.getBoardForPlayers(),
      active: this.gameActive
    };
  }
}

module.exports = Minesweeper;
