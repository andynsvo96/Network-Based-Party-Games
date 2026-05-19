// server.js - Poker Betting (no cards)
// Exported as a module for the master game launcher
//
// Notes:
// - Money is stored internally in CENTS (integers) to avoid floating point issues.
// - Host can "End Game" to reset WITHOUT gains/losses; server will rollback any lifetime deltas
//   applied during the current session.

"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

module.exports.init = function(config) {
  const { io, gamePath, players: initialPlayers, settings } = config;

  // -------------------- Config --------------------
  const BETWEEN_HANDS_DELAY_MS = 15_000; // cash-out window (between hands)
  const TICK_MS = 250; // timer tick resolution
  const LIFETIME_FILE = path.join(gamePath, "poker_lifetime.json");

  const SERVER_INFO = {
    port: config.port || 3000,
    ips: config.ips || [],
    playerPath: "/players",
    hostPath: "/"
  };

// -------------------- Helpers: Money --------------------
function dollarsToCents(v) {
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
function centsToDollars(c) {
  if (!Number.isFinite(c)) return null;
  return Math.round(c) / 100;
}
function fmtMoneyFromCents(c) {
  const d = centsToDollars(c);
  if (!Number.isFinite(d)) return "$0.00";
  return d.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}
function roundToNearestDollarCents(cents) {
  // nearest $1 => nearest 100 cents
  const rounded = Math.round(cents / 100) * 100;
  return Math.max(100, rounded);
}

// -------------------- Helpers: Text / IDs --------------------
function rid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// -------------------- Lifetime Store --------------------
let lifetime = {}; // { [playerId]: { earnedCents, lostCents } } total = earned - lost
function loadLifetime() {
  try {
    if (!fs.existsSync(LIFETIME_FILE)) return;
    const raw = fs.readFileSync(LIFETIME_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") lifetime = parsed;
  } catch (e) {
    console.log("[Lifetime] Failed to load:", e.message);
  }
}
function saveLifetime() {
  try {
    fs.writeFileSync(LIFETIME_FILE, JSON.stringify(lifetime, null, 2), "utf8");
  } catch (e) {
    console.log("[Lifetime] Failed to save:", e.message);
  }
}

function resetLifetimeAll() {
  lifetime = {};
  saveLifetime();
  emitToastToHosts("good", "Lifetime reset", "All lifetime scores have been reset.");
  addHistory("Lifetime scores were reset by the host.");
}
function getLifetimePublic(playerId) {
  const row = lifetime[playerId] || { earnedCents: 0, lostCents: 0 };
  const earned = row.earnedCents || 0;
  const lost = row.lostCents || 0;
  const total = earned - lost;
  return {
    earned: centsToDollars(earned),
    lost: centsToDollars(lost),
    total: centsToDollars(total),
  };
}

// session ledger so host End Game can rollback "no gains/losses"
let sessionLedger = []; // [{ playerId, deltaCents }]
function applyLifetimeDelta(playerId, deltaCents, recordInLedger = true) {
  if (!Number.isFinite(deltaCents) || deltaCents === 0) return;
  if (!lifetime[playerId]) lifetime[playerId] = { earnedCents: 0, lostCents: 0 };

  const row = lifetime[playerId];
  if (deltaCents > 0) row.earnedCents += deltaCents;
  else row.lostCents += Math.abs(deltaCents);

  // clamp to 0 (safety)
  row.earnedCents = Math.max(0, row.earnedCents | 0);
  row.lostCents = Math.max(0, row.lostCents | 0);

  if (recordInLedger) sessionLedger.push({ playerId, deltaCents });
  saveLifetime();
}
function rollbackSessionLedger() {
  // reverse apply deltas
  for (let i = sessionLedger.length - 1; i >= 0; i--) {
    const entry = sessionLedger[i];
    applyLifetimeDelta(entry.playerId, -entry.deltaCents, false);
  }
  sessionLedger = [];
}

  // -------------------- Router Setup --------------------
  loadLifetime();

  const router = express.Router();

  router.get("/", (req, res) => res.sendFile(path.join(gamePath, "index.html")));
  router.get("/players", (req, res) => res.sendFile(path.join(gamePath, "player.html")));

  // Avoid noisy favicon 404s in the console
  router.get('/favicon.ico', (req, res) => res.status(204).end());

  // Optional static folders if you add assets later
  router.use("/assets", express.static(path.join(gamePath, "assets")));
  router.use(express.json());

// -------------------- Global State --------------------
const state = {
  phase: "lobby", // "lobby" | "game"
  settings: null,
  lobby: {
    seatOrder: [],
    usePresetNames: false,
    presetNames: [],
  },
  players: [], // array of Player objects
  game: null,  // Game object
};

// socket registry
const socketInfo = new Map(); // socket.id -> { role, playerId }
function getPlayer(playerId) {
  return state.players.find((p) => p.id === playerId) || null;
}
function connectedPlayers() {
  return state.players.filter((p) => p.connected);
}
function activeSeats() {
  return Array.isArray(state.game?.seats) ? state.game.seats : [];
}

// -------------------- Player Model --------------------
function makePlayer(id, name) {
  return {
    id,
    name: String(name || "Player").trim().slice(0, 24) || "Player",
    connected: true,
    joinedSession: true,  // Connected this session
    joinedAt: Date.now(),
    socketIds: new Set(),
    lifetime: getLifetimePublic(id),

    // session flags
    cashedOut: false,     // cash game only
    eliminated: false,    // tournament only
  };
}

// -------------------- Game Model --------------------
function makeSeat(playerId, seatIndex, stackCents) {
  return {
    seatIndex,
    playerId,
    stackCents: Math.max(0, stackCents | 0),

    // per-hand
    handStartStackCents: Math.max(0, stackCents | 0),
    betStreetCents: 0,
    contributedCents: 0,
    folded: false,
    allIn: false,
    inHand: false,

    // persistent seat flags
    sitOut: false,
    out: false, // busted / cashed out / eliminated

    // computed per-hand
    isDealer: false,
    isSB: false,
    isBB: false,
    isTurn: false,

    // display status string
    status: "active", // "active" | "folded" | "allin" | "sitout" | "out"
  };
}

function makeSettingsFromHost(payload) {
  // payload already validated in host UI, but server must enforce.
  const mode = payload?.mode === "cash" ? "cash" : "tournament";
  const direction = payload?.direction === "counter" ? "counter" : "clockwise";
  const buyInCents = dollarsToCents(payload?.buyIn);
  const sbCents = dollarsToCents(payload?.sb);
  const bbCents = dollarsToCents(payload?.bb);

  const blindIncreasePct = Number(payload?.blindIncreasePct);
  const dealerMode = !!payload?.dealerMode;

  const timerEnabled = !!payload?.timer?.enabled;
  const timerSeconds = Math.max(3, Math.min(300, Number(payload?.timer?.seconds || 20)));

  const betweenRaw = Number(payload?.betweenHandsSeconds);
  const betweenHandsSeconds = (mode === "cash")
    ? Math.max(0, Math.min(120, Math.round(Number.isFinite(betweenRaw) ? betweenRaw : 15)))
    : 0;

  if (!Number.isFinite(buyInCents) || buyInCents <= 0) return { ok: false, error: "Buy-in invalid." };
  if (!Number.isFinite(sbCents) || sbCents <= 0) return { ok: false, error: "Small blind invalid." };
  if (!Number.isFinite(bbCents) || bbCents <= 0 || bbCents <= sbCents) return { ok: false, error: "Big blind invalid." };
  if (!Number.isFinite(blindIncreasePct) || blindIncreasePct <= 0 || blindIncreasePct > 500) return { ok: false, error: "Blind increase % invalid." };

  return {
    ok: true,
    value: {
      mode,
      direction,
      buyInCents,
      sbCents,
      bbCents,
      blindIncreasePct,
      blindRounding: "nearest_dollar",
      dealerMode,
      timer: { enabled: timerEnabled, seconds: timerSeconds, rule: "check_else_fold" },
      betweenHandsSeconds,
      cashoutPolicy: "between_hands_only",
      minPlayers: 2,
      maxPlayers: 8,
    },
  };
}

function startNewGame(settings, seatOrder) {
  sessionLedger = []; // new session ledger for rollback if host ends game void

  // mark all players session flags
  for (const p of state.players) {
    p.cashedOut = false;
    p.eliminated = false;
  }

  // Create seats in host-defined order
  const seats = [];
  for (let i = 0; i < seatOrder.length; i++) {
    const pid = seatOrder[i];
    seats.push(makeSeat(pid, i, settings.buyInCents));
  }

  // Initial button base indexes (random among eligible seats)
  const eligible = seats.filter((s) => !s.out);
  const randIndex = eligible.length ? eligible[Math.floor(Math.random() * eligible.length)].seatIndex : 0;

  const game = {
    id: rid(),
    handNo: 0,
    handId: null,
    street: null, // "preflop" | "flop" | "turn" | "river"
    streetLabel: "—",
    phaseLabel: "—",

    seats,
    blinds: { sbCents: settings.sbCents, bbCents: settings.bbCents },
    blindIncreasePct: settings.blindIncreasePct,

    dealerMode: settings.dealerMode,
    direction: settings.direction,

    // base position indices for rotation
    dealerIndex: settings.dealerMode ? randIndex : null,
    sbIndex: settings.dealerMode ? null : randIndex, // when dealerMode off, we rotate SB

    // betting state
    currentBetCents: 0,
    lastRaiseSizeCents: settings.bbCents,
    pendingAction: new Set(), // playerIds who must act this street
    turnSeatIndex: null,
    turnDeadlineMs: null,
    turnTimerSecondsLeft: null,

    awaitingResolution: false,
    tournamentFinished: false,
    betweenHands: false,
    betweenHandsUntilMs: null,

    gameOver: false,
    winnerPlayerId: null,
    winnerName: null,
    waitingForPlayers: false,
    waitingReason: null,
    // computed pots
    pots: [],

    // feeds
    actionFeed: [],     // compact (public)
    handHistory: [],    // host-only full history
    lastResultTextByPlayer: {}, // { [playerId]: safeHtmlString }

    // cash-out support
    cashoutClosedFor: new Set(), // players who cashed out (cannot rejoin)

    // for rejoin policy (cash game)
    rejoinPending: new Set(), // playerIds that reconnected mid-hand in cash game
  };

  state.phase = "game";
  state.settings = settings;
  state.game = game;

  addHistory(`Game started (${settings.mode === "cash" ? "Cash Game" : "Tournament"}). Buy-in ${fmtMoneyFromCents(settings.buyInCents)}. Blinds ${fmtMoneyFromCents(game.blinds.sbCents)} / ${fmtMoneyFromCents(game.blinds.bbCents)}.`);
  addFeed(`Game started. Blinds ${fmtMoneyFromCents(game.blinds.sbCents)} / ${fmtMoneyFromCents(game.blinds.bbCents)}.`);

  // Start first hand immediately
  beginBetweenHandsAndScheduleNextHand(true);
}

// -------------------- Feed / History --------------------
function addFeed(text) {
  if (!state.game) return;
  const safe = escapeHtml(text);
  state.game.actionFeed.push({ text: safe });
  if (state.game.actionFeed.length > 40) state.game.actionFeed.shift();
}
function addHistory(text) {
  if (!state.game) return;
  const safe = escapeHtml(text);
  state.game.handHistory.push({ text: safe });
  if (state.game.handHistory.length > 400) state.game.handHistory.shift();
}

// -------------------- Turn / Seat Helpers --------------------
function stepIndex(i, n) {
  if (n <= 0) return 0;
  const dir = state.settings?.direction === "counter" ? -1 : 1;
  return (i + dir + n) % n;
}
function prevIndex(i, n) {
  if (n <= 0) return 0;
  const dir = state.settings?.direction === "counter" ? 1 : -1;
  return (i + dir + n) % n;
}

function seatCount() {
  return activeSeats().length;
}

function isSeatEligibleForHand(seat) {
  if (!seat) return false;
  if (seat.out) return false;
  if (seat.sitOut) return false; // sit out skips the hand (folded effectively)
  if (seat.stackCents <= 0) return false;
  return true;
}

function handParticipantsSeatIndexes() {
  const g = state.game;
  const seats = activeSeats();
  const idx = [];
  // During an active hand, participants are the seats that were in the hand at hand start,
  // even if their stack has reached 0 (all-in).
  if (g && g.street) {
    for (const s of seats) {
      if (s.inHand && !s.out && !s.sitOut) idx.push(s.seatIndex);
    }
    return idx;
  }
  // Between hands / pre-hand setup: eligibility requires a positive stack.
  for (const s of seats) {
    if (isSeatEligibleForHand(s)) idx.push(s.seatIndex);
  }
  return idx;
}

function nextEligibleSeatIndex(startSeatIndex, predicate) {
  const seats = activeSeats();
  const n = seats.length;
  if (n === 0) return null;

  let cur = startSeatIndex;
  for (let k = 0; k < n; k++) {
    cur = stepIndex(cur, n);
    const seat = seats[cur];
    if (predicate(seat)) return cur;
  }
  return null;
}

function nextParticipantFrom(seatIndex, participantIndexes) {
  const seats = activeSeats();
  const n = seats.length;
  if (!participantIndexes.length) return null;
  let cur = seatIndex;
  for (let k = 0; k < n; k++) {
    cur = stepIndex(cur, n);
    if (participantIndexes.includes(cur)) return cur;
  }
  return null;
}

function prevParticipantFrom(seatIndex, participantIndexes) {
  const seats = activeSeats();
  const n = seats.length;
  if (!participantIndexes.length) return null;
  let cur = seatIndex;
  for (let k = 0; k < n; k++) {
    cur = prevIndex(cur, n);
    if (participantIndexes.includes(cur)) return cur;
  }
  return null;
}

function clearComputedSeatFlags() {
  for (const s of activeSeats()) {
    s.isDealer = false;
    s.isSB = false;
    s.isBB = false;
    s.isTurn = false;
  }
}

function setSeatStatus(seat) {
  if (seat.out) seat.status = "out";
  else if (seat.sitOut) seat.status = "sitout";
  else if (seat.folded) seat.status = "folded";
  else if (seat.allIn) seat.status = "allin";
  else seat.status = "active";
}

// -------------------- Hand Lifecycle --------------------
function beginBetweenHandsAndScheduleNextHand(isFirst = false) {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;

  if (g.tournamentFinished || g.gameOver) return;

  // Clear turn (always)
  g.turnSeatIndex = null;
  g.turnDeadlineMs = null;
  g.turnTimerSecondsLeft = null;

  // Clear any "waiting for players" stall state
  g.waitingForPlayers = false;
  g.waitingReason = null;

  clearComputedSeatFlags();
  for (const s of activeSeats()) setSeatStatus(s);

  // Delay rules:
  // - Tournament: instant between hands
  // - Cash: host-controlled between-hands timer (also before the very first hand)
  const delaySec = settings.mode === "cash" ? settings.betweenHandsSeconds : 0;
  const delayMs = Math.max(0, Math.floor(delaySec * 1000));

  // Tournament: if only one player left, do not schedule a new hand
  if (settings.mode === "tournament") {
    const alive = activeSeats().filter((s) => !s.out && s.stackCents > 0);
    if (alive.length <= 1) {
      if (alive.length === 1) {
        finishTournament(alive[0].playerId);
      }
      broadcastSync();
      return;
    }

  }

  // We never call startHand() directly from here (prevents recursive call stacks).
  // For an "instant" next hand (delayMs === 0), we set an immediate deadline and let the main tick start it.
  g.awaitingResolution = false;
  g.betweenHands = true;
  g.betweenHandsUntilMs = Date.now() + delayMs;

  // During between-hands, allow cashouts (cash game only) and rejoin-pending to re-enter next hand
  if (settings.mode === "cash" && delayMs > 0) addFeed(`Between hands (${Math.round(delayMs / 1000)}s). Cash-out available now (Cash Game only).`);
  broadcastSync();

  // Schedule next hand (handled by tick)
  // (host can still End Game during this window)
}

function startNextHandIfReady() {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;

  if (g.tournamentFinished || g.gameOver) {
    g.betweenHands = false;
    g.betweenHandsUntilMs = null;
    return;
  }

  if (!g.betweenHands) return;

  // If no deadline is set, we are waiting for enough active players to be eligible.
  if (g.betweenHandsUntilMs == null) {
    const eligible = activeSeats().filter(isSeatEligibleForHand);
    if (eligible.length < 2) return;
  } else {
    if (Date.now() < g.betweenHandsUntilMs) return;
  }

  // Tournament: if winner already decided, stop the between-hands window
  if (settings.mode === "tournament") {
    const alive = activeSeats().filter((s) => !s.out && s.stackCents > 0);
    if (alive.length <= 1) {
      if (alive.length === 1) {
        finishTournament(alive[0].playerId);
      }
      g.betweenHands = false;
      g.betweenHandsUntilMs = null;
      broadcastSync();
      return;
    }
  }

  startHand();
}

function startHand() {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;

  if (g.tournamentFinished || g.gameOver) return;

  // Determine eligible participants for a new hand (between-hands only)
  const participants = activeSeats().filter(isSeatEligibleForHand).map((s) => s.seatIndex);

  // Not enough players to start a hand
  if (participants.length < 2) {
    // Tournament: finish if a winner exists
    if (settings.mode === "tournament") {
      const alive = activeSeats().filter((s) => !s.out && s.stackCents > 0);
      if (alive.length === 1) {
        finishTournament(alive[0].playerId);
        broadcastSync();
      }
      return;
    }

    // Cash: if only one player remains, lock the game and require End & Settle.
    if (settings.mode === "cash") {
      if (maybeFinishCashGame("not_enough_players")) {
        broadcastSync();
        return;
      }

      // Otherwise, we are waiting for at least 2 active (non-sitOut) players.
      const msg = "Waiting for at least 2 active players to start the next hand.";
      const changed = !g.waitingForPlayers || g.waitingReason !== msg;

      g.awaitingResolution = false;
      g.betweenHands = true;
      g.betweenHandsUntilMs = null;

      g.waitingForPlayers = true;
      g.waitingReason = msg;
      g.phaseLabel = "Waiting for players";

      g.turnSeatIndex = null;
      g.turnDeadlineMs = null;
      g.turnTimerSecondsLeft = null;

      if (changed) {
        addFeed(msg);
        addHistory(msg);
        broadcastSync();
      }

      return;
    }

    return;
  }

  // Starting a real hand
  g.waitingForPlayers = false;
  g.waitingReason = null;

  g.betweenHands = false;
  g.betweenHandsUntilMs = null;
  g.awaitingResolution = false;

  // Cash rejoin policy resets at each new hand start
  g.rejoinPending.clear();

  g.handNo += 1;
  g.handId = rid();

// Reset per-hand stats
  for (const s of activeSeats()) {
    s.handStartStackCents = s.stackCents;
    s.betStreetCents = 0;
    s.contributedCents = 0;
    s.folded = false;
    s.allIn = false;
    // sitOut players skip this hand by being effectively folded/out-of-hand
    if (s.out || s.stackCents <= 0) s.out = true;
  }

  // Mark busted/out seats
  for (const s of activeSeats()) {
    if (s.stackCents <= 0) s.out = true;
    setSeatStatus(s);
  }

  
  // Set in-hand flags for this hand (used so all-in players stay in participants)
  const inHandSet = new Set(participants);
  for (const s of activeSeats()) {
    s.inHand = inHandSet.has(s.seatIndex);
  }

// Rotate positions (after previous hand) and apply blinds increase (after previous hand) BEFORE positions?
  // We apply blinds increase after hand concludes. So at the start of the hand, blinds are already set.
  rotatePositionsAfterPreviousHandIfNeeded();

  // Compute dealer/sb/bb indices for this hand
  const { dealerIndex, effectiveDealerIndex, sbIndex, bbIndex } = computePositionsForHand(participants);

  clearComputedSeatFlags();

  // Apply computed flags
  if (settings.dealerMode && dealerIndex != null) activeSeats()[dealerIndex].isDealer = true;
  activeSeats()[sbIndex].isSB = true;
  activeSeats()[bbIndex].isBB = true;

  // Post blinds (skip sitOut/out already excluded by participants)
  postBlind(sbIndex, g.blinds.sbCents, "SB");
  postBlind(bbIndex, g.blinds.bbCents, "BB");

  // Preflop betting state
  g.street = "preflop";
  g.streetLabel = "Preflop";
  g.phaseLabel = `Hand ${g.handNo}`;

  g.currentBetCents = Math.max(...participants.map((i) => activeSeats()[i].betStreetCents));
  g.lastRaiseSizeCents = g.blinds.bbCents;

  // Everyone who is in-hand and not all-in must act this street
  g.pendingAction = new Set();
  for (const idx of participants) {
    const s = activeSeats()[idx];
    if (!s.folded && !s.out && !s.allIn && !s.sitOut) g.pendingAction.add(s.playerId);
  }

  // Determine first to act
  const firstActorIndex = computeFirstActorIndex("preflop", participants, effectiveDealerIndex, sbIndex, bbIndex);
  setTurn(firstActorIndex);

  addHistory(`Hand ${g.handNo} started. Blinds: ${fmtMoneyFromCents(g.blinds.sbCents)} / ${fmtMoneyFromCents(g.blinds.bbCents)}.`);
  addFeed(`Hand ${g.handNo} started. ${settings.dealerMode ? `Dealer: ${nameOfSeat(dealerIndex)}. ` : ""}SB: ${nameOfSeat(sbIndex)}. BB: ${nameOfSeat(bbIndex)}.`);

  g.pots = computePots(false);
  broadcastSync();
}

let rotatedThisHand = false;
function rotatePositionsAfterPreviousHandIfNeeded() {
  // Positions rotate once per hand. We track and reset at hand start.
  rotatedThisHand = true;
}

function computePositionsForHand(participants) {
  const g = state.game;
  const settings = state.settings;
  const n = seatCount();

  // Ensure base indices are set
  if (settings.dealerMode) {
    if (g.dealerIndex == null) g.dealerIndex = participants[Math.floor(Math.random() * participants.length)];
  } else {
    if (g.sbIndex == null) g.sbIndex = participants[Math.floor(Math.random() * participants.length)];
  }

  let dealerIndex = null;
  let effectiveDealerIndex = null;
  let sbIndex = null;
  let bbIndex = null;

  if (settings.dealerMode) {
    // Dealer rotates with blinds (we keep g.dealerIndex updated at end of each hand)
    dealerIndex = g.dealerIndex;
    effectiveDealerIndex = dealerIndex;

    if (participants.length === 2) {
      sbIndex = dealerIndex; // dealer is SB
      bbIndex = nextParticipantFrom(dealerIndex, participants);
    } else {
      sbIndex = nextParticipantFrom(dealerIndex, participants);
      bbIndex = nextParticipantFrom(sbIndex, participants);
    }
  } else {
    // Dealer mode off: rotate SB only; derive effective dealer for action order
    sbIndex = g.sbIndex;
    bbIndex = nextParticipantFrom(sbIndex, participants);

    if (participants.length === 2) {
      effectiveDealerIndex = sbIndex; // SB acts as dealer
    } else {
      // seat BEFORE SB acts as dealer for postflop action order (hidden)
      effectiveDealerIndex = prevParticipantFrom(sbIndex, participants);
    }
  }

  return { dealerIndex, effectiveDealerIndex, sbIndex, bbIndex };
}

function computeFirstActorIndex(street, participants, effectiveDealerIndex, sbIndex, bbIndex) {
  // Standard Texas Hold’em:
  // Preflop:
  // - Heads-up: SB (dealer) acts first
  // - Multi: seat after BB acts first
  // Postflop:
  // - Heads-up: BB acts first
  // - Multi: seat after dealer acts first
  if (street === "preflop") {
    if (participants.length === 2) return sbIndex;
    return nextParticipantFrom(bbIndex, participants);
  } else {
    if (participants.length === 2) return bbIndex;
    return nextParticipantFrom(effectiveDealerIndex, participants);
  }
}

function postBlind(seatIndex, amountCents, label) {
  const g = state.game;
  if (!g) return;
  const s = activeSeats()[seatIndex];
  if (!s || s.out || s.sitOut) return;

  const pay = Math.min(s.stackCents, amountCents);
  s.stackCents -= pay;
  s.betStreetCents += pay;
  s.contributedCents += pay;

  if (s.stackCents === 0) s.allIn = true;

  setSeatStatus(s);
  addFeed(`${nameOfSeat(seatIndex)} posted ${label} ${fmtMoneyFromCents(pay)}${pay < amountCents ? " (all-in)" : ""}.`);
}

// -------------------- Betting / Streets --------------------
function setTurn(seatIndex) {
  const g = state.game;
  const settings = state.settings;
  if (!g) return;

  clearComputedSeatFlags();
  const seats = activeSeats();
  for (const s of seats) {
    // keep dealer/sb/bb flags set already
    // We'll re-apply below
  }

  // Re-apply D/SB/BB flags based on current hand
  // (We derive from existing flags stored on seats)
  for (const s of seats) {
    // nothing needed; flags already set in startHand and carried through streets
    s.isTurn = false;
  }

  g.turnSeatIndex = seatIndex;
  if (seatIndex != null) {
    seats[seatIndex].isTurn = true;
    // start timer deadline if enabled
    if (settings?.timer?.enabled) {
      g.turnDeadlineMs = Date.now() + settings.timer.seconds * 1000;
    } else {
      g.turnDeadlineMs = null;
      g.turnTimerSecondsLeft = null;
    }
  } else {
    g.turnDeadlineMs = null;
    g.turnTimerSecondsLeft = null;
  }

  // reset per-seat status strings
  for (const s of seats) setSeatStatus(s);
}

function countNotFoldedInHand() {
  const g = state.game;
  if (!g) return 0;
  const participants = handParticipantsSeatIndexes();
  let count = 0;
  for (const idx of participants) {
    const s = activeSeats()[idx];
    if (!s.folded && !s.out && !s.sitOut) count++;
  }
  return count;
}

function getLastStandingSeatIndex() {
  const g = state.game;
  if (!g) return null;
  const participants = handParticipantsSeatIndexes();
  for (const idx of participants) {
    const s = activeSeats()[idx];
    if (!s.folded && !s.out && !s.sitOut) return idx;
  }
  return null;
}

function toCallCents(seat) {
  const g = state.game;
  if (!g) return 0;
  return Math.max(0, g.currentBetCents - seat.betStreetCents);
}

function minRaiseToCentsFor(seat) {
  const g = state.game;
  if (!g) return null;

  if (g.currentBetCents === 0) {
    // minimum open bet = BB (simple home-rule)
    return g.blinds.bbCents;
  }
  // minimum raise to = currentBet + lastRaiseSize
  return g.currentBetCents + g.lastRaiseSizeCents;
}

function maxRaiseToCentsFor(seat) {
  // max "raise to" = betStreet + stack
  return seat.betStreetCents + seat.stackCents;
}

function handlePlayerAction(playerId, action) {
  const g = state.game;
  const settings = state.settings;
  if (!g || state.phase !== "game") return;

  if (g.betweenHands || g.awaitingResolution) {
    emitToastToPlayer(playerId, "warn", "Not now", "You can’t act between hands or while waiting for resolution.");
    return;
  }

  const seats = activeSeats();
  const seat = seats.find((s) => s.playerId === playerId);
  if (!seat) return;

  // Players can now rejoin and act at any time (no mid-hand blocking removed)

  // must be your turn
  if (g.turnSeatIndex == null || seats[g.turnSeatIndex]?.playerId !== playerId) {
    emitToastToPlayer(playerId, "warn", "Not your turn", "Wait until it’s your turn.");
    return;
  }

  // can't act if folded/out/all-in/sitout
  if (seat.out || seat.folded || seat.allIn || seat.sitOut) {
    emitToastToPlayer(playerId, "warn", "No action", "You can’t act right now.");
    advanceAfterAction(); // still try to move game
    return;
  }

  const type = action?.type;

  if (type === "fold") {
    seat.folded = true;
    g.pendingAction.delete(playerId);
    addFeed(`${nameOfPlayer(playerId)} folded.`);
  }
  else if (type === "sitout_toggle") {
    // Sit Out acts like folding; effect persists until toggled off (player returns next hand)
    seat.sitOut = !seat.sitOut;
    if (seat.sitOut) {
      seat.folded = true;
      g.pendingAction.delete(playerId);
      addFeed(`${nameOfPlayer(playerId)} is sitting out (fold).`);
    } else {
      // If toggled off mid-hand, they still return next hand (do not re-enter current hand)
      addFeed(`${nameOfPlayer(playerId)} will return next hand.`);
    }
  }
  else if (type === "check_call") {
    const call = toCallCents(seat);
    if (call <= 0) {
      // check
      g.pendingAction.delete(playerId);
      addFeed(`${nameOfPlayer(playerId)} checked.`);
    } else {
      const pay = Math.min(call, seat.stackCents);
      seat.stackCents -= pay;
      seat.betStreetCents += pay;
      seat.contributedCents += pay;

      if (seat.stackCents === 0) seat.allIn = true;

      if (pay < call) {
        addFeed(`${nameOfPlayer(playerId)} called ${fmtMoneyFromCents(pay)} (all-in).`);
      } else {
        addFeed(`${nameOfPlayer(playerId)} called ${fmtMoneyFromCents(pay)}.`);
      }

      // if they matched current bet or went all-in, they're done for this street
      if (seat.allIn || seat.betStreetCents >= g.currentBetCents) {
        g.pendingAction.delete(playerId);
      }
    }
  }
  else if (type === "bet_raise") {
    const raiseToDollars = action?.raiseTo;
    const raiseTo = dollarsToCents(raiseToDollars);

    if (!Number.isFinite(raiseTo) || raiseTo <= 0) {
      emitToastToPlayer(playerId, "bad", "Invalid", "Enter a valid raise amount.");
      return;
    }

    // interpret raiseTo as total bet this street
    const maxRaiseTo = maxRaiseToCentsFor(seat);
    const minRaiseTo = minRaiseToCentsFor(seat);

    const allInTo = maxRaiseTo;

    if (raiseTo > maxRaiseTo) {
      emitToastToPlayer(playerId, "bad", "Too high", `Max is ${fmtMoneyFromCents(maxRaiseTo)}.`);
      return;
    }

    // If they didn't exceed current bet, treat as call/check
    if (raiseTo <= g.currentBetCents) {
      handlePlayerAction(playerId, { type: "check_call" });
      return;
    }

    // enforce min raise unless it's exactly all-in
    if (raiseTo < minRaiseTo && raiseTo !== allInTo) {
      emitToastToPlayer(playerId, "bad", "Too small", `Min raise to is ${fmtMoneyFromCents(minRaiseTo)} (or go all-in).`);
      return;
    }

    const add = raiseTo - seat.betStreetCents;
    if (add <= 0) {
      handlePlayerAction(playerId, { type: "check_call" });
      return;
    }

    const pay = Math.min(add, seat.stackCents);
    seat.stackCents -= pay;
    seat.betStreetCents += pay;
    seat.contributedCents += pay;

    if (seat.stackCents === 0) seat.allIn = true;

    const oldBet = g.currentBetCents;
    const newBet = Math.max(g.currentBetCents, seat.betStreetCents);

    // update raise sizing
    const raiseSize = Math.max(0, newBet - oldBet);
    if (oldBet === 0) {
      // first bet of street: set lastRaiseSize to that amount (min bb at least)
      g.lastRaiseSizeCents = Math.max(g.blinds.bbCents, newBet);
    } else if (raiseSize >= g.lastRaiseSizeCents) {
      g.lastRaiseSizeCents = raiseSize;
    } else {
      // short all-in raise: does not update lastRaiseSizeCents
    }

    g.currentBetCents = newBet;

    addFeed(`${nameOfPlayer(playerId)} raised to ${fmtMoneyFromCents(newBet)}${seat.allIn ? " (all-in)" : ""}.`);

    // After a bet/raise, everyone (except raiser) must respond if they can
    resetPendingAfterAggression(playerId);
  }
  else if (type === "allin") {
    const raiseTo = maxRaiseToCentsFor(seat);
    // treat as bet/raise to all-in amount
    handlePlayerAction(playerId, { type: "bet_raise", raiseTo: centsToDollars(raiseTo) });
    return;
  }
  else {
    emitToastToPlayer(playerId, "warn", "Unknown action", "That action isn't supported.");
    return;
  }

  // Update status strings
  setSeatStatus(seat);

  // Update pots
  g.pots = computePots(false);

  // Check for last player standing
  if (countNotFoldedInHand() === 1) {
    autoAwardLastStandingAndConclude();
    return;
  }

  advanceAfterAction();
}

function resetPendingAfterAggression(aggressorPlayerId) {
  const g = state.game;
  if (!g) return;

  const participants = handParticipantsSeatIndexes();
  g.pendingAction = new Set();
  for (const idx of participants) {
    const s = activeSeats()[idx];
    if (s.playerId === aggressorPlayerId) continue;
    if (!s.folded && !s.out && !s.allIn && !s.sitOut) g.pendingAction.add(s.playerId);
  }

  // aggressor is done for now
  g.pendingAction.delete(aggressorPlayerId);
}

function advanceAfterAction() {
  const g = state.game;
  if (!g) return;

  // remove any folded/out/allin/sitout from pending
  for (const s of activeSeats()) {
    if (s.folded || s.out || s.allIn || s.sitOut) {
      g.pendingAction.delete(s.playerId);
    }
  }

  // Street complete?
  if (g.pendingAction.size === 0) {
    advanceStreetOrResolve();
    return;
  }

  // find next seat in pendingAction, starting from current seat
  const seats = activeSeats();
  const n = seats.length;
  let cur = g.turnSeatIndex;

  // Safety check: if turnSeatIndex is null/undefined, start from seat 0
  if (cur == null || cur < 0 || cur >= n) {
    cur = 0;
  }

  for (let k = 0; k < n; k++) {
    cur = stepIndex(cur, n);
    const pid = seats[cur]?.playerId;
    if (pid && g.pendingAction.has(pid)) {
      setTurn(cur);
      broadcastSync();
      return;
    }
  }

  // if we somehow didn't find, resolve street
  advanceStreetOrResolve();
}

function advanceStreetOrResolve() {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;

  // If only one player remains, award
  if (countNotFoldedInHand() === 1) {
    autoAwardLastStandingAndConclude();
    return;
  }

  // If everyone left is all-in or folded, auto-advance streets quickly to river then resolve.
  const participants = handParticipantsSeatIndexes();
  const actable = participants.filter((idx) => {
    const s = activeSeats()[idx];
    return !s.folded && !s.out && !s.sitOut && !s.allIn;
  });

  const nextStreet = (st) => (st === "preflop" ? "flop" : st === "flop" ? "turn" : st === "turn" ? "river" : null);

  if (g.street === "river") {
    // river done -> await host resolution
    g.awaitingResolution = true;
    g.phaseLabel = `Hand ${g.handNo} (Resolve)`;
    addFeed(`River complete. Waiting for host to resolve winners/splits.`);
    addHistory(`Hand ${g.handNo}: River complete. Awaiting resolution.`);
    // compute pots for resolution (eligible excludes folded; tournament also excludes disconnected at resolution)
    g.pots = computePots(true);
    clearTurnForResolution();
    broadcastSync();
    return;
  }

  // advance to next street
  const ns = nextStreet(g.street);
  g.street = ns;
  g.streetLabel = ns === "flop" ? "Flop" : ns === "turn" ? "Turn" : "River";
  g.phaseLabel = `Hand ${g.handNo}`;

  // Set phase transition for client overlays
  const phaseMessages = {
    flop: { title: "FLOP", body: "Three community cards dealt. Betting begins.", duration: 3000 },
    turn: { title: "TURN", body: "Fourth community card dealt.", duration: 3000 },
    river: { title: "RIVER", body: "Final community card dealt. Last round of betting.", duration: 3000 }
  };

  g.phaseTransition = phaseMessages[ns] ? {
    ...phaseMessages[ns],
    untilMs: Date.now() + phaseMessages[ns].duration
  } : null;

  // Clear phase transition after duration
  if (g.phaseTransition) {
    setTimeout(() => {
      if (g.phaseTransition && g.phaseTransition.untilMs <= Date.now()) {
        g.phaseTransition = null;
        broadcastSync();
      }
    }, phaseMessages[ns].duration + 100);
  }

  // reset street bets
  for (const idx of participants) {
    const s = activeSeats()[idx];
    s.betStreetCents = 0;
  }
  g.currentBetCents = 0;
  g.lastRaiseSizeCents = g.blinds.bbCents;

  // new pendingAction for this street:
  g.pendingAction = new Set();
  for (const idx of participants) {
    const s = activeSeats()[idx];
    if (!s.folded && !s.out && !s.allIn && !s.sitOut) g.pendingAction.add(s.playerId);
  }

  // determine first actor
  const { effectiveDealerIndex, sbIndex, bbIndex } = computePositionsForHand(participants);
  const first = computeFirstActorIndex(ns, participants, effectiveDealerIndex, sbIndex, bbIndex);

  addFeed(`${g.streetLabel} betting.`);
  addHistory(`Hand ${g.handNo}: ${g.streetLabel} betting.`);

  // If nobody can act (all-in), keep advancing
  if (g.pendingAction.size === 0 || actable.length === 0) {
    // immediately advance again
    g.pots = computePots(false);
    broadcastSync();
    advanceStreetOrResolve();
    return;
  }

  setTurn(first);

  g.pots = computePots(false);
  broadcastSync();
}

function clearTurnForResolution() {
  const g = state.game;
  if (!g) return;
  clearComputedSeatFlags();
  for (const s of activeSeats()) s.isTurn = false;
  g.turnSeatIndex = null;
  g.turnDeadlineMs = null;
  g.turnTimerSecondsLeft = null;
}

// -------------------- Pots / Resolution --------------------
function computePots(forResolution) {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return [];

  const seats = activeSeats();

  // contributions (including folded) define pot sizes
  const contribs = seats
    .map((s) => ({ playerId: s.playerId, c: s.contributedCents || 0, folded: s.folded, out: s.out, sitOut: s.sitOut }))
    .filter((x) => x.c > 0);

  if (!contribs.length) return [];

  // unique sorted levels
  const levels = Array.from(new Set(contribs.map((x) => x.c))).sort((a, b) => a - b);

  const pots = [];
  let prev = 0;

  for (const level of levels) {
    const contributingCount = contribs.filter((x) => x.c >= level).length;
    const amount = (level - prev) * contributingCount;

    // eligible winners: not folded, not out, not sitOut, AND contributed >= level
    let eligible = seats
      .filter((s) => (s.contributedCents || 0) >= level)
      .filter((s) => !s.folded && !s.out && !s.sitOut);

    // Tournament rule: if still disconnected at resolution time, they count as a loss and cannot win
    if (forResolution && settings.mode === "tournament") {
      eligible = eligible.filter((s) => {
        const p = getPlayer(s.playerId);
        return p?.connected !== false; // must be connected
      });
    }

    pots.push({
      id: `pot_${g.handNo}_${pots.length}`,
      label: pots.length === 0 ? "Main" : "Side",
      amountCents: amount,
      eligiblePlayerIds: eligible.map((s) => s.playerId),
    });

    prev = level;
  }

  return pots;
}

function hostResolveHand(hostPayload) {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;
  if (!g.awaitingResolution) return;

  if (hostPayload?.handId !== g.handId) {
    emitToastToHosts("warn", "Out of date", "That resolution was for an older hand.");
    return;
  }

  const submitted = Array.isArray(hostPayload?.pots) ? hostPayload.pots : [];
  const computed = computePots(true);
  if (!computed.length) {
    emitToastToHosts("bad", "No pots", "No pots found to resolve.");
    return;
  }

  // map computed by potId
  const computedById = new Map(computed.map((p) => [p.id, p]));

  // Validate every computed pot is resolved exactly once
  const resolvedById = new Map();
  for (const p of submitted) {
    resolvedById.set(p.potId, p);
  }
  for (const cp of computed) {
    if (!resolvedById.has(cp.id)) {
      emitToastToHosts("bad", "Missing pot", "Resolve every pot before submitting.");
      return;
    }
  }

  // Apply tournament disconnect-loss now (still disconnected at resolution => out, stack to 0)
  if (settings.mode === "tournament") {
    for (const s of activeSeats()) {
      if (s.out || s.sitOut) continue;
      const pl = getPlayer(s.playerId);
      if (pl && pl.connected === false) {
        // force loss
        s.stackCents = 0;
        s.out = true;
        s.folded = true;
        s.allIn = false;
        setSeatStatus(s);
        // lifetime delta = -buyin (loss)
        applyLifetimeDelta(s.playerId, -settings.buyInCents, true);
        addFeed(`${nameOfPlayer(s.playerId)} disconnected at showdown and is eliminated.`);
        addHistory(`Hand ${g.handNo}: ${nameOfPlayer(s.playerId)} disconnected at resolution => eliminated.`);
      }
    }
  }

  // distribute pots
  const seats = activeSeats();
  const winCentsByPlayer = new Map();
  for (const seat of seats) winCentsByPlayer.set(seat.playerId, 0);

  for (const cp of computed) {
    const sp = resolvedById.get(cp.id);
    const splitEvenly = !!sp.splitEvenly;
    const winners = Array.isArray(sp.winners) ? sp.winners : [];

    // validate winners are eligible
    const eligible = new Set(cp.eligiblePlayerIds || []);
    for (const w of winners) {
      if (!eligible.has(w)) {
        emitToastToHosts("bad", "Invalid winner", "A selected winner was not eligible for that pot.");
        return;
      }
    }
    if (!winners.length) {
      emitToastToHosts("bad", "Missing winner", "Pick a winner (or split) for every pot.");
      return;
    }
    if (splitEvenly && winners.length < 2) {
      emitToastToHosts("bad", "Split requires 2+", "Split pots require at least 2 winners.");
      return;
    }

    const amount = cp.amountCents | 0;
    if (amount <= 0) continue;

    const k = winners.length;
    const share = Math.floor(amount / k);
    let remainder = amount - share * k;

    for (let i = 0; i < winners.length; i++) {
      const pid = winners[i];
      let add = share;
      if (remainder > 0) {
        add += 1;
        remainder -= 1;
      }
      winCentsByPlayer.set(pid, (winCentsByPlayer.get(pid) || 0) + add);
    }

    if (!splitEvenly) {
      addFeed(`${nameOfPlayer(winners[0])} won ${cp.label} pot ${fmtMoneyFromCents(amount)}.`);
      addHistory(`Hand ${g.handNo}: ${cp.label} pot ${fmtMoneyFromCents(amount)} -> ${nameOfPlayer(winners[0])}.`);
    } else {
      addFeed(`${cp.label} pot ${fmtMoneyFromCents(amount)} split: ${winners.map(nameOfPlayer).join(", ")}.`);
      addHistory(`Hand ${g.handNo}: ${cp.label} pot ${fmtMoneyFromCents(amount)} split -> ${winners.map(nameOfPlayer).join(", ")}.`);
    }
  }

  // apply winnings to stacks
  for (const s of seats) {
    const add = winCentsByPlayer.get(s.playerId) || 0;
    if (add > 0 && !s.out) s.stackCents += add;
  }

  // finalize hand results and conclude
  g.pots = computePots(false);
  finalizeHandResultsAndConclude("host_resolve");
}

function autoAwardLastStandingAndConclude() {
  const g = state.game;
  if (!g) return;

  const lastIdx = getLastStandingSeatIndex();
  if (lastIdx == null) return;

  const lastSeat = activeSeats()[lastIdx];

  // Tournament rule: if last standing is disconnected at resolution, they still lose (edge).
  if (state.settings?.mode === "tournament") {
    const p = getPlayer(lastSeat.playerId);
    if (p && p.connected === false) {
      // force them out
      lastSeat.stackCents = 0;
      lastSeat.out = true;
      lastSeat.folded = true;
      setSeatStatus(lastSeat);
      applyLifetimeDelta(lastSeat.playerId, -state.settings.buyInCents, true);
      addFeed(`${nameOfPlayer(lastSeat.playerId)} disconnected and is eliminated.`);
      finalizeHandResultsAndConclude("auto_award_disc_elim");
      return;
    }
  }

  const totalPot = activeSeats().reduce((a, s) => a + (s.contributedCents || 0), 0);
  lastSeat.stackCents += totalPot;

  addFeed(`${nameOfPlayer(lastSeat.playerId)} wins the pot (${fmtMoneyFromCents(totalPot)}) — last player standing.`);
  addHistory(`Hand ${g.handNo}: Auto-award ${fmtMoneyFromCents(totalPot)} -> ${nameOfPlayer(lastSeat.playerId)} (last standing).`);

  finalizeHandResultsAndConclude("auto_award");
}

function finalizeHandResultsAndConclude(reason) {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;

  // Build per-player hand net results
  const resultLines = [];
  for (const s of activeSeats()) {
    const net = s.stackCents - s.handStartStackCents;
    const netStr = (net >= 0 ? "+" : "-") + fmtMoneyFromCents(Math.abs(net));
    resultLines.push(`${nameOfPlayer(s.playerId)}: ${netStr}`);

    // Store safe HTML result for player banner
    g.lastResultTextByPlayer[s.playerId] = `${escapeHtml(`Hand ${g.handNo} result:`)}<br/>${escapeHtml(net >= 0 ? "+" : "-")}${escapeHtml(fmtMoneyFromCents(Math.abs(net)).replace("$", "$"))}`;
  }

  addFeed(`Hand ${g.handNo} complete. ${resultLines.join(" | ")}`);
  addHistory(`Hand ${g.handNo} complete (${reason}).`);
  addHistory(`Results: ${resultLines.join(" | ")}`);

  // Blinds increase AFTER hand concludes (pot awarded)
  increaseBlinds();

  // Rotate dealer / blinds AFTER hand concludes (as scoped)
  rotatePositionsAfterHandConcludes();

  // Tournament elimination: anyone with stack <= 0 is out (buy-in loss)
  if (settings.mode === "tournament") {
    for (const s of activeSeats()) {
      if (s.out) continue;
      if (s.stackCents <= 0) {
        s.out = true;
        setSeatStatus(s);
        applyLifetimeDelta(s.playerId, -settings.buyInCents, true);
        addFeed(`${nameOfPlayer(s.playerId)} is eliminated.`);
        addHistory(`Eliminated: ${nameOfPlayer(s.playerId)}.`);
      }
    }

    // If winner now exists, finish tournament
    const alive = activeSeats().filter((s) => !s.out && s.stackCents > 0);
    if (alive.length === 1) {
      finishTournament(alive[0].playerId);
      broadcastSync();
      return;
    }
  } else {
    // Cash game: bust => out (kicked off)
    for (const s of activeSeats()) {
      if (s.out) continue;
      if (s.stackCents <= 0) {
        s.out = true;
        setSeatStatus(s);
        addFeed(`${nameOfPlayer(s.playerId)} is out of money and removed from the game.`);
        addHistory(`Removed (busted): ${nameOfPlayer(s.playerId)}.`);
        // lifetime for cash game is only applied on cashout; busting without cashout effectively ends at $0.
        // We'll treat bust as implicit cashout at $0 (delta = -buyIn) to keep lifetime consistent.
        applyLifetimeDelta(s.playerId, -settings.buyInCents, true);
      }
    }
  }

  // Clear in-hand flags
  for (const s of activeSeats()) {
    s.inHand = false;
  }

  // Clear hand state
  g.awaitingResolution = false;
  g.street = null;
  g.streetLabel = "—";
  g.phaseLabel = "Between hands";
  g.currentBetCents = 0;
  g.lastRaiseSizeCents = g.blinds.bbCents;
  g.pendingAction = new Set();
  g.pots = [];

  // Cash game: if only one player remains, lock the game and require End & Settle.
  if (settings.mode === "cash" && maybeFinishCashGame("hand_concluded_last_player")) {
    broadcastSync();
    return;
  }


  // Between hands window (cashout)
  beginBetweenHandsAndScheduleNextHand();
  broadcastSync();
}

function increaseBlinds() {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;

  const pct = Number(settings.blindIncreasePct || g.blindIncreasePct || 33);
  const mult = (100 + pct) / 100;

  const newSB = roundToNearestDollarCents(Math.round(g.blinds.sbCents * mult));
  const newBB = roundToNearestDollarCents(Math.round(g.blinds.bbCents * mult));

  g.blinds.sbCents = newSB;
  g.blinds.bbCents = Math.max(newBB, newSB + 100); // ensure BB > SB at least $1
  addFeed(`Blinds increased to ${fmtMoneyFromCents(g.blinds.sbCents)} / ${fmtMoneyFromCents(g.blinds.bbCents)}.`);
  addHistory(`Blinds increased -> ${fmtMoneyFromCents(g.blinds.sbCents)} / ${fmtMoneyFromCents(g.blinds.bbCents)}.`);
}

function rotatePositionsAfterHandConcludes() {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;

  const participants = handParticipantsSeatIndexes();
  if (participants.length < 2) return;

  if (settings.dealerMode) {
    // Dealer rotates to next eligible seat
    const base = g.dealerIndex != null ? g.dealerIndex : participants[0];
    const next = nextParticipantFrom(base, participants);
    g.dealerIndex = next;
  } else {
    // SB rotates to next eligible seat
    const base = g.sbIndex != null ? g.sbIndex : participants[0];
    const next = nextParticipantFrom(base, participants);
    g.sbIndex = next;
  }
}

function finishTournament(winnerPlayerId) {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;

  // Winner delta = finalStack - buyIn
  const winnerSeat = activeSeats().find((s) => s.playerId === winnerPlayerId);
  const finalStack = winnerSeat ? winnerSeat.stackCents : settings.buyInCents;
  const delta = finalStack - settings.buyInCents;

  applyLifetimeDelta(winnerPlayerId, delta, true);
  addFeed(`${nameOfPlayer(winnerPlayerId)} wins the tournament! (+${fmtMoneyFromCents(delta)})`);
  addHistory(`Tournament winner: ${nameOfPlayer(winnerPlayerId)}. Final stack ${fmtMoneyFromCents(finalStack)}. Delta ${fmtMoneyFromCents(delta)}.`);

  // Lock the game so it doesn't try to start new hands
  g.tournamentFinished = true;
  g.gameOver = true;
  g.winnerPlayerId = winnerPlayerId;
  g.winnerName = nameOfPlayer(winnerPlayerId);
  g.awaitingResolution = false;
  g.betweenHands = false;
  g.betweenHandsUntilMs = null;
  g.turnSeatIndex = null;
  g.turnDeadlineMs = null;
  g.turnTimerSecondsLeft = null;
  g.phaseLabel = "Tournament finished";

  // Mark all others out
  for (const s of activeSeats()) {
    if (s.playerId !== winnerPlayerId) {
      s.out = true;
      setSeatStatus(s);
    }
  }
}

// -------------------- Cash Game Finish --------------------
function maybeFinishCashGame(reason) {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return false;
  if (settings.mode !== "cash") return false;
  if (g.gameOver) return true;

  const remaining = activeSeats().filter((s) => !s.out && s.stackCents > 0);

  if (remaining.length <= 1) {
    const winnerId = remaining[0]?.playerId || null;

    g.gameOver = true;
    g.winnerPlayerId = winnerId;
    g.winnerName = winnerId ? nameOfPlayer(winnerId) : null;

    g.awaitingResolution = false;
    g.betweenHands = false;
    g.betweenHandsUntilMs = null;

    g.turnSeatIndex = null;
    g.turnDeadlineMs = null;
    g.turnTimerSecondsLeft = null;

    g.street = null;
    g.streetLabel = "—";
    g.phaseLabel = "Game finished";

    g.waitingForPlayers = false;
    g.waitingReason = null;

    addFeed(`Cash game finished. Winner: ${g.winnerName || "—"}.`);
    addHistory(`Cash game finished (${reason || "last_player"}). Winner: ${g.winnerName || "—"}.`);

    return true;
  }

  return false;
}


// -------------------- Naming helpers --------------------
function nameOfPlayer(playerId) {
  const p = getPlayer(playerId);
  return p?.name || "Player";
}
function nameOfSeat(seatIndex) {
  const s = activeSeats()[seatIndex];
  if (!s) return "—";
  return nameOfPlayer(s.playerId);
}

// -------------------- Cash Out --------------------
function playerCashout(playerId) {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return;

  if (settings.mode !== "cash") {
    emitToastToPlayer(playerId, "warn", "Not allowed", "Cash out is only available in Cash Game.");
    return;
  }
  if (!g.betweenHands) {
    emitToastToPlayer(playerId, "warn", "Between hands only", "Cash out is only available between hands.");
    return;
  }

  const seat = activeSeats().find((s) => s.playerId === playerId);
  if (!seat || seat.out) {
    emitToastToPlayer(playerId, "warn", "Not active", "You’re not currently in the game.");
    return;
  }

  // delta = currentStack - buyIn
  const delta = seat.stackCents - settings.buyInCents;
  applyLifetimeDelta(playerId, delta, true);

  seat.out = true;
  seat.folded = true;
  seat.allIn = false;
  seat.sitOut = false;
  setSeatStatus(seat);

  const p = getPlayer(playerId);
  if (p) p.cashedOut = true;

  addFeed(`${nameOfPlayer(playerId)} cashed out (${fmtMoneyFromCents(seat.stackCents)}). Net ${delta >= 0 ? "+" : "-"}${fmtMoneyFromCents(Math.abs(delta))}.`);
  addHistory(`Cash out: ${nameOfPlayer(playerId)}. Stack ${fmtMoneyFromCents(seat.stackCents)}. Delta ${fmtMoneyFromCents(delta)}.`);

  // If only one player remains, lock the game and require End & Settle.
  maybeFinishCashGame("cashout_last_player");

  broadcastSync();
}

// -------------------- End Game (host) --------------------
function endGameVoidNoLifetime() {
  // rollback session deltas and reset to lobby
  rollbackSessionLedger();

  state.phase = "lobby";
  state.settings = null;
  state.game = null;
  state.lobby.seatOrder = [];

  // refresh lifetime public on players (keep all players including offline)
  for (const p of state.players) {
    p.cashedOut = false;
    p.eliminated = false;
    p.lifetime = getLifetimePublic(p.id);
  }
  emitToastToAll("warn", "Game ended", "Host ended the game. No gains/losses were applied.");
  broadcastSync();
}

function endGameApplyLifetime(reason = "") {
  // Do NOT rollback session deltas; finalize and reset to lobby
  state.phase = "lobby";
  state.settings = null;
  state.game = null;
  state.lobby.seatOrder = [];

  // refresh lifetime public on players (keep all players including offline)
  for (const p of state.players) {
    p.cashedOut = false;
    p.eliminated = false;
    p.lifetime = getLifetimePublic(p.id);
  }

  const msg = reason === "game_finished"
    ? "Game finished and settled. Results were applied."
    : "Host ended the game. Results were applied.";

  emitToastToAll("good", "Game ended", msg);
  broadcastSync();
}


// -------------------- Force Advance (host emergency) --------------------
function hostForceAdvance() {
  const g = state.game;
  if (!g) return;

  if (g.awaitingResolution) return;

  // If pendingAction exists, clear it to force street completion
  g.pendingAction = new Set();
  addFeed("Host forced advance.");
  addHistory(`Hand ${g.handNo}: Host forced advance.`);
  advanceStreetOrResolve();
}

// -------------------- Toasts --------------------
function emitToast(socket, type, title, message) {
  socket.emit("toast", { type, title, message });
}
function emitToastToAll(type, title, message) {
  io.emit("toast", { type, title, message });
}
function emitToastToHosts(type, title, message) {
  io.to("hosts").emit("toast", { type, title, message });
}
function emitToastToPlayer(playerId, type, title, message) {
  for (const [sid, info] of socketInfo.entries()) {
    if (info.role === "player" && info.playerId === playerId) {
      io.to(sid).emit("toast", { type, title, message });
    }
  }
}

// -------------------- Sync Snapshots --------------------
function buildPublicPlayers() {
  return state.players.map((p) => ({
    id: p.id,
    name: p.name,
    connected: !!p.connected,
    joinedSession: p.joinedSession !== false,  // Default to true for backwards compatibility
    lifetime: getLifetimePublic(p.id),
  }));
}
function buildSettingsPublic() {
  if (!state.settings) return null;
  const s = state.settings;
  return {
    mode: s.mode,
    direction: s.direction,
    buyIn: centsToDollars(s.buyInCents),
    sb: centsToDollars(s.sbCents),
    bb: centsToDollars(s.bbCents),
    blindIncreasePct: s.blindIncreasePct,
    dealerMode: !!s.dealerMode,
    timer: { enabled: !!s.timer?.enabled, seconds: s.timer?.seconds || 20 },
    betweenHandsSeconds: Number.isFinite(s.betweenHandsSeconds) ? s.betweenHandsSeconds : (s.mode === "cash" ? 15 : 0),
  };
}
function buildGameForHost() {
  const g = state.game;
  if (!g) return null;

  const seats = activeSeats().map((s) => ({
    seatIndex: s.seatIndex,
    playerId: s.playerId,
    stack: centsToDollars(s.stackCents),
    betStreet: centsToDollars(s.betStreetCents),
    contributed: centsToDollars(s.contributedCents),
    status: s.status,
    isDealer: !!s.isDealer,
    isSB: !!s.isSB,
    isBB: !!s.isBB,
    isTurn: !!s.isTurn,
  }));

  // Host wants a generic "toCall" KPI. We'll show current player's toCall if a turn exists.
  let toCall = null;
  if (g.turnSeatIndex != null) {
    const s = activeSeats()[g.turnSeatIndex];
    if (s) toCall = centsToDollars(toCallCents(s));
  }

  const pots = Array.isArray(g.pots) ? g.pots : computePots(false);
  const potsPublic = pots.map((p) => ({
    id: p.id,
    label: p.label,
    amount: centsToDollars(p.amountCents),
    eligiblePlayerIds: p.eligiblePlayerIds || [],
  }));

  return {
    handNo: g.handNo,
    handId: g.handId,
    street: g.street,
    streetKey: g.awaitingResolution ? "showdown" : g.street,
    streetLabel: g.streetLabel,
    phaseLabel: g.phaseLabel,

    blinds: { sb: centsToDollars(g.blinds.sbCents), bb: centsToDollars(g.blinds.bbCents) },

    awaitingResolution: !!g.awaitingResolution,
    betweenHands: !!g.betweenHands,
    betweenHandsUntilMs: Number.isFinite(g.betweenHandsUntilMs) ? g.betweenHandsUntilMs : null,
    tournamentFinished: !!g.tournamentFinished,
    gameOver: !!g.gameOver,
    winnerPlayerId: g.winnerPlayerId || null,
    winnerName: g.winnerName || null,
    waitingForPlayers: !!g.waitingForPlayers,
    waitingReason: g.waitingReason || null,

    toCall,
    turnTimerSecondsLeft: Number.isFinite(g.turnTimerSecondsLeft) ? g.turnTimerSecondsLeft : null,

    seats,
    pots: potsPublic,

    actionFeed: g.actionFeed || [],
    handHistory: g.handHistory || [],
  };
}

function buildGameForPlayer(playerId) {
  const g = state.game;
  const settings = state.settings;
  if (!g || !settings) return null;

  const seatsPublic = activeSeats().map((s) => ({
    seatIndex: s.seatIndex,
    playerId: s.playerId,
    stack: centsToDollars(s.stackCents),
    betStreet: centsToDollars(s.betStreetCents),
    contributed: centsToDollars(s.contributedCents),
    status: s.status,
    isDealer: !!s.isDealer,
    isSB: !!s.isSB,
    isBB: !!s.isBB,
    isTurn: !!s.isTurn,
  }));

  const mySeat = activeSeats().find((s) => s.playerId === playerId) || null;
  const myToCall = mySeat ? toCallCents(mySeat) : 0;

  const minRaiseTo = mySeat ? minRaiseToCentsFor(mySeat) : null;
  const maxRaiseTo = mySeat ? maxRaiseToCentsFor(mySeat) : null;

  const canAct =
    !g.awaitingResolution &&
    !g.betweenHands &&
    mySeat &&
    g.turnSeatIndex != null &&
    activeSeats()[g.turnSeatIndex]?.playerId === playerId &&
    !mySeat.out &&
    !mySeat.folded &&
    !mySeat.allIn &&
    !mySeat.sitOut;
    // Removed rejoinPending check - players can act immediately after reconnecting

  const lastText = g.lastResultTextByPlayer?.[playerId] || null;

  const pots = computePots(false).map((p) => ({
    id: p.id,
    label: p.label,
    amount: centsToDollars(p.amountCents),
    eligiblePlayerIds: p.eligiblePlayerIds || [],
  }));

  return {
    handNo: g.handNo,
    handId: g.handId,
    streetLabel: g.streetLabel,
    awaitingResolution: !!g.awaitingResolution,
    betweenHands: !!g.betweenHands,
    betweenHandsUntilMs: Number.isFinite(g.betweenHandsUntilMs) ? g.betweenHandsUntilMs : null,
    tournamentFinished: !!g.tournamentFinished,
    gameOver: !!g.gameOver,
    winnerPlayerId: g.winnerPlayerId || null,
    winnerName: g.winnerName || null,
    waitingForPlayers: !!g.waitingForPlayers,
    waitingReason: g.waitingReason || null,
    blinds: { sb: centsToDollars(g.blinds.sbCents), bb: centsToDollars(g.blinds.bbCents) },
    toCallForYou: centsToDollars(myToCall),
    minRaiseToForYou: centsToDollars(minRaiseTo),
    maxRaiseToForYou: centsToDollars(maxRaiseTo),
    turnTimerSecondsLeft: Number.isFinite(g.turnTimerSecondsLeft) ? g.turnTimerSecondsLeft : null,

    seats: seatsPublic,
    pots,
    actionFeed: g.actionFeed || [],
    publicFeed: g.actionFeed || [],

    // Phase transition for overlays (flop/turn/river)
    phaseTransition: g.phaseTransition || null,

    // recommended per-player helpers
    me: {
      canAct: !!canAct,
      minRaiseTo: centsToDollars(minRaiseTo),
      maxRaiseTo: centsToDollars(maxRaiseTo),
      handNet: mySeat ? centsToDollars(mySeat.stackCents - mySeat.handStartStackCents) : null,
    },

    lastResultForYou: lastText ? { text: lastText } : null,
  };
}

function buildSnapshotForSocket(sid) {
  const info = socketInfo.get(sid) || { role: "unknown", playerId: null };
  const base = {
    phase: state.phase,
    players: buildPublicPlayers(),
    settings: buildSettingsPublic(),
    lobby: {
      seatOrder: Array.isArray(state.lobby?.seatOrder) ? state.lobby.seatOrder : [],
      usePresetNames: !!state.lobby.usePresetNames,
      presetNames: Array.isArray(state.lobby?.presetNames) ? state.lobby.presetNames : [],
    },
  };

  base.serverInfo = SERVER_INFO;

  if (state.phase === "game") {
    if (info.role === "host") base.game = buildGameForHost();
    else if (info.role === "player" && info.playerId) base.game = buildGameForPlayer(info.playerId);
    else base.game = buildGameForHost();
  } else {
    base.game = null;
  }

  if (info.role === "player") {
    const p = info.playerId ? getPlayer(info.playerId) : null;
    base.you = { id: p?.id || info.playerId || null, name: p?.name || null };
  }

  return base;
}

function broadcastSync() {
  // refresh lifetime in player list for UI
  for (const p of state.players) {
    p.lifetime = getLifetimePublic(p.id);
  }

  for (const [sid] of socketInfo.entries()) {
    io.to(sid).emit("sync", buildSnapshotForSocket(sid));
  }
}

// -------------------- Timer Tick --------------------
let lastSecondBroadcast = null;
const gameTickInterval = setInterval(() => {
  const g = state.game;
  const settings = state.settings;
  if (!g || state.phase !== "game") {
    lastSecondBroadcast = null;
    return;
  }

  if (g.tournamentFinished) {
    lastSecondBroadcast = null;
    return;
  }

  // between hands scheduling
  if (g.betweenHands) {
    startNextHandIfReady();
    // no timer updates needed
    return;
  }

  if (!settings?.timer?.enabled) {
    g.turnTimerSecondsLeft = null;
    lastSecondBroadcast = null;
    return;
  }

  if (g.awaitingResolution) {
    g.turnTimerSecondsLeft = null;
    lastSecondBroadcast = null;
    return;
  }

  if (g.turnSeatIndex == null || g.turnDeadlineMs == null) return;

  // Check if current turn player is offline
  const seat = activeSeats()[g.turnSeatIndex];
  if (seat) {
    const p = getPlayer(seat.playerId);
    if (p && !p.connected) {
      // Player is offline - pause timer and wait for reconnection
      const waitingReason = `⏸️ Waiting for ${p.name} to reconnect...`;
      const changed = !g.waitingForPlayers || g.waitingReason !== waitingReason || g.turnTimerSecondsLeft !== null;
      g.turnTimerSecondsLeft = null;
      lastSecondBroadcast = null;
      // Set waiting message
      g.waitingForPlayers = true;
      g.waitingReason = waitingReason;
      if (changed) broadcastSync();
      return;
    }
  }

  const now = Date.now();
  const leftMs = g.turnDeadlineMs - now;
  const leftSec = Math.max(0, Math.ceil(leftMs / 1000));

  g.turnTimerSecondsLeft = leftSec;

  // broadcast on second boundary changes only
  if (lastSecondBroadcast !== leftSec) {
    lastSecondBroadcast = leftSec;
    broadcastSync();
  }

  if (leftMs <= 0) {
    // timeout => auto-check if legal else auto-fold
    if (!seat) return;
    const pid = seat.playerId;

    const call = toCallCents(seat);
    if (call <= 0) {
      addFeed(`${nameOfPlayer(pid)} timed out (auto-check).`);
      handlePlayerAction(pid, { type: "check_call" });
    } else {
      addFeed(`${nameOfPlayer(pid)} timed out (auto-fold).`);
      handlePlayerAction(pid, { type: "fold" });
    }
  }
}, TICK_MS);

// -------------------- Socket.IO --------------------
io.on("connection", (socket) => {
  // default until join
  socketInfo.set(socket.id, { role: "unknown", playerId: null });

  socket.on("join", (payload) => {
    const role = payload?.role === "host" ? "host" : "player";

    if (role === "host") {
      socketInfo.set(socket.id, { role: "host", playerId: null });
      socket.join("hosts");
      emitToast(socket, "good", "Host connected", "You are connected as host.");
      io.to(socket.id).emit("sync", buildSnapshotForSocket(socket.id));
      return;
    }

    // player join
    const name = String(payload?.name || "").trim().slice(0, 24);
    if (!name) {
      emitToast(socket, "bad", "Name required", "Enter a name to join.");
      return;
    }

    // If a game is running, do not allow new players to join.
    if (state.phase === "game") {
      emitToast(socket, "warn", "Game in session", "A game is currently running. Ask the host to End Game to add new players.");
      socketInfo.set(socket.id, { role: "player", playerId: null });
      io.to(socket.id).emit("sync", buildSnapshotForSocket(socket.id));
      return;
    }

    // If preset names mode is enabled, validate that the name is from the preset list
    if (state.lobby.usePresetNames && state.lobby.presetNames.length > 0) {
      const normalizedName = name.trim();
      const isValidPreset = state.lobby.presetNames.some(preset => preset.trim().toLowerCase() === normalizedName.toLowerCase());

      if (!isValidPreset) {
        emitToast(socket, "bad", "Invalid name", "Please select a name from the preset list.");
        return;
      }
    }

    // enforce max players (all session players including offline)
    if (state.players.length >= 8) {
      emitToast(socket, "bad", "Full", "Max 8 players.");
      return;
    }

    const claimedId = String(payload?.playerId || "").trim();
    const playerId = claimedId && claimedId.length >= 6 ? claimedId : rid();

    // Check if name is already taken (case-insensitive, excluding current player if rejoining)
    const lower = name.toLowerCase();
    const nameTaken = state.players.some((p) => {
      if (p.id === playerId) return false; // allow same player to reconnect
      return p.name.toLowerCase() === lower;
    });

    if (nameTaken) {
      emitToast(socket, "bad", "Name taken", "That name is already taken. Please choose another one.");
      socket.emit("player_error", "That name is already taken. Please choose another one.");
      socket.emit("join_rejected", { reason: "That name is already taken. Please choose another one." });
      return;
    }

    let p = getPlayer(playerId);

    if (!p) {
      p = makePlayer(playerId, name);
      state.players.push(p);
    } else {
      // rejoin in lobby
      p.name = name;
      p.connected = true;
      p.joinedSession = true;  // Now connected this session
    }

    p.socketIds.add(socket.id);
    p.connected = true;
    p.joinedSession = true;  // Ensure set on any connection

    socketInfo.set(socket.id, { role: "player", playerId: p.id });

    // send identity
    socket.emit("you", { id: p.id, name: p.name });

    // initialize lobby seat order if empty
    if (!state.lobby.seatOrder.length) {
      state.lobby.seatOrder = state.players.map((x) => x.id);
    } else {
      // reconcile: remove missing (kicked), append new
      const ids = new Set(state.players.map((x) => x.id));
      state.lobby.seatOrder = state.lobby.seatOrder.filter((id) => ids.has(id));
      if (!state.lobby.seatOrder.includes(p.id)) state.lobby.seatOrder.push(p.id);
    }

    emitToast(socket, "good", "Joined", "You joined the lobby.");
    broadcastSync();
  });

  socket.on("player_rename", (payload) => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "player" || !info.playerId) return;
    const p = getPlayer(info.playerId);
    if (!p) return;

    const nm = String(payload?.name || "").trim().slice(0, 24);
    if (!nm) {
      emitToast(socket, "bad", "Invalid name", "Name cannot be empty.");
      return;
    }

    // Validate preset names if enabled
    if (state.lobby.usePresetNames && state.lobby.presetNames.length > 0) {
      const isValidPreset = state.lobby.presetNames.some(
        preset => preset.trim().toLowerCase() === nm.toLowerCase()
      );
      if (!isValidPreset) {
        emitToast(socket, "bad", "Invalid name", "Please select a name from the preset list.");
        return;
      }
    }

    // Check for duplicate names (case-insensitive, excluding current player)
    const lower = nm.toLowerCase();
    const nameTaken = state.players.some((other) => {
      if (other.id === p.id) return false;
      return other.name.toLowerCase() === lower && other.connected;
    });

    if (nameTaken) {
      emitToast(socket, "bad", "Name taken", "That name is already taken. Please choose another one.");
      socket.emit("player_error", "That name is already taken. Please choose another one.");
      socket.emit("join_rejected", { reason: "That name is already taken. Please choose another one." });
      return;
    }

    p.name = nm;
    socket.emit("you", { id: p.id, name: p.name });
    addFeed(`${p.name} renamed.`);
    broadcastSync();
  });

  socket.on("player_action", (payload) => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "player" || !info.playerId) return;
    handlePlayerAction(info.playerId, payload);
  });

  socket.on("player_cashout", () => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "player" || !info.playerId) return;
    playerCashout(info.playerId);
  });

  socket.on("host_start_game", (payload) => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;

    if (state.phase !== "lobby") {
      emitToast(socket, "warn", "Already started", "A game is already running.");
      return;
    }

    const settingsRes = makeSettingsFromHost(payload?.settings);
    if (!settingsRes.ok) {
      emitToast(socket, "bad", "Invalid settings", settingsRes.error);
      return;
    }
    const settings = settingsRes.value;

    // Validate players - count all session players (including offline who joined)
    const sessionPlayers = state.players.filter(p => p.joinedSession !== false);
    if (sessionPlayers.length < 2) {
      emitToast(socket, "bad", "Need players", "At least 2 players required.");
      return;
    }
    if (sessionPlayers.length > 8) {
      emitToast(socket, "bad", "Too many", "Max 8 players.");
      return;
    }

    const seatOrder = Array.isArray(payload?.seatOrder) ? payload.seatOrder.slice() : [];
    const sessionPlayerIds = new Set(sessionPlayers.map((p) => p.id));

    if (seatOrder.length !== sessionPlayers.length) {
      emitToast(socket, "bad", "Seat order", "Seat order must include every player.");
      return;
    }
    for (const id of seatOrder) {
      if (!sessionPlayerIds.has(id)) {
        emitToast(socket, "bad", "Seat order", "Seat order contains an unknown player.");
        return;
      }
    }
    // Also ensure no duplicates
    const dupeCheck = new Set(seatOrder);
    if (dupeCheck.size !== seatOrder.length) {
      emitToast(socket, "bad", "Seat order", "Seat order has duplicates.");
      return;
    }

    // lock lobby seat order to game start order
    state.lobby.seatOrder = seatOrder.slice();

    startNewGame(settings, seatOrder);

    emitToastToAll("good", "Game started", "Host started a new game.");
    broadcastSync();
  });

  socket.on("host_end_game", (payload) => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;

    if (state.phase !== "game" || !state.game || !state.settings) return;

    const g = state.game;
    const settings = state.settings;

    const applyLifetime = !!payload?.applyLifetime;

    // If a tournament has finished, require settlement (prevents accidental "void" end)
    if ((g.tournamentFinished || g.gameOver) && !applyLifetime) {
      emitToast(socket, "warn", "Game finished", "Use END & SETTLE to close out the finished game (so results are applied).");
      return;
    }

    if (applyLifetime) {
      // Cash game: if host ends with settlement, apply deltas for anyone still in the game (who hasn't cashed out)
      if (settings.mode === "cash") {
        for (const seat of activeSeats()) {
          if (!seat.playerId) continue;
          const p = getPlayer(seat.playerId);
          if (p?.cashedOut) continue;
          if (seat.out) continue;
          const delta = seat.stackCents - settings.buyInCents;
          applyLifetimeDelta(seat.playerId, delta, true);
        }
      }

      // Lock in any session deltas and reset to lobby
      sessionLedger = [];
      saveLifetime();
      endGameApplyLifetime(payload?.reason || "");
      return;
    }

    endGameVoidNoLifetime();
  });

    socket.on("host_reset_lifetime", (payload) => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;

    // UI already prompts for confirmation; allow bare emits.
    if (payload && payload.confirm === false) return;

    resetLifetimeAll();
    broadcastSync();
  });

