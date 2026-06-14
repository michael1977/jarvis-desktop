# J.A.R.V.I.S. Desktop

Always-on voice assistant with a sci-fi HUD. Electron app: offline wake word + speech-to-text
(Vosk) → Claude (Anthropic SDK) brain with tool use → text-to-speech (Edge TTS) reply, all
driving a glassy heads-up-display overlay. Targets **Windows** (primary) and **macOS**.

Say **"Hey J.A.R.V.I.S."** to wake it, speak a command, and it replies aloud and acts on your
machine. After each reply it returns to a dormant state and waits for the wake word again.

## Features
- Offline wake-word detection + speech-to-text (Vosk) — no audio leaves the machine for STT.
- Claude **Opus 4.8** brain (low effort, no extended thinking) for fast spoken replies.
- Neural TTS via Microsoft Edge (`en-GB-RyanNeural` by default).
- Iron-Man-style HUD: arc reactor, vitals, radar, network nodes, clickable desktop apps,
  scrollable live transcript.
- Extensive tool use: system info, disk, network, processes, weather, math, clipboard,
  files/notes, timers, web requests, app/URL launching, and preset system actions.

## Prerequisites
- **Node.js 18+** and npm.
- An **Anthropic API key** (`sk-ant-...`).
- macOS or Windows. On macOS you'll grant **Microphone** (and, for some actions, Accessibility)
  permissions on first run.

## Setup (both platforms)

```bash
git clone git@github.com:michael1977/jarvis-desktop.git
cd jarvis-desktop
npm install

# Rebuild native modules (naudiodon, vosk-koffi/koffi) against Electron's ABI.
# REQUIRED after install and after any Electron version bump.
npx electron-rebuild

# Download the Vosk speech model into models/ (not checked into git — too large)
npm run download-model

# Add your API key
cp .env.example .env
#   then edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

Run it in development:

```bash
npm run dev
```

## Building

### macOS

```bash
npm run build:mac
```

Produces a `.dmg` and `.zip` for both Intel (`x64`) and Apple Silicon (`arm64`) in `dist/`.

macOS notes:
- **Build native modules on a Mac.** `naudiodon`/`vosk-koffi` are compiled per-platform — you
  cannot reuse the Windows `node_modules`. Run `npm install` + `npx electron-rebuild` on the Mac.
- **Build arm64 on Apple Silicon, x64 on Intel** for the smoothest native-module compile. Cross-
  compiling the other arch may need extra toolchain setup.
- The app is **unsigned**. To open it the first time: right-click the app → *Open*, or run
  `xattr -dr com.apple.quarantine "/Applications/J.A.R.V.I.S..app"`. For distribution you'd need
  an Apple Developer ID and notarization.
- First launch prompts for **Microphone** access (declared via `NSMicrophoneUsageDescription`).
- If electron-builder warns about the icon, supply `assets/icon.icns` (≥512×512). A large
  `icon.png` usually converts automatically.

### Windows

```bash
npm run build:win
```

Produces an NSIS installer and a portable `.exe` (x64) in `dist/`.

## Configuration (`.env`)
- `ANTHROPIC_API_KEY` — **required**.
- `JARVIS_MODEL` — optional model override; default `claude-opus-4-8`.
- `JARVIS_VOICE` — optional Edge TTS voice override (e.g. `Daniel`, `en-US-GuyNeural`).

## Project layout
- `src/main/` — Electron main process: app entry, IPC, voice→brain→TTS pipeline, tools.
  - `index.js` — app entry and wiring; `brain.js` — Claude client + persona + tool loop;
    `voice.js` — Vosk wake word + STT; `tts.js` — Edge TTS; `actions.js` + `actions.json` —
    system action presets; `system-tools.js` — tool definitions; `desktop-icons.js` — desktop
    app launcher; `network.js`, `native-modules.js` — networking and native-module loading.
- `src/preload/index.js` — contextBridge IPC.
- `src/renderer/` — the HUD UI (`index.html`, `hud.js`, `hud.css`).
- `electron-builder.yml` — packaging config (Windows / macOS / Linux targets).
- `scripts/download-model.js` — fetches the Vosk model into `models/`.

## Gotchas
- **Native modules must match Electron's ABI** — re-run `npx electron-rebuild` after `npm install`
  or an Electron bump, or the app crashes on launch with a module-load error.
- **First run needs the Vosk model** — run `npm run download-model` before `npm run dev`, or
  `voice.js` fails to load.
- `models/`, `node_modules/`, `dist/`, and `.env` are git-ignored. Each machine downloads the
  model and supplies its own `.env`.

## License
Private project.
