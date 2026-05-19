const express = require("express");
const path = require("path");
const fs = require("fs");

module.exports.init = function(config) {
  const { io, gamePath, players: initialPlayers, settings: initialSettings } = config;
  const router = express.Router();

// ====== LIFETIME DB (simple JSON file) ======
const DB_PATH = path.join(gamePath, "mafia_lifetime_db.json");

let lifetimeDB = { players: {} };
try {
  const raw = fs.readFileSync(DB_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && parsed.players) {
    lifetimeDB = parsed;
  }
} catch (e) {
  lifetimeDB = { players: {} };
}

let saveDbTimer = null;
function scheduleSaveDb() {
  if (saveDbTimer) return;
  saveDbTimer = setTimeout(() => {
    saveDbTimer = null;
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(lifetimeDB, null, 2), "utf8");
    } catch (e) {
      console.warn("Failed to write DB:", e && e.message ? e.message : e);
    }
  }, 200);
}

function normalizeDbStats(stats) {
  const base = {
    mafiaGained: 0,
    civilianGained: 0,
    doctorGained: 0,
    detectiveGained: 0,
    lost: 0,
  };
  if (!stats || typeof stats !== "object") return base;
  return {
    mafiaGained: Number(stats.mafiaGained || 0),
    civilianGained: Number(stats.civilianGained || 0),
    doctorGained: Number(stats.doctorGained || 0),
    detectiveGained: Number(stats.detectiveGained || 0),
    lost: Number(stats.lost || 0),
  };
}

function computePointsFromStats(stats) {
  const s = normalizeDbStats(stats);
  const gained =
    (s.mafiaGained || 0) +
    (s.civilianGained || 0) +
    (s.doctorGained || 0) +
    (s.detectiveGained || 0);
  return Math.max(0, gained - (s.lost || 0));
}

function computeRoundDelta(winner, role) {
  if (!winner || !role) return 0;
  if (winner === "town") return role === "mafia" ? -1 : 1;
  if (winner === "mafia") return role === "mafia" ? 1 : -1;
  return 0;
}


function dbKeyFor(uid, name) {
  if (uid && typeof uid === "string" && uid.trim()) return "uid:" + uid.trim();
  return "name:" + String(name || "").trim().toLowerCase();
}

function loadLifetimeIntoPlayer(player, uid, name) {
  const key = dbKeyFor(uid, name);
  const record = lifetimeDB.players[key];
  if (!record) return;

  player.stats = normalizeDbStats(record.stats);
  player.points = computePointsFromStats(player.stats);

  // prefer saved canonical name, but keep the latest chosen name
  if (record.name && !name) player.name = record.name;
}

function upsertLifetimeFromPlayer(player) {
  const key = dbKeyFor(player.uid, player.name);
  lifetimeDB.players[key] = {
    uid: player.uid || null,
    name: player.name || "",
    stats: normalizeDbStats(player.stats),
    updatedAt: Date.now(),
  };
  scheduleSaveDb();
}

function resetLifetimeDb() {
  lifetimeDB = { players: {} };
  scheduleSaveDb();
}

// Join-order (for leaderboard tie-breaks)
let joinSeq = 0;

