/* Public torrent identity only. Never forward an encoded stream or add-on URL. */
(() => {
  'use strict';
  function clean(value) {
    if (!value || typeof value !== 'object' || typeof value.infoHash !== 'string' || !/^[a-f0-9]{40}$/i.test(value.infoHash)) return null;
    const fileIdx = value.fileIdx == null ? null : value.fileIdx;
    if (fileIdx !== null && (!Number.isInteger(fileIdx) || fileIdx < 0 || fileIdx > 65535)) return null;
    return { infoHash: value.infoHash.toLowerCase(), fileIdx };
  }
  async function read(hash) {
    try {
      const match = hash.match(/^#\/player\/([^/?#]+)/);
      if (!match || match[1].length > 22000) return null;
      const binary = atob(decodeURIComponent(match[1]).replace(/-/g, '+').replace(/_/g, '/'));
      const reader = new Blob([Uint8Array.from(binary, c => c.charCodeAt(0))]).stream()
        .pipeThrough(new DecompressionStream('deflate')).getReader();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 65536) { await reader.cancel(); return null; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return clean(JSON.parse(new TextDecoder().decode(bytes)));
    } catch { return null; }
  }
  async function route(value) {
    const source = clean(value);
    if (!source) throw new Error('Invalid torrent selection');
    const stream = { infoHash: source.infoHash, name: 'Party torrent', description: '' };
    if (source.fileIdx !== null) stream.fileIdx = source.fileIdx;
    const compressed = await new Response(new Blob([JSON.stringify(stream)]).stream()
      .pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
    return '#/player/' + encodeURIComponent(btoa(String.fromCharCode(...new Uint8Array(compressed))));
  }
  const same = (a, b) => !!a && !!b && a.infoHash === b.infoHash && a.fileIdx === b.fileIdx;
  const api = { clean, read, route, same };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.OpenStremioPartyTorrent = api;
})();
