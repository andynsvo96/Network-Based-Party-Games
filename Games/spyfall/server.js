// server.js - Spyfall
// Exported as a module for the master game launcher

const fs = require("fs");
const path = require("path");
const express = require("express");

module.exports.init = function(config) {
  const { io, gamePath, players: initialPlayers, settings } = config;

  // ---- Router Setup ----
  const router = express.Router();

  router.use(express.static(gamePath));
  router.use(express.json());

  router.get("/", (req, res) => {
    res.sendFile(path.join(gamePath, "index.html"));
  });

  router.get("/player", (req, res) => {
    res.sendFile(path.join(gamePath, "player.html"));
  });

  router.get("/players", (req, res) => {
    res.sendFile(path.join(gamePath, "player.html"));
  });

  // Avoid noisy favicon 404s in the console
  router.get('/favicon.ico', (req, res) => res.status(204).end());

  // ---- Locations from XML ----
  const locationsFile = path.join(gamePath, "locations.xml");
  const allLocations = loadLocations(locationsFile);

  function loadLocations(filePath) {
    const result = { real: [], fictional: [] };
    try {
      const xml = fs.readFileSync(filePath, "utf8");
      const regex = /<location\s+type="([^"]+)"\s*>([\s\S]*?)<\/location>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        const typeRaw = (match[1] || "").trim().toLowerCase();
        const text = (match[2] || "").trim();
        if (!text) continue;
        if (typeRaw === "real") {
          result.real.push(text);
        } else if (typeRaw === "fictional") {
          result.fictional.push(text);
        }
      }
    } catch (err) {
      console.error("Failed to load locations:", err.message);
    }
    return result;
  }

  function pickRandomLocation(useFictional) {
    const real = allLocations.real || [];
    const fictional = allLocations.fictional || [];
    let pool = real;
    if (useFictional) {
      pool = real.concat(fictional);
    }
    if (!pool.length) return "Unknown Location";
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx];
  }

  // ---- State ----
  const players = new Map(); // id -> {id, name, score, connected, socketId, hasVoted}
  let hostSocket = null;

  const hostState = {
    phase: "lobby", // lobby | discussion | voting | results
    settings: {
      numSpies: 1,
      voteTimeSeconds: 0,
      anonymousVoting: true,
      useFictionalLocations: false,
      usePresetNames: settings?.usePresetNames || false,
      presetNames: settings?.presetNames || [],
    },
    players: [],
  };

  let currentRound = null;

  // ---- Helper: IDs, players ----
  function makeId() {
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function getPlayersArray(connectedOnly = false) {
    let arr = Array.from(players.values());
    if (connectedOnly) {
      arr = arr.filter(p => p.connected);
    }
    arr.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      const sa = a.score || 0;
      const sb = b.score || 0;
      if (sb !== sa) return sb - sa;
      const na = (a.name || "").toUpperCase();
      const nb = (b.name || "").toUpperCase();
      return na.localeCompare(nb);
    });
    return arr.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      connected: p.connected,
      joinedSession: p.joinedSession !== false,  // Default to true for backwards compatibility
      hasVoted: !!p.hasVoted,
    }));
  }

  function getAllPlayersCount() {
    return players.size;
  }

  function sendHostState() {
    if (!hostSocket) return;
    hostState.players = getPlayersArray();
    hostSocket.emit("hostState", hostState);
  }

  function getTakenNames() {
    const taken = [];
    players.forEach((p) => {
      if (p.name) {
        taken.push(p.name.toUpperCase());
      }
    });
    return taken;
  }

  function sendPlayersState() {
    const payload = {
      phase: hostState.phase,
      leaderboard: getPlayersArray(),
      usePresetNames: hostState.settings.usePresetNames,
      presetNames: hostState.settings.presetNames,
      takenNames: getTakenNames(),
    };
    io.emit("playersState", payload);
  }

  function setError(msg) {
    if (hostSocket) hostSocket.emit("errorMessage", msg);
  }

  // ---- Round flow ----
  function startRound() {
    const allPlayers = getPlayersArray(false);
    const connectedPlayers = getPlayersArray(true);
    // Session players are those who have connected at some point this session
    const sessionPlayers = allPlayers.filter(p => p.joinedSession !== false);

    // Min-player check uses all session players (including offline who joined)
    if (sessionPlayers.length < 3) {
      setError("Need at least 3 players registered to start.");
      return;
    }

    // But need at least 2 connected to actually play
    if (connectedPlayers.length < 2) {
      setError("Need at least 2 connected players to play.");
      return;
    }

    const numSpiesSetting = hostState.settings.numSpies || 1;
    const numSpies = Math.min(
      Math.max(1, numSpiesSetting),
      Math.max(1, sessionPlayers.length - 1)
    );

    // Assign roles to all session players (including offline)
    const ids = sessionPlayers.map(p => p.id);
    shuffle(ids);
    const spyIds = ids.slice(0, numSpies);
    const spiesSet = new Set(spyIds);

    const roles = {};
    ids.forEach(id => {
      roles[id] = spiesSet.has(id) ? "spy" : "citizen";
    });

    const location = pickRandomLocation(hostState.settings.useFictionalLocations);

    currentRound = {
      location,
      spies: spiesSet,
      roles,
      voting: null,
    };

    players.forEach((p) => {
      if (roles[p.id]) {
        p.hasVoted = false;
      }
    });

    hostState.phase = "discussion";

    if (hostSocket) {
      hostSocket.emit("roundStarted", { numSpies });
    }

    Object.keys(roles).forEach((pid) => {
      const p = players.get(pid);
      if (!p || !p.connected) return;
      const sockId = p.socketId;
      if (!sockId) return;

      if (roles[pid] === "spy") {
        const otherSpies = Array.from(spiesSet)
          .filter(sid => sid !== pid)
          .map(sid => {
            const sp = players.get(sid);
            return sp ? sp.name : sid;
          });
        io.to(sockId).emit("roleAssigned", {
          role: "spy",
          otherSpies,
        });
      } else {
        io.to(sockId).emit("roleAssigned", {
          role: "citizen",
          otherSpies: [],
        });
      }
    });

    sendHostState();
    sendPlayersState();
  }

  function beginVoting() {
    if (!currentRound || !currentRound.roles) return;
    const ids = Object.keys(currentRound.roles);

    const allowedTargets = new Set(ids);
    const votes = new Map();

    players.forEach((p) => {
      if (currentRound.roles[p.id]) {
        p.hasVoted = false;
      }
    });

    const voting = {
      allowedTargets,
      votes,
      deadline: null,
      timeout: null,
      closed: false,
    };

    const voteTimeSeconds = hostState.settings.voteTimeSeconds || 0;
    if (voteTimeSeconds > 0) {
      voting.deadline = Date.now() + voteTimeSeconds * 1000;
      voting.timeout = setTimeout(() => {
        closeVoting("time");
      }, voteTimeSeconds * 1000 + 200);
    }

    currentRound.voting = voting;
    hostState.phase = "voting";

    const payload = {
      allowedTargets: Array.from(allowedTargets),
      voteTimeSeconds,
      deadline: voting.deadline,
      maxVotes: hostState.settings.numSpies || 1,
    };

    io.emit("votingStarted", payload);
    sendHostState();
    sendPlayersState();
  }

  function closeVoting(reason) {
    if (!currentRound || !currentRound.voting) return;
    const voting = currentRound.voting;
    if (voting.closed) return;

    voting.closed = true;
    if (voting.timeout) {
      clearTimeout(voting.timeout);
      voting.timeout = null;
    }

    io.emit("votingClosed");

    const { counts, votersByTarget } = tallyVotes(voting);
    handleVotingOutcome(counts, votersByTarget);
  }

  function tallyVotes(voting) {
    const counts = {};
    const votersByTarget = {};
    const allowed = voting.allowedTargets || new Set();

    (voting.votes || new Map()).forEach((targetsSet, voterId) => {
      if (!targetsSet) return;
      targetsSet.forEach((targetId) => {
        if (!allowed.has(targetId)) return;
        counts[targetId] = (counts[targetId] || 0) + 1;
        if (!votersByTarget[targetId]) {
          votersByTarget[targetId] = [];
        }
        votersByTarget[targetId].push(voterId);
      });
    });

    return { counts, votersByTarget };
  }

  function handleVotingOutcome(counts, votersByTarget) {
    const targetIds = Object.keys(counts);
    const numSpies = hostState.settings.numSpies || 1;

    if (targetIds.length === 0) {
      finalizeRound({ accused: [], counts, votersByTarget });
      return;
    }

    let maxCount = 0;
    targetIds.forEach((id) => {
      const c = counts[id] || 0;
      if (c > maxCount) maxCount = c;
    });

    const best = targetIds.filter(id => (counts[id] || 0) === maxCount);

    if (best.length > numSpies) {
      if (hostSocket) {
        hostSocket.emit("voteResultsIntermediate", {
          counts,
          tieCandidates: best,
        });
      }
      startTieBreaker(best);
      return;
    }

    finalizeRound({ accused: best, counts, votersByTarget });
  }

  function startTieBreaker(tieCandidates) {
    if (!currentRound) return;

    const allowedTargets = new Set(tieCandidates);
    const votes = new Map();

    const voting = {
      allowedTargets,
      votes,
      deadline: null,
      timeout: null,
      closed: false,
    };

    players.forEach((p) => {
      if (currentRound.roles && currentRound.roles[p.id]) {
        p.hasVoted = false;
      }
    });

    const voteTimeSeconds = hostState.settings.voteTimeSeconds || 0;
    if (voteTimeSeconds > 0) {
      voting.deadline = Date.now() + voteTimeSeconds * 1000;
      voting.timeout = setTimeout(() => {
        closeVoting("time");
      }, voteTimeSeconds * 1000 + 200);
    }

    currentRound.voting = voting;
    hostState.phase = "voting";

    const payload = {
      allowedTargets: tieCandidates,
      voteTimeSeconds,
      deadline: voting.deadline,
      maxVotes: hostState.settings.numSpies || 1,
    };

    io.emit("votingStarted", payload);
    sendHostState();
    sendPlayersState();
  }

  function finalizeRound({ accused, counts, votersByTarget }) {
    if (!currentRound) return;

    const spies = Array.from(currentRound.spies || []);
    const roles = currentRound.roles || {};
    const location = currentRound.location || "Unknown Location";

    const correctSpies = accused.filter(id => currentRound.spies.has(id));
    const numSpies = spies.length;
    const citizensWin = correctSpies.length > 0;

    const scoreChanges = {};

    function setEquals(aSet, bSet) {
      if (aSet.size !== bSet.size) return false;
      for (const v of aSet) {
        if (!bSet.has(v)) return false;
      }
      return true;
    }

    if (numSpies === 1) {
      const spyId = spies[0];

      if (citizensWin) {
        players.forEach((p) => {
          if (!roles[p.id]) return;
          let delta = p.id !== spyId ? 1 : 0;
          const newScore = Math.max(0, (p.score || 0) + delta);
          scoreChanges[p.id] = newScore - (p.score || 0);
          p.score = newScore;
        });
      } else {
        const spySet = new Set(spies);
        players.forEach((p) => {
          if (!roles[p.id]) return;
          const isSpy = spySet.has(p.id);
          let delta = 0;

          if (isSpy) {
            delta = 1;
          } else {
            const voting = currentRound.voting;
            const voteSet = voting && voting.votes && voting.votes.get(p.id)
              ? voting.votes.get(p.id)
              : new Set();
            const correctSet = new Set(spies);
            const perfectGuess = setEquals(voteSet, correctSet);
            delta = perfectGuess ? 0 : -1;
          }

          const newScore = Math.max(0, (p.score || 0) + delta);
          scoreChanges[p.id] = newScore - (p.score || 0);
          p.score = newScore;
        });
      }
    } else {
      const spiesSet = new Set(spies);

      if (citizensWin) {
        const k = correctSpies.length;
        players.forEach((p) => {
          if (!roles[p.id]) return;
          const isSpy = spiesSet.has(p.id);
          let delta = 0;

          if (!isSpy) {
            delta = k;
          } else if (correctSpies.includes(p.id)) {
            delta = -1;
          } else {
            delta = 1;
          }

          const newScore = Math.max(0, (p.score || 0) + delta);
          scoreChanges[p.id] = newScore - (p.score || 0);
          p.score = newScore;
        });
      } else {
        players.forEach((p) => {
          if (!roles[p.id]) return;
          const isSpy = spiesSet.has(p.id);
          let delta = 0;

          if (isSpy) {
            delta = 1;
          } else {
            const voting = currentRound.voting;
            const voteSet = voting && voting.votes && voting.votes.get(p.id)
              ? voting.votes.get(p.id)
              : new Set();
            const correctSet = new Set(spies);
            const perfectGuess = setEquals(voteSet, correctSet);
            delta = perfectGuess ? 0 : -1;
          }

          const newScore = Math.max(0, (p.score || 0) + delta);
          scoreChanges[p.id] = newScore - (p.score || 0);
          p.score = newScore;
        });
      }
    }

    players.forEach((p) => {
      p.hasVoted = false;
    });

    hostState.phase = "results";

    const result = {
      spies,
      accused,
      correctSpies,
      counts,
      votersByTarget,
      settings: hostState.settings,
      scoreChanges,
    };

    const envelope = {
      result,
      location,
      players: getPlayersArray(),
    };

    io.emit("roundResults", envelope);
    sendHostState();
    sendPlayersState();

    currentRound = null;
  }

  function endGameToLobby() {
    if (currentRound && currentRound.voting && currentRound.voting.timeout) {
      clearTimeout(currentRound.voting.timeout);
    }
    currentRound = null;

    players.forEach((p) => {
      p.hasVoted = false;
    });

    hostState.phase = "lobby";
    io.emit("votingClosed");
    io.emit("gameEndedByHost", {
      message: "The host has ended the game. You can now join a new round."
    });

    sendHostState();
    sendPlayersState();
  }

  function allConnectedVoted() {
    if (!currentRound || !currentRound.roles) return false;
    let ids = Object.keys(currentRound.roles);
    ids = ids.filter(id => {
      const p = players.get(id);
      return p && p.connected;
    });
    if (ids.length === 0) return false;
    return ids.every(id => {
      const p = players.get(id);
      return p && p.hasVoted;
    });
  }

  function getSocketIdForPlayer(playerId) {
    const p = players.get(playerId);
    if (!p || !p.connected) return null;
    return p.socketId || null;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  // ---- Socket.io ----
  io.on("connection", (socket) => {
    let isHost = false;
    let playerId = null;

    socket.emit("playersState", {
      phase: hostState.phase,
      leaderboard: getPlayersArray(),
      usePresetNames: hostState.settings.usePresetNames,
      presetNames: hostState.settings.presetNames,
      takenNames: getTakenNames(),
    });

    socket.on("hostJoin", () => {
      isHost = true;
      hostSocket = socket;
      sendHostState();
      sendPlayersState();
    });

    socket.on("host_return_to_menu", () => {
      if (socket !== hostSocket) return;
      endGameToLobby();
      io.emit("returned_to_menu", {});
    });

    socket.on("host_start_with_intro", () => {
      if (socket !== hostSocket) return;
      io.emit("introPhase", {
        gameName: "Spyfall",
        slides: [
          { title: "How to Play", content: "Everyone gets a location card except the spy, who must figure out the location by listening to others!" },
          { title: "Asking Questions", content: "Players take turns asking each other questions or saying the associated word. Try to identify the spy without revealing the location!" },
          { title: "Winning", content: "Non-spies win by voting out the spy. The spy wins by guessing the location or staying hidden!" }
        ]
      });
    });

    socket.on("host_skip_intro", () => {
      if (socket !== hostSocket) return;
      io.emit("introEnded");
    });

    socket.on("registerPlayer", ({ playerId: incomingId, name }) => {
      const cleanName = (name || "Player").trim().toUpperCase();
      let id = incomingId;
      const isReconnecting = id && players.has(id);
      const gameInProgress = hostState.phase !== "lobby";

      if (hostState.settings.usePresetNames && hostState.settings.presetNames.length > 0) {
        const normalizedName = cleanName.trim();
        const isValidPreset = hostState.settings.presetNames.some(preset => preset.trim().toUpperCase() === normalizedName);
        if (!isValidPreset) {
          socket.emit("registerError", "Please select a name from the preset list.");
          return;
        }
      }

      const nameTaken = Array.from(players.values()).some((p) => {
        if (p.id === id) return false;
        return p.name.toUpperCase() === cleanName;
      });

      if (nameTaken) {
        socket.emit("registerError", "That name is already taken. Please choose another one.");
        return;
      }

      if (isReconnecting) {
        const p = players.get(id);
        p.name = cleanName;
        p.connected = true;
        p.joinedSession = true;  // Now connected this session
        p.socketId = socket.id;
        playerId = id;
      } else {
        id = makeId();
        const p = {
          id,
          name: cleanName,
          score: 0,
          connected: true,
          joinedSession: true,  // Connected this session
          socketId: socket.id,
          hasVoted: false,
        };
        players.set(id, p);
        playerId = id;
      }

      socket.emit("playerRegistered", { playerId: id, name: cleanName });
      sendHostState();
      sendPlayersState();

      if (gameInProgress && currentRound && currentRound.roles && currentRound.roles[id]) {
        const role = currentRound.roles[id];
        const spiesSet = currentRound.spies || new Set();

        if (role === "spy") {
          const otherSpies = Array.from(spiesSet)
            .filter(sid => sid !== id)
            .map(sid => {
              const sp = players.get(sid);
              return sp ? sp.name : sid;
            });
          socket.emit("roleAssigned", { role: "spy", otherSpies });
        } else {
          socket.emit("roleAssigned", { role: "citizen", otherSpies: [] });
        }

        if (hostState.phase === "voting" && currentRound.voting) {
          const voting = currentRound.voting;
          socket.emit("votingStarted", {
            allowedTargets: Array.from(voting.allowedTargets || []),
            voteTimeSeconds: hostState.settings.voteTimeSeconds || 0,
            deadline: voting.deadline,
            maxVotes: hostState.settings.numSpies || 1,
          });
        }
      }
    });

    socket.on("changeName", ({ playerId: pid, newName }) => {
      if (hostState.phase !== "lobby") {
        socket.emit("changeNameError", "You can only change your name before the game starts.");
        return;
      }

      if (!pid || !players.has(pid)) {
        socket.emit("changeNameError", "Player not found.");
        return;
      }

      const cleanName = (newName || "").trim().toUpperCase();
      if (!cleanName) {
        socket.emit("changeNameError", "Please enter a valid name.");
        return;
      }

      if (hostState.settings.usePresetNames && hostState.settings.presetNames.length > 0) {
        const isValidPreset = hostState.settings.presetNames.some(preset => preset.trim().toUpperCase() === cleanName);
        if (!isValidPreset) {
          socket.emit("changeNameError", "Please select a name from the preset list.");
          return;
        }
      }

      const nameTaken = Array.from(players.values()).some((p) => {
        if (p.id === pid) return false;
        return p.name.toUpperCase() === cleanName;
      });

      if (nameTaken) {
        socket.emit("changeNameError", "That name is already taken. Please choose another one.");
        return;
      }

      const p = players.get(pid);
      p.name = cleanName;

      socket.emit("nameChanged", { playerId: pid, name: cleanName });
      sendHostState();
      sendPlayersState();
    });

    socket.on("updateSettings", (changes) => {
      if (!isHost) return;
      if (!changes || typeof changes !== "object") return;

      if (Object.prototype.hasOwnProperty.call(changes, "numSpies")) {
        hostState.settings.numSpies = Math.max(1, parseInt(changes.numSpies, 10) || 1);
      }
      if (Object.prototype.hasOwnProperty.call(changes, "voteTimeSeconds")) {
        hostState.settings.voteTimeSeconds = Math.max(0, parseInt(changes.voteTimeSeconds, 10) || 0);
      }
      if (Object.prototype.hasOwnProperty.call(changes, "anonymousVoting")) {
        hostState.settings.anonymousVoting = !!changes.anonymousVoting;
      }
      if (Object.prototype.hasOwnProperty.call(changes, "useFictionalLocations")) {
        hostState.settings.useFictionalLocations = !!changes.useFictionalLocations;
      }
      if (Object.prototype.hasOwnProperty.call(changes, "usePresetNames")) {
        const wasPreset = hostState.settings.usePresetNames;
        hostState.settings.usePresetNames = !!changes.usePresetNames;

        if (!wasPreset && hostState.settings.usePresetNames && hostState.settings.presetNames.length > 0) {
          const presetNamesUpper = new Set(hostState.settings.presetNames.map(n => n.toUpperCase()));
          players.forEach((p) => {
            if (p.connected && p.name && !presetNamesUpper.has(p.name.toUpperCase())) {
              if (p.socketId) {
                io.to(p.socketId).emit("forceReselect", {
                  reason: "Host enabled preset names. Please select a name from the list."
                });
              }
              p.connected = false;
              p.socketId = null;
            }
          });
        }
      }

      sendHostState();
      sendPlayersState();
    });

    socket.on("addPresetName", (data) => {
      if (!isHost) return;
      const name = (data?.name || "").trim().toUpperCase();
      if (!name) return;

      const isDuplicate = hostState.settings.presetNames.some(n => n.toUpperCase() === name);
      if (isDuplicate) {
        socket.emit("error", "That name is already in the preset list.");
        return;
      }

      hostState.settings.presetNames.push(name);
      sendHostState();
      sendPlayersState();
    });

    socket.on("removePresetName", (data) => {
      if (!isHost) return;
      const name = (data?.name || "").trim().toUpperCase();
      if (!name) return;

      hostState.settings.presetNames = hostState.settings.presetNames.filter(n => n.toUpperCase() !== name);
      sendHostState();
      sendPlayersState();
    });

    socket.on("resetScores", () => {
      if (!isHost) return;
      players.forEach((p) => { p.score = 0; });
      sendHostState();
      sendPlayersState();
    });

    socket.on("kickPlayer", ({ playerId: kickId }) => {
      if (!isHost) return;
      if (!kickId || !players.has(kickId)) return;

      const p = players.get(kickId);
      if (p.socketId) {
        io.to(p.socketId).emit("kicked", {
          message: "You have been removed from the game by the host."
        });
      }

      players.delete(kickId);
      sendHostState();
      sendPlayersState();
    });

    socket.on("startGame", () => {
      if (!isHost) return;
      if (hostState.phase !== "lobby") {
        setError("You can only start a game from the lobby.");
        return;
      }
      startRound();
    });

    socket.on("beginVote", () => {
      if (!isHost) return;
      if (!currentRound || hostState.phase !== "discussion") {
        setError("You can only begin voting while a round is in session.");
        return;
      }
      beginVoting();
    });

    socket.on("endGame", () => {
      if (!isHost) return;
      endGameToLobby();
    });

    socket.on("requestLocationReveal", ({ playerId: pid }) => {
      if (!currentRound || !currentRound.roles) return;
      const role = currentRound.roles[pid];
      if (role !== "citizen") return;

      const pSocketId = getSocketIdForPlayer(pid);
      if (!pSocketId) return;

      io.to(pSocketId).emit("locationReveal", {
        location: currentRound.location,
      });
    });

    socket.on("submitVote", ({ playerId: pid, targets }) => {
      if (!currentRound || !currentRound.voting) return;
      if (hostState.phase !== "voting") return;
      if (currentRound.voting.closed) return;
      if (!currentRound.roles || !currentRound.roles[pid]) return;

      const p = players.get(pid);
      if (!p || !p.connected) return;

      const voteTargets = Array.isArray(targets) ? targets : [];
      const allowed = currentRound.voting.allowedTargets || new Set();

      const cleanTargets = [];
      const seen = new Set();
      const maxVotes = hostState.settings.numSpies || 1;
      for (const t of voteTargets) {
        if (t === pid) continue;
        if (!allowed.has(t)) continue;
        if (seen.has(t)) continue;
        cleanTargets.push(t);
        seen.add(t);
        if (cleanTargets.length >= maxVotes) break;
      }

      if (!currentRound.voting.votes) {
        currentRound.voting.votes = new Map();
      }
      currentRound.voting.votes.set(pid, new Set(cleanTargets));
      p.hasVoted = true;

      sendHostState();
      sendPlayersState();

      if (allConnectedVoted()) {
        closeVoting("allVoted");
      }
    });

    socket.on("disconnect", () => {
      if (isHost && hostSocket && hostSocket.id === socket.id) {
        hostSocket = null;
      }
      if (playerId && players.has(playerId)) {
        const p = players.get(playerId);
        p.connected = false;
        p.socketId = null;
        p.hasVoted = false;
      }
      sendHostState();
      sendPlayersState();
    });
  });

  // API endpoints
  router.post('/api/init-players', (req, res) => {
    const { players: playersArray, settings: initSettings } = req.body;
    if (!Array.isArray(playersArray)) {
      return res.status(400).json({ error: 'Invalid players array' });
    }

    console.log('[INIT] Received', playersArray.length, 'players from launcher');

    if (initSettings) {
      hostState.settings.usePresetNames = initSettings.usePresetNames || false;
      hostState.settings.presetNames = initSettings.presetNames || [];
    }

    for (const p of playersArray) {
      if (!p.key || !p.name) continue;
      if (players.has(p.key)) continue;

      players.set(p.key, {
        id: p.key,
        name: (p.name || 'Player').trim().toUpperCase(),
        score: 0,
        connected: false,
        joinedSession: false,  // Never connected this session
        socketId: null,
        hasVoted: false,
      });
    }

    sendHostState();
    sendPlayersState();
    res.json({ ok: true, count: playersArray.length });
  });

  router.post("/api/update-settings", (req, res) => {
    const { usePresetNames, presetNames } = req.body || {};

    if (usePresetNames !== undefined) {
      hostState.settings.usePresetNames = usePresetNames;
    }
    if (presetNames !== undefined) {
      hostState.settings.presetNames = presetNames;
    }

    console.log("[API] Updated preset settings:", { usePresetNames, presetNames: presetNames?.length || 0 });
    res.status(200).json({ success: true });
  });

  // Cleanup function
  function cleanup() {
    console.log('[Spyfall] Cleaning up...');
    if (currentRound && currentRound.voting && currentRound.voting.timeout) {
      clearTimeout(currentRound.voting.timeout);
    }
    currentRound = null;
    players.clear();
    hostSocket = null;
    hostState.phase = "lobby";
  }

  // Initialize with any players passed from launcher
  if (Array.isArray(initialPlayers)) {
    for (const p of initialPlayers) {
      if (!p.key || !p.name) continue;
      players.set(p.key, {
        id: p.key,
        name: (p.name || 'Player').trim().toUpperCase(),
        score: 0,
        connected: false,
        joinedSession: false,  // Never connected this session
        socketId: null,
        hasVoted: false,
      });
    }
  }

  console.log('[Spyfall] Game initialized');

  return { router, cleanup };
};
