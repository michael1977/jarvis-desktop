const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// The HUD is a full-screen, always-on, continuously-animated overlay. On some
// Windows GPU/driver + session configurations Chromium's GPU/compositor crashes
// inside the DWM session-capability check (WinStationGetCurrentSessionCapabilities),
// taking the whole app down. All HUD drawing is 2D canvas, so software rendering
// is visually identical — disabling hardware acceleration removes the GPU process
// (and that crash path) entirely. Must run before app 'ready'.
app.disableHardwareAcceleration();

// Patch require resolution BEFORE any native modules are loaded, and neutralize
// naudiodon's bundled segfault-handler (its broken native handler was crashing
// the whole app — see native-modules.js). Both must run before voice/naudiodon.
const { patchRequire, disableSegfaultHandler } = require('./native-modules');
disableSegfaultHandler();
patchRequire();

const AutoLaunch = require('auto-launch');

// Load .env — try project root first (dev mode), packaged path is loaded later in whenReady
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const brain = require('./brain');
const voice = require('./voice');
const tts = require('./tts');
const { loadActions } = require('./actions');
const systemTools = require('./system-tools');
const network = require('./network');
const desktopIcons = require('./desktop-icons');

let mainWindow = null;
let tray = null;
let isPacked = false;
let appDir = '';
let wallpaperMode = true; // default to wallpaper mode

const autoLauncher = new AutoLaunch({
  name: 'J.A.R.V.I.S.',
  isHidden: true,
});

// Resolve where conversation + long-term memory are stored. Prefers a Google Drive
// "Jarvis" folder so memory syncs across machines; falls back to local userData.
function resolveMemoryDir() {
  // 1. Explicit override
  if (process.env.JARVIS_MEMORY_DIR) {
    try { fs.mkdirSync(process.env.JARVIS_MEMORY_DIR, { recursive: true }); return process.env.JARVIS_MEMORY_DIR; } catch (_) {}
  }
  // 2. Auto-detect Google Drive
  const candidates = [];
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) candidates.push(`${String.fromCharCode(c)}:\\My Drive`); // G:\My Drive etc.
    candidates.push(path.join(os.homedir(), 'My Drive'));
    candidates.push(path.join(os.homedir(), 'Google Drive'));
  } else {
    const cs = path.join(os.homedir(), 'Library', 'CloudStorage'); // macOS Google Drive for Desktop
    try {
      for (const d of fs.readdirSync(cs)) {
        if (d.startsWith('GoogleDrive')) candidates.push(path.join(cs, d, 'My Drive'));
      }
    } catch (_) {}
    candidates.push(path.join(os.homedir(), 'Google Drive'));
  }
  for (const base of candidates) {
    try {
      if (fs.existsSync(base)) {
        const dir = path.join(base, 'Jarvis');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
    } catch (_) {}
  }
  // 3. Fallback: local (no cross-machine sync)
  return app.getPath('userData');
}

// One-time copy of existing local memory into the (new) memory dir so switching to
// Google Drive doesn't lose what Jarvis already learned. Never overwrites.
function migrateMemory(fromDir, toDir) {
  if (!fromDir || !toDir || fromDir === toDir) return;
  for (const f of ['memory.json', 'conversation.json']) {
    try {
      const src = path.join(fromDir, f), dst = path.join(toDir, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch (_) {}
  }
}

// Lightweight crash logging (pure JS, no native dep). Records GPU/renderer/child
// process failures to userData/crash-events.log so issues are diagnosable.
function logCrash(kind, details) {
  try {
    const line = `[${new Date().toISOString()}] ${kind} ${JSON.stringify(details)}\n`;
    console.error('[crash]', kind, details);
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash-events.log'), line);
  } catch (_) {}
}

app.on('child-process-gone', (_e, details) => logCrash('child-process-gone', details));
app.on('render-process-gone', (_e, _wc, details) => {
  logCrash('render-process-gone', details);
  // Reload the HUD instead of leaving a dead window.
  if (mainWindow && !mainWindow.isDestroyed() && details.reason !== 'clean-exit') {
    try { mainWindow.webContents.reload(); } catch (_) {}
  }
});

// Helper: send IPC to renderer if window exists
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ---- Real system telemetry ----
let prevCpuTimes = null;

function getCpuUsage() {
  const cpus = os.cpus();
  const totals = { idle: 0, total: 0 };
  for (const cpu of cpus) {
    for (const type in cpu.times) totals.total += cpu.times[type];
    totals.idle += cpu.times.idle;
  }
  if (!prevCpuTimes) {
    prevCpuTimes = totals;
    return 0;
  }
  const dTotal = totals.total - prevCpuTimes.total;
  const dIdle = totals.idle - prevCpuTimes.idle;
  prevCpuTimes = totals;
  return dTotal > 0 ? ((1 - dIdle / dTotal) * 100) : 0;
}

// Enumerate fixed drive roots once (C:\ … Z:\ on Windows, / elsewhere).
let diskRoots = null;
function listDriveRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let c = 67; c <= 90; c++) {
      const r = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(r)) roots.push(r); } catch (_) {}
    }
    return roots.length ? roots : ['C:\\'];
  }
  return ['/'];
}

