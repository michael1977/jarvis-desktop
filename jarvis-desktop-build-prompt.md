# Claude Code Build Prompt — J.A.R.V.I.S. Desktop (macOS + Windows)

> Paste everything below into Claude Code as your initial instruction. Build it milestone by
> milestone, testing each one before moving on. Two reference files can be dropped into the repo to
> guide the look and the pipeline: `jarvis-ai.html` (the HUD design + animations) and `jarvis.py`
> (the wake→STT→Claude→action→speak flow). Reuse them where useful.

---

## ROLE & GOAL

You are building **J.A.R.V.I.S. Desktop**, an always-on voice assistant with a sci-fi HUD interface,
running as a native desktop app on **both macOS (Intel + Apple Silicon) and Windows**.

The user says **"Jarvis"**, speaks a request, and the app:
1. lights the HUD up (wake detected),
2. transcribes their speech on-device,
3. sends it to Claude wearing the J.A.R.V.I.S. personality,
4. speaks the reply aloud while the HUD reacts (reactor pulses, radar sweeps, transcript updates),
5. optionally performs a **safe, whitelisted** action on the computer (open an app/URL, or run a
   user-defined script).

It must be genuinely cross-platform from one codebase, start at login, and live in the system tray.

## NON-NEGOTIABLE CONSTRAINTS

- **One codebase**, builds to both `.dmg` (macOS) and `.exe`/NSIS installer (Windows).
- The Claude API key lives **only in the main process**, loaded from env/`.env`. Never expose it to
  the renderer or bundle it into the shipped binary.
- The model can **only** take actions from a whitelist: open an app, open an http/https URL, or run a
  user-defined action from `actions.json`. **No arbitrary shell execution from model output, ever.**
- All speech transcription runs **on-device** (Picovoice), not in the cloud.
- Ship a quality floor: keyboard-accessible command input, graceful failure if a key is missing or a
  network call fails (fall back to a scripted in-character reply rather than crashing), and respect
  `prefers-reduced-motion`.

## TECH STACK (use these specific packages)

- **App shell:** Electron (latest stable) + `electron-builder` for packaging.
- **Wake word:** `@picovoice/porcupine-node` with the built-in keyword `"jarvis"`.
- **Microphone capture:** `@picovoice/pvrecorder-node`.
- **Speech-to-text:** `@picovoice/cheetah-node` (streaming, on-device, cross-platform). Use Cheetah's
  endpoint detection to know when the user has finished speaking.
- **Brain:** `@anthropic-ai/sdk` (Node). Default model `claude-sonnet-4-6`, configurable.
- **Text-to-speech:** the renderer's Web Speech API (`speechSynthesis`) — Chromium uses OS voices on
  both platforms, so no native TTS shelling required. Prefer a British male voice when available
  (e.g. "Daniel" on macOS, a "Microsoft" natural voice on Windows); fall back gracefully.
- **Autostart:** `auto-launch` npm package (handles login-start on both macOS and Windows).
- **Config:** `dotenv` for keys; a plain `actions.json` for the action whitelist.

(If at any point a native module won't build on one platform, stop and tell me before substituting —
do not silently swap in a cloud STT service.)

## ARCHITECTURE

**Main process** (Node, has system access):
- Owns the audio pipeline: Porcupine wake-word loop → on wake, switch the same PvRecorder stream into
  Cheetah for streaming transcription until endpoint → final transcript.
- Owns the Claude client and the **tool-use loop** (see below).
- Owns the action executor (whitelist only).
- Owns the tray icon (show/hide window, mute mic, quit) and autostart registration.
- Emits IPC events to the renderer: `state:listening`, `state:thinking`, `state:speaking`,
  `state:idle`, `transcript:user`, `transcript:jarvis`, `action:ran`, plus periodic fake telemetry
  ticks so the HUD feels alive.

**Renderer** (the HUD, Chromium):
- Renders the full HUD (below) and reacts to IPC state events with animations.
- Performs TTS via `speechSynthesis` when it receives `transcript:jarvis`, and tells main when speech
  starts/ends (so the signal waveform can swell while Jarvis talks).
- Has a text command line as a fallback/alternate to voice; typing + Enter sends `cmd:submit` to main
  and runs the exact same pipeline from the Claude step onward.

