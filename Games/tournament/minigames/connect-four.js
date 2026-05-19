// connect-four.js - Connect Four Mini-Game
// Classic Connect Four: first to connect 4 in a row/column/diagonal wins

const MiniGameBase = require('./minigame-base');

class ConnectFour extends MiniGameBase {
  constructor(config) {
    super(config);

    this.ROWS = 6;
    this.COLS = 7;

    this.state = {
      board: this.createEmptyBoard(),
      currentPlayerKey: this.player1.key,
      moveHistory: [],
      gameNumber: 1 // Track number of restarts due to ties
    };

    // Player symbols
    this.symbols = {
      [this.player1.key]: 'red',
      [this.player2.key]: 'yellow'
    };
  }

  createEmptyBoard() {
    const board = [];
    for (let row = 0; row < this.ROWS; row++) {
      board[row] = new Array(this.COLS).fill(null);
    }
    return board;
  }

  async start() {
    console.log(`[ConnectFour] Starting match: ${this.player1.name} vs ${this.player2.name}`);

    this.gameActive = true;

    // Register socket handlers
    this.registerSocketHandlers();

    // Emit initial state
    this.emitToBothPlayers('connectfour:start', {
      rows: this.ROWS,
      cols: this.COLS,
      yourSymbol: null, // Will be set per player below
      opponentSymbol: null,
      firstPlayer: this.getPlayerName(this.state.currentPlayerKey)
    });

    // Send player-specific info
    this.emitToPlayer(this.player1.key, 'connectfour:player_info', {
      yourSymbol: this.symbols[this.player1.key],
      opponentSymbol: this.symbols[this.player2.key],
      yourTurn: this.state.currentPlayerKey === this.player1.key
    });

    this.emitToPlayer(this.player2.key, 'connectfour:player_info', {
      yourSymbol: this.symbols[this.player2.key],
      opponentSymbol: this.symbols[this.player1.key],
      yourTurn: this.state.currentPlayerKey === this.player2.key
    });

    // Emit to spectators
    this.emitToSpectators('connectfour:start', {
      player1: this.player1.name,
      player2: this.player2.name,
      player1Symbol: this.symbols[this.player1.key],
      player2Symbol: this.symbols[this.player2.key]
    });

  }