function normalizeDisplayName(name) {
  const cleaned = String(name || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  // Convert to ALL UPPERCASE
  return cleaned.toUpperCase();
}


// Serve static files
router.use(express.static(gamePath));
router.use(express.json());

// Main host page
router.get("/", (req, res) => {
  res.sendFile(path.join(gamePath, "index.html"));
});

// Serve player screen at /players (easier URL for phones)
router.get("/players", (req, res) => {
  res.sendFile(path.join(gamePath, "player.html"));
});

// Avoid noisy favicon 404s in the console
router.get('/favicon.ico', (req, res) => res.status(204).end());

// Helper endpoint so host can show a "Join link" with LAN IP
router.get("/host-info", (req, res) => {
  res.json({
    ip: null,
    port: null,
    joinPath: "/players",
  });
});

const PHASES = {
  LOBBY: "lobby",
  INTRO: "intro",
  NIGHT: "night",
  DAY: "day",
  VOTE: "vote",
  RESULTS: "results",
};

const SKIP_KILL = "SKIP_KILL";
const SKIP_VOTE = "SKIP_VOTE";
const NO_ONE = "NO_ONE";

let hostSocketId = null;

let gameState = {
  phase: PHASES.LOBBY,
  day: 0,
  night: 0,
  settings: {
    mafia: 1,
    doctor: 1,
    detective: 1,
    boxer: 0,
    civilian: 3,
anonymousVoting: false,
    timedVote: false,
    voteDurationSeconds: 60,
    mafiaCanSkipKill: false,
    detectiveRememberMafia: true,
    allowMafiaVoteMafia: false,
    usePresetNames: false,
    presetNames: [],
  },
  // players: { id, name, role, alive, points, stats, disconnected }
  players: [],
  actions: {
    mafiaVotes: {}, // mafiaPlayerId -> targetId | SKIP_KILL
    mafiaVoteSignals: {}, // mafiaPlayerId -> targetId (coordination only)
    doctorTarget: null,
    detectiveTarget: null,
    boxerTargets: {}, // boxerPlayerId -> targetId | NO_ONE
    civilianNotes: [], // { playerId, suspectId, trustId, night }
    votes: {}, // playerId -> targetId | SKIP_VOTE
  },
  detectiveHistory: [], // { night, detectiveId, targetId, isMafia }
  detectiveCancelHistory: [], // { night, detectiveId, message }
  lastDetectiveCancel: null, // { detectiveId, night, message }
  lastDetectiveResult: null, // { detectiveId, targetId, targetName, isMafia, night }
  timeline: [], // { type, night, day, info }
  lastNightSummary: null,
  voteTimer: null,
  voteTimerEnd: null,
};

// Initialize players from launcher (includes offline players)
if (initialPlayers && Array.isArray(initialPlayers)) {
  console.log('[Mafia] Initializing with', initialPlayers.length, 'players from launcher');
  for (const p of initialPlayers) {
    if (!p.key || !p.name) continue;
    gameState.players.push({
      id: null,
      uid: p.key,
      name: normalizeDisplayName(p.name).substring(0, 24),
      role: null,
      alive: true,
      points: 0,
      stats: {
        mafiaGained: 0,
        civilianGained: 0,
        doctorGained: 0,
        detectiveGained: 0,
        lost: 0,
      },
      disconnected: true,
      joinedSession: true,
      joinOrder: ++joinSeq,
    });
  }
}

// Helper to get socket from namespace
function getSocket(socketId) {
  if (!socketId) return null;
  return io.sockets ? io.sockets.get(socketId) : null;
}

// ====== HELPERS ======

function getPlayerById(id) {
  return gameState.players.find((p) => p.id === id) || null;
}

function getPlayerByUid(uid) {
  if (!uid) return null;
  return gameState.players.find((p) => p.uid && p.uid === uid) || null;
}

function getConnectedPlayers() {
  return gameState.players.filter((p) => !p.disconnected);
}

function getAlivePlayers() {
  return gameState.players.filter((p) => p.alive);
}

function getAliveMafia() {
  return getAlivePlayers().filter((p) => p.role === "mafia");
}

function getAliveMafiaAll() {
  // For Mafia coordination UI, count alive Mafia even if a player was momentarily marked disconnected.
  return gameState.players.filter((p) => p && p.alive && p.role === "mafia");
}

function buildNightTargetsForPlayer(requestingPlayer) {
  // Provides a clean list of valid (alive) targets for night selections.
  // This is additive metadata for clients; server-side validation still applies.
  const alive = getAlivePlayers();
  const base = alive.map((p) => ({ id: p.id, name: p.name }));

  if (!requestingPlayer || !requestingPlayer.role) return base;

  if (requestingPlayer.role === "mafia") {
    return alive
      .filter((p) => p.role !== "mafia")
      .map((p) => ({ id: p.id, name: p.name }));
  }

  if (requestingPlayer.role === "detective") {
    return alive
      .filter((p) => p.id !== requestingPlayer.id)
      .map((p) => ({ id: p.id, name: p.name }));
  }

  if (requestingPlayer.role === "boxer") {
    const last = requestingPlayer.lastBoxerTarget || null;
    return alive
      .filter((p) => !last || p.id !== last)
      .map((p) => ({ id: p.id, name: p.name }));
  }

  // doctor + civilian (notes): any alive player is a valid selection target
  return base;
}




function buildMafiaVoteSignals() {
  const aliveMafia = getAliveMafiaAll();
  const signals = (gameState.actions && gameState.actions.mafiaVoteSignals) || {};
  return aliveMafia
    .map((m) => {
      const targetId = signals[m.id];
      if (!targetId) return null;
      const target = getPlayerById(targetId);
      return {
        voterId: m.id,
        voterName: m.name,
        targetId,
        targetName: target && target.name ? target.name : "Unknown",
      };
    })
    .filter(Boolean);
}

function getAliveTown() {
  return getAlivePlayers().filter(
    (p) =>
      p.role === "civilian" ||
      p.role === "doctor" ||
      p.role === "detective" ||
      p.role === "boxer"
  );
}

function sumRoleCounts() {
  const s = gameState.settings;
  return s.mafia + s.doctor + s.detective + s.boxer + s.civilian;
}

function resetVotes() {
  gameState.actions.votes = {};
  gameState.voteTimerEnd = null;
  if (gameState.voteTimer) {
    clearTimeout(gameState.voteTimer);
    gameState.voteTimer = null;
  }
}

function resetNightActions() {
  gameState.actions.mafiaVotes = {};
  gameState.actions.mafiaVoteSignals = {};
  gameState.actions.doctorTarget = null;
  gameState.actions.detectiveTarget = null;
  gameState.actions.boxerTargets = {};
  // civilianNotes are kept as a historical record; do not wipe
}


function resetGameToLobby({ message = null, removeDisconnected = true } = {}) {
  if (gameState.voteTimer) {
    clearTimeout(gameState.voteTimer);
    gameState.voteTimer = null;
  }

  gameState.phase = PHASES.LOBBY;
  gameState.day = 0;
  gameState.night = 0;

  const basePlayers = removeDisconnected
    ? gameState.players.filter((p) => !p.disconnected)
    : gameState.players.slice();

  gameState.players = basePlayers.map((p) => ({
    ...p,
    role: null,
    alive: true,
    disconnected: false,
    lastBoxerTarget: null,
  }));

  gameState.actions = {
    mafiaVotes: {},
    mafiaVoteSignals: {},
    doctorTarget: null,
    detectiveTarget: null,
    civilianNotes: [],
    votes: {},
  };
  gameState.detectiveHistory = [];
  gameState.detectiveCancelHistory = [];
  gameState.lastDetectiveCancel = null;
  gameState.timeline = [];
  gameState.lastNightSummary = null;
  gameState.lastDetectiveResult = null;
  gameState.voteTimerEnd = null;

  broadcastLobby();

  if (message) {
    if (hostSocketId) {
      io.to(hostSocketId).emit("host_error", { message });
    }
    io.emit("player_error", message);
  }
}

function removePlayerById(id) {
  const idx = gameState.players.findIndex((p) => p.id === id);
  if (idx >= 0) {
    gameState.players.splice(idx, 1);
    return true;
  }
  return false;
}


function allNightActionsComplete() {
  const alivePlayers = getAlivePlayers();
  for (const p of alivePlayers) {
    // Disconnected players count as incomplete unless host skips them

    if (p.role === "mafia") {
      if (!gameState.actions.mafiaVotes[p.id]) {
        return false;
      }
    } else if (p.role === "doctor") {
      if (!gameState.actions.doctorTarget) {
        return false;
      }
    } else if (p.role === "detective") {
      if (!gameState.actions.detectiveTarget) {
        return false;
      }
    } else if (p.role === "boxer") {
      const bt = gameState.actions.boxerTargets || {};
      if (bt[p.id] === undefined) {
        return false;
      }
    } else if (p.role === "civilian") {
      const hasNote = gameState.actions.civilianNotes.some(
        (n) => n.playerId === p.id && n.night === gameState.night
      );
      if (!hasNote) {
        return false;
      }
    }
  }
  return true;
}

// Force-complete night actions for an offline player (host-initiated skip)
function forceCompletePlayerNightAction(player) {
  if (!player || !player.alive) return;

  const role = player.role;

  if (role === "mafia") {
    if (!gameState.actions.mafiaVotes[player.id]) {
      gameState.actions.mafiaVotes[player.id] = "SKIP_KILL";
    }
  } else if (role === "doctor") {
    if (!gameState.actions.doctorTarget) {
      gameState.actions.doctorTarget = "SKIP";
    }
  } else if (role === "detective") {
    if (!gameState.actions.detectiveTarget) {
      gameState.actions.detectiveTarget = "SKIP";
    }
  } else if (role === "boxer") {
    const bt = gameState.actions.boxerTargets || {};
    if (bt[player.id] === undefined) {
      gameState.actions.boxerTargets = gameState.actions.boxerTargets || {};
      gameState.actions.boxerTargets[player.id] = null;
    }
  } else if (role === "civilian") {
    const hasNoteThisNight = gameState.actions.civilianNotes.some(
      (n) => n.playerId === player.id && n.night === gameState.night
    );
    if (!hasNoteThisNight) {
      gameState.actions.civilianNotes.push({
        playerId: player.id,
        night: gameState.night,
        suspectId: null,
        suspectName: "(skipped)",
        trustId: null,
        trustName: "(skipped)",
      });
    }
  }
}

// Notify host that an offline player has a pending night action
function notifyHostOfflinePlayer(player) {
  if (!player || !hostSocketId) return;
  io.to(hostSocketId).emit("waiting_for_offline_player", {
    playerId: player.id,
    playerName: player.name,
    role: player.role,
    message: `${player.name} is offline and has a pending night action. You can skip their action.`
  });
}

function getNightStatus() {
  return gameState.players.map((p) => {
    if (!p.alive) {
      return {
        id: p.id,
        name: p.name,
        role: gameState.phase === PHASES.RESULTS ? p.role : null,
        status: "dead",
      };
    }

    let status = "done";

    if (p.role === "mafia") {
      status = gameState.actions.mafiaVotes[p.id] ? "done" : "pending";
    } else if (p.role === "doctor") {
      status = gameState.actions.doctorTarget ? "done" : "pending";
    } else if (p.role === "detective") {
      status = gameState.actions.detectiveTarget ? "done" : "pending";
    } else if (p.role === "boxer") {
      const bt = gameState.actions.boxerTargets || {};
      status = bt[p.id] === undefined ? "pending" : "done";
    } else if (p.role === "civilian") {
      const hasNoteThisNight = gameState.actions.civilianNotes.some(
        (n) => n.playerId === p.id && n.night === gameState.night
      );
      if (!hasNoteThisNight && p.alive) {
        status = "pending";
      }
    }

    return {
      id: p.id,
      name: p.name,
      role: null, // hide role during game
      status: p.disconnected ? "offline" : status,
      disconnected: !!p.disconnected,
    };
  });
}

function getCivilianNotesForNight(nightNumber) {
  return gameState.actions.civilianNotes
    .filter((n) => n.night === nightNumber)
    .map((n) => {
      let suspectName = "Unknown";
      let trustName = "Unknown";
      if (n.suspectId === NO_ONE) suspectName = "No one";
      else {
        const suspect = getPlayerById(n.suspectId);
        suspectName = suspect ? suspect.name : "Unknown";
      }
      if (n.trustId === NO_ONE) trustName = "No one";
      else {
        const trust = getPlayerById(n.trustId);
        trustName = trust ? trust.name : "Unknown";
      }
      return {
        suspectName,
        trustName,
      };
    });
}

function checkWinCondition() {
  const aliveMafia = getAliveMafia().length;
  const aliveTown = getAliveTown().length;

  if (aliveMafia === 0) {
    return "town";
  }
  if (aliveMafia > 0 && aliveMafia >= aliveTown) {
    return "mafia";
  }

  return null;
}

function ensurePlayerStats(p) {
  if (!p.stats) {
    p.stats = {
      mafiaGained: 0,
      civilianGained: 0,
      doctorGained: 0,
      detectiveGained: 0,
      boxerGained: 0,
      lost: 0,
    };
  } else {
    if (p.stats.boxerGained === undefined) p.stats.boxerGained = 0;
  }
}

function applyEndGameScoring(winner) {
  if (!winner) return;

  gameState.players.forEach((p) => {
    ensurePlayerStats(p);

    if (winner === "town") {
      if (p.role === "mafia") {
        p.stats.lost = (p.stats.lost || 0) + 1;
      } else if (p.role === "civilian") {
        p.stats.civilianGained = (p.stats.civilianGained || 0) + 1;
      } else if (p.role === "doctor") {
        p.stats.doctorGained = (p.stats.doctorGained || 0) + 1;
      } else if (p.role === "detective") {
        p.stats.detectiveGained = (p.stats.detectiveGained || 0) + 1;
      } else if (p.role === "boxer") {
        p.stats.boxerGained = (p.stats.boxerGained || 0) + 1;
      }
    } else if (winner === "mafia") {
      if (p.role === "mafia") {
        p.stats.mafiaGained = (p.stats.mafiaGained || 0) + 1;
      } else {
        p.stats.lost = (p.stats.lost || 0) + 1;
      }
    }

    const gained =
      (p.stats.mafiaGained || 0) +
      (p.stats.civilianGained || 0) +
      (p.stats.doctorGained || 0) +
      (p.stats.detectiveGained || 0) +
      (p.stats.boxerGained || 0);
    const lost = p.stats.lost || 0;
    p.points = Math.max(0, gained - lost);
    upsertLifetimeFromPlayer(p);
  });
}

function buildPointsDetailForPlayer(p) {
  const stats = p.stats || {};
  return {
    mafia: stats.mafiaGained || 0,
    civilian: stats.civilianGained || 0,
    doctor: stats.doctorGained || 0,
    detective: stats.detectiveGained || 0,
    boxer: stats.boxerGained || 0,
    lost: stats.lost || 0,
    total: p.points || 0,
  };
}

function sortPlayersForDisplay(a, b) {
  // Connected first
  if (!!a.disconnected !== !!b.disconnected) return a.disconnected ? 1 : -1;

  const ap = a.points || 0;
  const bp = b.points || 0;
  if (bp !== ap) return bp - ap;

  const aj = typeof a.joinOrder === "number" ? a.joinOrder : 0;
  const bj = typeof b.joinOrder === "number" ? b.joinOrder : 0;
  return aj - bj;
}

function buildGameOverSummary(winner) {
  const summary = {
    winner,
    dayCount: gameState.day,
    nightCount: gameState.night,
    players: gameState.players.map((p) => {
      const roundDelta = computeRoundDelta(winner, p.role);
      const lifetimePoints = p.points || 0;
      const lifetimePointsDetail = buildPointsDetailForPlayer(p);

      return {
        id: p.id,
        name: p.name,
        role: p.role,
        alive: p.alive,

        // Points for the game that just concluded (delta only)
        roundDelta,

        // Lifetime points (kept for compatibility / non-results UI)
        points: lifetimePoints,
        pointsDetail: lifetimePointsDetail,
        lifetimePoints,
        lifetimePointsDetail,
      };
    }),
    timeline: gameState.timeline.slice(),
  };
  return summary;
}

function buildPublicPlayers() {
  return gameState.players
    .slice()
    .sort(sortPlayersForDisplay)
    .map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    disconnected: p.disconnected,
    joinedSession: p.joinedSession !== false,  // Default to true for backwards compatibility
    points: p.points || 0,
    pointsDetail: buildPointsDetailForPlayer(p),
  }));
}

