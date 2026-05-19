"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..", "..");
const TOURNAMENT_SETTINGS_FILE = path.join(ROOT, "Games", "tournament", "gameSettings.json");
const PORT = Number(process.env.PERF_PORT) || (5300 + Math.floor(Math.random() * 1000));
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REQUEST_TIMEOUT_MS = 10_000;
const PERF_PRESET_NAMES = ["ANDY", "JASON", "RON", "JIA", "MIA", "LEE", "SAM", "KIM"];
const DEFAULT_GAME_IDS = [
  "charades",
  "jeopardy",
  "mafia",
  "poker",
  "spin-the-wheel",
  "spyfall",
  "tournament",
  "trivia",
  "truthordare",
  "voting",
];
const PLAYER_NAMES = PERF_PRESET_NAMES.map(name => name[0] + name.slice(1).toLowerCase());

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parseNumberArg(name, envName, fallback) {
  const value = Number(parseArg(name, process.env[envName] || String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createTempJsonFile(prefix, contents) {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
  return file;
}

function removeFileIfExists(file) {
  if (!file) return;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {
    // Best effort cleanup for temporary perf files.
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function round(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
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

async function waitForProcessExit(child, timeoutMs = 1000) {
  if (!child || child.exitCode !== null) return;

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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

async function measureFramePacing(page, sampleMs) {
  return page.evaluate(async (durationMs) => {
    const frameDeltas = [];
    const longTasks = [];
    let observer = null;

    if ("PerformanceObserver" in window) {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ duration: entry.duration, startTime: entry.startTime });
          }
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch (_) {
        observer = null;
      }
    }

    return new Promise((resolve) => {
      const start = performance.now();
      let last = start;

      function step(now) {
        frameDeltas.push(now - last);
        last = now;

        if (now - start >= durationMs) {
          if (observer) observer.disconnect();
          resolve({
            durationMs: now - start,
            frameDeltas,
            longTasks,
          });
          return;
        }

        requestAnimationFrame(step);
      }

      requestAnimationFrame(step);
    });
  }, sampleMs);
}

function summarizeFrameSample(sample) {
  const deltas = sample.frameDeltas.filter(value => Number.isFinite(value) && value > 0);
  const avgFrameMs = deltas.length
    ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
    : 0;

  return {
    sampleMs: Math.round(sample.durationMs),
    frames: deltas.length,
    avgFps: avgFrameMs ? round(1000 / avgFrameMs) : 0,
    avgFrameMs: round(avgFrameMs),
    p95FrameMs: round(percentile(deltas, 95)),
    p99FrameMs: round(percentile(deltas, 99)),
    maxFrameMs: round(Math.max(0, ...deltas)),
    framesOver16ms: deltas.filter(value => value > 16.7).length,
    framesOver33ms: deltas.filter(value => value > 33.4).length,
    framesOver50ms: deltas.filter(value => value > 50).length,
    longTasks: sample.longTasks.length,
    maxLongTaskMs: round(Math.max(0, ...sample.longTasks.map(task => task.duration))),
  };
}

function collectPerfFailures(results, thresholds) {
  const failures = [];

  for (const result of results) {
    const prefix = `${result.gameId} ${result.scenario}`;

    if (result.avgFps < thresholds.minAvgFps) {
      failures.push(`${prefix}: avg FPS ${result.avgFps} below ${thresholds.minAvgFps}`);
    }
    if (result.maxFrameMs > thresholds.maxFrameMs) {
      failures.push(`${prefix}: max frame ${result.maxFrameMs}ms above ${thresholds.maxFrameMs}ms`);
    }
    if (result.longTasks > thresholds.maxLongTasks) {
      failures.push(`${prefix}: ${result.longTasks} long task(s) above limit ${thresholds.maxLongTasks}`);
    }
    if (result.consoleMessages.length > 0) {
      failures.push(`${prefix}: ${result.consoleMessages.length} console warning/error message(s)`);
    }
    if (result.pageErrors.length > 0) {
      failures.push(`${prefix}: ${result.pageErrors.length} page error(s)`);
    }
    if (result.failedResponses.length > 0) {
      failures.push(`${prefix}: ${result.failedResponses.length} failed HTTP response(s)`);
    }
  }

  return failures;
}

function summarizeResults(results) {
  return {
    gamesMeasured: results.length,
    minAvgFps: round(Math.min(...results.map(result => result.avgFps))),
    maxFrameMs: round(Math.max(...results.map(result => result.maxFrameMs))),
    totalConsoleMessages: results.reduce((sum, result) => sum + result.consoleMessages.length, 0),
    totalPageErrors: results.reduce((sum, result) => sum + result.pageErrors.length, 0),
    totalFailedResponses: results.reduce((sum, result) => sum + result.failedResponses.length, 0),
  };
}

function watchPageHealth(page, pageHealth) {
  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) {
      pageHealth.consoleMessages.push({ type: msg.type(), text: msg.text(), url: page.url() });
    }
  });
  page.on("pageerror", (err) => {
    pageHealth.pageErrors.push({ message: err.message, url: page.url() });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      pageHealth.failedResponses.push({
        status: response.status(),
        url: response.url(),
        pageUrl: page.url(),
      });
    }
  });
}

