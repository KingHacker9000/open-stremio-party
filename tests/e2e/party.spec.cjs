const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const source = fs.readFileSync(path.resolve('extension/content.js'), 'utf8');
const SERVER = 'http://127.0.0.1:18787';
const STREMIO = 'https://web.stremio.com/';
const player = `<!doctype html><style>body{background:#141827;color:white;font:16px system-ui}video{width:640px}</style>
  <h1>Party playback test</h1><div id="player"><video controls muted preload="auto" src="/fixture.webm"></video>
  <button id="native">Native control</button><button id="fullscreen">Fullscreen</button></div>
  <script>document.addEventListener('keydown',()=>document.body.dataset.shortcut='fired');
  document.querySelector('#native').onclick=()=>document.body.dataset.native='clicked';
  document.querySelector('#fullscreen').onclick=()=>document.querySelector('#player').requestFullscreen();</script>`;

async function viewer(browser, { configured = true, room = null } = {}) {
  const context = await browser.newContext();
  if (browser.browserType().name() === 'chromium') {
    await context.grantPermissions(['local-network-access'], { origin: STREMIO });
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('https://web.stremio.com/**', route => {
    if (!route.request().url().includes('fixture.webm')) return route.fulfill({ body: player, contentType: 'text/html' });
    const video = fs.readFileSync(path.resolve('tests/fixtures/video.webm'));
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
    return route.fulfill({ status: range ? 206 : 200, body: video.subarray(start, end + 1),
      contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}) } });
  });
  // Only the extension APIs are simulated. Video, DOM, WebSockets and server are real.
  await context.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const shadow = attach.call(this, options);
      if (this.id === 'open-stremio-party-root') window.partyTestRoot = shadow;
      return shadow;
    };
    window.chrome = { storage: { local: {
      get: async () => JSON.parse(localStorage.getItem('testExtensionStorage') || '{}'),
      set: async values => localStorage.setItem('testExtensionStorage', JSON.stringify({
        ...JSON.parse(localStorage.getItem('testExtensionStorage') || '{}'), ...values })),
    } }, runtime: { onMessage: { addListener: fn => { window.toolbar = fn; } } } };
    const Socket = window.WebSocket;
    window.sockets = [];
    window.WebSocket = class extends Socket {
      constructor(...args) { super(...args); window.sockets.push(this); }
    };
  });
  const url = new URL(STREMIO);
  if (configured) url.searchParams.set('partyServer', SERVER);
  if (room) url.searchParams.set('partyRoom', room);
  url.hash = '/player/encoded-stream/series/tt1234567/tt1234567%3A1%3A9';
  await page.goto(url.href);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 3);
  await page.evaluate(source);
  await page.waitForFunction(() => !!window.partyTestRoot.querySelector('#nickname').value);
  await page.evaluate(() => window.toolbar({ type: 'open-stremio-party:toggle' }, {}, () => {}));
  return { page, context, errors };
}
async function click(page, id) { await page.evaluate(id => window.partyTestRoot.querySelector('#' + id).click(), id); }
async function fill(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const el = window.partyTestRoot.querySelector('#' + id); el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id, value });
}
async function text(page, id) { return page.evaluate(id => window.partyTestRoot.querySelector('#' + id).textContent, id); }
async function create(page) {
  await click(page, 'create');
  await expect.poll(() => text(page, 'code')).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
  return text(page, 'code');
}
async function media(page, properties) {
  await page.evaluate(async properties => {
    const v = document.querySelector('video');
    if (properties.position !== undefined) v.currentTime = properties.position;
    if (properties.speed !== undefined) v.playbackRate = properties.speed;
    if (properties.paused === true) v.pause();
    if (properties.paused === false) await v.play();
  }, properties);
}
async function value(page, property) { return page.$eval('video', (v, p) => v[p], property); }