socket.on("host_resolve_hand", (payload) => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;
    hostResolveHand(payload);
    broadcastSync();
  });

  socket.on("host_toggle_preset_names", () => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;
    if (state.phase !== "lobby") return;

    const wasPreset = state.lobby.usePresetNames;
    state.lobby.usePresetNames = !state.lobby.usePresetNames;

    // When switching to preset mode, notify players with invalid names
    if (!wasPreset && state.lobby.usePresetNames && state.lobby.presetNames.length > 0) {
      const validNames = new Set(state.lobby.presetNames.map(n => n.toLowerCase()));

      for (const p of state.players) {
        if (p.connected && !validNames.has(p.name.toLowerCase())) {
          // Notify player they need to re-select a name via forceReselect
          for (const sid of p.socketIds) {
            io.to(sid).emit("forceReselect", {
              reason: "Host enabled preset names. Please select a name from the list."
            });
          }

          // Remove player from seat order
          if (Array.isArray(state.lobby.seatOrder)) {
            state.lobby.seatOrder = state.lobby.seatOrder.filter(id => id !== p.id);
          }

          // Remove player so they can rejoin with a valid name
          state.players = state.players.filter(x => x.id !== p.id);
        }
      }
    }

    broadcastSync();
  });

  socket.on("host_add_preset_name", (payload) => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;
    if (state.phase !== "lobby") return;

    const name = String(payload?.name || "").trim().slice(0, 24);
    if (!name) {
      emitToast(socket, "bad", "Empty name", "Name cannot be empty.");
      return;
    }

    // Check for duplicates (case-insensitive)
    const lower = name.toLowerCase();
    const isDuplicate = state.lobby.presetNames.some(n => n.toLowerCase() === lower);

    if (isDuplicate) {
      emitToast(socket, "warn", "Duplicate", "That name is already in the preset list.");
      return;
    }

    state.lobby.presetNames.push(name);
    broadcastSync();
  });

  socket.on("host_remove_preset_name", (payload) => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;
    if (state.phase !== "lobby") return;

    const name = String(payload?.name || "").trim();
    if (!name) return;

    const lower = name.toLowerCase();
    state.lobby.presetNames = state.lobby.presetNames.filter(n => n.toLowerCase() !== lower);
    broadcastSync();
  });

  socket.on("host_kick_player", (payload) => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;

    // Only allow kick in lobby phase
    if (state.phase !== "lobby") {
      socket.emit("toast", {
        type: "warn",
        title: "Cannot Kick",
        message: "You can only kick players in the lobby, not during an active game."
      });
      return;
    }

    const playerId = payload?.playerId;
    if (!playerId) return;

    const player = getPlayer(playerId);
    if (!player) return;

    // Disconnect all sockets for this player
    for (const sid of player.socketIds) {
      io.to(sid).emit("kicked", { message: "You have been removed from the game by the host." });
      const targetSocket = io.sockets.get(sid);
      if (targetSocket) targetSocket.disconnect(true);
    }

    // Remove from seat order
    state.lobby.seatOrder = state.lobby.seatOrder.filter(id => id !== playerId);

    // Remove from players list
    state.players = state.players.filter(p => p.id !== playerId);

    addHistory(`${player.name} was kicked by the host.`);
    broadcastSync();
  });

  socket.on("host_force_advance", () => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;
    hostForceAdvance();
    broadcastSync();
  });

  socket.on("host_return_to_menu", () => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;
    // Clean up game state before returning to menu
    if (state.phase === "game") {
      endGameVoidNoLifetime();
    }
    // Broadcast to all players to return to launcher
    io.emit("returned_to_menu", {});
  });

  // Intro phase handlers
  socket.on("host_start_with_intro", () => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;
    io.emit("introPhase", {
      gameName: "Poker",
      slides: [
        { title: "How to Play", content: "You get 2 private cards. Throughout the round, 5 community cards are dealt face-up in the center for everyone to use." },
        { title: "Betting", content: "Bet, check, call, raise, or fold based on your hand. The player with the best 5-card hand wins the pot!" },
        { title: "Winning", content: "Win by having the best hand at showdown, or by making all other players fold. Build your stack to dominate!" }
      ]
    });
  });

  socket.on("host_skip_intro", () => {
    const info = socketInfo.get(socket.id);
    if (!info || info.role !== "host") return;
    io.emit("introEnded");
  });

  socket.on("disconnect", () => {
    const info = socketInfo.get(socket.id);
    socketInfo.delete(socket.id);

    if (!info) return;

    if (info.role === "player" && info.playerId) {
      const p = getPlayer(info.playerId);
      if (!p) return;

      p.socketIds.delete(socket.id);

      // Only treat as fully disconnected when their last socket closes
      if (p.socketIds.size === 0) {
        p.connected = false;
        p.lastSeen = Date.now();

        // Keep player in lobby for reconnection - do NOT remove them
        if (state.phase === "lobby") {
          // Keep them in seatOrder but mark as disconnected (player can reconnect)
          broadcastSync();
          return;
        }

        // If a game is in session, keep player connected (no auto-fold, no auto-advance)
        if (state.phase === "game" && state.game && state.settings) {
          const g = state.game;

          // DO NOT remove from pending action - game will pause and wait
          // DO NOT auto-fold - player stays in hand
          // DO NOT auto-advance turn - game waits for reconnection

          const seat = activeSeats().find((s) => s.playerId === p.id);
          if (seat && !seat.out) {
            // Keep player in hand, just mark as disconnected
            // Don't change seat.folded, seat.sitOut, or any game state

            addFeed(`${p.name} disconnected (waiting for reconnection).`);
            addHistory(`Hand ${g.handNo}: ${p.name} disconnected.`);
          } else {
            addFeed(`${p.name} disconnected.`);
            addHistory(`Hand ${g.handNo}: ${p.name} disconnected.`);
          }
        }
      }
    }

    broadcastSync();
  });

  // always push a sync after connect so UI isn't blank
  socket.emit("sync", buildSnapshotForSocket(socket.id));
});