function broadcastLobby() {
  const playersPayload = buildPublicPlayers();
  const payload = {
    phase: gameState.phase,
    players: playersPayload,
    settings: gameState.settings,
  };

  io.emit("lobby_update", payload);
}

function broadcastPhase() {
  const base = {
    phase: gameState.phase,
    day: gameState.day,
    night: gameState.night,
  };

  const publicPlayers = buildPublicPlayers();

  if (gameState.phase === PHASES.INTRO) {
    // Host gets intro phase so it can run the animation
    if (hostSocketId) {
      io.to(hostSocketId).emit("intro_phase_host", {
        ...base,
        settings: gameState.settings,
        players: publicPlayers,
        alivePlayers: publicPlayers.filter((pp) => pp.alive),
      });
    }
    // Players get their role + mafia partners
    gameState.players.forEach((p) => {
      const s = getSocket(p.id);
      if (!s) return;

      const mafiaPeers =
        p.role === "mafia"
          ? getAliveMafiaAll()
              .filter((m) => m.id !== p.id)
              .map((m) => ({ id: m.id, name: m.name }))
          : [];

      s.emit("intro_phase_player", {
        ...base,
        yourRole: p.role, // legacy
        role: p.role,
        alive: p.alive,
        settings: gameState.settings,
        players: publicPlayers,
        mafiaPartners: mafiaPeers, // legacy
        mafiaPeers,
      });
    });
  } else if (gameState.phase === PHASES.NIGHT) {
    // Host night view (status table)
    if (hostSocketId) {
      io.to(hostSocketId).emit("night_phase_host", {
        ...base,
        settings: gameState.settings,
        nightStatus: getNightStatus(),
      });
    }

    // Players: tell them it's night and what they can do
    gameState.players.forEach((p) => {
      const s = getSocket(p.id);
      if (!s) return;

      const mafiaPeers =
        p.role === "mafia"
          ? getAliveMafiaAll()
              .filter((m) => m.id !== p.id)
              .map((m) => ({ id: m.id, name: m.name }))
          : [];

      let detectiveMemory = [];
      if (p.role === "detective" && gameState.settings.detectiveRememberMafia) {
        detectiveMemory = gameState.detectiveHistory
          .filter((h) => h.detectiveId === p.id)
          .map((h) => {
            const t = getPlayerById(h.targetId);
            return {
              night: h.night,
              name: t ? t.name : "Unknown",
              isMafia: !!h.isMafia,
            };
          });
      }

      s.emit("night_phase_player", {
        ...base,
        yourRole: p.role, // legacy
        role: p.role,
        alive: p.alive,
        settings: gameState.settings,
        players: publicPlayers,
        alivePlayers: publicPlayers.filter((pp) => pp.alive),
        nightTargets: buildNightTargetsForPlayer(p),
        mafiaPeers,
        aliveMafiaCount: getAliveMafiaAll().length,
        mafiaCoordEnabled: getAliveMafiaAll().length >= 2,
        mafiaVoteSignals: p.role === "mafia" ? buildMafiaVoteSignals() : [],
        detectiveMemory,
        locked: false,
        nightSummary: null,
      });
    });
  } else if (gameState.phase === PHASES.DAY) {
    const daySummary = gameState.lastNightSummary || "";

    // Host
    if (hostSocketId) {
      io.to(hostSocketId).emit("day_phase", {
        ...base,
        settings: gameState.settings,
        daySummary,
      });
    }

    // Players
    gameState.players.forEach((p) => {
      const s = getSocket(p.id);
      if (!s) return;

      let detectiveMemory = [];
      if (p.role === "detective" && gameState.settings.detectiveRememberMafia) {
        detectiveMemory = gameState.detectiveHistory
          .filter((h) => h.detectiveId === p.id)
          .map((h) => {
            const t = getPlayerById(h.targetId);
            return {
              night: h.night,
              name: t ? t.name : "Unknown",
              isMafia: !!h.isMafia,
            };
          });
      }

      let detectiveLastResult = null;
      if (p.role === "detective" && gameState.lastDetectiveResult && gameState.lastDetectiveResult.detectiveId === p.id) {
        detectiveLastResult = {
          night: gameState.lastDetectiveResult.night,
          targetName: gameState.lastDetectiveResult.targetName,
          isMafia: !!gameState.lastDetectiveResult.isMafia,
        };
      }

      let detectiveCancelMessage = null;
      if (
        p.role === "detective" &&
        !gameState.settings.detectiveRememberMafia &&
        gameState.lastDetectiveCancel &&
        gameState.lastDetectiveCancel.detectiveId === p.id
      ) {
        detectiveCancelMessage = gameState.lastDetectiveCancel.message || null;
      }

      let detectiveCancelHistory = [];
      if (p.role === "detective" && gameState.settings.detectiveRememberMafia) {
        detectiveCancelHistory = (gameState.detectiveCancelHistory || [])
          .filter((h) => h.detectiveId === p.id)
          .map((h) => ({ night: h.night, message: h.message }));
      }

      s.emit("day_phase_player", {
        ...base,
        role: p.role,
        alive: p.alive,
        settings: gameState.settings,
        players: publicPlayers,
        daySummary,
        detectiveLastResult,
        detectiveCancelMessage,
        detectiveCancelHistory,
        detectiveMemory,
      });
    });
  } else if (gameState.phase === PHASES.VOTE) {
    const alivePlayers = getAlivePlayers();

    const voteInfoForHost = {
      ...base,
      settings: gameState.settings,
      voteTimerEnd: gameState.voteTimerEnd,
      players: gameState.players
        .slice()
        .sort(sortPlayersForDisplay)
        .map((p) => ({
          id: p.id,
          name: p.name,
          role: p.role,
          alive: p.alive,
          disconnected: p.disconnected,
          points: p.points || 0,
        })),
    };

    if (hostSocketId) {
      io.to(hostSocketId).emit("vote_phase_host", voteInfoForHost);
    }

    // Players
    gameState.players.forEach((p) => {
      const s = getSocket(p.id);
      if (!s) return;

      const options = [];

      if (p.alive) {
        // All other alive players
        alivePlayers
          .filter((x) => x.id !== p.id)
          .filter((x) => {
            if (p.role === "mafia" && !gameState.settings.allowMafiaVoteMafia) {
              return x.role !== "mafia";
            }
            return true;
          })
          .forEach((x) => {
            options.push({
              id: x.id,
              name: x.name,
              type: "player",
            });
          });

        // Skip vote option
        options.push({
          id: SKIP_VOTE,
          name: "Skip Vote",
          type: "skip",
        });
      }

      let remainingSeconds = 0;
      if (gameState.settings.timedVote && gameState.voteTimerEnd) {
        remainingSeconds = Math.max(
          0,
          Math.round((gameState.voteTimerEnd - Date.now()) / 1000)
        );
      }

      s.emit("vote_phase_player", {
        ...base,
        alive: p.alive,
        settings: gameState.settings,
        players: publicPlayers,
        options,
        remainingSeconds,
        timed: !!gameState.settings.timedVote,
      });
    });
  }
}

