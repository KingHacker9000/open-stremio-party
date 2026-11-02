/* Browser action: open the in-page party panel with no separate setup UI. */
const api = typeof browser !== 'undefined' ? browser : chrome;
const STREMIO_WEB = 'https://web.stremio.com/';
const TOGGLE = { type: 'open-stremio-party:toggle' };

async function toggleInTab(tab) {
  if (!tab?.id) return;
  if (!tab.url?.startsWith(STREMIO_WEB)) {
    await api.tabs.create({ url: STREMIO_WEB });
    return;
  }

  try {
    await api.tabs.sendMessage(tab.id, TOGGLE);
  } catch (_error) {
    // Content scripts aren't injected into existing tabs when an extension
    // is newly installed/reloaded. Inject on demand without reloading video.
    try {
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await api.tabs.sendMessage(tab.id, TOGGLE);
    } catch (error) {
      console.error('[Open Stremio Party] failed to open panel', error);
      // Inform the user without interrupting playback or displaying an overlay.
      await api.action.setBadgeText({ tabId: tab.id, text: '!' });
      await api.action.setTitle({ tabId: tab.id, title: 'Party unavailable — reload this tab' });
      return;
    }
  }
  await api.action.setBadgeText({ tabId: tab.id, text: '' });
  await api.action.setTitle({ tabId: tab.id, title: 'Open Party' });
}

api.action.onClicked.addListener(tab => { void toggleInTab(tab); });
