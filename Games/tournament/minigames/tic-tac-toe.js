// tic-tac-toe.js - Tic Tac Toe Mini-Game
// Classic 3x3 grid, first to win 3 rounds wins the match

const MiniGameBase = require('./minigame-base');

class TicTacToe extends MiniGameBase {
  constructor(config) {
    super(config);

    this.ROUNDS_TO_WIN = config.settings.ticTacToeWins || 3;

    this.state = {
      board: this.createEmptyBoard(),
      currentTurn: this.player1.key,
      roundNumber: 1,
      roundsWon: {
        [this.player1.key]: 0,
        [this.player2.key]: 0
      },
      symbols: {
        [this.player1.key]: 'X',
        [this.player2.key]: 'O'
      },
      roundActive: true
    };
  }

  createEmptyBoard() {
    return Array(3).fill(null).map(() => Array(3).fill(null));
  }

  async start() {
    console.log(`[TicTacToe] Starting match: ${this.player1.name} vs ${this.player2.name}`);

    this.gameActive = true;

    // Register socket handlers
    this.registerSocketHandlers();

    // Emit initial state
    this.emitToPlayer(this.player1.key, 'tictactoe:start', {
      yourSymbol: 'X',
      opponentSymbol: 'O',
      roundsToWin: this.ROUNDS_TO_WIN,
      yourTurn: true
    });

    this.emitToPlayer(this.player2.key, 'tictactoe:start', {
      yourSymbol: 'O',
      opponentSymbol: 'X',
      roundsToWin: this.ROUNDS_TO_WIN,
      yourTurn: false
    });

    // Send initial board state
    this.broadcastBoardState();
  }

