// battleship.js - Battleship Mini-Game
// Place 5 ships on a 5x5 grid and sink opponent's fleet

const MiniGameBase = require('./minigame-base');

class Battleship extends MiniGameBase {
  constructor(config) {
    super(config);

    this.GRID_SIZE = 5;
    this.NUM_SHIPS = 5;

    this.state = {
      phase: 'placement', // 'placement', 'battle'
      boards: {
        [this.player1.key]: this.createEmptyBoard(),
        [this.player2.key]: this.createEmptyBoard()
      },
      ships: {
        [this.player1.key]: [], // Array of {row, col} positions
        [this.player2.key]: []
      },
      hits: {
        [this.player1.key]: [], // Ships hit by player1 (opponent's ships)
        [this.player2.key]: []
      },
      misses: {
        [this.player1.key]: [], // Misses by player1
        [this.player2.key]: []
      },
      placementComplete: {
        [this.player1.key]: false,
        [this.player2.key]: false
      },
      currentPlayerKey: null,
      moveHistory: []
    };
  }

  createEmptyBoard() {
    const board = [];
    for (let row = 0; row < this.GRID_SIZE; row++) {
      board[row] = new Array(this.GRID_SIZE).fill(null);
    }
    return board;
  }

  async start() {
    console.log(`[Battleship] Starting match: ${this.player1.name} vs ${this.player2.name}`);

    this.gameActive = true;

    // Register socket handlers
    this.registerSocketHandlers();

    // Emit initial state
    this.emitToBothPlayers('battleship:start', {
      gridSize: this.GRID_SIZE,
      numShips: this.NUM_SHIPS,
      phase: 'placement'
    });

    this.emitToSpectators('battleship:start', {
      player1: this.player1.name,
      player2: this.player2.name,
      gridSize: this.GRID_SIZE,
      numShips: this.NUM_SHIPS
    });

  }