**IPC** via `contextBridge`/`preload` (contextIsolation on, nodeIntegration off). Expose a minimal,
typed API to the renderer — no raw `ipcRenderer`.

## THE HUD (renderer UI)

Recreate the look from `jarvis-ai.html` as the live interface. Dark space-black background with a
faint grid, cyan (#38e1ff) primary with amber (#f5c451) accents, Orbitron for display type and a mono
face for data. Frameless window, draggable by the header, resizable, with a tray toggle. Layout:

- **Header:** "J.A.R.V.I.S." wordmark, status chips, live clock.
- **Left panel — System Vitals & Transcript:** animated vitals bars (driven by telemetry ticks from
  main) and a live scrolling transcript of the conversation (you said / Jarvis said), newest at
  bottom, typewriter effect on Jarvis lines.
- **Center — Arc Reactor:** the canvas particle core + concentric rings from the reference. It has
  visible **states** it animates between:
  - `idle` → slow steady pulse, "ONLINE"
  - `listening` → brighter, reactive, "LISTENING" (triggered by wake word)
  - `thinking` → fast energetic pulse, "THINKING"
  - `speaking` → pulses in time with TTS, "SPEAKING"
- **Right panel — Radar + Signal + Diagnostics:** sweeping radar with blips, animated signal waveform
  (swells while Jarvis speaks), diagnostics list.
- **Bottom — Command console:** mic button (shows listening state), text input + send, and a row of
  quick-command buttons. A small VOICE on/off toggle for TTS.

Keep the boldness in the reactor; everything else stays quiet and disciplined. Respect reduced motion.

## VOICE PIPELINE (main process detail)

1. Start PvRecorder at Porcupine's frame length / 16 kHz. Feed frames to Porcupine.
2. On wake-word match: emit `state:listening`, play a short audio cue, and begin feeding frames to a
   Cheetah instance. Accumulate the partial transcripts; when Cheetah reports the endpoint (user
   stopped talking), take the final transcript.
3. If transcript is empty/garbage, return to idle.
4. Emit `transcript:user` + `state:thinking`, then call the Claude tool-use loop.
5. Emit `transcript:jarvis` + `state:speaking`; renderer speaks it.
6. On TTS end, return to `state:idle` and resume the wake-word loop.

## CLAUDE TOOL-USE LOOP

System prompt = the J.A.R.V.I.S. persona: dry understated British wit, calm, loyal, occasional "sir",
**short spoken replies (1–2 sentences), no markdown/lists/emoji**, confirm actions briefly, never
mention being a language model. Define these tools:

- `open_app({ name })` — open an application by name.
- `open_url({ url })` — open an http/https URL (reject anything else).
- `run_action({ action_id })` — `action_id` constrained to the keys present in `actions.json`.

Loop: call `messages.create` with the tools; if `stop_reason === "tool_use"`, execute each tool via
the whitelist executor, append `tool_result` blocks, and call again (cap ~5 iterations); otherwise
take the text as the spoken reply. Keep a rolling conversation history (~last 12 messages) so
follow-ups work. On any API/network error, return a scripted in-character fallback so the app never
hard-fails.

## ACTION EXECUTOR (cross-platform, whitelist only)

- `open_app`: macOS → `open -a <name>`; Windows → `start "" <name>` (or resolve known app paths).
- `open_url`: macOS → `open <url>`; Windows → `start "" <url>`. Validate scheme is http/https.
- `run_action`: look the id up in `actions.json`, run its `command` as an **argument array** with
  `spawn`/`execFile` (never `shell: true`, never interpolate model text into a command). Return a
  short result string. Time out long commands.

`actions.json` schema (user-editable, ships with a couple of cross-platform examples):
```json
{
  "open_projects": {
    "description": "Open my projects folder",
    "command_mac": ["open", "/Users/REPLACE_ME/Developer"],
    "command_win": ["explorer", "C:\\Users\\REPLACE_ME\\Developer"]
  }
}
```
Pick `command_mac` or `command_win` at runtime based on `process.platform`. (Support a single
`command` key too, for platform-agnostic actions.)

## CROSS-PLATFORM SPECIFICS — handle explicitly

- **Paths:** never hardcode `/Users/...`; use `app.getPath()` and `path.join`.
- **TTS voices:** enumerate `speechSynthesis.getVoices()` (it populates async — wait for
  `voiceschanged`), pick the best British/en voice available, degrade gracefully.
- **Autostart:** register via `auto-launch` on first run; expose a tray toggle to disable.
- **macOS mic permission:** the app needs the `NSMicrophoneUsageDescription` key in its Info.plist
  (set via electron-builder `mac.extendInfo`). On first run macOS will prompt; document this.
- **Windows mic:** ensure microphone privacy setting allows desktop apps; document it.
- **Tray:** provide a tray icon for both platforms with Show/Hide, Mute, Start-at-login, Quit.

## CONFIG & SECRETS

- `.env` (gitignored) holds `ANTHROPIC_API_KEY`, `PICOVOICE_ACCESS_KEY`, and optional
  `JARVIS_MODEL`, `JARVIS_VOICE`, `JARVIS_WAKEWORD`. Provide `.env.example`.
- Load with `dotenv` in main only. If keys are missing, show a clean first-run screen in the HUD
  telling the user where to paste them, rather than crashing.

## PACKAGING (electron-builder)

- macOS target: `dmg` (and `zip`), `category` set, `NSMicrophoneUsageDescription` injected, arm64 +
  x64. Note signing/notarization as a later step (unsigned is fine for personal use, document the
  Gatekeeper right-click-open workaround).
- Windows target: `nsis` installer + portable `.exe`.
- Make sure Picovoice native `.node` binaries and model files are unpacked from asar
  (`asarUnpack`) so they load at runtime.
- npm scripts: `dev` (electron with reload), `build:mac`, `build:win`.

## PROJECT STRUCTURE (suggested)

```
jarvis-desktop/
  package.json
  electron-builder.yml
  .env.example
  actions.json
  src/
    main/
      index.js            // app lifecycle, window, tray, autostart
      voice.js            // porcupine + pvrecorder + cheetah pipeline
      brain.js            // anthropic client + tool-use loop + persona
      actions.js          // whitelist executor (cross-platform)
      ipc.js              // typed IPC surface
    preload/
      index.js            // contextBridge API
    renderer/
      index.html          // HUD markup
      hud.css             // styles (from jarvis-ai.html)
      hud.js              // canvas animations, state machine, TTS, command line
  assets/                 // tray icons, etc.
```

## BUILD MILESTONES (do in order, verify each)

1. **Skeleton:** Electron app opens a frameless window showing the static HUD (port the visuals from
   `jarvis-ai.html`), with a tray icon and clean quit. No audio yet.
2. **Brain via text:** wire the command-line input → main → Claude tool-use loop → reply back to the
   transcript, with TTS speaking it. Persona working. Confirm `open_app`/`open_url`/`run_action` work
   from typed commands.
3. **Wake word + STT:** add Porcupine ("jarvis") + PvRecorder + Cheetah so voice drives the same
   pipeline. HUD states animate (listening/thinking/speaking).
4. **Cross-platform + polish:** action executor branches per platform, autostart, mic-permission
   handling, first-run key screen, reduced-motion, error fallbacks.
5. **Package:** electron-builder configs; produce a `.dmg` and a Windows installer; verify each on its
   OS (or at least that the build completes and native modules unpack).

After each milestone, give me a short "how to test this" note and wait.

## ACCEPTANCE CRITERIA

- Say "Jarvis, what time is it?" → HUD wakes, transcribes, Claude answers in character, speaks aloud.
- Say "Jarvis, open Safari" (mac) / "open Notepad" (win) → app opens, Jarvis confirms briefly.
- Add an entry to `actions.json` → "Jarvis, <do that thing>" runs it and confirms.
- Pull the network / remove the API key → app still responds with a scripted in-character line, no
  crash.
- `npm run build:mac` and `npm run build:win` each produce an installable artifact.

## SAFETY (keep this throughout)

The assistant can open apps, open http/https URLs, and run only the user-approved actions in
`actions.json`. It never executes raw shell from model output. To give it more power, the user adds a
reviewed script to the whitelist — never widen the executor to accept arbitrary commands.
