# J.A.R.V.I.S. Desktop — Cold Start

**Rebuilding Jarvis from nothing but this repository.**
Verified against the live install 2026-08-04.

Jarvis is an **Electron desktop app** — an always-on voice assistant with a HUD. There is no
server, no database and no hosting. Everything is either in this repo, downloaded at build
time, or synced through Google Drive.

---

## 1. What the system actually is

| Piece | Where | Notes |
|---|---|---|
| Source | GitHub `michael1977/jarvis-desktop` | trunk = `main`, currently v0.1.19 |
| Local checkout | `C:\Jarvis\jarvis-desktop` | **not** under `C:\Users\micha` |
| iOS companion | GitHub `michael1977/JarvisIOS` | separate repo, built on the Mac |
| Runtime brain | Anthropic API | `@anthropic-ai/sdk` |
| Speech-to-text | Vosk (local) | `vosk-koffi`, model downloaded separately |
| Text-to-speech | `msedge-tts` | no key needed |
| Audio I/O | `naudiodon` | native module |
| Memory / state | Google Drive | `G:\My Drive\Jarvis\` |
| Installers | Google Drive | `G:\My Drive\Jarvis\Installers\` |
| Updates | GitHub Releases | via `electron-updater` |

---

## 2. Rebuild

### 2.1 Source
```bash
gh auth login
gh auth setup-git
git clone https://github.com/michael1977/jarvis-desktop C:\Jarvis\jarvis-desktop
cd C:\Jarvis\jarvis-desktop
npm install
```
Use the **HTTPS** remote. The SSH key was revoked 2026-08-01 and never replaced on GitHub, so
`git@github.com:` fails with *Permission denied (publickey)*.

`npm install` runs `postinstall` → `scripts/patch-naudiodon-macos26.js`. Expected, not a
compromise.

### 2.2 Speech model (required — not in git)
```bash
npm run download-model
```
Downloads a Vosk model into `models/`, which is excluded from git **and** from the asar
bundle (shipped via `extraResources`). Default is
`vosk-model-en-us-0.22-lgraph`; `vosk-model-en-us-0.22` is more accurate but 1.8 GB.
Override with `JARVIS_VOSK_MODEL`.

### 2.3 Configuration
Copy `.env.example` → `.env` and set:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Optional: `JARVIS_MODEL`, `JARVIS_VOICE`, `JARVIS_MIC_DEVICE` (pin a specific mic — the input
device list is logged at startup), `JARVIS_VOSK_MODEL`, `JARVIS_MEMORY_DIR`.

**Cross-machine config:** the first machine with an `ANTHROPIC_API_KEY` writes it — plus model
and voice — into `<memory dir>/jarvis-config.json` on Google Drive, so other machines pick it
up with no `.env` at all. A local `.env` always wins over the shared file.

> ⚠ **That means a live Anthropic API key sits in plaintext at
> `G:\My Drive\Jarvis\jarvis-config.json`.** It is a documented trade-off, not a bug — but if
> that Drive folder is ever shared or exposed, **rotate the key**. Given the 2026-08-01 account
> compromise, this file is worth an explicit look during any credential rotation.

### 2.4 Run and build
```bash
npm run dev          # electron .
npm run build:win    # electron-builder --win
npm run build:mac    # electron-builder --mac
```
Output → `dist/`. `electron-builder.yml` publishes to GitHub Releases
(`owner: michael1977, repo: jarvis-desktop`), which is what `electron-updater` checks, so a
release is what makes installed copies update. The Mac build is **ad-hoc signed**
(`scripts/afterSign.js`, `codesign --sign -`) — no Apple developer certificate required.

All of `node_modules` is unpacked from asar deliberately: koffi, vosk-koffi, naudiodon and
segfault-handler are native and need a real filesystem path. Unpacking everything avoids
per-module whack-a-mole — don't narrow it.

---

## 3. Memory and state

`G:\My Drive\Jarvis\` holds:
- `memory.json` — long-term memory
- `conversation.json` — conversation history
- `jarvis-config.json` — shared API key / model / voice (see the warning above)
- `MAC-HANDOVER.md` — Mac port notes
- `Installers\` — built installers, pushed here by the `JarvisInstallerSync` scheduled task
  (`scripts/sync-installers.ps1`)

Because this lives on Drive it is **already off-machine** and syncs across computers. Restoring
Jarvis's personality and history is just having Drive mounted — no import step.

---

## 4. On a new machine

1. Install Google Drive for Desktop (sign in as **tfas77**) so `G:` exists.
2. Clone, `npm install`, `npm run download-model`.
3. Either set `ANTHROPIC_API_KEY` in `.env`, or let it read `jarvis-config.json` from Drive.
4. `npm run dev` to verify, `npm run build:win` for an installer.
5. Re-register the `JarvisInstallerSync` scheduled task
   (XML in `G:\My Drive\OpsBackup\scheduled-tasks\`).

Nothing else is required. Jarvis has no cloud state to restore beyond the Drive folder.

---

## 5. Known gaps

- **`.env` is deliberately not backed up** — it holds a live API key, and secrets do not belong
  on a sync drive. Restoring means re-entering the key, not recovering a file. Keep it in a
  password manager.
- `JarvisIOS` has **no local checkout on the Windows PC** — it exists on GitHub (and on the Mac).
  It is covered by the nightly GitHub bundle at
  `G:\My Drive\PodiatryCAD_Backup\GitHub\JarvisIOS.bundle`.
- `models/` is a download, not a backup. If Vosk ever pulls a model, keep a copy.

See `G:\My Drive\OpsBackup\RECOVERY - START HERE.md` for whole-machine recovery.
