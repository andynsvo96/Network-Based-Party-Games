"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

const ROOT = path.resolve(__dirname, "..", "..");
const PORT = Number(process.env.LOAD_PORT) || (4300 + Math.floor(Math.random() * 1000));
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REQUEST_TIMEOUT_MS = 10_000;

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parseBooleanArg(name, fallback = false) {
  const raw = String(parseArg(name, String(fallback))).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createIsolatedRuntimeFiles(playerCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "game-launcher-load-"));
  const presetNames = Array.from({ length: playerCount }, (_, i) => `LOAD${String(i + 1).padStart(2, "0")}`);
  const settingsFile = path.join(dir, "settings.json");
  const statsFile = path.join(dir, "stats.json");

  fs.writeFileSync(settingsFile, JSON.stringify({ usePresetNames: true, presetNames }, null, 2));
  fs.writeFileSync(statsFile, JSON.stringify({}, null, 2));

  return { dir, settingsFile, statsFile };
}

function requestJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${pathname}`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${pathname} returned ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`${pathname} returned invalid JSON: ${err.message}`));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`${pathname} timed out`));
    });
    req.on("error", reject);
  });
}

async function waitForServer() {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await requestJson("/health");
      return;
    } catch (err) {
      lastError = err;
      await delay(150);
    }
  }

  throw lastError || new Error("Server did not start in time");
}

async function waitForHealth(predicate, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastHealth = null;

  while (Date.now() < deadline) {
    lastHealth = await requestJson("/health");
    if (predicate(lastHealth)) return lastHealth;
    await delay(100);
  }

  throw new Error(`Timed out waiting for health: ${label}. Last health: ${JSON.stringify(lastHealth)}`);
}

function onceEvent(socket, eventName, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    const onEvent = (payload) => {
      cleanup();
      resolve(payload);
    };

    const onDisconnect = (reason) => {
      cleanup();
      reject(new Error(`Socket disconnected before ${eventName}: ${reason}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off(eventName, onEvent);
      socket.off("disconnect", onDisconnect);
    };

    socket.once(eventName, onEvent);
    socket.once("disconnect", onDisconnect);
  });
}

async function connectSocket(label) {
  const socket = io(BASE_URL, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    timeout: REQUEST_TIMEOUT_MS,
  });

  try {
    await onceEvent(socket, "connect");
  } catch (err) {
    socket.close();
    throw new Error(`${label} failed to connect: ${err.message}`);
  }

  return socket;
}

async function reconnectPlayerDuringGame(players, playerIndex, sockets, game) {
  const player = players[playerIndex];
  if (!player) return null;

  const reconnectStart = Date.now();
  player.socket.close();

  await waitForHealth(health =>
    health.phase === "game" &&
    health.currentGameId === game.id &&
    health.connectedPlayerCount === players.length - 1,
    `${player.name} disconnected during ${game.id}`
  );

  const reconnectedSocket = await connectSocket(`reconnected player ${player.name}`);
  sockets.push(reconnectedSocket);

  const joinSuccessPromise = onceEvent(reconnectedSocket, "join_success");
  const launchGamePromise = onceEvent(reconnectedSocket, "launch_game");
  reconnectedSocket.emit("player_join", { name: player.name, playerKey: player.key });

  await joinSuccessPromise;
  await launchGamePromise;

  players[playerIndex] = { ...player, socket: reconnectedSocket };

  const health = await waitForHealth(nextHealth =>
    nextHealth.phase === "game" &&
    nextHealth.currentGameId === game.id &&
    nextHealth.connectedPlayerCount === players.length,
    `${player.name} reconnected during ${game.id}`
  );

  return {
    playerName: player.name,
    reconnectMs: Date.now() - reconnectStart,
    health,
  };
}