async function launchGame(page, gameId) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".game-btn", { timeout: REQUEST_TIMEOUT_MS });
  await page.evaluate((id) => {
    window.selectGame(id);
  }, gameId);

  await page.waitForURL(new RegExp(`/game/${gameId}/?$`), { timeout: REQUEST_TIMEOUT_MS });
  await waitForHealth(health =>
    health.phase === "game" &&
    health.currentGameId === gameId &&
    health.mountedGames.includes(gameId),
    `${gameId} launched`
  );
}

async function joinPlayer(browser, name, pageHealth) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (pageHealth) watchPageHealth(page, pageHealth);
  await page.goto(`${BASE_URL}/players`, { waitUntil: "domcontentloaded" });

  await page.waitForFunction(() => {
    function isVisible(id) {
      const el = document.getElementById(id);
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
    }

    return isVisible("presetNameGroup") || isVisible("nameInput");
  }, null, { timeout: REQUEST_TIMEOUT_MS });

  if (await page.locator("#presetNameGroup").isVisible()) {
    await page.waitForFunction((value) => {
      return Array.from(document.querySelectorAll("#nameSelect option"))
        .some(option => option.value === value);
    }, name.toUpperCase(), { timeout: REQUEST_TIMEOUT_MS });
    await page.locator("#nameSelect").selectOption(name.toUpperCase());
  } else {
    await page.locator("#nameInput").fill(name);
  }

  await page.locator("#joinBtn").click();
  await page.waitForSelector("#waitingSection", { timeout: REQUEST_TIMEOUT_MS });
  return { context, page };
}

async function ensurePlayerAtMenu(playerContext) {
  const page = playerContext.page;
  const isWaiting = await page.locator("#waitingSection").isVisible().catch(() => false);
  const isPlayerMenu = page.url().includes("/players");

  if (!isWaiting || !isPlayerMenu) {
    await page.goto(`${BASE_URL}/players`, { waitUntil: "domcontentloaded" });
  }

  await page.locator("#waitingSection").waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
}

async function ensurePlayersJoined(browser, playerContexts, count, pageHealth) {
  while (playerContexts.length < count) {
    playerContexts.push(await joinPlayer(browser, PLAYER_NAMES[playerContexts.length], pageHealth));
  }

  await Promise.all(playerContexts.slice(0, count).map(ensurePlayerAtMenu));
  await waitForHealth(health =>
    health.phase === "menu" &&
    health.connectedPlayerCount >= count,
    `${count} players connected at menu`
  );
}

async function waitForDrawerPage(playerContexts) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const playerContext of playerContexts) {
      const isDrawer = await playerContext.page.locator("#drawerScreen").isVisible().catch(() => false);
      const hasCanvas = await playerContext.page.locator("#drawingCanvas").isVisible().catch(() => false);
      if (isDrawer && hasCanvas) return playerContext.page;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for Charades drawer player");
}