  registerSocketHandlers() {
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'tictactoe:place', (data) => this.handlePlace(this.player1.key, data));
    }

    if (this.socket2) {
      this.registerEvent(this.socket2, 'tictactoe:place', (data) => this.handlePlace(this.player2.key, data));
    }
  }

  handlePlace(playerKey, data) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;
    if (!this.state.roundActive) return;

    const { row, col } = data;

    // Validate it's player's turn
    if (this.state.currentTurn !== playerKey) {
      console.log(`[TicTacToe] ${this.getPlayerName(playerKey)} tried to play out of turn`);
      return;
    }

    // Validate position
    if (row < 0 || row > 2 || col < 0 || col > 2) {
      console.log(`[TicTacToe] Invalid position: ${row},${col}`);
      return;
    }

    // Check if position is empty
    if (this.state.board[row][col] !== null) {
      console.log(`[TicTacToe] Position ${row},${col} already occupied`);
      this.emitToPlayer(playerKey, 'tictactoe:invalid_move', {
        message: 'That position is already taken'
      });
      return;
    }

    // Place symbol
    const symbol = this.state.symbols[playerKey];
    this.state.board[row][col] = symbol;

    console.log(`[TicTacToe] ${this.getPlayerName(playerKey)} placed ${symbol} at ${row},${col}`);

    // Switch turn
    this.state.currentTurn = this.getOpponentKey(playerKey);

    // Broadcast updated board
    this.broadcastBoardState();

    // Check for win
    const winner = this.checkWinner();
    if (winner) {
      this.endRound(winner);
      return;
    }

    // Check for tie
    if (this.isBoardFull()) {
      this.endRound('tie');
      return;
    }
  }

  checkWinner() {
    const board = this.state.board;

    // Check rows
    for (let row = 0; row < 3; row++) {
      if (board[row][0] && board[row][0] === board[row][1] && board[row][1] === board[row][2]) {
        return this.getPlayerBySymbol(board[row][0]);
      }
    }

    // Check columns
    for (let col = 0; col < 3; col++) {
      if (board[0][col] && board[0][col] === board[1][col] && board[1][col] === board[2][col]) {
        return this.getPlayerBySymbol(board[0][col]);
      }
    }

    // Check diagonals
    if (board[0][0] && board[0][0] === board[1][1] && board[1][1] === board[2][2]) {
      return this.getPlayerBySymbol(board[0][0]);
    }

    if (board[0][2] && board[0][2] === board[1][1] && board[1][1] === board[2][0]) {
      return this.getPlayerBySymbol(board[0][2]);
    }

    return null;
  }

  isBoardFull() {
    return this.state.board.every(row => row.every(cell => cell !== null));
  }

  getPlayerBySymbol(symbol) {
    if (this.state.symbols[this.player1.key] === symbol) return this.player1.key;
    if (this.state.symbols[this.player2.key] === symbol) return this.player2.key;
    return null;
  }

  endRound(result) {
    this.state.roundActive = false;

    if (result === 'tie') {
      console.log(`[TicTacToe] Round ${this.state.roundNumber} ended in a tie`);

      // Notify players of tie
      this.emitToBothPlayers('tictactoe:round_tie', {
        message: 'Round tied! Starting new round...',
        score: `${this.state.roundsWon[this.player1.key]}-${this.state.roundsWon[this.player2.key]}`
      });

      // Start new round after delay
      this.setTimeout(() => {
        this.startNewRound();
      }, 2000);
      return;
    }

    // Someone won the round
    const winnerKey = result;
    const loserKey = this.getOpponentKey(winnerKey);
    this.state.roundsWon[winnerKey]++;

    console.log(`[TicTacToe] Round ${this.state.roundNumber} winner: ${this.getPlayerName(winnerKey)}`);

    // Notify players
    this.emitToPlayer(winnerKey, 'tictactoe:round_win', {
      result: 'win',
      roundsWon: this.state.roundsWon[winnerKey],
      roundsNeeded: this.ROUNDS_TO_WIN
    });

    this.emitToPlayer(loserKey, 'tictactoe:round_win', {
      result: 'lose',
      roundsWon: this.state.roundsWon[loserKey],
      roundsNeeded: this.ROUNDS_TO_WIN
    });

    // Notify spectators
    this.emitToSpectators('tictactoe:round_win', {
      winner: this.getPlayerName(winnerKey),
      score: `${this.state.roundsWon[this.player1.key]}-${this.state.roundsWon[this.player2.key]}`
    });

    // Check if match is over
    if (this.state.roundsWon[winnerKey] >= this.ROUNDS_TO_WIN) {
      this.setTimeout(() => {
        this.endGame(winnerKey);
      }, 2000);
    } else {
      // Start new round
      this.setTimeout(() => {
        this.startNewRound();
      }, 2000);
    }
  }

  startNewRound() {
    if (!this.gameActive) return;

    this.state.roundNumber++;
    this.state.board = this.createEmptyBoard();
    this.state.roundActive = true;

    // Alternate who goes first
    this.state.currentTurn = this.state.roundNumber % 2 === 1 ? this.player1.key : this.player2.key;

    console.log(`[TicTacToe] Starting round ${this.state.roundNumber}`);

    // Notify players with per-player round data
    this.emitToPlayer(this.player1.key, 'tictactoe:new_round', {
      roundNumber: this.state.roundNumber,
      yourRoundsWon: this.state.roundsWon[this.player1.key],
      opponentRoundsWon: this.state.roundsWon[this.player2.key]
    });
    this.emitToPlayer(this.player2.key, 'tictactoe:new_round', {
      roundNumber: this.state.roundNumber,
      yourRoundsWon: this.state.roundsWon[this.player2.key],
      opponentRoundsWon: this.state.roundsWon[this.player1.key]
    });

    this.broadcastBoardState();
  }

  broadcastBoardState() {
    // Send to player 1
    this.emitToPlayer(this.player1.key, 'tictactoe:update', {
      board: this.state.board,
      yourTurn: this.state.currentTurn === this.player1.key,
      score: `${this.state.roundsWon[this.player1.key]}-${this.state.roundsWon[this.player2.key]}`
    });

    // Send to player 2
    this.emitToPlayer(this.player2.key, 'tictactoe:update', {
      board: this.state.board,
      yourTurn: this.state.currentTurn === this.player2.key,
      score: `${this.state.roundsWon[this.player2.key]}-${this.state.roundsWon[this.player1.key]}`
    });

    // Send to spectators
    this.emitToSpectators('tictactoe:update', {
      board: this.state.board,
      currentPlayer: this.getPlayerName(this.state.currentTurn),
      score: `${this.state.roundsWon[this.player1.key]}-${this.state.roundsWon[this.player2.key]}`,
      player1Name: this.player1.name,
      player2Name: this.player2.name
    });
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;
    const loserKey = this.getOpponentKey(winnerKey);

    console.log(`[TicTacToe] Match ended. Winner: ${this.getPlayerName(winnerKey)} (${this.state.roundsWon[winnerKey]}-${this.state.roundsWon[loserKey]})`);

    // Notify players
    this.emitToPlayer(winnerKey, 'tictactoe:match_end', {
      result: 'win',
      finalScore: `${this.state.roundsWon[winnerKey]}-${this.state.roundsWon[loserKey]}`
    });

    this.emitToPlayer(loserKey, 'tictactoe:match_end', {
      result: 'lose',
      finalScore: `${this.state.roundsWon[loserKey]}-${this.state.roundsWon[winnerKey]}`
    });

    // Notify spectators
    this.emitToSpectators('tictactoe:match_end', {
      winner: this.getPlayerName(winnerKey),
      finalScore: `${this.state.roundsWon[winnerKey]}-${this.state.roundsWon[loserKey]}`
    });

    // Declare winner to tournament
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'tic-tac-toe',
      player1: {
        name: this.player1.name,
        symbol: this.state.symbols[this.player1.key],
        roundsWon: this.state.roundsWon[this.player1.key]
      },
      player2: {
        name: this.player2.name,
        symbol: this.state.symbols[this.player2.key],
        roundsWon: this.state.roundsWon[this.player2.key]
      },
      board: this.state.board,
      currentTurn: this.getPlayerName(this.state.currentTurn),
      roundNumber: this.state.roundNumber,
      roundsToWin: this.ROUNDS_TO_WIN,
      active: this.gameActive
    };
  }
}

module.exports = TicTacToe;
