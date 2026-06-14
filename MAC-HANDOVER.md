# Mac Handover — pulling the latest features into the Mac app

The Windows side of this project added a batch of features (listed below). They
all live in the **public** repo `https://github.com/michael1977/jarvis-desktop`
on `main`. The Mac app diverged earlier with local voice patches that are **not**
in the repo. This doc tells the Mac Claude session how to reconcile so the Mac
app gets **all** the new features while keeping its working voice fix.

## The plan (run on the Mac)

1. **Get the latest source** (repo is public now — no auth needed):
   ```bash
   git clone https://github.com/michael1977/jarvis-desktop ~/jarvis-desktop
   cd ~/jarvis-desktop
   ```
2. **Re-apply the Mac voice fix to `src/`.** The repo's voice path is naudiodon in
   the main process (broken on macOS 26). Re-apply the renderer `getUserMedia` →
   PCM Int16 → IPC → Vosk approach you already built, editing the *repo* copies of:
   - `src/preload/index.js` (add the audio-chunk bridge)
   - `src/main/index.js` (Vosk audio handler + mic permission grant)
   - `src/main/voice.js` / `src/renderer/hud.js` (capture + feed)
   **Commit it** (`git commit -am "Mac: renderer getUserMedia voice capture"` and
   push) so it becomes permanent and future builds + auto-update include it.
3. **Build from the unified source** (needs Node 22.x = Electron 35's Node):
   ```bash
   npm install
   npx @electron/rebuild -f      # rebuild native modules for Electron
   npm run download-model        # fetches vosk-model-en-us-0.22-lgraph
   npm run build:mac
   ```
4. **Ad-hoc sign + install** (arm64 macOS 26 requires at least ad-hoc signing):
   ```bash
   codesign --force --deep --sign - "dist/mac-arm64/J.A.R.V.I.S.app"  # adjust path
   # then drag the built app from the dmg to /Applications, replacing the old one
   ```
   `CFBundleName` is already fixed in `electron-builder.yml` (period-free), so the
   launch crash should be gone — verify on launch.

## Data is preserved (lives outside the app bundle)
- API key: `~/Library/Application Support/jarvis-desktop/.env` (the app also now
  auto-reads `jarvis-config.json` from the Google Drive `Jarvis` folder).
- Memory: the Google Drive `Jarvis` folder (`conversation.json`, `memory.json`),
  auto-detected on macOS at `~/Library/CloudStorage/GoogleDrive-*/My Drive/Jarvis`.

## Features added this session (all already in the repo)
- **Brain:** Claude Opus 4.8 at low effort + prompt caching → faster spoken replies (`brain.js`).
- **Persistent memory + "remember" facts** across restarts (`brain.js`).
- **Cross-machine memory via Google Drive** — `resolveMemoryDir` / `migrateMemory` (`index.js`).
- **Zero-setup shared config** — reads API key/model/voice from `jarvis-config.json` in Drive (`loadSharedConfig`, `index.js`).
- **Conversational follow-up window (~9s)** — no repeated wake word (`voice.js`).
- **Higher-accuracy speech model** `vosk-model-en-us-0.22-lgraph` + `JARVIS_MIC_DEVICE` mic selection (`index.js`, `voice.js`, `scripts/download-model.js`).
- **Scrollable transcript** + visible **DORMANT / "Hey Jarvis"** wake reset (`hud.js/css`, `voice.js`).
- **Clickable desktop-app launcher** in the HUD (`desktop-icons.js`, renderer).
- **Hard-drive usage in System Vitals** (`index.js`, `hud.js`, `index.html`).
- **Auto-update via GitHub Releases** + **update-status chip** (`updater.js`, `index.js`, preload, HUD).
- **Crash fixes:** `app.disableHardwareAcceleration()` and neutralized the
  `segfault-handler` that naudiodon arms (`index.js`, `native-modules.js`) — the
  segfault-handler neutralization also helps the Mac.
- **Safe artifact filenames** for working auto-update (`electron-builder.yml`).
- **Mac `CFBundleName`** pinned period-free to fix the launch crash (`electron-builder.yml`).

## Best end state
Commit the Mac voice fix to the repo. Then one `npm run build:mac` produces a Mac
app with **every** feature **and** working voice, and (once ad-hoc signing is
added to CI) the Mac can auto-update from GitHub like Windows does.