async function simulateDrawing(drawerPage) {
  const canvas = drawerPage.locator("#drawingCanvas");
  await canvas.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Could not locate Charades drawing canvas");

  const left = box.x + box.width * 0.12;
  const right = box.x + box.width * 0.88;
  const top = box.y + box.height * 0.18;
  const bottom = box.y + box.height * 0.82;
  const strokes = 7;
  const pointsPerStroke = 34;

  for (let stroke = 0; stroke < strokes; stroke++) {
    const startY = top + ((bottom - top) * stroke) / Math.max(1, strokes - 1);
    await drawerPage.mouse.move(left, startY);
    await drawerPage.mouse.down();

    for (let point = 1; point <= pointsPerStroke; point++) {
      const progress = point / pointsPerStroke;
      const x = left + (right - left) * progress;
      const y = startY + Math.sin((progress * Math.PI * 2) + stroke) * (box.height * 0.045);
      await drawerPage.mouse.move(x, y);
      await delay(6);
    }

    await drawerPage.mouse.up();
    await delay(45);
  }
}

async function waitForPokerActionPage(playerContexts, timeoutMs = REQUEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const playerContext of playerContexts) {
      const page = playerContext.page;
      const canCall = await page.locator("#callBtn").isEnabled().catch(() => false);
      const canFold = await page.locator("#foldBtn").isEnabled().catch(() => false);
      const canRaise = await page.locator("#raiseBtn").isEnabled().catch(() => false);
      if (canCall || canFold || canRaise) return page;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for Poker player action");
}

async function drivePokerActions(playerContexts, durationMs) {
  const deadline = Date.now() + durationMs;
  let actionCount = 0;

  while (Date.now() < deadline) {
    let acted = false;

    for (const playerContext of playerContexts) {
      const page = playerContext.page;
      const callButton = page.locator("#callBtn");
      const foldButton = page.locator("#foldBtn");

      if (await callButton.isEnabled().catch(() => false)) {
        await callButton.click();
        actionCount++;
        acted = true;
        break;
      }

      if (await foldButton.isEnabled().catch(() => false)) {
        await foldButton.click();
        actionCount++;
        acted = true;
        break;
      }
    }

    await delay(acted ? 175 : 100);
  }

  return actionCount;
}

async function configureTournamentTapRace(page) {
  await page.waitForSelector("#gameCheckboxes input[type='checkbox']", { timeout: REQUEST_TIMEOUT_MS });
  await page.evaluate(() => {
    for (const checkbox of document.querySelectorAll("#gameCheckboxes input[type='checkbox']")) {
      checkbox.checked = checkbox.value === "tap-race";
    }
    window.handleGameCheckboxChange();
  });
}

async function waitForTournamentTapPages(playerContexts) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS * 2;

  while (Date.now() < deadline) {
    const pages = [];

    for (const playerContext of playerContexts) {
      const hasTapButton = await playerContext.page.locator("#tapButton").isVisible().catch(() => false);
      if (hasTapButton) pages.push(playerContext.page);
    }

    if (pages.length >= 2) return pages;
    await delay(100);
  }

  throw new Error("Timed out waiting for Tournament Tap Race players");
}

async function driveTournamentTapRace(playerPages, durationMs) {
  const deadline = Date.now() + durationMs;
  let index = 0;
  let tapCount = 0;

  while (Date.now() < deadline) {
    const page = playerPages[index % playerPages.length];
    index++;

    const tapButton = page.locator("#tapButton");
    if (await tapButton.isVisible().catch(() => false)) {
      await tapButton.click();
      tapCount++;
    }

    await delay(35);
  }

  return tapCount;
}