async function hostReturnToLauncherDuringGame(host, players, sockets, game) {
  const hostReturnStart = Date.now();
  host.close();

  await waitForHealth(health =>
    health.phase === "game" &&
    health.currentGameId === game.id &&
    health.hostConnected === false &&
    health.connectedPlayerCount === players.length,
    `host disconnected during ${game.id}`
  );

  const reconnectedHost = await connectSocket("reconnected host");
  sockets.push(reconnectedHost);

  const hostInitPromise = onceEvent(reconnectedHost, "host_init");
  reconnectedHost.emit("host_join");
  await hostInitPromise;

  const health = await waitForHealth(nextHealth =>
    nextHealth.phase === "menu" &&
    nextHealth.currentGameId === null &&
    nextHealth.mountedGames.length === 0 &&
    nextHealth.connectedPlayerCount === players.length &&
    nextHealth.hostConnected === true,
    `host returned ${game.id} to menu`
  );

  return {
    socket: reconnectedHost,
    hostReturnMs: Date.now() - hostReturnStart,
    health,
  };
}

async function launchAndResetGame(hostRef, players, game, options = {}) {
  const host = hostRef.socket;
  const launchStart = Date.now();
  const hostLaunchPromise = onceEvent(host, "launch_game");
  const playerLaunchPromises = players.map(player => onceEvent(player.socket, "launch_game"));
  host.emit("host_select_game", { gameId: game.id });

  await Promise.all([hostLaunchPromise, ...playerLaunchPromises]);
  const gameHealth = await waitForHealth(health =>
    health.phase === "game" &&
    health.currentGameId === game.id &&
    health.mountedGames.includes(game.id) &&
    health.connectedPlayerCount === players.length,
    `${game.id} launched`
  );
  const launchMs = Date.now() - launchStart;

  const reconnect = options.reconnectCheck
    ? await reconnectPlayerDuringGame(players, 0, options.sockets || [], game)
    : null;

  if (options.hostReturnCheck) {
    const hostReturnResult = await hostReturnToLauncherDuringGame(host, players, options.sockets || [], game);
    hostRef.socket = hostReturnResult.socket;
    delete hostReturnResult.socket;

    return {
      gameId: game.id,
      gameName: game.name,
      minPlayers: game.minPlayers,
      launchMs,
      resetMs: hostReturnResult.hostReturnMs,
      reconnect,
      hostReturn: hostReturnResult,
      gameHealth,
      menuHealth: hostReturnResult.health,
    };
  }

  const resetStart = Date.now();
  host.emit("host_reset_session");
  const menuHealth = await waitForHealth(health =>
    health.phase === "menu" &&
    health.currentGameId === null &&
    health.mountedGames.length === 0 &&
    health.connectedPlayerCount === players.length,
    `${game.id} reset to menu`
  );
  const resetMs = Date.now() - resetStart;

  return {
    gameId: game.id,
    gameName: game.name,
    minPlayers: game.minPlayers,
    launchMs,
    resetMs,
    reconnect,
    hostReturn: null,
    gameHealth,
    menuHealth,
  };
}

