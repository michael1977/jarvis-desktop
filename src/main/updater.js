/**
 * Auto-update via GitHub Releases (electron-updater).
 *
 * - Checks shortly after startup and then once every 24h.
 * - Windows: downloads the new installer automatically and applies it on quit
 *   (works without code signing).
 * - macOS: the app is unsigned, so it cannot self-install updates. We still check
 *   and, when a newer version exists, notify the user with a link to the release.
 *
 * No-ops in dev (only works in packaged builds).
 */

const { app, shell, Notification } = require('electron');

const RELEASES_URL = 'https://github.com/michael1977/jarvis-desktop/releases/latest';
const DAY_MS = 24 * 60 * 60 * 1000;

let started = false;

function notify(title, body, url) {
  try {
    const n = new Notification({ title, body });
    if (url) n.on('click', () => shell.openExternal(url));
    n.show();
  } catch (_) {}
}

function initUpdater() {
  if (started) return;
  if (!app.isPackaged) {
    console.log('[updater] dev build — auto-update disabled');
    return;
  }
  started = true;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.error('[updater] electron-updater unavailable:', e.message);
    return;
  }

  const isWin = process.platform === 'win32';
  autoUpdater.autoDownload = isWin;            // mac can't self-install (unsigned)
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => console.error('[updater] error:', e && e.message));
  autoUpdater.on('checking-for-update', () => console.log('[updater] checking…'));
  autoUpdater.on('update-not-available', () => console.log('[updater] up to date'));
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version);
    if (!isWin) {
      notify('J.A.R.V.I.S. update available',
        `Version ${info.version} is out. Click to download.`, RELEASES_URL);
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] downloaded:', info.version, '— will install on quit');
    notify('J.A.R.V.I.S. update ready',
      `Version ${info.version} will be applied next time you restart J.A.R.V.I.S.`);
  });

  const check = () => autoUpdater.checkForUpdates().catch(e => console.error('[updater] check failed:', e && e.message));
  setTimeout(check, 10000);   // initial check ~10s after launch
  setInterval(check, DAY_MS); // then daily
}

module.exports = { initUpdater };
