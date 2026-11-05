const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const localPython = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
module.exports = defineConfig({
  testDir: './tests/e2e', timeout: 30000, workers: 1,
  expect: { timeout: 7000 },
  use: { viewport: { width: 1280, height: 800 }, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', testIgnore: '**/extension.spec.cjs', use: { browserName: 'firefox' } }],
  webServer: {
    command: `"${process.env.PYTHON || (fs.existsSync(localPython) ? localPython : 'python')}" -m server.app`,
    url: 'http://127.0.0.1:18787/healthz', reuseExistingServer: false,
    env: { PORT: '18787', BASE_URL: 'http://127.0.0.1:18787',
      PARTY_DB: path.join(os.tmpdir(), `party-e2e-${process.pid}.sqlite`) },
  },
});
