const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const PORT = 3300 + Math.floor(Math.random() * 1000);

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: PORT, path: pathname }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const res = await request("/host-info");
      if (res.status === 200) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  throw lastError || new Error("Server did not start in time");
}

describe("launcher smoke checks", function () {
  this.timeout(15000);

  let server;

  before(async () => {
    server = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForServer();
  });

  after(() => {
    if (server && !server.killed) {
      server.kill();
    }
  });

  it("serves the host, player, QR, and game manifest routes", async () => {
    const host = await request("/");
    assert.strictEqual(host.status, 200);
    assert.match(host.body, /Game Launcher - Host/);

    const player = await request("/players");
    assert.strictEqual(player.status, 200);
    assert.match(player.body, /Game Night - Join/);

    const qr = await request("/shared/vendor/qrcode.min.js");
    assert.strictEqual(qr.status, 200);

    const manifest = await request("/games/jeopardy/game.json");
    assert.strictEqual(manifest.status, 200);
    assert.match(manifest.body, /"id":\s*"jeopardy"/);

    const health = await request("/health");
    assert.strictEqual(health.status, 200);
    assert.strictEqual(JSON.parse(health.body).ok, true);
  });

  it("does not expose root project files as static assets", async () => {
    const res = await request("/package.json");
    assert.strictEqual(res.status, 404);
  });
});

describe("game registry files", () => {
  it("has valid game manifests and JavaScript syntax", () => {
    const gamesDir = path.join(ROOT, "Games");
    const gameFolders = fs.readdirSync(gamesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(gamesDir, entry.name));

    assert.ok(gameFolders.length > 0, "expected at least one game folder");

    for (const gameDir of gameFolders) {
      const manifestPath = path.join(gameDir, "game.json");
      const serverPath = path.join(gameDir, "server.js");

      assert.ok(fs.existsSync(manifestPath), `${path.basename(gameDir)} is missing game.json`);
      assert.ok(fs.existsSync(serverPath), `${path.basename(gameDir)} is missing server.js`);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      assert.ok(manifest.id, `${path.basename(gameDir)} manifest is missing id`);
      assert.ok(manifest.name, `${path.basename(gameDir)} manifest is missing name`);
      assert.strictEqual(typeof manifest.minPlayers, "number");
      assert.strictEqual(typeof manifest.maxPlayers, "number");

      const syntax = spawnSync(process.execPath, ["--check", serverPath], { cwd: ROOT });
      assert.strictEqual(syntax.status, 0, syntax.stderr.toString() || syntax.stdout.toString());
    }
  });
});
