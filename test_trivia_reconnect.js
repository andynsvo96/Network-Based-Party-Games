// Test: Host + 2 Players connect to trivia, exit to launcher, reconnect to trivia, exit again
const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

async function getPageText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function joinAsPlayer(page, name) {
  // Clear any stale data
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await sleep(2000);

  // Check if preset names mode is active (dropdown visible)
  const hasDropdown = await page.evaluate(() => {
    const presetGroup = document.getElementById('presetNameGroup');
    return presetGroup && !presetGroup.classList.contains('hidden');
  });

  if (hasDropdown) {
    // Wait for the option to be available and enabled
    for (let i = 0; i < 20; i++) {
      const optionReady = await page.evaluate((n) => {
        const select = document.getElementById('nameSelect');
        if (!select) return false;
        const opt = Array.from(select.options).find(o => o.value === n);
        return opt && !opt.disabled;
      }, name);
      if (optionReady) break;
      await sleep(500);
    }
    await page.evaluate((n) => {
      document.getElementById('nameSelect').value = n;
    }, name);
    await sleep(200);
  } else {
    // Use text input
    await page.waitForSelector('#nameInput', { state: 'visible', timeout: 5000 });
    await page.fill('#nameInput', name);
  }

  await page.click('#joinBtn');
  await sleep(500);
}