// -------------------- Startup --------------------
function listLocalIPs() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

// API endpoint to receive initial player list from launcher (including offline players)
router.post('/api/init-players', (req, res) => {
  const { players, settings } = req.body || {};
  if (!Array.isArray(players)) {
    return res.status(400).json({ error: 'Invalid players array' });
  }

  console.log('[INIT] Received', players.length, 'players from launcher');

  // Store preset settings if provided
  if (settings) {
    state.lobby.usePresetNames = settings.usePresetNames || false;
    state.lobby.presetNames = settings.presetNames || [];
  }

  for (const p of players) {
    if (!p.key || !p.name) continue;
    // Check if player already exists
    const existing = state.players.find(pl => pl.id === p.key);
    if (existing) continue;

    // Create new player using makePlayer helper
    const newPlayer = makePlayer(p.key, p.name);
    newPlayer.connected = false;
    newPlayer.joinedSession = false;  // Never connected this session
    newPlayer.socketIds = new Set();
    state.players.push(newPlayer);
  }

  broadcastSync();
  res.json({ ok: true, count: players.length });
});

router.post("/api/update-settings", express.json(), (req, res) => {
  const { usePresetNames, presetNames } = req.body || {};

  // Update the game's preset settings variables
  if (usePresetNames !== undefined) {
    state.lobby.usePresetNames = usePresetNames;
  }
  if (presetNames !== undefined) {
    state.lobby.presetNames = presetNames;
  }

    console.log("[API] Updated preset settings:", { usePresetNames, presetNames: presetNames?.length || 0 });
    res.status(200).json({ success: true });
  });

  // Initialize with players from launcher
  if (initialPlayers && Array.isArray(initialPlayers)) {
    console.log('[POKER] Initializing with', initialPlayers.length, 'players from launcher');
    for (const p of initialPlayers) {
      if (!p.key || !p.name) continue;
      const existing = state.players.find(pl => pl.id === p.key);
      if (existing) continue;

      const newPlayer = makePlayer(p.key, p.name);
      newPlayer.connected = p.connected || false;
      newPlayer.joinedSession = p.connected || false;  // Only joined if connected from launcher
      newPlayer.socketIds = new Set();
      state.players.push(newPlayer);
    }
  }

  // Initialize preset settings
  if (settings) {
    state.lobby.usePresetNames = settings.usePresetNames || false;
    state.lobby.presetNames = settings.presetNames || [];
  }

  // Listen for settings updates from master launcher via namespace
  io.on('settings_updated', (data) => {
    if (data.usePresetNames !== undefined) {
      state.lobby.usePresetNames = data.usePresetNames;
    }
    if (data.presetNames !== undefined) {
      state.lobby.presetNames = data.presetNames;
    }
    console.log("[POKER] Settings updated from launcher:", data);
  });

  console.log(`[POKER] Game module initialized`);

  // Cleanup function for when game ends
  function cleanup() {
    console.log('[POKER] Cleaning up game instance');
    clearInterval(gameTickInterval);
    saveLifetime();
    socketInfo.clear();
    state.players.length = 0;
    state.phase = "lobby";
    state.game = null;
    state.settings = null;
    state.lobby.seatOrder = [];
  }

  // Return router and cleanup function
  return {
    router: router,
    cleanup: cleanup
  };
};