// Fast per-drive usage via statfs (no PowerShell) — safe to poll every tick.
function getDisks() {
  if (!diskRoots) diskRoots = listDriveRoots();
  const disks = [];
  for (const root of diskRoots) {
    try {
      const s = fs.statfsSync(root);
      const total = s.blocks * s.bsize;
      const free = s.bfree * s.bsize;
      if (!total) continue;
      const used = total - free;
      disks.push({
        name: process.platform === 'win32' ? root.slice(0, 2) : root,
        usedGb: Math.round(used / 1e9),
        freeGb: Math.round(free / 1e9),
        totalGb: Math.round(total / 1e9),
        pct: Math.round((used / total) * 100),
      });
    } catch (_) {}
  }
  return disks;
}

function startTelemetry() {
  getCpuUsage(); // prime
  setInterval(() => {
    const cpuPct = getCpuUsage();
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memPct = ((1 - memFree / memTotal) * 100);
    const uptimeH = (os.uptime() / 3600);
    send('telemetry', {
      cpu: cpuPct,
      mem: memPct,
      memUsedGb: ((memTotal - memFree) / 1e9),
      memTotalGb: (memTotal / 1e9),
      uptime: uptimeH,
      cores: os.cpus().length,
      platform: process.platform === 'win32' ? 'Windows' : 'macOS',
      disks: getDisks(),
    });
  }, 2000);
}

let processingTimeout = null;

async function handleUtterance(text) {
  // Clear any stale processing state
  clearTimeout(processingTimeout);

  send('transcript:user', text);
  send('state', 'thinking');
  voice.pause();

  let reply;
  try {
    reply = await brain.think(text);
  } catch (e) {
    console.error('[main] brain error:', e.message);
    reply = 'My systems are experiencing a hiccup, sir. Try again shortly.';
  }

  send('transcript:jarvis', reply);
  send('state', 'speaking');

  try {
    const audioBuf = await tts.synthesize(reply);
    if (audioBuf) {
      const tmpFile = path.join(os.tmpdir(), `jarvis-tts-${Date.now()}.mp3`);
      fs.writeFileSync(tmpFile, audioBuf);
      send('tts:play', tmpFile);
    } else {
      send('tts:play', null);
    }
  } catch (e) {
    console.error('[main] TTS error:', e.message);
    send('tts:play', null);
  }

  // Safety: if renderer doesn't send tts:ended within 30s, auto-reset
  processingTimeout = setTimeout(() => {
    console.warn('[main] TTS timeout — auto-resetting state');
    voice.resume();
  }, 30000);
}