function summarizeResults(results) {
  const maxOf = (selector) => results.reduce((max, result) => {
    const value = selector(result);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);

  const averageOf = (selector) => {
    const values = results.map(selector).filter(Number.isFinite);
    if (!values.length) return 0;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  };

  return {
    runs: results.length,
    maxLaunchMs: maxOf(result => result.launchMs),
    avgLaunchMs: averageOf(result => result.launchMs),
    maxResetMs: maxOf(result => result.resetMs),
    avgResetMs: averageOf(result => result.resetMs),
    maxReconnectMs: maxOf(result => result.reconnect?.reconnectMs),
    maxHostReturnMs: maxOf(result => result.hostReturn?.hostReturnMs),
  };
}

async function main() {
  const requestedPlayers = Math.max(1, Number(parseArg("players", process.env.LOAD_PLAYERS || "4")) || 4);
  const requestedGameId = parseArg("game", parseArg("games", process.env.LOAD_GAME_ID || "trivia"));
  const cycles = Math.max(1, Number(parseArg("cycles", process.env.LOAD_CYCLES || "1")) || 1);
  const reconnectCheck = parseBooleanArg("reconnect", false);
  const hostReturnCheck = parseBooleanArg("host-return", false);
  const isolatedSettings = parseBooleanArg("isolated-settings", false);
  const isolatedRuntime = isolatedSettings ? createIsolatedRuntimeFiles(requestedPlayers) : null;

  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ...(isolatedRuntime ? {
        GAME_LAUNCHER_SETTINGS_FILE: isolatedRuntime.settingsFile,
        GAME_LAUNCHER_STATS_FILE: isolatedRuntime.statsFile,
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const serverLogs = [];
  server.stdout.on("data", chunk => serverLogs.push(chunk.toString()));
  server.stderr.on("data", chunk => serverLogs.push(chunk.toString()));

  const sockets = [];

  try {
    await waitForServer();

    const host = await connectSocket("host");
    sockets.push(host);
    const hostRef = { socket: host };

    const hostInitPromise = onceEvent(host, "host_init");
    host.emit("host_join");
    const hostInit = await hostInitPromise;

    const games = Array.isArray(hostInit.games) ? hostInit.games : [];
    if (!games.length) throw new Error("No games are available to launch.");

    const presetNames = Array.isArray(hostInit.presetNames) ? hostInit.presetNames : [];
    const generatedNames = Array.from({ length: requestedPlayers }, (_, i) => `LOAD${String(i + 1).padStart(2, "0")}`);
    const names = hostInit.usePresetNames && presetNames.length
      ? presetNames.slice(0, requestedPlayers)
      : generatedNames;

    if (names.length < requestedPlayers) {
      console.warn(`Preset names are enabled, so this run is capped at ${names.length} simulated player(s).`);
    }

    const joinStart = Date.now();
    const players = [];
    for (const name of names) {
      const player = await connectSocket(`player ${name}`);
      sockets.push(player);

      const joinSuccessPromise = onceEvent(player, "join_success");
      player.emit("player_join", { name });
      const joinSuccess = await joinSuccessPromise;
      players.push({ socket: player, name, key: joinSuccess.playerKey });
    }

    await waitForHealth(health =>
      health.phase === "menu" && health.connectedPlayerCount === players.length,
      "players joined"
    );
    const joinMs = Date.now() - joinStart;

    const requestedGameIds = requestedGameId.toLowerCase() === "all"
      ? games.map(game => game.id)
      : requestedGameId.split(",").map(id => id.trim()).filter(Boolean);

    const results = [];
    const skipped = [];

    for (let cycle = 1; cycle <= cycles; cycle++) {
      for (const gameId of requestedGameIds) {
        const game = games.find(g => g.id === gameId);
        if (!game) {
          if (cycle === 1) skipped.push({ gameId, reason: "not found" });
          continue;
        }

        if (players.length < game.minPlayers) {
          if (cycle === 1) {
            skipped.push({
              gameId: game.id,
              gameName: game.name,
              minPlayers: game.minPlayers,
              players: players.length,
              reason: "not enough simulated players",
            });
          }
          continue;
        }

        const result = await launchAndResetGame(hostRef, players, game, { reconnectCheck, hostReturnCheck, sockets });
        results.push({ cycle, ...result });
      }
    }

    if (!results.length) {
      throw new Error(`No requested games were run. Skipped: ${JSON.stringify(skipped)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      port: PORT,
      players: players.length,
      requestedPlayers,
      requestedGameId,
      cycles,
      reconnectCheck,
      hostReturnCheck,
      isolatedSettings,
      joinMs,
      summary: summarizeResults(results),
      results,
      skipped,
    }, null, 2));
  } catch (err) {
    console.error(err.stack || err.message);
    if (serverLogs.length) {
      console.error("\nServer log tail:");
      console.error(serverLogs.join("").split(/\r?\n/).slice(-40).join("\n"));
    }
    process.exitCode = 1;
  } finally {
    for (const socket of sockets) socket.close();
    if (!server.killed) server.kill();
    if (isolatedRuntime) {
      fs.rmSync(isolatedRuntime.dir, { recursive: true, force: true });
    }
  }
}

main();
