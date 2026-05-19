const { test, expect } = require("@playwright/test");

async function joinPlayer(browser, baseURL, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/players`);
  if (await page.locator("#presetNameGroup").isVisible()) {
    await page.locator("#nameSelect").selectOption(name.toUpperCase());
  } else {
    await page.locator("#nameInput").fill(name);
  }
  await page.locator("#joinBtn").click();
  await expect(page.locator("#waitingSection")).toBeVisible();
  await expect(page.locator("#playerName")).toHaveText(name.toUpperCase());
  return { context, page };
}

async function waitForHealth(page, baseURL, predicate) {
  await expect.poll(async () => {
    const response = await page.request.get(`${baseURL}/health`);
    return predicate(await response.json());
  }, { timeout: 10000 }).toBe(true);
}

async function clickExitToLauncher(page) {
  const exitButton = page.locator("#returnToLauncherBtn, #menuBtn, #exitBtn").first();
  await expect(exitButton).toBeVisible();
  await exitButton.click();
}

test("host and players can launch games, return to launcher, and repeat", async ({ page, browser, baseURL }) => {
  await page.goto("/");
  await expect(page.locator("#gameGrid")).toBeVisible();

  const p1 = await joinPlayer(browser, baseURL, "Andy");
  const p2 = await joinPlayer(browser, baseURL, "Jason");

  async function launchAndReturn(gameName, gameId) {
    await page.locator(".game-btn", { hasText: gameName }).click();

    await expect(page).toHaveURL(new RegExp(`/game/${gameId}/?$`), { timeout: 10000 });
    await expect(p1.page).toHaveURL(new RegExp(`/game/${gameId}/players`), { timeout: 10000 });
    await expect(p2.page).toHaveURL(new RegExp(`/game/${gameId}/players`), { timeout: 10000 });

    await waitForHealth(page, baseURL, health =>
      health.phase === "game" &&
      health.currentGameId === gameId &&
      health.mountedGames.includes(gameId)
    );

    await clickExitToLauncher(page);

    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
    await expect(p1.page).toHaveURL(/\/players/, { timeout: 10000 });
    await expect(p2.page).toHaveURL(/\/players/, { timeout: 10000 });

    await waitForHealth(page, baseURL, health =>
      health.phase === "menu" &&
      health.currentGameId === null &&
      health.mountedGames.length === 0 &&
      health.connectedPlayerCount === 2
    );
  }

  await launchAndReturn("Trivia Party", "trivia");
  await launchAndReturn("Jeopardy", "jeopardy");
  await launchAndReturn("SPIN THE WHEEL", "spin-the-wheel");
  await launchAndReturn("CHARADES", "charades");
  await launchAndReturn("Truth or Dare", "truthordare");
  await launchAndReturn("Poker", "poker");

  await p1.context.close();
  await p2.context.close();
});
