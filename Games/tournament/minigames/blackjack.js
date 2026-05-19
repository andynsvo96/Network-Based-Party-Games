// blackjack.js - Blackjack Mini-Game
// Head-to-head blackjack, first to 3 round wins

const MiniGameBase = require('./minigame-base');

class Blackjack extends MiniGameBase {
  constructor(config) {
    super(config);

    this.state = {
      roundsWon: {
        [this.player1.key]: 0,
        [this.player2.key]: 0
      },
      currentPlayerKey: this.player1.key,
      deck: [],
      playerHands: {
        [this.player1.key]: [],
        [this.player2.key]: []
      },
      playerStanding: {
        [this.player1.key]: false,
        [this.player2.key]: false
      },
      roundNumber: 1,
      phase: 'dealing' // 'dealing', 'player1_turn', 'player2_turn', 'results'
    };

    this.ROUNDS_TO_WIN = 3;
  }

  async start() {
    console.log(`[Blackjack] Starting match: ${this.player1.name} vs ${this.player2.name}`);

    this.gameActive = true;

    // Register socket handlers
    this.registerSocketHandlers();

    // Emit initial state
    this.emitToBothPlayers('blackjack:start', {
      roundsToWin: this.ROUNDS_TO_WIN
    });

    // Start first round
    this.startRound();
  }

  registerSocketHandlers() {
    this.socket1 = this.getPlayerSocket(this.player1.key);
    this.socket2 = this.getPlayerSocket(this.player2.key);

    if (this.socket1) {
      this.registerEvent(this.socket1, 'blackjack:hit', () => this.handleHit(this.player1.key));
      this.registerEvent(this.socket1, 'blackjack:stand', () => this.handleStand(this.player1.key));
    }

    if (this.socket2) {
      this.registerEvent(this.socket2, 'blackjack:hit', () => this.handleHit(this.player2.key));
      this.registerEvent(this.socket2, 'blackjack:stand', () => this.handleStand(this.player2.key));
    }
  }

  createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const deck = [];

    for (const suit of suits) {
      for (const rank of ranks) {
        deck.push({ rank, suit });
      }
    }