// ====== NIGHT RESOLUTION ======

function resolveNightPhase() {
  if (gameState.phase !== PHASES.NIGHT) return;

  const aliveMafia = getAliveMafia();
  const aliveDoctors = getAlivePlayers().filter((p) => p.role === "doctor");
  const aliveDetectives = getAlivePlayers().filter((p) => p.role === "detective");
  const aliveBoxers = getAlivePlayers().filter((p) => p.role === "boxer");

  const boxerTargets = (gameState.actions && gameState.actions.boxerTargets) || {};

  // Any player ID in this set has their night action cancelled by at least one boxer.
  const cancelledByBoxer = new Set();
  aliveBoxers.forEach((b) => {
    const tid = boxerTargets[b.id];
    if (!tid || tid === NO_ONE) return;
    cancelledByBoxer.add(tid);
  });

  const doctorCancelled = aliveDoctors.some((d) => cancelledByBoxer.has(d.id));
  const detectiveCancelled = aliveDetectives.some((d) => cancelledByBoxer.has(d.id));
  const cancelledMafiaIds = new Set(
    aliveMafia.filter((m) => cancelledByBoxer.has(m.id)).map((m) => m.id)
  );

  let killTargetId = null;
  let noKillReason = null;

  function computeMafiaTopTarget(mafiaVoters) {
    const voteCounts = {};
    mafiaVoters.forEach((m) => {
      const choice = gameState.actions.mafiaVotes[m.id];
      if (!choice) return;
      voteCounts[choice] = (voteCounts[choice] || 0) + 1;
    });

    let maxVotes = 0;
    let topTargets = [];

    Object.entries(voteCounts).forEach(([tid, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        topTargets = [tid];
      } else if (count === maxVotes) {
        topTargets.push(tid);
      }
    });

    const topTarget =
      topTargets.length === 0
        ? null
        : topTargets.length === 1
        ? topTargets[0]
        : topTargets[Math.floor(Math.random() * topTargets.length)];

    return { topTarget, voteCounts };
  }

  // 1) Mafia votes (with boxer rule)
  if (aliveMafia.length > 0) {
    const initial = computeMafiaTopTarget(aliveMafia);

    // Boxer has NO effect on the Mafia kill if 2+ Mafia are planning to kill the same person.
    // (We treat this as: any non-SKIP_KILL target has 2+ votes.)
    let anyKillHasTwoPlus = false;
    Object.entries(initial.voteCounts || {}).forEach(([tid, count]) => {
      if (tid !== SKIP_KILL && count >= 2) anyKillHasTwoPlus = true;
    });

    const mafiaVotersForResolution = anyKillHasTwoPlus
      ? aliveMafia
      : aliveMafia.filter((m) => !cancelledMafiaIds.has(m.id));

    const resolved = anyKillHasTwoPlus
      ? initial
      : computeMafiaTopTarget(mafiaVotersForResolution);

    const chosen = resolved.topTarget;

    if (!chosen) {
      killTargetId = null;
      noKillReason = "no_votes";
    } else if (chosen === SKIP_KILL) {
      killTargetId = null;
      noKillReason = "mafia_skip";
    } else {
      const targetPlayer = getPlayerById(chosen);
      if (targetPlayer && targetPlayer.alive) {
        killTargetId = targetPlayer.id;
      } else {
        killTargetId = null;
        noKillReason = "invalid_target";
      }
    }
  }

  const doctorTargetId = gameState.actions.doctorTarget;
  const detectiveTargetId = gameState.actions.detectiveTarget;

  // 2) Doctor protection (unless cancelled)
  let actuallyKilledId = killTargetId;
  if (!doctorCancelled && killTargetId && doctorTargetId === killTargetId) {
    actuallyKilledId = null;
    noKillReason = "saved_by_doctor";
  }

  // Apply death
  let nightSummaryText = "";
  if (actuallyKilledId) {
    const victim = getPlayerById(actuallyKilledId);
    if (victim) {
      victim.alive = false;
      nightSummaryText = `${victim.name} was killed by the Mafia.`;
    } else {
      nightSummaryText = "Someone was killed, but target is unknown.";
    }
  } else {
    if (noKillReason === "mafia_skip") {
      nightSummaryText = "The Mafia decided not to kill anyone tonight.";
    } else if (noKillReason === "saved_by_doctor") {
      nightSummaryText = "Someone was attacked, but the Doctor saved them.";
    } else {
      nightSummaryText = "No one died tonight.";
    }
  }

  gameState.lastNightSummary = nightSummaryText;

  // Store last detective result for Day-phase reveal (if enabled)
  gameState.lastDetectiveResult = null;
  gameState.lastDetectiveCancel = null;

  // 3) Detective result (unless cancelled)
  let detectiveResult = null;

  if (detectiveCancelled) {
    const detective = gameState.players.find((p) => p.role === "detective" && p.alive);
    if (detective) {
      const message = "Your action has been cancelled by a boxer.";
      gameState.lastDetectiveCancel = {
        detectiveId: detective.id,
        night: gameState.night,
        message,
      };
      if (gameState.settings.detectiveRememberMafia) {
        gameState.detectiveCancelHistory.push({
          detectiveId: detective.id,
          night: gameState.night,
          message,
        });
      }
    }
  } else if (detectiveTargetId) {
    const detectiveTarget = getPlayerById(detectiveTargetId);
    if (detectiveTarget) {
      const isMafia = detectiveTarget.role === "mafia";
      const detective = gameState.players.find((p) => p.role === "detective");
      if (detective) {
        detectiveResult = {
          detectiveId: detective.id,
          night: gameState.night,
          targetId: detectiveTarget.id,
          targetName: detectiveTarget.name,
          isMafia,
        };
        if (gameState.settings.detectiveRememberMafia) {
          gameState.detectiveHistory.push({
            night: gameState.night,
            detectiveId: detective.id,
            targetId: detectiveTarget.id,
            isMafia,
          });
          gameState.lastDetectiveResult = detectiveResult;
        }
      }
    }
  }

  // 4. Build civilian notes for host
  const civilianNotes = getCivilianNotesForNight(gameState.night);

  // Timeline entry
  gameState.timeline.push({
    type: "night",
    night: gameState.night,
    day: gameState.day,
    info: {
      killedId: actuallyKilledId,
      noKillReason,
      doctorTargetId: doctorTargetId || null,
      detectiveResult: detectiveResult
        ? {
            targetName: detectiveResult.targetName,
            isMafia: detectiveResult.isMafia,
          }
        : null,
      notes: civilianNotes,
    },
  });

  // Host results payload (same structure as before)
  const deathInfoForHost = {
    night: gameState.night,
    killedPlayer: actuallyKilledId
      ? (() => {
          const v = getPlayerById(actuallyKilledId);
          return v
            ? {
                id: v.id,
                name: v.name,
                role: v.role,
              }
            : null;
        })()
      : null,
    notes: civilianNotes,
    textSummary: nightSummaryText,
  };

  const detectiveForHost = detectiveResult
    ? {
        targetName: detectiveResult.targetName,
        isMafia: detectiveResult.isMafia,
      }
    : null;

  // Send results to host
  if (hostSocketId) {
    io.to(hostSocketId).emit("night_resolved_for_host", {
      night: gameState.night,
      deathInfo: deathInfoForHost,
      detectiveInfo: detectiveForHost,
    });
  }

  // Send results to all players (generic summary)
  io.emit("night_resolved_for_players", {
    night: gameState.night,
    textSummary: nightSummaryText,
  });

  // Detective gets private result (only if not cancelled)
  if (detectiveResult) {
    const detSocket = getSocket(detectiveResult.detectiveId);
    if (detSocket) {
      detSocket.emit("detective_result", {
        playerName: detectiveResult.targetName,
        isMafia: detectiveResult.isMafia,
      });
    }
  }

  // Boxer: lock in last target so they cannot repeat next night
  aliveBoxers.forEach((b) => {
    const tid = boxerTargets[b.id];
    b.lastBoxerTarget = tid && tid !== NO_ONE ? tid : null;
  });

  // Check win condition
  const winner = checkWinCondition();
  if (winner) {
    gameState.phase = PHASES.RESULTS;
    applyEndGameScoring(winner);
    const summary = buildGameOverSummary(winner);
    io.emit("game_over", summary);
    return;
  }

  // Advance to Day
  gameState.phase = PHASES.DAY;
  broadcastPhase();
}