test('first-time server setup and native controls', async ({ browser }) => {
  const v = await viewer(browser, { configured: false });
  try {
    await fill(v.page, 'server', 'http://unsafe.example');
    expect(await v.page.evaluate(() => partyTestRoot.querySelector('#create').disabled)).toBe(true);
    await fill(v.page, 'server', SERVER);
    expect(await v.page.evaluate(() => partyTestRoot.querySelector('#create').disabled)).toBe(false);
    await create(v.page);
    await v.page.evaluate(() => partyTestRoot.querySelector('#chat').focus());
    await v.page.keyboard.type('k');
    expect(await v.page.locator('body').getAttribute('data-shortcut')).toBeNull();
    await v.page.keyboard.press('Escape');
    expect(await v.page.evaluate(() => partyTestRoot.querySelector('#panel').hidden)).toBe(true);
    await v.page.locator('#native').click();
    await v.page.keyboard.press('k');
    await expect(v.page.locator('body')).toHaveAttribute('data-shortcut', 'fired');
    await expect(v.page.locator('body')).toHaveAttribute('data-native', 'clicked');
    await click(v.page, 'close');
    expect(await v.page.locator('#open-stremio-party-root').evaluate(el => el.getBoundingClientRect().width)).toBe(42);
    expect(v.errors).toEqual([]);
  } finally { await v.context.close(); }
});

test('two viewers sync play, seek, pause, speed, chat and shared control', async ({ browser }) => {
  const host = await viewer(browser);
  let guest;
  try {
    const code = await create(host.page);
    guest = await viewer(browser, { room: code });
    await expect.poll(() => text(guest.page, 'members')).toBe('2 watching');
    await media(host.page, { position: 20, paused: false });
    await expect.poll(() => value(guest.page, 'paused')).toBe(false);
    await expect.poll(async () => Math.abs(await value(host.page, 'currentTime') - await value(guest.page, 'currentTime'))).toBeLessThan(1.5);
    await media(host.page, { position: 40, paused: true, speed: 1.5 });
    await expect.poll(() => value(guest.page, 'paused')).toBe(true);
    await expect.poll(() => value(guest.page, 'currentTime')).toBeCloseTo(40, 0);
    await expect.poll(() => value(guest.page, 'playbackRate')).toBe(1.5);
    await fill(guest.page, 'chat', '<img src=x onerror=alert(1)> hello');
    await click(guest.page, 'send');
    await expect.poll(() => text(host.page, 'messages')).toContain('<img src=x onerror=alert(1)> hello');
    expect(await host.page.evaluate(() => partyTestRoot.querySelector('#messages img'))).toBeNull();
    // Let remote-event suppression expire before exercising a guest's own controls.
    await guest.page.waitForTimeout(1100);
    await media(guest.page, { position: 65 });
    await guest.page.waitForTimeout(400);
    expect(await value(host.page, 'currentTime')).toBeCloseTo(40, 0);
    await host.page.evaluate(() => {
      const select = partyTestRoot.querySelector('#mode'); select.value = 'everyone';
      select.dispatchEvent(new Event('change'));
    });
    await expect.poll(() => guest.page.evaluate(() => partyTestRoot.querySelector('#mode').value)).toBe('everyone');
    await media(host.page, { position: 45 });
    await expect.poll(() => value(guest.page, 'currentTime')).toBeCloseTo(45, 0);
    // A deliberate seek must work immediately after a remote seek, within its echo guard.
    await media(guest.page, { position: 55 });
    await expect.poll(() => value(host.page, 'currentTime')).toBeCloseTo(55, 0);
    expect(host.errors.concat(guest.errors)).toEqual([]);
  } finally { await guest?.context.close(); await host.context.close(); }
});

