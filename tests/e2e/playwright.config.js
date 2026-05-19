const { defineConfig } = require("@playwright/test");
const path = require("path");

const port = Number(process.env.E2E_PORT || 3210);
const rootDir = path.resolve(__dirname, "../..");

module.exports = defineConfig({
  testDir: ".",
  timeout: 60000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server.js",
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
    },
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 15000,
  },
});