// ====== VOTE RESOLUTION ======

function resolveVotePhase() {
  if (gameState.phase !== PHASES.VOTE) return;

  const alivePlayers = getAlivePlayers();
  const votes = gameState.actions.votes || {};

  const counts = {};
  const detailedVotes = [];

  alivePlayers.forEach((p) => {
    const choice = votes[p.id];
    if (!choice) return;
    detailedVotes.push({
      voterId: p.id,
      voterName: p.name,
      targetId: choice,
      targetName:
        choice === SKIP_VOTE
          ? "Skip"
          : (() => {
              const t = getPlayerById(choice);
              return t ? t.name : "Unknown";
            })(),
    });
    counts[choice] = (counts[choice] || 0) + 1;
  });

  let topTarget = null;
  let topCount = 0;
  let secondTopCount = 0;

  Object.entries(counts).forEach(([targetId, count]) => {
    if (count > topCount) {
      secondTopCount = topCount;
      topCount = count;
      topTarget = targetId;
    } else if (count > secondTopCount) {
      secondTopCount = count;
    }
  });

  let eliminatedPlayer = null;
  let skipped = false;

  if (!topTarget) {
    skipped = true;
  } else {
    if (secondTopCount === topCount) {
      skipped = true;
    } else {
      if (topTarget === SKIP_VOTE) {
        skipped = true;
      } else {
        const victim = getPlayerById(topTarget);
        if (victim && victim.alive) {
          victim.alive = false;
          eliminatedPlayer = victim;
        } else {
          skipped = true;
        }
      }
    }
  }

  let summaryText = "";
  if (skipped) {
    summaryText = "Voting was skipped.";
  } else if (eliminatedPlayer) {
    summaryText = `${eliminatedPlayer.name} was voted out.`;
  }

  // Timeline
  gameState.timeline.push({
    type: "vote",
    night: gameState.night,
    day: gameState.day,
    info: {
      eliminatedId: eliminatedPlayer ? eliminatedPlayer.id : null,
      skipped,
      votes: detailedVotes,
    },
  });

  const voteResultPayload = {
    eliminated: eliminatedPlayer
      ? {
          id: eliminatedPlayer.id,
          name: eliminatedPlayer.name,
          role: eliminatedPlayer.role,
        }
      : null,
    skipped,
    detailedVotes,
  };

  if (hostSocketId) {
    io.to(hostSocketId).emit("vote_resolved_for_host", voteResultPayload);
  }

  io.emit("vote_resolved_for_players", voteResultPayload);

  resetVotes();

  // Check win condition
  const winner = checkWinCondition();
  if (winner) {
    gameState.phase = PHASES.RESULTS;
    applyEndGameScoring(winner);
    const summary = buildGameOverSummary(winner);
    io.emit("game_over", summary);
    return;
  }

  // Advance to next night
  gameState.phase = PHASES.NIGHT;
  gameState.night += 1;
  resetNightActions();
  broadcastPhase();
}

// ====== SOCKET.IO HANDLERS ======

