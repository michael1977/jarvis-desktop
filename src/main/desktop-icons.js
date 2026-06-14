/**
 * Read desktop shortcuts and return them for display in the HUD.
 * Reads both user desktop and public desktop on Windows.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

function getDesktopPaths() {
  const userDesktop = path.join(os.homedir(), 'Desktop');
  const publicDesktop = path.join('C:', 'Users', 'Public', 'Desktop');
  return [userDesktop, publicDesktop].filter(p => fs.existsSync(p));
}

/**
 * Read all desktop shortcuts/items.
 * Returns array of { name, path, type } objects.
 */
function readDesktopItems() {
  const items = [];
  const seen = new Set();

  for (const desktop of getDesktopPaths()) {
    try {
      const entries = fs.readdirSync(desktop, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'desktop.ini') continue;
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(desktop, entry.name);
        let name = entry.name;
        let type = 'file';

        if (entry.isDirectory()) {
          type = 'folder';
        } else if (name.endsWith('.lnk')) {
          name = name.replace(/\.lnk$/i, '');
          type = 'shortcut';
        } else if (name.endsWith('.url')) {
          name = name.replace(/\.url$/i, '');
          type = 'url';
        } else if (name.endsWith('.exe')) {
          name = name.replace(/\.exe$/i, '');
          type = 'app';
        }

        // Deduplicate by name
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());

        items.push({ name, path: fullPath, type });
      }
    } catch (_) {}
  }

  // Sort alphabetically
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/**
 * Launch a desktop item by its path.
 */
function launchItem(itemPath) {
  if (!fs.existsSync(itemPath)) return;

  if (process.platform === 'win32') {
    // Use start command to open .lnk, folders, files, etc.
    spawn('cmd', ['/c', 'start', '', itemPath], { stdio: 'ignore', detached: true });
  } else {
    execFile('open', [itemPath], { timeout: 5000 }, () => {});
  }
}

module.exports = { readDesktopItems, launchItem };