  registerSocketHandlers() {
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'connectfour:place', (data) => this.handlePlace(this.player1.key, data));
    }

    if (this.socket2) {
      this.registerEvent(this.socket2, 'connectfour:place', (data) => this.handlePlace(this.player2.key, data));
    }
  }

  handlePlace(playerKey, data) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    // Check if it's this player's turn
    if (playerKey !== this.state.currentPlayerKey) {
      console.log(`[ConnectFour] ${this.getPlayerName(playerKey)} tried to play out of turn`);
      return;
    }

    const { col } = data;

    // Validate column
    if (col < 0 || col >= this.COLS) {
      console.log(`[ConnectFour] Invalid column: ${col}`);
      return;
    }

    // Find lowest empty row in column
    let row = -1;
    for (let r = this.ROWS - 1; r >= 0; r--) {
      if (this.state.board[r][col] === null) {
        row = r;
        break;
      }
    }

    if (row === -1) {
      // Column is full
      this.emitToPlayer(playerKey, 'connectfour:invalid_move', {
        reason: 'Column is full'
      });
      return;
    }

    // Place piece
    const symbol = this.symbols[playerKey];
    this.state.board[row][col] = symbol;
    this.state.moveHistory.push({ playerKey, row, col, symbol });

    console.log(`[ConnectFour] ${this.getPlayerName(playerKey)} placed ${symbol} at (${row}, ${col})`);

    // Broadcast move
    this.broadcastMove(row, col, symbol, playerKey);

    // Check for win
    if (this.checkWin(row, col)) {
      this.endGame(playerKey);
      return;
    }

    // Check for tie (board full)
    if (this.isBoardFull()) {
      this.handleTie();
      return;
    }

    // Switch turns
    this.state.currentPlayerKey = this.getOpponentKey(playerKey);
    this.broadcastTurnChange();
  }

  broadcastMove(row, col, symbol, playerKey) {
    // Send to both players
    this.emitToBothPlayers('connectfour:move', {
      row: row,
      col: col,
      symbol: symbol,
      player: this.getPlayerName(playerKey),
      nextPlayer: this.getPlayerName(this.getOpponentKey(playerKey))
    });

    // Send to spectators
    this.emitToSpectators('connectfour:move', {
      row: row,
      col: col,
      symbol: symbol,
      player: this.getPlayerName(playerKey),
      board: this.state.board
    });
  }

  broadcastTurnChange() {
    const currentPlayer = this.getPlayerName(this.state.currentPlayerKey);

    this.emitToPlayer(this.player1.key, 'connectfour:turn', {
      yourTurn: this.state.currentPlayerKey === this.player1.key,
      currentPlayer: currentPlayer
    });

    this.emitToPlayer(this.player2.key, 'connectfour:turn', {
      yourTurn: this.state.currentPlayerKey === this.player2.key,
      currentPlayer: currentPlayer
    });

    this.emitToSpectators('connectfour:turn', {
      currentPlayer: currentPlayer
    });
  }

  checkWin(row, col) {
    const symbol = this.state.board[row][col];
    if (!symbol) return false;

    // Check all four directions: horizontal, vertical, diagonal /, diagonal \
    const directions = [
      { dr: 0, dc: 1 },  // Horizontal
      { dr: 1, dc: 0 },  // Vertical
      { dr: 1, dc: 1 },  // Diagonal \
      { dr: 1, dc: -1 }  // Diagonal /
    ];

    for (const { dr, dc } of directions) {
      let count = 1; // Count the placed piece

      // Check positive direction
      for (let i = 1; i < 4; i++) {
        const r = row + dr * i;
        const c = col + dc * i;
        if (r < 0 || r >= this.ROWS || c < 0 || c >= this.COLS) break;
        if (this.state.board[r][c] !== symbol) break;
        count++;
      }

      // Check negative direction
      for (let i = 1; i < 4; i++) {
        const r = row - dr * i;
        const c = col - dc * i;
        if (r < 0 || r >= this.ROWS || c < 0 || c >= this.COLS) break;
        if (this.state.board[r][c] !== symbol) break;
        count++;
      }

      if (count >= 4) {
        return true;
      }
    }

    return false;
  }

  isBoardFull() {
    // Check top row - if any cell is empty, board not full
    for (let col = 0; col < this.COLS; col++) {
      if (this.state.board[0][col] === null) {
        return false;
      }
    }
    return true;
  }

  handleTie() {
    console.log(`[ConnectFour] Game ${this.state.gameNumber} ended in a tie, restarting...`);

    this.state.gameNumber++;

    // Notify players of tie and restart
    this.emitToBothPlayers('connectfour:tie', {
      message: 'Board full! Restarting game...',
      gameNumber: this.state.gameNumber
    });

    this.emitToSpectators('connectfour:tie', {
      message: 'Board full! Restarting game...',
      gameNumber: this.state.gameNumber
    });

    // Reset board after delay
    this.setTimeout(() => {
      this.resetBoard();
    }, 2000);
  }

  resetBoard() {
    if (!this.gameActive) return;

    this.state.board = this.createEmptyBoard();
    this.state.moveHistory = [];
    // Keep same starting player or alternate? Let's alternate
    this.state.currentPlayerKey = this.state.currentPlayerKey === this.player1.key
      ? this.player2.key
      : this.player1.key;

    console.log(`[ConnectFour] Board reset. ${this.getPlayerName(this.state.currentPlayerKey)} starts game ${this.state.gameNumber}`);

    // Notify players
    this.emitToBothPlayers('connectfour:reset', {
      gameNumber: this.state.gameNumber,
      firstPlayer: this.getPlayerName(this.state.currentPlayerKey)
    });

    this.broadcastTurnChange();
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;
    const loserKey = this.getOpponentKey(winnerKey);

    console.log(`[ConnectFour] Match ended. Winner: ${this.getPlayerName(winnerKey)} after ${this.state.gameNumber} game(s)`);

    // Notify players
    this.emitToPlayer(winnerKey, 'connectfour:end', {
      result: 'win',
      gamesPlayed: this.state.gameNumber
    });

    this.emitToPlayer(loserKey, 'connectfour:end', {
      result: 'lose',
      gamesPlayed: this.state.gameNumber
    });

    // Notify spectators
    this.emitToSpectators('connectfour:end', {
      winner: this.getPlayerName(winnerKey),
      gamesPlayed: this.state.gameNumber
    });

    // Declare winner to tournament
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'connect-four',
      player1: {
        name: this.player1.name,
        symbol: this.symbols[this.player1.key]
      },
      player2: {
        name: this.player2.name,
        symbol: this.symbols[this.player2.key]
      },
      board: this.state.board,
      currentPlayer: this.getPlayerName(this.state.currentPlayerKey),
      gameNumber: this.state.gameNumber,
      active: this.gameActive
    };
  }
}

module.exports = ConnectFour;