io.on("connection", (socket) => {
  console.log("Mafia client connected:", socket.id);

  // Optional reconnect hook from players (safe to ignore for now)
  socket.on("player_connect", () => {
    // No-op: players will still use player_join to join/rename
  });

  // HOST JOINS
  socket.on("host_join", () => {
    hostSocketId = socket.id;
    broadcastLobby();
  });

  // PLAYER JOINS (with unique name enforcement + player_init)
  socket.on("player_join", (data) => {
    let name = (data && data.name) || "";
    name = name.trim();

    name = normalizeDisplayName(name);

    const playerUid = (data && typeof data.playerUid === "string") ? data.playerUid.trim() : "";

    if (!name) {
      socket.emit("player_error", "Please enter a name first.");
      socket.emit("join_rejected", {
        reason: "Please enter a name first.",
      });
      return;
    }

    // If preset names mode is enabled, validate that the name is from the preset list
    if (gameState.settings.usePresetNames && gameState.settings.presetNames.length > 0) {
      const normalizedPresetNames = gameState.settings.presetNames.map(n => normalizeDisplayName(n));
      const isValidPreset = normalizedPresetNames.some(preset => preset.toLowerCase() === name.toLowerCase());

      if (!isValidPreset) {
        socket.emit("player_error", "Please select a name from the preset list.");
        socket.emit("join_rejected", {
          reason: "Please select a name from the preset list.",
        });
        return;
      }
    }

    // Do not allow new players to join mid-game
    if (gameState.phase !== PHASES.LOBBY) {
      socket.emit(
        "player_error",
        "The game has already started. Please wait for the next round."
      );
      socket.emit("join_rejected", {
        reason: "Game already started.",
      });
      return;
    }

    // Enforce unique names among all session players (case-insensitive)
    const lower = name.toLowerCase();
    const nameTaken = gameState.players.some((p) => {
      if (!p || p.id === socket.id) return false;
      if (playerUid && p.uid && p.uid === playerUid) return false;
      if (p.disconnected || !p.id) return false;
      const pname = (p.name || "").trim().toLowerCase();
      return pname === lower;
    });

    if (nameTaken) {
      socket.emit(
        "player_error",
        "That name is already taken. Please choose another one."
      );
      socket.emit("join_rejected", {
        reason: "That name is already taken. Please choose another one.",
      });
      return;
    }

let player = getPlayerById(socket.id);

// If the browser provides a persistent UID, allow refresh/rejoin in the lobby without losing points
if (!player && playerUid) {
  player = getPlayerByUid(playerUid);

  if (player) {
    // If the old socket is still connected, disconnect it so we don't duplicate the same player
    const oldId = player.id;
    if (oldId && oldId !== socket.id) {
      const oldSocket = getSocket(oldId);
      if (oldSocket) {
        try {
          oldSocket.disconnect(true);
        } catch (e) {}
      }
    }

    player.id = socket.id;
    player.joinedSession = true;  // Now connected this session
  }
}

if (!player) {
  player = gameState.players.find((p) => {
    if (!p || p.id === socket.id) return false;
    if (!p.disconnected && p.id) return false;
    return (p.name || "").trim().toLowerCase() === lower;
  });

  if (player) {
    player.id = socket.id;
    if (playerUid && !player.uid) player.uid = playerUid;
    player.joinedSession = true;
  }
}

if (!player) {
  player = {
    id: socket.id,
    uid: playerUid || null,
    name,
    role: null,
    alive: true,
    points: 0,
    stats: {
      mafiaGained: 0,
      civilianGained: 0,
      doctorGained: 0,
      detectiveGained: 0,
      lost: 0,
    },
    disconnected: false,
    joinedSession: true,  // Connected this session
    joinOrder: ++joinSeq,
  };
  gameState.players.push(player);

  // Restore lifetime stats if present
  loadLifetimeIntoPlayer(player, playerUid, player.name);
  upsertLifetimeFromPlayer(player);
} else {
  if (playerUid && !player.uid) player.uid = playerUid;
  player.name = name;
  const wasDisconnected = player.disconnected;
  player.disconnected = false;
  player.joinedSession = true;  // Now connected this session
  ensurePlayerStats(player);

  // If reconnecting during NIGHT, update host with new status
  if (wasDisconnected && gameState.phase === PHASES.NIGHT && hostSocketId) {
    io.to(hostSocketId).emit("night_status_update", {
      nightStatus: getNightStatus(),
    });
    io.to(hostSocketId).emit("host_notification", {
      message: `${player.name} has reconnected.`,
      type: "info"
    });
  }
}


    // Keep DB in sync with latest name + stats
    loadLifetimeIntoPlayer(player, player.uid, player.name);
    upsertLifetimeFromPlayer(player);

    // Legacy acceptance event
    socket.emit("join_accepted", {
      id: socket.id,
      name,
    });

    // New-style player_init with full state
    const publicPlayers = buildPublicPlayers();

    // Build night-specific data if reconnecting during NIGHT
    let nightData = {};
    if (gameState.phase === PHASES.NIGHT && player.alive) {
      const mafiaPeers = player.role === "mafia"
        ? getAliveMafiaAll()
            .filter((m) => m.id !== player.id)
            .map((m) => ({ id: m.id, name: m.name }))
        : [];

      let detectiveMemory = [];
      if (player.role === "detective" && gameState.settings.detectiveRememberMafia) {
        detectiveMemory = gameState.detectiveHistory
          .filter((h) => h.detectiveId === player.id)
          .map((h) => {
            const t = getPlayerById(h.targetId);
            return {
              night: h.night,
              name: t ? t.name : "Unknown",
              isMafia: !!h.isMafia,
            };
          });
      }

      nightData = {
        nightTargets: buildNightTargetsForPlayer(player),
        mafiaPeers,
        mafiaCoordEnabled: getAliveMafiaAll().length >= 2,
        mafiaVoteSignals: player.role === "mafia" ? buildMafiaVoteSignals() : [],
        detectiveMemory,
      };
    }

    socket.emit("player_init", {
      id: player.id,
      name: player.name,
      points: player.points || 0,
      pointsDetail: buildPointsDetailForPlayer(player),
      phase: gameState.phase,
      day: gameState.day,
      night: gameState.night,
      role: player.role,
      alive: player.alive,
      settings: gameState.settings,
      players: publicPlayers,
      mafiaPeers: nightData.mafiaPeers || [],
      aliveMafiaCount: getAliveMafia().length,
      mafiaCoordEnabled: nightData.mafiaCoordEnabled || getAliveMafia().length >= 2,
      detectiveMemory: nightData.detectiveMemory || [],
      nightTargets: nightData.nightTargets || [],
      mafiaVoteSignals: nightData.mafiaVoteSignals || [],
    });

    broadcastLobby();
  });

  // HOST UPDATES SETTINGS
  socket.on("host_update_settings", (settings) => {
    if (socket.id !== hostSocketId) return;
    if (gameState.phase !== PHASES.LOBBY) return;

    const s = gameState.settings;
    if (typeof settings.mafia === "number") s.mafia = Math.max(1, settings.mafia);
    if (typeof settings.doctor === "number")
      s.doctor = Math.max(0, settings.doctor);
    if (typeof settings.detective === "number")
      s.detective = Math.max(0, settings.detective);
    if (typeof settings.boxer === "number")
      s.boxer = Math.max(0, settings.boxer);
    if (typeof settings.civilian === "number")
      s.civilian = Math.max(1, settings.civilian);

    if (typeof settings.anonymousVoting === "boolean")
      s.anonymousVoting = settings.anonymousVoting;
    if (typeof settings.timedVote === "boolean")
      s.timedVote = settings.timedVote;
    if (typeof settings.voteDurationSeconds === "number") {
      s.voteDurationSeconds = Math.max(5, settings.voteDurationSeconds);
    }
    if (typeof settings.mafiaCanSkipKill === "boolean")
      s.mafiaCanSkipKill = settings.mafiaCanSkipKill;
    if (typeof settings.detectiveRememberMafia === "boolean")
      s.detectiveRememberMafia = settings.detectiveRememberMafia;

    if (typeof settings.allowMafiaVoteMafia === "boolean")
      s.allowMafiaVoteMafia = settings.allowMafiaVoteMafia;

    const wasPreset = s.usePresetNames;
    if (typeof settings.usePresetNames === "boolean")
      s.usePresetNames = settings.usePresetNames;

    if (Array.isArray(settings.presetNames)) {
      s.presetNames = settings.presetNames.map(n => normalizeDisplayName(String(n).trim())).filter(n => n.length > 0);
    }

    // If switching from custom to preset mode, force players with invalid names to reselect
    if (!wasPreset && s.usePresetNames && s.presetNames.length > 0) {
      const validNames = new Set(s.presetNames.map(n => n.toUpperCase()));

      for (const p of gameState.players) {
        if (!p.disconnected && !validNames.has((p.name || '').toUpperCase())) {
          // Send forceReselect event to player
          io.to(p.id).emit("forceReselect", {
            reason: "Host enabled preset names. Please select a name from the list."
          });
          // Remove player so they can rejoin with a valid name
          gameState.players = gameState.players.filter(x => x.id !== p.id);
        }
      }
    }

    broadcastLobby();
  });

  // HOST STARTS GAME
  socket.on("host_start_game", () => {
    if (socket.id !== hostSocketId) return;
    if (gameState.phase !== PHASES.LOBBY) return;

    const totalRoles = sumRoleCounts();
    // Count all session players (including offline who joined this session)
    const playerCount = gameState.players.filter((p) => p.joinedSession !== false).length;

    if (playerCount < 6) {
      io.to(hostSocketId).emit("host_error", {
        message: "You need at least 6 players to start.",
      });
      return;
    }

    if (totalRoles !== playerCount) {
      io.to(hostSocketId).emit("host_error", {
        message:
          "Number of roles does not match current amount of players. Please adjust in the settings.",
      });
      return;
    }

    // Assign roles
    const rolesArray = [];
    for (let i = 0; i < gameState.settings.mafia; i++) rolesArray.push("mafia");
    for (let i = 0; i < gameState.settings.doctor; i++) rolesArray.push("doctor");
    for (let i = 0; i < gameState.settings.detective; i++)
      rolesArray.push("detective");
    for (let i = 0; i < gameState.settings.boxer; i++) rolesArray.push("boxer");
    for (let i = 0; i < gameState.settings.civilian; i++)
      rolesArray.push("civilian");

    const shuffled = rolesArray.slice().sort(() => Math.random() - 0.5);
    const allPlayers = gameState.players;

    allPlayers.forEach((p, index) => {
      p.role = shuffled[index];
      p.alive = true;
      p.lastBoxerTarget = null;
      p.points = p.points || 0;
      ensurePlayerStats(p);
    });

    gameState.phase = PHASES.INTRO;
    gameState.day = 0;
    gameState.night = 0;
    resetNightActions();
    resetVotes();
    gameState.timeline = [];
    gameState.detectiveHistory = [];
    gameState.detectiveCancelHistory = [];
    gameState.lastDetectiveCancel = null;
    gameState.lastNightSummary = null;

    broadcastPhase();
  });

  // HOST SKIPS INTRO / STARTS NIGHT 1
  socket.on("host_skip_intro", () => {
    if (socket.id !== hostSocketId) return;
    if (gameState.phase !== PHASES.INTRO) return;

    gameState.phase = PHASES.NIGHT;
    gameState.night = 1;
    resetNightActions();
    broadcastPhase();
  });

  // HOST PROCEEDS TO DAY (after night actions)
  socket.on("host_proceed_day", () => {
    if (socket.id !== hostSocketId) return;
    if (gameState.phase !== PHASES.NIGHT) return;

    // Optional: enforce allNightActionsComplete()
    // if (!allNightActionsComplete()) return;

    resolveNightPhase();
  });

  // HOST SKIPS AN OFFLINE PLAYER'S NIGHT ACTION
  socket.on("host_skip_turn", (data) => {
    if (socket.id !== hostSocketId) return;
    if (gameState.phase !== PHASES.NIGHT) return;

    const playerId = data && data.playerId;
    if (!playerId) return;

    const player = getPlayerById(playerId);
    if (!player || !player.alive) return;

    // Force-complete this player's night action
    forceCompletePlayerNightAction(player);

    // Broadcast updated night status
    if (hostSocketId) {
      io.to(hostSocketId).emit("night_status_update", {
        nightStatus: getNightStatus(),
      });
    }

    io.to(hostSocketId).emit("host_notification", {
      message: `${player.name}'s night action has been skipped.`,
      type: "info"
    });
  });

  // HOST BEGINS VOTE
  socket.on("host_begin_vote", () => {
    if (socket.id !== hostSocketId) return;
    if (gameState.phase !== PHASES.DAY) return;

    gameState.phase = PHASES.VOTE;
    resetVotes();

    if (gameState.settings.timedVote) {
      const duration = gameState.settings.voteDurationSeconds || 60;
      const now = Date.now();
      gameState.voteTimerEnd = now + duration * 1000;

      if (hostSocketId) {
        io.to(hostSocketId).emit("vote_timer_started", {
          voteTimerEnd: gameState.voteTimerEnd,
        });
      }

      gameState.voteTimer = setTimeout(() => {
        if (gameState.phase === PHASES.VOTE) {
          resolveVotePhase();
        }
      }, duration * 1000 + 500);
    }

    broadcastPhase();
  });

  // HOST FORCE RESOLVE VOTE
  socket.on("host_resolve_vote", () => {
    if (socket.id !== hostSocketId) return;
    if (gameState.phase !== PHASES.VOTE) return;

    resolveVotePhase();
  });

  // Alias for older host clients
  socket.on("host_reveal_vote_result", () => {
    if (socket.id !== hostSocketId) return;
    if (gameState.phase !== PHASES.VOTE) return;
    resolveVotePhase();
  });

  // HOST RESET GAME / END GAME (back to lobby, keep lifetime points)
  socket.on("host_reset_game", () => {
    if (socket.id !== hostSocketId) return;
    resetGameToLobby({ removeDisconnected: true });
  });

// RESET ALL LIFETIME POINTS (wipes the DB + resets current in-memory players)
  socket.on("host_reset_points", () => {
    if (socket.id !== hostSocketId) return;

    resetLifetimeDb();

    gameState.players.forEach((p) => {
      p.points = 0;
      p.stats = {
        mafiaGained: 0,
        civilianGained: 0,
        doctorGained: 0,
        detectiveGained: 0,
        lost: 0,
      };
      upsertLifetimeFromPlayer(p);
    });

    broadcastLobby();
  });

  // HOST RETURN TO LAUNCHER
  socket.on("host_return_to_menu", () => {
    if (socket.id !== hostSocketId) return;
    io.emit("returned_to_menu", {});
  });

  // HOST KICKS A PLAYER (lobby only)
  socket.on("kickPlayer", ({ playerId }) => {
    if (socket.id !== hostSocketId) return;

    // Only allow kick in lobby phase
    if (gameState.phase !== PHASES.LOBBY) {
      io.to(hostSocketId).emit("host_error", {
        message: "You can only kick players in the lobby, not during an active game."
      });
      return;
    }

    const playerIndex = gameState.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return;

    const player = gameState.players[playerIndex];
    const sockId = player.id;

    // Notify kicked player
    if (sockId) {
      io.to(sockId).emit("kicked", {
        message: "You have been removed from the game by the host."
      });
      const targetSocket = getSocket(sockId);
      if (targetSocket) targetSocket.disconnect(true);
    }

    // Remove player
    gameState.players.splice(playerIndex, 1);

    console.log("Player kicked:", player.name);
    broadcastLobby();
  });

  // UNIFIED PLAYER NIGHT ACTIONS

  // Mafia "VOTE/RE-VOTE" coordination signal during Night (does NOT confirm the kill)
  socket.on("mafia_vote_signal", (data) => {
    const player = getPlayerById(socket.id);
    if (!player) return;
    if (gameState.phase !== PHASES.NIGHT) return;
    if (player.role !== "mafia" || !player.alive) return;

    const aliveMafia = getAliveMafia();
    // Only enabled when 2+ Mafias are alive (otherwise no coordination needed)
    if (aliveMafia.length < 2) return;

    // If the Mafia already locked in a kill choice, ignore further vote signals
    if (gameState.actions.mafiaVotes && gameState.actions.mafiaVotes[player.id]) return;

    const targetId = data && data.targetId;
    if (!targetId) return;

    const targetPlayer = getPlayerById(targetId);
    if (!targetPlayer || !targetPlayer.alive || targetPlayer.role === "mafia") return;

    if (!gameState.actions.mafiaVoteSignals) gameState.actions.mafiaVoteSignals = {};
    gameState.actions.mafiaVoteSignals[player.id] = targetId;

    const votes = buildMafiaVoteSignals();
    aliveMafia.forEach((m) => {
      io.to(m.id).emit("mafia_vote_signal_update", { votes });
    });
  });


  socket.on("player_night_action", (data) => {
    const player = getPlayerById(socket.id);
    if (!player) return;
    if (gameState.phase !== PHASES.NIGHT) return;

    const type = data && data.type;

    if (type === "mafia") {
      if (player.role !== "mafia" || !player.alive) return;

      let targetId = data && data.targetId;
      const skipKill = !!(data && data.skipKill);

      if (skipKill) {
        if (!gameState.settings.mafiaCanSkipKill) return;
        gameState.actions.mafiaVotes[player.id] = SKIP_KILL;
      } else {
        if (!targetId) return;
        const targetPlayer = getPlayerById(targetId);
        if (!targetPlayer || !targetPlayer.alive || targetPlayer.role === "mafia")
          return;
        gameState.actions.mafiaVotes[player.id] = targetId;
      }
    } else if (type === "doctor") {
      if (player.role !== "doctor" || !player.alive) return;

      const targetId = data && data.targetId;
      if (!targetId) return;
      const targetPlayer = getPlayerById(targetId);
      if (!targetPlayer || !targetPlayer.alive) return;

      gameState.actions.doctorTarget = targetId;
    } else if (type === "detective") {
      if (player.role !== "detective" || !player.alive) return;

      const targetId = data && data.targetId;
      if (!targetId) return;
      const targetPlayer = getPlayerById(targetId);
      if (!targetPlayer || !targetPlayer.alive || targetPlayer.id === player.id)
        return;

      gameState.actions.detectiveTarget = targetId;
    } else if (type === "boxer") {
      if (player.role !== "boxer" || !player.alive) return;

      const targetId = data && data.targetId;
      if (targetId === undefined || targetId === null) return;

      if (targetId !== NO_ONE) {
        const targetPlayer = getPlayerById(targetId);
        if (!targetPlayer || !targetPlayer.alive) return;

        // cannot select same person two nights in a row
        if (player.lastBoxerTarget && player.lastBoxerTarget === targetId) return;
      }

      if (!gameState.actions.boxerTargets) gameState.actions.boxerTargets = {};
      gameState.actions.boxerTargets[player.id] = targetId;
    } else if (type === "civilian" || type === "civilian_note") {
      if (player.role !== "civilian") return;

      // Civilians cannot keep posting notes after death
      if (!player.alive) return;

      const suspectId = data && data.suspectId;
      const trustId = data && data.trustId;
      if (!suspectId || !trustId) return;

      if (suspectId !== NO_ONE) {
        const suspect = getPlayerById(suspectId);
        if (!suspect || !suspect.alive) return;
      }
      if (trustId !== NO_ONE) {
        const trust = getPlayerById(trustId);
        if (!trust || !trust.alive) return;
      }
      gameState.actions.civilianNotes = gameState.actions.civilianNotes.filter(
        (n) => !(n.playerId === player.id && n.night === gameState.night)
      );

      gameState.actions.civilianNotes.push({
        playerId: player.id,
        suspectId,
        trustId,
        night: gameState.night,
      });
    }

    if (hostSocketId) {
      io.to(hostSocketId).emit("night_status_update", {
        nightStatus: getNightStatus(),
      });
    }
  });

  // LEGACY NIGHT ACTION EVENTS (kept for backward compatibility)

  socket.on("player_mafia_choice", (data) => {
    const player = getPlayerById(socket.id);
    if (!player || player.role !== "mafia" || !player.alive) return;
    if (gameState.phase !== PHASES.NIGHT) return;

    const targetId = data && data.targetId;
    if (!targetId) return;

    if (targetId === SKIP_KILL) {
      if (!gameState.settings.mafiaCanSkipKill) return;
      gameState.actions.mafiaVotes[player.id] = SKIP_KILL;
    } else {
      const targetPlayer = getPlayerById(targetId);
      if (!targetPlayer || !targetPlayer.alive || targetPlayer.role === "mafia")
        return;
      gameState.actions.mafiaVotes[player.id] = targetId;
    }

    if (hostSocketId) {
      io.to(hostSocketId).emit("night_status_update", {
        nightStatus: getNightStatus(),
      });
    }
  });

  socket.on("player_doctor_choice", (data) => {
    const player = getPlayerById(socket.id);
    if (!player || player.role !== "doctor" || !player.alive) return;
    if (gameState.phase !== PHASES.NIGHT) return;

    const targetId = data && data.targetId;
    if (!targetId) return;

    const targetPlayer = getPlayerById(targetId);
    if (!targetPlayer || !targetPlayer.alive) return;

    gameState.actions.doctorTarget = targetId;

    if (hostSocketId) {
      io.to(hostSocketId).emit("night_status_update", {
        nightStatus: getNightStatus(),
      });
    }
  });

  socket.on("player_detective_choice", (data) => {
    const player = getPlayerById(socket.id);
    if (!player || player.role !== "detective" || !player.alive) return;
    if (gameState.phase !== PHASES.NIGHT) return;

    const targetId = data && data.targetId;
    if (!targetId) return;

    const targetPlayer = getPlayerById(targetId);
    if (!targetPlayer || !targetPlayer.alive || targetPlayer.id === player.id)
      return;

    gameState.actions.detectiveTarget = targetId;

    if (hostSocketId) {
      io.to(hostSocketId).emit("night_status_update", {
        nightStatus: getNightStatus(),
      });
    }
  });

  socket.on("player_civilian_note", (data) => {
    const player = getPlayerById(socket.id);
    if (!player || player.role !== "civilian") return;
    if (gameState.phase !== PHASES.NIGHT) return;

    // Civilians cannot keep posting notes after death
    if (!player.alive) return;

    const suspectId = data && data.suspectId;
    const trustId = data && data.trustId;
    if (!suspectId || !trustId) return;

      if (suspectId !== NO_ONE) {
        const suspect = getPlayerById(suspectId);
        if (!suspect || !suspect.alive) return;
      }
      if (trustId !== NO_ONE) {
        const trust = getPlayerById(trustId);
        if (!trust || !trust.alive) return;
      }
    gameState.actions.civilianNotes = gameState.actions.civilianNotes.filter(
      (n) => !(n.playerId === player.id && n.night === gameState.night)
    );

    gameState.actions.civilianNotes.push({
      playerId: player.id,
      suspectId,
      trustId,
      night: gameState.night,
    });

    if (hostSocketId) {
      io.to(hostSocketId).emit("night_status_update", {
        nightStatus: getNightStatus(),
      });
    }
  });

  // PLAYER VOTE
  socket.on("player_vote", (data) => {
    const player = getPlayerById(socket.id);
    if (!player || !player.alive) return;
    if (gameState.phase !== PHASES.VOTE) return;

    const voteId = data && (data.voteId || data.targetId);
    if (!voteId) return;

    if (voteId === SKIP_VOTE) {
      gameState.actions.votes[player.id] = SKIP_VOTE;
    } else {
      const targetPlayer = getPlayerById(voteId);
      if (!targetPlayer || !targetPlayer.alive || targetPlayer.id === player.id)
        return;

      // Optional rule: prevent mafia from voting other mafia (unless enabled)
      if (
        player.role === "mafia" &&
        !gameState.settings.allowMafiaVoteMafia &&
        targetPlayer.role === "mafia"
      ) {
        return;
      }

      gameState.actions.votes[player.id] = voteId;
    }

    if (hostSocketId) {
      const voteStatus = {};
      getAlivePlayers().forEach((p) => {
        voteStatus[p.id] = !!gameState.actions.votes[p.id];
      });
      const voteTargets = {};
      if (!gameState.settings.anonymousVoting) {
        getAlivePlayers().forEach((p) => {
          voteTargets[p.id] = gameState.actions.votes[p.id] || null;
        });
      }
      io.to(hostSocketId).emit("vote_status_update", {
        voteStatus,
        voteTargets,
      });
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("Mafia client disconnected:", socket.id);

    if (socket.id === hostSocketId) {
      hostSocketId = null;
      return;
    }

    const player = getPlayerById(socket.id);
    if (!player) return;

    const name = player.name || "A player";
    player.disconnected = true;

    // During lobby phase, keep them in list for reconnection
    if (gameState.phase === PHASES.LOBBY) {
      broadcastLobby();
      return;
    }

    // During active game: keep player in game but mark disconnected
    if (gameState.phase === PHASES.NIGHT) {
      // Notify host about the offline player's pending night action
      notifyHostOfflinePlayer(player);

      // Broadcast night status update
      if (hostSocketId) {
        io.to(hostSocketId).emit("night_status_update", {
          nightStatus: getNightStatus(),
        });
      }
    }

    // During voting phase: their vote just won't count (already handled by voteComplete logic)
    // Game continues without their participation

    // Notify host about the disconnect
    if (hostSocketId) {
      io.to(hostSocketId).emit("host_notification", {
        message: `${name} has disconnected but the game continues.`,
        type: "warning"
      });
    }

    // Broadcast updated lobby/player status to everyone
    broadcastLobby();
  });

});

// API endpoint to receive initial player list from launcher (including offline players)
router.post('/api/init-players', (req, res) => {
  const { players, settings } = req.body || {};
  if (!Array.isArray(players)) {
    return res.status(400).json({ error: 'Invalid players array' });
  }

  console.log('[INIT] Received', players.length, 'players from launcher');

  // Store preset settings if provided
  if (settings) {
    gameState.settings.usePresetNames = settings.usePresetNames || false;
    gameState.settings.presetNames = Array.isArray(settings.presetNames)
      ? settings.presetNames.map(n => normalizeDisplayName(String(n).trim())).filter(n => n.length > 0)
      : [];
  }

  for (const p of players) {
    if (!p.key || !p.name) continue;
    // Check if player already exists by uid
    const existing = gameState.players.find(gp => gp.uid === p.key);
    if (existing) continue;

    // Add offline player to gameState.players array
    const newPlayer = {
      id: null,  // No socket ID yet
      uid: p.key,
      name: normalizeDisplayName(p.name).substring(0, 24),
      role: null,
      alive: true,
      points: 0,
      stats: {
        mafiaGained: 0,
        civilianGained: 0,
        doctorGained: 0,
        detectiveGained: 0,
        lost: 0,
      },
      disconnected: true,  // Mark as offline
      joinedSession: false,  // Never connected this session
      joinOrder: ++joinSeq,
    };

    // Load lifetime stats if available
    loadLifetimeIntoPlayer(newPlayer, p.key, newPlayer.name);
    gameState.players.push(newPlayer);
  }

  broadcastLobby();
  res.json({ ok: true, count: players.length });
});

router.post("/api/update-settings", (req, res) => {
  const { usePresetNames, presetNames } = req.body || {};

  // Update the game's preset settings variables
  if (usePresetNames !== undefined) {
    gameState.settings.usePresetNames = usePresetNames;
  }
  if (presetNames !== undefined) {
    gameState.settings.presetNames = Array.isArray(presetNames)
      ? presetNames.map(n => normalizeDisplayName(String(n).trim())).filter(n => n.length > 0)
      : [];
  }

  console.log("[API] Updated preset settings:", { usePresetNames, presetNames: presetNames?.length || 0 });
  res.status(200).json({ success: true });
});

// Cleanup function
function cleanup() {
  console.log("Cleaning up Mafia game...");

  // Clear vote timer
  if (gameState.voteTimer) {
    clearTimeout(gameState.voteTimer);
    gameState.voteTimer = null;
  }

  // Clear save DB timer
  if (saveDbTimer) {
    clearTimeout(saveDbTimer);
    saveDbTimer = null;
  }

  // Reset game state
  hostSocketId = null;
  gameState.phase = PHASES.LOBBY;
  gameState.players = [];
  gameState.day = 0;
  gameState.night = 0;
  gameState.actions = {
    mafiaVotes: {},
    mafiaVoteSignals: {},
    doctorTarget: null,
    detectiveTarget: null,
    boxerTargets: {},
    civilianNotes: [],
    votes: {},
  };
  gameState.detectiveHistory = [];
  gameState.detectiveCancelHistory = [];
  gameState.lastDetectiveCancel = null;
  gameState.lastDetectiveResult = null;
  gameState.timeline = [];
  gameState.lastNightSummary = null;
  gameState.voteTimerEnd = null;
  joinSeq = 0;
}

return { router, cleanup };
};
