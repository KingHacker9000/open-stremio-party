(() => {
  const match = location.pathname.match(/^\/r\/([A-HJ-NP-Z2-9]{10})$/i);
  const code = match && match[1].toUpperCase();
  const url = new URL('https://web.stremio.com/');
  url.searchParams.set('partyServer', location.origin);
  if (code) {
    url.searchParams.set('partyRoom', code);
    document.querySelector('#invite').hidden = false;
    document.querySelector('#roomCode').textContent = code;
    document.querySelector('#openStremio').textContent = 'Join party';
  }
  document.querySelector('#openStremio').href = url.href;
  fetch('/public-config').then(r => r.ok ? r.json() : {}).then(config => {
    if (typeof config.releasesUrl === 'string' && config.releasesUrl.startsWith('https://')) {
      const link = document.querySelector('#downloads');
      link.href = config.releasesUrl;
      link.hidden = false;
    }
  }).catch(() => {});
})();