function createWindow() {
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: wallpaperMode ? width : 1280,
    height: wallpaperMode ? height : 800,
    x: wallpaperMode ? 0 : undefined,
    y: wallpaperMode ? 0 : undefined,
    minWidth: 720,
    minHeight: 520,
    frame: false,
    transparent: false,
    backgroundColor: '#03070f',
    show: false,
    skipTaskbar: wallpaperMode,
    resizable: !wallpaperMode,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (wallpaperMode) {
    // Keep window at the bottom of the z-order
    mainWindow.setAlwaysOnTop(true, 'screen-saver', -1);
    // Actually we want it BELOW everything. Use a trick: set on top briefly then remove.
    // On Windows, we set it as a "tool" type to keep below.
    mainWindow.setAlwaysOnTop(false);
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.on('console-message', (_e, level, msg, line, src) => {
    console.log(`[RENDERER L${level}] ${msg}`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (wallpaperMode) {
      // Push to bottom — below other windows
      mainWindow.moveTop(); // bring to front briefly
      mainWindow.setAlwaysOnTop(false);
    }
    send('brain:status', brain.isReady());
    send('voice:status', voice.isRunning() ? 'active' : 'unavailable');
    send('voice:muted', voice.isMuted());
    send('mode', wallpaperMode ? 'wallpaper' : 'windowed');

    if (!process.env.ANTHROPIC_API_KEY) {
      const envPath = isPacked
        ? path.join(app.getPath('userData'), '.env')
        : path.join(__dirname, '..', '..', '.env');
      send('first-run', { envPath });
    }

    // Discover network devices and send to renderer
    refreshNetwork();

    // Send desktop shortcuts to renderer
    send('desktop:items', desktopIcons.readDesktopItems());
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function toggleWallpaperMode() {
  wallpaperMode = !wallpaperMode;
  const { screen } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  if (wallpaperMode) {
    mainWindow.setResizable(false);
    mainWindow.setBounds({ x: 0, y: 0, width, height });
    mainWindow.setSkipTaskbar(true);
    mainWindow.setAlwaysOnTop(false);
  } else {
    mainWindow.setResizable(true);
    mainWindow.setBounds({ x: 100, y: 100, width: 1280, height: 800 });
    mainWindow.setSkipTaskbar(false);
  }
  send('mode', wallpaperMode ? 'wallpaper' : 'windowed');
}

async function refreshNetwork() {
  try {
    const devices = await network.discover();
    send('network:devices', devices);
  } catch (e) {
    console.warn('[main] Network discovery error:', e.message);
  }
}

// Refresh network discovery every 60 seconds
setInterval(refreshNetwork, 60000);

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('J.A.R.V.I.S.');

  function buildTrayMenu() {
    return Menu.buildFromTemplate([
      {
        label: 'Show / Hide',
        click: () => {
          if (mainWindow.isVisible()) mainWindow.hide();
          else { mainWindow.show(); mainWindow.focus(); }
        },
      },
      {
        label: wallpaperMode ? 'Windowed Mode' : 'Wallpaper Mode',
        click: () => {
          toggleWallpaperMode();
          tray.setContextMenu(buildTrayMenu());
        },
      },
      {
        label: voice.isMuted() ? 'Unmute Mic' : 'Mute Mic',
        click: () => {
          voice.toggleMute();
          tray.setContextMenu(buildTrayMenu());
        },
      },
      {
        label: 'Refresh Network',
        click: () => refreshNetwork(),
      },
      { type: 'separator' },
      {
        label: 'Start at Login',
        type: 'checkbox',
        checked: false,
        click: async (menuItem) => {
          if (menuItem.checked) await autoLauncher.enable();
          else await autoLauncher.disable();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit J.A.R.V.I.S.',
        click: () => { app.isQuitting = true; app.quit(); },
      },
    ]);
  }

  // Build menu, then async-check autostart state and update
  const menu = buildTrayMenu();
  tray.setContextMenu(menu);

  autoLauncher.isEnabled().then((enabled) => {
    // Rebuild with correct checked state
    tray.setContextMenu(buildTrayMenu());
    // Patch the checkbox item
    const items = tray.contextMenu?.items;
    if (items) {
      const loginItem = items.find(i => i.label === 'Start at Login');
      if (loginItem) loginItem.checked = enabled;
    }
  }).catch(() => {});

  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ---- IPC handlers ----

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.on('cmd:submit', async (_event, text) => {
  console.log('[ipc] cmd:submit received:', text);
  if (!text || typeof text !== 'string' || !text.trim()) return;
  await handleUtterance(text.trim());
});

ipcMain.on('tts:ended', () => {
  clearTimeout(processingTimeout);
  // voice.resume() reopens the follow-up window and emits 'listening' (or 'idle'
  // if voice is unavailable), so don't force a state here.
  voice.resume();
});

ipcMain.on('mic:toggle', () => {
  voice.toggleMute();
});

ipcMain.on('desktop:launch', (_e, itemPath) => {
  desktopIcons.launchItem(itemPath);
});

// Right-click context menu for text input
ipcMain.on('show:input-menu', () => {
  Menu.buildFromTemplate([
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { type: 'separator' },
    { role: 'selectAll' },
  ]).popup({ window: mainWindow });
});

// ---- App lifecycle ----

app.whenReady().then(async () => {
  // In dev: appDir is the project root. Packaged: resources are in process.resourcesPath
  isPacked = app.isPackaged;
  appDir = isPacked ? process.resourcesPath : path.join(__dirname, '..', '..');

  // Load .env from user's app data if packaged, or project root if dev
  if (isPacked) {
    const userEnv = path.join(app.getPath('userData'), '.env');
    if (fs.existsSync(userEnv)) {
      require('dotenv').config({ path: userEnv, override: true });
    }
  }

  loadActions(appDir, false);

  // Initialize brain
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Persist conversation + long-term memory in a Google Drive "Jarvis" folder when
  // available, so memory syncs across all the user's computers. Falls back to local
  // userData. Override with JARVIS_MEMORY_DIR.
  const memoryDir = resolveMemoryDir();
  migrateMemory(app.getPath('userData'), memoryDir); // carry over any existing local memory
  console.log('[main] Memory dir:', memoryDir);
  const brainOk = brain.init(apiKey, {
    model: process.env.JARVIS_MODEL || 'claude-opus-4-8',
    onEvent: (event, data) => send(event, data),
    storeDir: memoryDir,
  });
  if (!brainOk) {
    console.warn('[main] No ANTHROPIC_API_KEY. Brain will use fallback replies.');
  }

  // Timer callback
  systemTools.setTimerCallback(async (message) => {
    send('transcript:jarvis', message);
    send('state', 'speaking');
    try {
      const audioBuf = await tts.synthesize(message);
      if (audioBuf) {
        const tmpFile = path.join(os.tmpdir(), `jarvis-tts-${Date.now()}.mp3`);
        fs.writeFileSync(tmpFile, audioBuf);
        send('tts:play', tmpFile);
      } else { send('tts:play', null); }
    } catch (_) { send('tts:play', null); }
  });

  // Initialize TTS
  const voiceName = process.env.JARVIS_VOICE || 'en-GB-RyanNeural';
  await tts.init(voiceName);

  // Initialize voice pipeline (Vosk + naudiodon). Auto-detect the installed model,
  // preferring a larger/more-accurate one over the small model when both exist.
  // Override with JARVIS_VOSK_MODEL (a dir name under models/).
  const modelsDir = path.join(appDir, 'models');
  let modelName = process.env.JARVIS_VOSK_MODEL;
  if (!modelName) {
    try {
      const dirs = fs.readdirSync(modelsDir).filter(d =>
        d.startsWith('vosk-model') && fs.statSync(path.join(modelsDir, d)).isDirectory());
      modelName = dirs.find(d => !d.includes('small')) || dirs[0] || 'vosk-model-small-en-us-0.15';
    } catch (_) {
      modelName = 'vosk-model-small-en-us-0.15';
    }
  }
  const modelPath = path.join(modelsDir, modelName);
  console.log('[main] Using Vosk model:', modelName);
  const voiceOk = voice.init(modelPath, {
    onEvent: (event, data) => send(event, data),
    deviceId: process.env.JARVIS_MIC_DEVICE ? parseInt(process.env.JARVIS_MIC_DEVICE, 10) : -1,
  });

  createWindow();
  createTray();
  startTelemetry();

  // Hidden app menu to enable Ctrl+C/V/X/A in frameless window
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
  ]));

  if (voiceOk) {
    voice.start((transcript) => handleUtterance(transcript));
  } else {
    console.warn('[main] Voice pipeline not available. Run: npm run download-model');
  }

  // Enable autostart on first run (user can disable via tray)
  try {
    const enabled = await autoLauncher.isEnabled();
    if (!enabled) await autoLauncher.enable();
  } catch (e) {
    console.warn('[main] Could not set autostart:', e.message);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  voice.stop();
});