async function submitTriviaAnswer(page) {
  const answered = await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
    }

    const optionButton = Array.from(document.querySelectorAll(".option-btn"))
      .find(button => isVisible(button) && !button.disabled);
    if (optionButton) {
      optionButton.click();
      return true;
    }

    const tfButton = Array.from(document.querySelectorAll(".tf-btn"))
      .find(button => isVisible(button) && !button.disabled);
    if (tfButton) {
      tfButton.click();
      return true;
    }

    const numberInput = document.getElementById("numberAnswer");
    const numberButton = document.getElementById("submitNumber");
    if (isVisible(numberInput) && isVisible(numberButton) && !numberButton.disabled) {
      numberInput.value = "1";
      numberInput.dispatchEvent(new Event("input", { bubbles: true }));
      numberButton.click();
      return true;
    }

    const textInput = document.getElementById("textAnswer");
    const textButton = document.getElementById("submitText");
    if (isVisible(textInput) && isVisible(textButton) && !textButton.disabled) {
      textInput.value = "test";
      textInput.dispatchEvent(new Event("input", { bubbles: true }));
      textButton.click();
      return true;
    }

    const checkbox = Array.from(document.querySelectorAll("#checkboxGrid .option-btn"))
      .find(button => isVisible(button) && !button.classList.contains("selected"));
    const checkboxSubmit = document.getElementById("submitCheckbox");
    if (checkbox && isVisible(checkboxSubmit) && !checkboxSubmit.disabled) {
      checkbox.click();
      checkboxSubmit.click();
      return true;
    }

    return false;
  });

  return answered;
}

async function waitForTriviaAnswers(playerContexts) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const playerContext of playerContexts) {
      const ready = await playerContext.page.evaluate(() => {
        function isVisible(el) {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
        }

        return Array.from(document.querySelectorAll(".option-btn, .tf-btn")).some(isVisible) ||
          isVisible(document.getElementById("numberAnswer")) ||
          isVisible(document.getElementById("textAnswer"));
      }).catch(() => false);

      if (ready) return;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for Trivia answer controls");
}

async function driveTriviaAnswers(playerContexts) {
  let answerCount = 0;

  for (const playerContext of playerContexts) {
    if (await submitTriviaAnswer(playerContext.page)) answerCount++;
  }

  return answerCount;
}

async function waitForVotingButtons(playerContexts) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const playerContext of playerContexts) {
      const canVote = await playerContext.page.locator(".player-button").first().isVisible().catch(() => false);
      if (canVote) return;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for Voting player buttons");
}

async function driveVotingRound(playerContexts) {
  let voteCount = 0;

  for (const playerContext of playerContexts) {
    const button = playerContext.page.locator(".player-button:not(:disabled)").first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      voteCount++;
    }
  }

  return voteCount;
}

async function waitForSpyfallRevealButtons(playerContexts) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const readyCount = await Promise.all(playerContexts.map(playerContext =>
      playerContext.page.locator("#reveal-btn").isVisible().catch(() => false)
    ));

    if (readyCount.filter(Boolean).length >= Math.min(3, playerContexts.length)) return;
    await delay(100);
  }

  throw new Error("Timed out waiting for Spyfall reveal buttons");
}

async function driveSpyfallRoleReveal(playerContexts) {
  let revealCount = 0;

  for (const playerContext of playerContexts) {
    const button = playerContext.page.locator("#reveal-btn");
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      revealCount++;
    }
  }

  return revealCount;
}

async function selectFirstNonEmptyOption(page, selector) {
  return page.locator(selector).evaluate((select) => {
    const option = Array.from(select.options).find(opt => opt.value && !opt.disabled);
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
}

async function waitForMafiaNightActions(playerContexts) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const playerContext of playerContexts) {
      const hasNightUi = await playerContext.page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll("select"));
        return selects.some(select => {
          const style = window.getComputedStyle(select);
          return style.display !== "none" && style.visibility !== "hidden" && select.getClientRects().length > 0;
        });
      }).catch(() => false);

      if (hasNightUi) return;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for Mafia night actions");
}

async function driveMafiaNightActions(playerContexts) {
  let actionCount = 0;

  for (const playerContext of playerContexts) {
    const page = playerContext.page;
    const selected = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"))
        .filter(select => {
          const style = window.getComputedStyle(select);
          return !select.disabled &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            select.getClientRects().length > 0;
        });

      for (const select of selects) {
        const option = Array.from(select.options).find(opt => opt.value && !opt.disabled);
        if (option) {
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      return selects.length > 0;
    }).catch(() => false);

    if (!selected) continue;

    const actionButton = page.locator("button:not(:disabled)").filter({
      hasText: /KILL|CONFIRM|Confirm Night Action|Confirm Action|Submit Alibi Note/i,
    }).first();

    if (await actionButton.isVisible().catch(() => false)) {
      await actionButton.click();
      actionCount++;
    }
  }

  return actionCount;
}