    // Shuffle deck
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
  }

  drawCard() {
    if (this.state.deck.length === 0) {
      this.state.deck = this.createDeck();
    }
    return this.state.deck.pop();
  }

  calculateHandValue(hand) {
    let value = 0;
    let aces = 0;

    for (const card of hand) {
      if (card.rank === 'A') {
        aces++;
        value += 11;
      } else if (['J', 'Q', 'K'].includes(card.rank)) {
        value += 10;
      } else {
        value += parseInt(card.rank);
      }
    }

    // Adjust for aces
    while (value > 21 && aces > 0) {
      value -= 10;
      aces--;
    }

    return value;
  }

  // Get visible cards for opponent (all cards except the first one which is hidden)
  getVisibleCards(playerKey) {
    const hand = this.state.playerHands[playerKey];
    if (hand.length <= 1) return [];
    return hand.slice(1); // First card is hidden, rest are visible
  }

  getVisibleValue(playerKey) {
    return this.calculateHandValue(this.getVisibleCards(playerKey));
  }

  startRound() {
    console.log(`[Blackjack] Starting round ${this.state.roundNumber}`);

    this.state.deck = this.createDeck();
    this.state.playerHands[this.player1.key] = [];
    this.state.playerHands[this.player2.key] = [];
    this.state.playerStanding[this.player1.key] = false;
    this.state.playerStanding[this.player2.key] = false;
    this.state.phase = 'dealing';

    // Deal initial cards - first card is hidden, second is visible
    this.state.playerHands[this.player1.key].push(this.drawCard()); // hidden
    this.state.playerHands[this.player1.key].push(this.drawCard()); // visible
    this.state.playerHands[this.player2.key].push(this.drawCard()); // hidden
    this.state.playerHands[this.player2.key].push(this.drawCard()); // visible

    const p1Value = this.calculateHandValue(this.state.playerHands[this.player1.key]);
    const p2Value = this.calculateHandValue(this.state.playerHands[this.player2.key]);

    console.log(`[Blackjack] Dealt cards. P1: ${p1Value}, P2: ${p2Value}`);

    // Send initial hands to players
    // Each player sees their own full hand + opponent's visible card(s)
    this.emitToPlayer(this.player1.key, 'blackjack:deal', {
      yourHand: this.state.playerHands[this.player1.key],
      yourValue: p1Value,
      opponentName: this.player2.name,
      opponentVisibleCards: this.getVisibleCards(this.player2.key),
      opponentVisibleValue: this.getVisibleValue(this.player2.key),
      roundNumber: this.state.roundNumber,
      roundsWon: this.state.roundsWon[this.player1.key],
      opponentRoundsWon: this.state.roundsWon[this.player2.key]
    });

    this.emitToPlayer(this.player2.key, 'blackjack:deal', {
      yourHand: this.state.playerHands[this.player2.key],
      yourValue: p2Value,
      opponentName: this.player1.name,
      opponentVisibleCards: this.getVisibleCards(this.player1.key),
      opponentVisibleValue: this.getVisibleValue(this.player1.key),
      roundNumber: this.state.roundNumber,
      roundsWon: this.state.roundsWon[this.player2.key],
      opponentRoundsWon: this.state.roundsWon[this.player1.key]
    });

    this.emitToSpectators('blackjack:deal', {
      player1: this.player1.name,
      player2: this.player2.name,
      player1VisibleValue: this.getVisibleValue(this.player1.key),
      player2VisibleValue: this.getVisibleValue(this.player2.key),
      roundNumber: this.state.roundNumber
    });

    // Start player 1's turn
    this.setTimeout(() => {
      this.startPlayerTurn(this.player1.key);
    }, 1000);
  }

  startPlayerTurn(playerKey) {
    this.state.currentPlayerKey = playerKey;
    this.state.phase = playerKey === this.player1.key ? 'player1_turn' : 'player2_turn';

    console.log(`[Blackjack] ${this.getPlayerName(playerKey)}'s turn`);

    this.emitToPlayer(playerKey, 'blackjack:your_turn', {
      yourHand: this.state.playerHands[playerKey],
      yourValue: this.calculateHandValue(this.state.playerHands[playerKey])
    });

    const opponentKey = this.getOpponentKey(playerKey);
    this.emitToPlayer(opponentKey, 'blackjack:opponent_turn', {
      opponentName: this.getPlayerName(playerKey)
    });

    this.emitToSpectators('blackjack:turn', {
      currentPlayer: this.getPlayerName(playerKey)
    });
  }

  handleHit(playerKey) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    if (playerKey !== this.state.currentPlayerKey) {
      console.log(`[Blackjack] ${this.getPlayerName(playerKey)} tried to hit out of turn`);
      return;
    }

    if (this.state.playerStanding[playerKey]) {
      console.log(`[Blackjack] ${this.getPlayerName(playerKey)} already standing`);
      return;
    }

    // Draw card (hit cards are always visible to opponent)
    const card = this.drawCard();
    this.state.playerHands[playerKey].push(card);
    const handValue = this.calculateHandValue(this.state.playerHands[playerKey]);

    console.log(`[Blackjack] ${this.getPlayerName(playerKey)} hit, drew ${card.rank}${card.suit}, value: ${handValue}`);

    // Emit to the hitting player - they see their full hand
    this.emitToPlayer(playerKey, 'blackjack:hit_result', {
      card: card,
      yourHand: this.state.playerHands[playerKey],
      yourValue: handValue
    });

    // Emit to opponent - they see the new card (visible) but not the hidden first card
    const opponentKey = this.getOpponentKey(playerKey);
    this.emitToPlayer(opponentKey, 'blackjack:opponent_hit', {
      card: card,
      opponentVisibleCards: this.getVisibleCards(playerKey),
      opponentVisibleValue: this.getVisibleValue(playerKey)
    });

    this.emitToSpectators('blackjack:hit', {
      player: this.getPlayerName(playerKey),
      visibleValue: this.getVisibleValue(playerKey)
    });

    // Check for bust - do NOT reveal bust to opponent, just auto-stand
    if (handValue > 21) {
      console.log(`[Blackjack] ${this.getPlayerName(playerKey)} BUST at ${handValue}!`);

      // Tell the busting player they busted
      this.emitToPlayer(playerKey, 'blackjack:bust', {
        yourValue: handValue
      });

      this.state.playerStanding[playerKey] = true;

      // Move to next player or resolve (opponent doesn't know about the bust)
      this.setTimeout(() => {
        this.advanceToNextPhase();
      }, 1500);
    }
  }

  handleStand(playerKey) {
    if (!this.validateGameActive()) return;
    if (!this.validatePlayer(playerKey)) return;

    if (playerKey !== this.state.currentPlayerKey) {
      console.log(`[Blackjack] ${this.getPlayerName(playerKey)} tried to stand out of turn`);
      return;
    }

    if (this.state.playerStanding[playerKey]) {
      console.log(`[Blackjack] ${this.getPlayerName(playerKey)} already standing`);
      return;
    }

    this.state.playerStanding[playerKey] = true;
    const handValue = this.calculateHandValue(this.state.playerHands[playerKey]);

    console.log(`[Blackjack] ${this.getPlayerName(playerKey)} stands at ${handValue}`);

    this.emitToPlayer(playerKey, 'blackjack:stand_confirm', {
      yourValue: handValue
    });

    // Tell opponent that this player stood (but not their value)
    const opponentKey = this.getOpponentKey(playerKey);
    this.emitToPlayer(opponentKey, 'blackjack:opponent_stood', {
      opponentName: this.getPlayerName(playerKey)
    });

    this.emitToSpectators('blackjack:stand', {
      player: this.getPlayerName(playerKey)
    });

    // Move to next player or resolve
    this.setTimeout(() => {
      this.advanceToNextPhase();
    }, 1000);
  }

  advanceToNextPhase() {
    if (this.state.phase === 'player1_turn') {
      // Move to player 2
      this.startPlayerTurn(this.player2.key);
    } else if (this.state.phase === 'player2_turn') {
      // Both players done, resolve round
      this.resolveRound();
    }
  }

  resolveRound() {
    this.state.phase = 'results';

    const p1Value = this.calculateHandValue(this.state.playerHands[this.player1.key]);
    const p2Value = this.calculateHandValue(this.state.playerHands[this.player2.key]);
    const p1Bust = p1Value > 21;
    const p2Bust = p2Value > 21;

    let roundWinner = null; // null = tie

    if (p1Bust && p2Bust) {
      // Both bust: closer to 21 wins (lower bust value)
      if (p1Value < p2Value) {
        roundWinner = this.player1.key;
      } else if (p2Value < p1Value) {
        roundWinner = this.player2.key;
      }
      // Equal bust values = tie
    } else if (p1Bust) {
      roundWinner = this.player2.key;
    } else if (p2Bust) {
      roundWinner = this.player1.key;
    } else {
      // Both under 21: higher value wins
      if (p1Value > p2Value) {
        roundWinner = this.player1.key;
      } else if (p2Value > p1Value) {
        roundWinner = this.player2.key;
      }
      // Equal values = tie
    }

    // Update round wins
    if (roundWinner) {
      this.state.roundsWon[roundWinner]++;
    }

    const p1Result = roundWinner === this.player1.key ? 'win' : roundWinner === this.player2.key ? 'lose' : 'tie';
    const p2Result = roundWinner === this.player2.key ? 'win' : roundWinner === this.player1.key ? 'lose' : 'tie';

    console.log(`[Blackjack] Round ${this.state.roundNumber} results: P1=${p1Result} (${p1Value}), P2=${p2Result} (${p2Value})`);

    // Emit results with FULL hands revealed
    this.emitToPlayer(this.player1.key, 'blackjack:round_result', {
      result: p1Result,
      yourValue: p1Value,
      yourHand: this.state.playerHands[this.player1.key],
      opponentValue: p2Value,
      opponentHand: this.state.playerHands[this.player2.key],
      opponentName: this.player2.name,
      roundsWon: this.state.roundsWon[this.player1.key],
      opponentRoundsWon: this.state.roundsWon[this.player2.key]
    });

    this.emitToPlayer(this.player2.key, 'blackjack:round_result', {
      result: p2Result,
      yourValue: p2Value,
      yourHand: this.state.playerHands[this.player2.key],
      opponentValue: p1Value,
      opponentHand: this.state.playerHands[this.player1.key],
      opponentName: this.player1.name,
      roundsWon: this.state.roundsWon[this.player2.key],
      opponentRoundsWon: this.state.roundsWon[this.player1.key]
    });

    this.emitToSpectators('blackjack:round_result', {
      player1Result: p1Result,
      player2Result: p2Result,
      player1Value: p1Value,
      player2Value: p2Value,
      player1Hand: this.state.playerHands[this.player1.key],
      player2Hand: this.state.playerHands[this.player2.key],
      player1RoundsWon: this.state.roundsWon[this.player1.key],
      player2RoundsWon: this.state.roundsWon[this.player2.key]
    });

    // Check for match winner (first to 3)
    if (this.state.roundsWon[this.player1.key] >= this.ROUNDS_TO_WIN) {
      this.setTimeout(() => {
        this.endGame(this.player1.key);
      }, 3000);
    } else if (this.state.roundsWon[this.player2.key] >= this.ROUNDS_TO_WIN) {
      this.setTimeout(() => {
        this.endGame(this.player2.key);
      }, 3000);
    } else {
      // Next round
      this.state.roundNumber++;
      this.setTimeout(() => {
        this.startRound();
      }, 3000);
    }
  }

  endGame(winnerKey) {
    if (!this.gameActive) return;

    this.gameActive = false;
    const loserKey = this.getOpponentKey(winnerKey);

    console.log(`[Blackjack] Match ended. Winner: ${this.getPlayerName(winnerKey)} (${this.state.roundsWon[winnerKey]}-${this.state.roundsWon[loserKey]})`);

    // Notify players
    this.emitToPlayer(winnerKey, 'blackjack:end', {
      result: 'win',
      roundsWon: this.state.roundsWon[winnerKey],
      opponentRoundsWon: this.state.roundsWon[loserKey]
    });

    this.emitToPlayer(loserKey, 'blackjack:end', {
      result: 'lose',
      roundsWon: this.state.roundsWon[loserKey],
      opponentRoundsWon: this.state.roundsWon[winnerKey]
    });

    // Notify spectators
    this.emitToSpectators('blackjack:end', {
      winner: this.getPlayerName(winnerKey),
      winnerRounds: this.state.roundsWon[winnerKey],
      loserRounds: this.state.roundsWon[loserKey]
    });

    // Declare winner to tournament
    this.declareWinner(winnerKey);
  }

  getStateForSpectators() {
    return {
      type: 'blackjack',
      player1: {
        name: this.player1.name,
        roundsWon: this.state.roundsWon[this.player1.key],
        visibleValue: this.getVisibleValue(this.player1.key)
      },
      player2: {
        name: this.player2.name,
        roundsWon: this.state.roundsWon[this.player2.key],
        visibleValue: this.getVisibleValue(this.player2.key)
      },
      roundNumber: this.state.roundNumber,
      phase: this.state.phase,
      roundsToWin: this.ROUNDS_TO_WIN,
      active: this.gameActive
    };
  }
}

module.exports = Blackjack;
