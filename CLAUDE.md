# J.A.R.V.I.S. Desktop

Always-on voice assistant with a sci-fi HUD. Electron app: offline wake/speech-to-text
(Vosk) → Claude (Anthropic SDK) brain with tool use → text-to-speech (Edge TTS) reply,
all driving a glassy heads-up-display overlay. Targets Windows (primary) and macOS.

## Stack
- **Electron** 35 (`main` / `preload` / `renderer` split)
- **@anthropic-ai/sdk** — the "brain" (tool-use loop)
- **vosk-koffi** — offline speech-to-text (needs a downloaded Vosk model in `models/`)
- **msedge-tts** — neural text-to-speech
- **naudiodon** — native audio I/O (mic capture)
- **auto-launch** — start on boot
- **dotenv** — config from `.env`

## Layout
- `src/main/index.js` — app entry; wires IPC, voice→brain→tts pipeline, model selection
- `src/main/brain.js` — Anthropic client, J.A.R.V.I.S. system prompt/persona, tool loop
- `src/main/voice.js` — Vosk speech-to-text
- `src/main/tts.js` — Edge TTS playback
- `src/main/actions.js` + `actions.json` — `run_action` presets (volume, media, screenshots, lock, brightness, open folders, …). `actions-powerful.json` is an excluded alt set.
- `src/main/system-tools.js` — tool defs: datetime, system info, disk, network, processes, weather, calculate, clipboard, web_request, files/notes, timers
- `src/main/network.js`, `desktop-icons.js`, `native-modules.js` — networking, icon handling, native-module loading
- `src/preload/index.js` — contextBridge IPC
- `src/renderer/{index.html,hud.js,hud.css}` — the HUD UI

## Commands
- `npm run dev` — run in Electron (`electron .`)
- `npm run download-model` — fetch the Vosk speech model into `models/`
- `npm run build:win` — package for Windows (NSIS installer + portable, x64)
- `npm run build:mac` — package for macOS (dmg + zip, x64/arm64)

## Config (`.env`, see `.env.example`)
- `ANTHROPIC_API_KEY` — **required**
- `JARVIS_MODEL` — optional override; default `claude-opus-4-8` (run at low effort, no
  extended thinking, for snappy spoken replies)
- `JARVIS_VOICE` — optional Edge TTS voice override
- `JARVIS_VOSK_MODEL` — speech model dir under `models/`. Default
  `vosk-model-en-us-0.22-lgraph` (~128 MB, accurate). `index.js` auto-detects the
  installed model (prefers non-"small"); `download-model` fetches this one.
- `JARVIS_MIC_DEVICE` — input device id to pin a specific mic (ids are logged at
  startup under "Input devices"). Default is the system default input.

## Gotchas
- **Native modules** (`naudiodon`, `vosk-koffi`/`koffi`): rebuilt against Electron's ABI.
  After `npm install` or an Electron bump, run `npx electron-rebuild`. Mismatch =
  module-load crash at startup.
- **Packaging**: `asar: true` but `node_modules/**/*` is fully `asarUnpack`ed (native
  `.dll`/`.node` files must live on the real filesystem). The Vosk model ships via
  `extraResources` (`models/`), not asar — too large. If a packaged build can't find
  the model or a native DLL, check `dist/win-unpacked/resources/`.
- **First run needs the model**: `voice.js` fails to load if `models/` is empty —
  run `download-model` before `dev`.
- **GPU/compositor crashes**: the HUD is a full-screen always-on animated overlay;
  Chromium's GPU process used to SIGSEGV in the Windows DWM session-capability check
  (`WinStationGetCurrentSessionCapabilities`), killing the app. Fixed via
  `app.disableHardwareAcceleration()` in `index.js` (all drawing is 2D canvas, so
  software rendering is visually identical). Don't re-enable HW accel without retesting.
- **Crash logging**: process failures are logged (pure JS, no native dep) to
  `crash-events.log` in the app's `userData` dir via `child-process-gone` /
  `render-process-gone` handlers; the renderer auto-reloads on a non-clean exit.
  (A legacy native `crash.log` at repo root from old `segfault-handler` builds is
  obsolete and safe to delete.)
- Spoken interface: brain replies are deliberately short, plain text, no markdown.

## Conventions
- Tools are defined in `system-tools.js` (`TOOL_DEFS`) + inline in `brain.js`
  (`open_app`, `open_url`, `run_action`); add new capabilities there and the model
  picks them up via the tool loop.
- Keep the J.A.R.V.I.S. persona/system prompt edits in `brain.js` (`SYSTEM_PROMPT_BASE`).
