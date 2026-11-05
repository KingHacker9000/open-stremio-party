const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

(async () => {
  let listener;
  const calls = [];
  let injected = false;
  const api = {
    action: {
      onClicked: { addListener: fn => { listener = fn; } },
      setBadgeText: async args => calls.push(['badge', args.text]),
      setTitle: async args => calls.push(['title', args.title]),
    },
    tabs: {
      create: async args => calls.push(['newTab', args.url]),
      sendMessage: async (_, message) => {
        calls.push(['send', message.type]);
        if (!injected) throw new Error('No receiver');
        return { ok: true };
      },
    },
    scripting: { executeScript: async args => {
      assert.equal(JSON.stringify(args.files), JSON.stringify(['torrent.js', 'content.js']));
      calls.push(['inject']); injected = true;
    } },
  };
  vm.runInNewContext(fs.readFileSync('extension/background.js', 'utf8'), {chrome: api, console});
  assert.equal(typeof listener, 'function');
  listener({id: 1, url: 'https://web.stremio.com/#/discover'});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls.map(x=>x[0]), ['send','inject','send','badge','title']);
  calls.length = 0;
  listener({id: 2, url: 'https://example.org'});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, [['newTab','https://web.stremio.com/']]);
  console.log('Browser action smoke tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