async function returnToMenu(page) {
  let clickedExit = false;

  for (const selector of ["#returnToLauncherBtn", "#menuBtn", "#exitBtn"]) {
    const exitButton = page.locator(selector).first();
    if (await exitButton.count() && await exitButton.isVisible().catch(() => false)) {
      await exitButton.click();
      clickedExit = true;
      break;
    }
  }

  if (!clickedExit) {
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  }

  await waitForHealth(health =>
    health.phase === "menu" &&
    health.currentGameId === null &&
    health.mountedGames.length === 0 &&
    health.pendingShutdowns === 0 &&
    health.shuttingDownGames.length === 0,
    "returned to menu"
  );
}

async function runActiveScenario(page, browser, playerContexts, gameId, sampleMs) {
  if (gameId === "spin-the-wheel") {
    await page.locator("#startGameBtn").click();
    await page.locator("#skipIntroBtn").click();
    const spinButton = page.locator("#spinBtn");
    await spinButton.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await spinButton.evaluate(button => button.disabled = false);

    const samplePromise = measureFramePacing(page, sampleMs);
    await spinButton.click();
    return {
      scenario: "active-spin",
      sample: summarizeFrameSample(await samplePromise),
    };
  }

  if (gameId === "truthordare") {
    await page.locator("#startBtn").click();
    const introStart = page.locator("#introStartBtn");
    await introStart.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    page.once("dialog", dialog => dialog.accept());

    const samplePromise = measureFramePacing(page, sampleMs);
    await introStart.click();
    return {
      scenario: "active-spin",
      sample: summarizeFrameSample(await samplePromise),
    };
  }

  if (gameId === "charades") {
    await page.locator('.mode-card[data-mode="pictionary"]').click();
    await page.locator("#startGameBtn").click();
    const skipIntro = page.locator("#skipIntroBtn");
    await skipIntro.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await skipIntro.click();
    await page.locator("#canvasContainer").waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    const drawerPage = await waitForDrawerPage(playerContexts);

    const samplePromise = measureFramePacing(page, sampleMs);
    await simulateDrawing(drawerPage);
    return {
      scenario: "active-drawing",
      sample: summarizeFrameSample(await samplePromise),
    };
  }

  if (gameId === "poker") {
    await page.locator("#autoSeatBtn").click();
    const startButton = page.locator("#startGameBtn");
    await startButton.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await page.waitForFunction(() => {
      const button = document.getElementById("startGameBtn");
      return button && !button.disabled;
    }, null, { timeout: REQUEST_TIMEOUT_MS });

    await startButton.click();
    const introStart = page.locator("#btnStartAfterIntro");
    await introStart.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await introStart.click();
    await page.locator("#gameView.active").waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await waitForPokerActionPage(playerContexts);

    const samplePromise = measureFramePacing(page, sampleMs);
    await drivePokerActions(playerContexts, sampleMs);
    return {
      scenario: "active-actions",
      sample: summarizeFrameSample(await samplePromise),
    };
  }

  if (gameId === "tournament") {
    await configureTournamentTapRace(page);
    await page.locator("#startButton").click();
    const skipIntro = page.locator("#skipIntroBtn");
    await skipIntro.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await skipIntro.click();
    await page.locator("#bracketScreen.active, #miniGameScreen.active, #showdownScreen.active").waitFor({
      state: "visible",
      timeout: REQUEST_TIMEOUT_MS,
    });
    const tapPages = await waitForTournamentTapPages(playerContexts);

    const samplePromise = measureFramePacing(page, sampleMs);
    await driveTournamentTapRace(tapPages, sampleMs);
    return {
      scenario: "active-tap-race",
      sample: summarizeFrameSample(await samplePromise),
    };
  }

  if (gameId === "trivia") {
    const startButton = page.locator("#startGameBtn");
    await startButton.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await page.waitForFunction(() => {
      const button = document.getElementById("startGameBtn");
      return button && !button.disabled;
    }, null, { timeout: REQUEST_TIMEOUT_MS });

    await startButton.click();
    const skipIntro = page.locator("#skipIntroBtn");
    await skipIntro.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await skipIntro.click();
    await waitForTriviaAnswers(playerContexts);

    const samplePromise = measureFramePacing(page, sampleMs);
    await driveTriviaAnswers(playerContexts);
    return {
      scenario: "active-answers",
      sample: summarizeFrameSample(await samplePromise),
    };
  }

  if (gameId === "voting") {
    const startButton = page.locator("#btnStart");
    await startButton.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await page.waitForFunction(() => {
      const button = document.getElementById("btnStart");
      return button && !button.disabled;
    }, null, { timeout: REQUEST_TIMEOUT_MS });

    await startButton.click();
    const introStart = page.locator("#btnStartGame");
    await introStart.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await introStart.click();
    await waitForVotingButtons(playerContexts);

    const samplePromise = measureFramePacing(page, sampleMs);
    await driveVotingRound(playerContexts);
    return {
      scenario: "active-votes",
      sample: summarizeFrameSample(await samplePromise),
    };
  }

  if (gameId === "spyfall") {
    const startButton = page.locator("#start-game-btn");
    await startButton.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await page.waitForFunction(() => {
      const button = document.getElementById("start-game-btn");
      return button && !button.disabled;
    }, null, { timeout: REQUEST_TIMEOUT_MS });

    await startButton.click();
    const skipIntro = page.locator("#skipIntroBtn");
    await skipIntro.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await skipIntro.click();
    await waitForSpyfallRevealButtons(playerContexts);

    const samplePromise = measureFramePacing(page, sampleMs);
    await driveSpyfallRoleReveal(playerContexts);
    return {
      scenario: "active-role-reveal",
      sample: summarizeFrameSample(await samplePromise),
    };
  }

  if (gameId === "mafia") {
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll("button"))
        .some(button => {
          const style = window.getComputedStyle(button);
          return button.textContent.trim() === "Start Game" &&
            !button.disabled &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            button.getClientRects().length > 0;
        });
    }, null, { timeout: REQUEST_TIMEOUT_MS });
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find(candidate => {
          const style = window.getComputedStyle(candidate);
          return candidate.textContent.trim() === "Start Game" &&
            !candidate.disabled &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            candidate.getClientRects().length > 0;
        });
      if (button) button.click();
    });

    const introStart = page.locator("#introActionBtn");
    await introStart.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT_MS });
    await introStart.click();
    await page.waitForFunction(() => document.body.textContent.includes("Night 1"), null, {
      timeout: REQUEST_TIMEOUT_MS,
    });
    await waitForMafiaNightActions(playerContexts);

    const samplePromise = measureFramePacing(page, sampleMs);
    await driveMafiaNightActions(playerContexts);
    return {
      scenario: "active-night-actions",
      sample: summarizeFrameSample(await samplePromise),
    };
  }

  return null;
}

