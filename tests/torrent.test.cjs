const assert = require('node:assert/strict');
const { deflateSync, inflateSync } = require('node:zlib');
const torrent = require('../extension/torrent.js');
const hash = 'abcdef0123456789abcdef0123456789abcdef0123'.slice(0, 40);
const encoded = value => '#/player/' + encodeURIComponent(deflateSync(JSON.stringify(value)).toString('base64'));
(async () => {
  assert.deepEqual(await torrent.read(encoded({ infoHash: hash.toUpperCase(), fileIdx: 8,
    url: 'https://private.example/key', announce: ['https://tracker.example/passkey'],
    behaviorHints: { proxyHeaders: { request: { Authorization: 'secret' } } } })), { infoHash: hash, fileIdx: 8 });
  const route = await torrent.route({ infoHash: hash, fileIdx: 8, secret: 'never share' });
  const stream = JSON.parse(inflateSync(Buffer.from(decodeURIComponent(route.split('/')[2]), 'base64')));
  assert.deepEqual(stream, { infoHash: hash, name: 'Party torrent', description: '', fileIdx: 8 });
  assert.deepEqual(await torrent.read(route), { infoHash: hash, fileIdx: 8 });
  assert.deepEqual(await torrent.read(await torrent.route({ infoHash: hash })), { infoHash: hash, fileIdx: null });
  for (const bad of ['#/discover', '#/player/invalid', encoded({ url: 'https://example.com/movie.mp4' }),
    encoded({ infoHash: hash, fileIdx: -1 }), encoded({ infoHash: hash, fileIdx: 1.5 }), encoded({ infoHash: hash, fileIdx: 65536 }),
    encoded({ infoHash: hash, description: 'x'.repeat(70000) })]) assert.equal(await torrent.read(bad), null);
  console.log('Torrent identity, route, bounds and credential-stripping tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