  registerSocketHandlers() {
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'battleship:place_ships', (data) => this.handlePlaceShips(this.player1.key, data));
      this.registerEvent(this.socket1, 'battleship:fire', (data) => this.handleFire(this.player1.key, data));
    }

    if (this.socket2) {
      this.registerEvent(this.socket2, 'battleship:place_ships', (data) => this.handlePlaceShips(this.player2.key, data));
      this.registerEvent(this.socket2, 'battleship:fire', (data) => this.handleFire(this.player2.key, data));
    }
  }

  handlePlaceShips(playerKey, data) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    if (this.state.phase !== 'placement') {
      console.log(`[Battleship] ${this.getPlayerName(playerKey)} tried to place ships during battle phase`);
      return;
    }

    if (this.state.placementComplete[playerKey]) {
      console.log(`[Battleship] ${this.getPlayerName(playerKey)} already placed ships`);
      return;
    }

    const { ships } = data; // Array of {row, col} positions

    // Validate ships
    if (!Array.isArray(ships) || ships.length !== this.NUM_SHIPS) {
      this.emitToPlayer(playerKey, 'battleship:placement_error', {
        message: `Must place exactly ${this.NUM_SHIPS} ships`
      });
      return;
    }

    // Check for duplicates and valid positions
    const positions = new Set();
    for (const ship of ships) {
      const { row, col } = ship;

      if (row < 0 || row >= this.GRID_SIZE || col < 0 || col >= this.GRID_SIZE) {
        this.emitToPlayer(playerKey, 'battleship:placement_error', {
          message: 'Invalid ship position'
        });
        return;
      }

      const key = `${row},${col}`;
      if (positions.has(key)) {
        this.emitToPlayer(playerKey, 'battleship:placement_error', {
          message: 'Ships cannot overlap'
        });
        return;
      }
      positions.add(key);
    }

    // Valid placement
    this.state.ships[playerKey] = ships;
    this.state.placementComplete[playerKey] = true;

    // Mark ships on board
    for (const ship of ships) {
      this.state.boards[playerKey][ship.row][ship.col] = 'ship';
    }

    console.log(`[Battleship] ${this.getPlayerName(playerKey)} placed ${ships.length} ships`);

    this.emitToPlayer(playerKey, 'battleship:placement_complete', {
      ships: ships
    });

    // Check if both players have placed ships
    if (this.state.placementComplete[this.player1.key] && this.state.placementComplete[this.player2.key]) {
      // Determine who goes first (whoever placed ships first)
      // For simplicity, player1 goes first
      this.state.currentPlayerKey = this.player1.key;

      this.setTimeout(() => {
        this.startBattle();
      }, 1000);
    } else {
      // Notify waiting for opponent
      this.emitToPlayer(playerKey, 'battleship:waiting', {
        message: 'Waiting for opponent to place ships...'
      });
    }
  }

  startBattle() {
    this.state.phase = 'battle';

    console.log(`[Battleship] Battle phase started. ${this.getPlayerName(this.state.currentPlayerKey)} goes first`);

    this.emitToBothPlayers('battleship:battle_start', {
      firstPlayer: this.getPlayerName(this.state.currentPlayerKey)
    });

    this.emitToSpectators('battleship:battle_start', {
      firstPlayer: this.getPlayerName(this.state.currentPlayerKey)
    });

    this.broadcastTurnUpdate();

  }

  handleFire(playerKey, data) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    if (this.state.phase !== 'battle') {
      console.log(`[Battleship] ${this.getPlayerName(playerKey)} tried to fire during placement phase`);
      return;
    }

    if (playerKey !== this.state.currentPlayerKey) {
      console.log(`[Battleship] ${this.getPlayerName(playerKey)} tried to fire out of turn`);
      return;
    }

    const { row, col } = data;

    // Validate coordinates
    if (row < 0 || row >= this.GRID_SIZE || col < 0 || col >= this.GRID_SIZE) {
      this.emitToPlayer(playerKey, 'battleship:fire_error', {
        message: 'Invalid coordinates'
      });
      return;
    }

    // Check if already fired at this position
    const alreadyHit = this.state.hits[playerKey].some(h => h.row === row && h.col === col);
    const alreadyMissed = this.state.misses[playerKey].some(m => m.row === row && m.col === col);

    if (alreadyHit || alreadyMissed) {
      this.emitToPlayer(playerKey, 'battleship:fire_error', {
        message: 'Already fired at this position'
      });
      return;
    }

    // Check opponent's board
    const opponentKey = this.getOpponentKey(playerKey);
    const opponentShips = this.state.ships[opponentKey];
    const isHit = opponentShips.some(ship => ship.row === row && ship.col === col);

    console.log(`[Battleship] ${this.getPlayerName(playerKey)} fires at (${row}, ${col}) - ${isHit ? 'HIT' : 'MISS'}`);

    if (isHit) {
      // Hit!
      this.state.hits[playerKey].push({ row, col });

      this.emitToPlayer(playerKey, 'battleship:hit', {
        row: row,
        col: col,
        hitsRemaining: this.NUM_SHIPS - this.state.hits[playerKey].length
      });

      this.emitToPlayer(opponentKey, 'battleship:your_ship_hit', {
        row: row,
        col: col,
        shipsRemaining: this.NUM_SHIPS - this.state.hits[playerKey].length
      });

      this.emitToSpectators('battleship:hit', {
        attacker: this.getPlayerName(playerKey),
        defender: this.getPlayerName(opponentKey),
        row: row,
        col: col,
        attackerHits: this.state.hits[playerKey].length,
        defenderShipsRemaining: this.NUM_SHIPS - this.state.hits[playerKey].length
      });

      // Check for win
      if (this.state.hits[playerKey].length >= this.NUM_SHIPS) {
        this.setTimeout(() => {
          this.endGame(playerKey);
        }, 2000);
        return;
      }

    } else {
      // Miss
      this.state.misses[playerKey].push({ row, col });

      this.emitToPlayer(playerKey, 'battleship:miss', {
        row: row,
        col: col
      });

      this.emitToPlayer(opponentKey, 'battleship:opponent_miss', {
        row: row,
        col: col
      });

      this.emitToSpectators('battleship:miss', {
        attacker: this.getPlayerName(playerKey),
        row: row,
        col: col
      });
    }

    // Record move
    this.state.moveHistory.push({
      playerKey: playerKey,
      row: row,
      col: col,
      result: isHit ? 'hit' : 'miss'
    });

    // Switch turns
    this.state.currentPlayerKey = opponentKey;

    this.setTimeout(() => {
      this.broadcastTurnUpdate();
    }, 1500);
  }

  broadcastTurnUpdate() {
    const currentPlayer = this.getPlayerName(this.state.currentPlayerKey);

    this.emitToPlayer(this.player1.key, 'battleship:turn', {
      yourTurn: this.state.currentPlayerKey === this.player1.key,
      currentPlayer: currentPlayer,
      yourHits: this.state.hits[this.player1.key].length,
      opponentHits: this.state.hits[this.player2.key].length
    });

    this.emitToPlayer(this.player2.key, 'battleship:turn', {
      yourTurn: this.state.currentPlayerKey === this.player2.key,
      currentPlayer: currentPlayer,
      yourHits: this.state.hits[this.player2.key].length,
      opponentHits: this.state.hits[this.player1.key].length
    });

    this.emitToSpectators('battleship:turn', {
      currentPlayer: currentPlayer,
      player1Hits: this.state.hits[this.player1.key].length,
      player2Hits: this.state.hits[this.player2.key].length
    });
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;
    const loserKey = this.getOpponentKey(winnerKey);

    console.log(`[Battleship] Match ended. Winner: ${this.getPlayerName(winnerKey)} (sunk all ${this.NUM_SHIPS} ships)`);

    // Notify players
    this.emitToPlayer(winnerKey, 'battleship:end', {
      result: 'win',
      moves: this.state.moveHistory.filter(m => m.playerKey === winnerKey).length
    });

    this.emitToPlayer(loserKey, 'battleship:end', {
      result: 'lose',
      moves: this.state.moveHistory.filter(m => m.playerKey === loserKey).length
    });

    // Notify spectators
    this.emitToSpectators('battleship:end', {
      winner: this.getPlayerName(winnerKey),
      winnerMoves: this.state.moveHistory.filter(m => m.playerKey === winnerKey).length,
      loserMoves: this.state.moveHistory.filter(m => m.playerKey === loserKey).length
    });

    // Declare winner to tournament
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'battleship',
      player1: {
        name: this.player1.name,
        hits: this.state.hits[this.player1.key].length,
        shipsRemaining: this.NUM_SHIPS - this.state.hits[this.player2.key].length
      },
      player2: {
        name: this.player2.name,
        hits: this.state.hits[this.player2.key].length,
        shipsRemaining: this.NUM_SHIPS - this.state.hits[this.player1.key].length
      },
      phase: this.state.phase,
      currentPlayer: this.state.currentPlayerKey ? this.getPlayerName(this.state.currentPlayerKey) : null,
      gridSize: this.GRID_SIZE,
      numShips: this.NUM_SHIPS,
      active: this.gameActive
    };
  }
}

module.exports = Battleship;