async function run() {
  const browser = await chromium.launch({ headless: true });

  const hostCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const p1Page = await p1Ctx.newPage();
  const p2Page = await p2Ctx.newPage();

  let serverErrors = [];
  for (const [name, page] of [['HOST', hostPage], ['P1', p1Page], ['P2', p2Page]]) {
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('favicon') && !msg.text().includes('404'))
        serverErrors.push(`[${name}] ${msg.text()}`);
    });
  }

  try {
    // ====== STEP 1: Connect host and players to launcher ======
    log('STEP 1: Connecting to launcher...');
    await hostPage.goto(BASE + '/');
    await p1Page.goto(BASE + '/players');
    await p2Page.goto(BASE + '/players');
    await sleep(1500);

    log('  Joining ANDY...');
    await joinAsPlayer(p1Page, 'ANDY');

    log('  Joining JASON...');
    await joinAsPlayer(p2Page, 'JASON');
    await sleep(1000);

    let hostText = await getPageText(hostPage);
    log(`  Host sees ANDY: ${hostText.includes('ANDY')}, JASON: ${hostText.includes('JASON')}`);

    // CHECK localStorage after join
    const p1LsAfterJoin = await p1Page.evaluate(() => ({
      key: localStorage.getItem('launcher_playerKey'),
      name: localStorage.getItem('launcher_playerName'),
      all: Object.keys(localStorage)
    }));
    const p2LsAfterJoin = await p2Page.evaluate(() => ({
      key: localStorage.getItem('launcher_playerKey'),
      name: localStorage.getItem('launcher_playerName'),
      all: Object.keys(localStorage)
    }));
    log(`  P1 localStorage after join: ${JSON.stringify(p1LsAfterJoin)}`);
    log(`  P2 localStorage after join: ${JSON.stringify(p2LsAfterJoin)}`);

    // ====== STEP 2: Launch trivia ======
    log('STEP 2: Launching trivia...');
    await hostPage.evaluate(() => {
      if (typeof socket !== 'undefined') socket.emit('host_select_game', { gameId: 'trivia' });
    });
    await sleep(5000);

    log(`  Host URL: ${hostPage.url()}`);
    log(`  P1 URL: ${p1Page.url()}`);
    log(`  P2 URL: ${p2Page.url()}`);

    // CHECK localStorage on trivia page
    const p1LsOnTrivia = await p1Page.evaluate(() => ({
      key: localStorage.getItem('launcher_playerKey'),
      name: localStorage.getItem('launcher_playerName'),
      all: Object.keys(localStorage)
    }));
    log(`  P1 localStorage on trivia page: ${JSON.stringify(p1LsOnTrivia)}`);

    // ====== STEP 3: Verify trivia game ======
    log('STEP 3: Verifying trivia game...');
    await sleep(3000);

    hostText = await getPageText(hostPage);
    log(`  Host sees ANDY: ${hostText.includes('ANDY')}, JASON: ${hostText.includes('JASON')}`);

    // Get detailed player status from host
    let playerStatus = await hostPage.evaluate(() => {
      const items = document.querySelectorAll('[class*="player"], li, tr, div');
      const results = [];
      items.forEach(el => {
        const text = el.textContent;
        if ((text.includes('ANDY') || text.includes('JASON')) && text.length < 200) {
          results.push({
            text: text.trim().slice(0, 120),
            classes: el.className
          });
        }
      });
      return results;
    });
    log(`  Player status: ${JSON.stringify(playerStatus)}`);

    // ====== STEP 4: Exit to launcher (1st time) ======
    log('STEP 4: Host exits to launcher (1st time)...');
    await hostPage.evaluate(() => {
      if (typeof socket !== 'undefined') socket.emit('host_return_to_menu');
    });
    await sleep(6000);

    log(`  Host URL: ${hostPage.url()}`);
    log(`  P1 URL: ${p1Page.url()}`);
    log(`  P2 URL: ${p2Page.url()}`);

    hostText = await getPageText(hostPage);
    log(`  Host at launcher: ${!hostPage.url().includes('/game/')}`);
    log(`  P1 at launcher: ${p1Page.url().includes('/players')}`);
    log(`  P2 at launcher: ${p2Page.url().includes('/players')}`);
    log(`  Host sees ANDY: ${hostText.includes('ANDY')}, JASON: ${hostText.includes('JASON')}`);

    // ====== STEP 5: Relaunch trivia (2nd time) ======
    log('STEP 5: Relaunching trivia...');
    await sleep(1000);

    await hostPage.evaluate(() => {
      if (typeof socket !== 'undefined') socket.emit('host_select_game', { gameId: 'trivia' });
    });
    await sleep(6000);

    log(`  Host URL: ${hostPage.url()}`);
    log(`  P1 URL: ${p1Page.url()}`);
    log(`  P2 URL: ${p2Page.url()}`);

    // ====== STEP 6: CRITICAL - Check connections after relaunch ======
    log('STEP 6: CRITICAL CHECK - Player connections after relaunch...');
    await sleep(4000);

    hostText = await getPageText(hostPage);
    log(`  Host sees ANDY: ${hostText.includes('ANDY')}`);
    log(`  Host sees JASON: ${hostText.includes('JASON')}`);

    playerStatus = await hostPage.evaluate(() => {
      const items = document.querySelectorAll('[class*="player"], li, tr, div');
      const results = [];
      items.forEach(el => {
        const text = el.textContent;
        if ((text.includes('ANDY') || text.includes('JASON')) && text.length < 200) {
          results.push({
            text: text.trim().slice(0, 120),
            classes: el.className
          });
        }
      });
      return results;
    });
    log(`  Player status (2nd launch): ${JSON.stringify(playerStatus)}`);

    // Check player socket status
    const p1Socket = await p1Page.evaluate(() => {
      if (typeof socket !== 'undefined') return { connected: socket.connected, id: socket.id, url: window.location.href };
      return { noSocket: true, url: window.location.href };
    });
    const p2Socket = await p2Page.evaluate(() => {
      if (typeof socket !== 'undefined') return { connected: socket.connected, id: socket.id, url: window.location.href };
      return { noSocket: true, url: window.location.href };
    });
    log(`  P1 socket: ${JSON.stringify(p1Socket)}`);
    log(`  P2 socket: ${JSON.stringify(p2Socket)}`);

    // Check if players are joined in trivia
    const p1Joined = await p1Page.evaluate(() => {
      return { joined: typeof joined !== 'undefined' ? joined : 'n/a', url: window.location.href };
    });
    const p2Joined = await p2Page.evaluate(() => {
      return { joined: typeof joined !== 'undefined' ? joined : 'n/a', url: window.location.href };
    });
    log(`  P1 joined: ${JSON.stringify(p1Joined)}`);
    log(`  P2 joined: ${JSON.stringify(p2Joined)}`);

    // ====== STEP 7: Exit to launcher (2nd time) ======
    log('STEP 7: Host exits to launcher (2nd time)...');
    await hostPage.evaluate(() => {
      if (typeof socket !== 'undefined') socket.emit('host_return_to_menu');
    });
    await sleep(6000);

    log(`  Host URL: ${hostPage.url()}`);
    log(`  P1 URL: ${p1Page.url()}`);
    log(`  P2 URL: ${p2Page.url()}`);

    hostText = await getPageText(hostPage);
    log(`  Host sees ANDY: ${hostText.includes('ANDY')}, JASON: ${hostText.includes('JASON')}`);

    // ====== STEP 8: Relaunch trivia (3rd time) ======
    log('STEP 8: Relaunching trivia (3rd time)...');
    await sleep(1000);

    await hostPage.evaluate(() => {
      if (typeof socket !== 'undefined') socket.emit('host_select_game', { gameId: 'trivia' });
    });
    await sleep(6000);

    log('STEP 9: FINAL CHECK - Player connections after 3rd launch...');
    await sleep(4000);

    hostText = await getPageText(hostPage);
    log(`  Host sees ANDY: ${hostText.includes('ANDY')}`);
    log(`  Host sees JASON: ${hostText.includes('JASON')}`);

    playerStatus = await hostPage.evaluate(() => {
      const items = document.querySelectorAll('[class*="player"], li, tr, div');
      const results = [];
      items.forEach(el => {
        const text = el.textContent;
        if ((text.includes('ANDY') || text.includes('JASON')) && text.length < 200) {
          results.push({
            text: text.trim().slice(0, 120),
            classes: el.className
          });
        }
      });
      return results;
    });
    log(`  Player status (3rd launch): ${JSON.stringify(playerStatus)}`);

    const p1Final = await p1Page.evaluate(() => {
      return {
        url: window.location.href,
        socketConnected: typeof socket !== 'undefined' ? socket.connected : 'no socket',
        joined: typeof joined !== 'undefined' ? joined : 'n/a'
      };
    });
    const p2Final = await p2Page.evaluate(() => {
      return {
        url: window.location.href,
        socketConnected: typeof socket !== 'undefined' ? socket.connected : 'no socket',
        joined: typeof joined !== 'undefined' ? joined : 'n/a'
      };
    });
    log(`  P1 final: ${JSON.stringify(p1Final)}`);
    log(`  P2 final: ${JSON.stringify(p2Final)}`);

    if (serverErrors.length > 0) {
      log('Console errors:');
      serverErrors.forEach(e => log(`  ${e}`));
    }

    log('TEST COMPLETE');

  } catch (err) {
    log(`ERROR: ${err.message}`);
    console.error(err.stack);
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
