const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('built Chromium extension injects and responds to its real toolbar worker', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'party-extension-'));
  const extension = path.resolve('dist/chrome');
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const messages = [];
    page.on('console', msg => messages.push(msg.text()));
    if (!process.env.PARTY_LIVE_SMOKE) await page.route('https://web.stremio.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><style>*{overflow:hidden}</style><h1>Unmodified player page</h1><button>Native control</button>',
    }));
    await page.goto('https://web.stremio.com/');
    await expect(page.locator('#open-stremio-party-root')).toHaveCount(1);
    expect(await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return chrome.tabs.sendMessage(tabs.at(-1).id, { type: 'open-stremio-party:toggle' });
    })).toEqual({ ok: true });
    await expect.poll(() => messages.includes('[Open Stremio Party] panel opened')).toBe(true);
    expect(await page.locator('#open-stremio-party-root').evaluate(el => getComputedStyle(el).overflow)).toBe('visible');
    if (process.env.PARTY_LIVE_SMOKE) await page.waitForTimeout(2000);
    if (!process.env.PARTY_LIVE_SMOKE) await page.getByRole('button', { name: 'Native control' }).click();
    await page.screenshot({ path: test.info().outputPath('extension-panel.png') });
  } finally {
    await context?.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