async function main() {
  const sampleMs = Math.max(1000, parseNumberArg("sample-ms", "PERF_SAMPLE_MS", 5000));
  const settleMs = Math.max(0, parseNumberArg("settle-ms", "PERF_SETTLE_MS", 750));
  const active = String(parseArg("active", process.env.PERF_ACTIVE || "false")).toLowerCase() === "true";
  const thresholds = {
    minAvgFps: Math.max(1, parseNumberArg("min-fps", "PERF_MIN_FPS", 55)),
    maxFrameMs: Math.max(1, parseNumberArg("max-frame-ms", "PERF_MAX_FRAME_MS", 100)),
    maxLongTasks: Math.max(0, parseNumberArg("max-long-tasks", "PERF_MAX_LONG_TASKS", 0)),
  };
  const gameIds = parseArg("games", parseArg("game", DEFAULT_GAME_IDS.join(",")))
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const launcherSettingsFile = createTempJsonFile("game-launcher-perf-settings", {
    usePresetNames: true,
    presetNames: PERF_PRESET_NAMES,
  });
  const launcherStatsFile = createTempJsonFile("game-launcher-perf-stats", {});
  const tournamentSettingsBackup = fs.existsSync(TOURNAMENT_SETTINGS_FILE)
    ? fs.readFileSync(TOURNAMENT_SETTINGS_FILE, "utf8")
    : null;

  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      GAME_LAUNCHER_SETTINGS_FILE: launcherSettingsFile,
      GAME_LAUNCHER_STATS_FILE: launcherStatsFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const serverLogs = [];
  server.stdout.on("data", chunk => serverLogs.push(chunk.toString()));
  server.stderr.on("data", chunk => serverLogs.push(chunk.toString()));

  let browser;

  try {
    await waitForServer();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const playerContexts = [];
    const pageHealth = {
      consoleMessages: [],
      pageErrors: [],
      failedResponses: [],
    };
    watchPageHealth(page, pageHealth);

    const results = [];
    for (const gameId of gameIds) {
      const beforeConsoleCount = pageHealth.consoleMessages.length;
      const beforePageErrorCount = pageHealth.pageErrors.length;
      const beforeFailedResponseCount = pageHealth.failedResponses.length;

      if (active && gameId === "truthordare") {
        await ensurePlayersJoined(browser, playerContexts, 2, pageHealth);
      }
      if (active && gameId === "charades") {
        await ensurePlayersJoined(browser, playerContexts, 3, pageHealth);
      }
      if (active && gameId === "poker") {
        await ensurePlayersJoined(browser, playerContexts, 3, pageHealth);
      }
      if (active && gameId === "tournament") {
        await ensurePlayersJoined(browser, playerContexts, 4, pageHealth);
      }
      if (active && gameId === "trivia") {
        await ensurePlayersJoined(browser, playerContexts, 3, pageHealth);
      }
      if (active && gameId === "voting") {
        await ensurePlayersJoined(browser, playerContexts, 3, pageHealth);
      }
      if (active && gameId === "spyfall") {
        await ensurePlayersJoined(browser, playerContexts, 3, pageHealth);
      }
      if (active && gameId === "mafia") {
        await ensurePlayersJoined(browser, playerContexts, 6, pageHealth);
      }

      const launchStart = Date.now();
      await launchGame(page, gameId);
      const launchMs = Date.now() - launchStart;
      await delay(settleMs);

      const activeScenario = active
        ? await runActiveScenario(page, browser, playerContexts, gameId, sampleMs)
        : null;
      const sample = activeScenario
        ? activeScenario.sample
        : summarizeFrameSample(await measureFramePacing(page, sampleMs));
      const url = page.url();

      await returnToMenu(page);

      results.push({
        gameId,
        scenario: activeScenario?.scenario || "idle",
        url,
        launchMs,
        ...sample,
        consoleMessages: pageHealth.consoleMessages.slice(beforeConsoleCount),
        pageErrors: pageHealth.pageErrors.slice(beforePageErrorCount),
        failedResponses: pageHealth.failedResponses.slice(beforeFailedResponseCount),
      });
    }

    const summary = summarizeResults(results);
    const failures = collectPerfFailures(results, thresholds);
    const ok = failures.length === 0;

    console.log(JSON.stringify({
      ok,
      port: PORT,
      sampleMs,
      settleMs,
      active,
      thresholds,
      games: gameIds,
      results,
      summary,
      failures,
    }, null, 2));

    if (!ok) {
      console.error(`Performance check failed:\n- ${failures.join("\n- ")}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.stack || err.message);
    if (serverLogs.length) {
      console.error("\nServer log tail:");
      console.error(serverLogs.join("").split(/\r?\n/).slice(-40).join("\n"));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (!server.killed) server.kill();
    await waitForProcessExit(server);
    if (tournamentSettingsBackup !== null) {
      fs.writeFileSync(TOURNAMENT_SETTINGS_FILE, tournamentSettingsBackup);
    }
    removeFileIfExists(launcherSettingsFile);
    removeFileIfExists(launcherStatsFile);
  }
}

main();