test('transport reconnect, host replacement and rejected room recovery', async ({ browser }) => {
  const host = await viewer(browser);
  try {
    const code = await create(host.page);
    await host.page.evaluate(() => sockets.at(-1).close());
    await expect.poll(() => host.page.evaluate(() => sockets.length)).toBe(2);
    await expect.poll(() => text(host.page, 'members')).toBe('1 watching');
    const second = await host.context.newPage();
    await second.goto(`${STREMIO}?partyServer=${encodeURIComponent(SERVER)}&partyRoom=${code}`);
    await second.evaluate(source);
    await expect.poll(() => text(host.page, 'notice')).toContain('another tab');
    await host.page.waitForTimeout(2200);
    expect(await host.page.evaluate(() => sockets.length)).toBe(2);
    await second.close();
    await fill(host.page, 'room', 'AAAAAAAAAA'); await click(host.page, 'join');
    await expect.poll(() => text(host.page, 'notice')).toContain('not found');
    await create(host.page);
    expect(host.errors).toEqual([]);
  } finally { await host.context.close(); }
});

test('episode mismatch is safe and a replacement video recovers despite clock skew', async ({ browser }) => {
  const host = await viewer(browser);
  let guest;
  try {
    const code = await create(host.page);
    guest = await viewer(browser, { room: code });
    await expect.poll(() => text(guest.page, 'members')).toBe('2 watching');
    await guest.page.evaluate(() => {
      const realNow = Date.now; Date.now = () => realNow() + 300000;
      location.hash = '/player/encoded-stream/series/tt1234567/tt1234567%3A1%3A10';
    });
    await media(host.page, { position: 30 });
    await expect.poll(() => text(guest.page, 'notice')).toContain('Different title/episode');
    expect(await value(guest.page, 'currentTime')).toBe(0);
    await guest.page.evaluate(() => {
      location.hash = '/player/encoded-stream/series/tt1234567/tt1234567%3A1%3A9';
      const video = document.querySelector('video');
      video.replaceWith(video.cloneNode(true));
    });
    await expect.poll(() => value(guest.page, 'currentTime')).toBeCloseTo(30, 0);
    await media(host.page, { position: 60 });
    await expect.poll(() => value(guest.page, 'currentTime')).toBeCloseTo(60, 0);
    expect(guest.errors.concat(host.errors)).toEqual([]);
  } finally { await guest?.context.close(); await host.context.close(); }
});

test('invite page configures Stremio and panel remains reachable after drag and resize', async ({ browser }) => {
  const v = await viewer(browser);
  try {
    const code = await create(v.page);
    const landing = await v.context.newPage();
    await landing.goto(`${SERVER}/r/${code}`);
    const link = new URL(await landing.locator('#openStremio').getAttribute('href'));
    expect(link.searchParams.get('partyServer')).toBe(SERVER);
    expect(link.searchParams.get('partyRoom')).toBe(code);
    const box = await v.page.locator('#open-stremio-party-root').boundingBox();
    await v.page.mouse.move(box.x + 21, box.y + 21); await v.page.mouse.down();
    await v.page.mouse.move(24, 780, { steps: 6 }); await v.page.mouse.up();
    await v.page.setViewportSize({ width: 420, height: 500 });
    await expect.poll(async () => v.page.evaluate(() => partyTestRoot.querySelector('#panel').getBoundingClientRect().bottom)).toBeLessThanOrEqual(500);
    const panel = await v.page.evaluate(() => {
      const b = partyTestRoot.querySelector('#panel').getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    });
    expect(panel.left).toBeGreaterThanOrEqual(0); expect(panel.right).toBeLessThanOrEqual(420);
    expect(panel.top).toBeGreaterThanOrEqual(0); expect(panel.bottom).toBeLessThanOrEqual(500);
    await click(v.page, 'close');
    await v.page.locator('#fullscreen').click();
    await expect.poll(() => v.page.evaluate(() => document.fullscreenElement?.contains(document.querySelector('#open-stremio-party-root')))).toBe(true);
    await v.page.evaluate(() => document.exitFullscreen());
    expect(v.errors).toEqual([]);
  } finally { await v.context.close(); }
});
