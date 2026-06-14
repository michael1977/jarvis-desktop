#!/usr/bin/env python3
"""
J.A.R.V.I.S. — an always-on local voice assistant for macOS.

Flow:  wake word ("Jarvis")  ->  record what you say  ->  transcribe locally
       ->  Claude decides + replies in character  ->  speak it aloud
       ->  optionally run a SAFE, whitelisted action (open apps/URLs, your scripts)

Nothing runs arbitrary shell from the model. Actions are limited to:
  - opening an app
  - opening a URL
  - running an action you defined yourself in actions.json
"""

import os
import sys
import json
import subprocess
import time

import numpy as np
import pvporcupine
from pvrecorder import PvRecorder
from faster_whisper import WhisperModel
import anthropic

# ----------------------------------------------------------------------------
# Config (from environment / .env)
# ----------------------------------------------------------------------------
PICOVOICE_KEY = os.environ.get("PICOVOICE_ACCESS_KEY")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
VOICE        = os.environ.get("JARVIS_VOICE", "Daniel")          # any macOS voice
MODEL        = os.environ.get("JARVIS_MODEL", "claude-sonnet-4-6")
WHISPER_SIZE = os.environ.get("JARVIS_WHISPER", "base.en")       # tiny.en / base.en / small.en
WAKE_WORD    = os.environ.get("JARVIS_WAKEWORD", "jarvis")
HERE = os.path.dirname(os.path.abspath(__file__))

if not PICOVOICE_KEY or not ANTHROPIC_KEY:
    sys.exit("Missing keys. Set PICOVOICE_ACCESS_KEY and ANTHROPIC_API_KEY (see README).")

# ----------------------------------------------------------------------------
# Persona
# ----------------------------------------------------------------------------
SYSTEM_PROMPT = """You are J.A.R.V.I.S., a personal AI assistant running on the user's Mac.
Personality: dry, understated British wit; calm and unflappable; quietly loyal. Address the user
as "sir" occasionally, not in every reply.
Style: this is a SPOKEN interface, so keep replies short — usually one or two sentences. No markdown,
no lists, no emoji. Speak plainly so it sounds natural read aloud.
You can take real actions on the Mac using the provided tools (open an app, open a URL, or run one of
the user's predefined actions). Use a tool when the user clearly wants something done; otherwise just
answer conversationally. After an action runs, confirm it briefly. Never invent actions that aren't
available. Never mention being a language model."""

# ----------------------------------------------------------------------------
# Action whitelist (user-editable) — see actions.json
# ----------------------------------------------------------------------------
def load_actions():
    path = os.path.join(HERE, "actions.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"[warn] could not read actions.json: {e}")
        return {}

ACTIONS = load_actions()

def tool_defs():
    action_lines = "\n".join(f"  - {k}: {v.get('description','')}" for k, v in ACTIONS.items()) or "  (none defined)"
    return [
        {
            "name": "open_app",
            "description": "Open a macOS application by name, e.g. 'Safari', 'Notes', 'Visual Studio Code'.",
            "input_schema": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
        },
        {
            "name": "open_url",
            "description": "Open a web URL in the default browser. Must start with http:// or https://.",
            "input_schema": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
        {
            "name": "run_action",
            "description": "Run one of the user's predefined actions. Available action ids:\n" + action_lines,
            "input_schema": {
                "type": "object",
                "properties": {"action_id": {"type": "string", "enum": list(ACTIONS.keys()) or ["__none__"]}},
                "required": ["action_id"],
            },
        },
    ]

def execute_tool(name, args):
    """Run a whitelisted tool. Never uses shell=True; never runs raw model strings."""
    try:
        if name == "open_app":
            app = str(args.get("name", "")).strip()
            if not app:
                return "No app name given."
            subprocess.run(["open", "-a", app], check=True)
            return f"Opened {app}."
        if name == "open_url":
            url = str(args.get("url", "")).strip()
            if not (url.startswith("http://") or url.startswith("https://")):
                return "Refused: only http/https URLs are allowed."
            subprocess.run(["open", url], check=True)
            return f"Opened {url}."
        if name == "run_action":
            aid = str(args.get("action_id", "")).strip()
            action = ACTIONS.get(aid)
            if not action:
                return f"No such action '{aid}'."
            cmd = action.get("command")
            if not isinstance(cmd, list) or not cmd:
                return f"Action '{aid}' has no valid command."
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            tail = (out.stdout or out.stderr or "").strip()[-300:]
            return f"Ran {aid}. {tail}" if tail else f"Ran {aid}."
        return f"Unknown tool {name}."
    except subprocess.CalledProcessError as e:
        return f"That failed ({e})."
    except Exception as e:
        return f"Error running {name}: {e}"

# ----------------------------------------------------------------------------
# Speech out (macOS built-in `say`)
# ----------------------------------------------------------------------------
def speak(text):
    text = (text or "").strip()
    if not text:
        return
    print(f"JARVIS> {text}")
    try:
        subprocess.run(["say", "-v", VOICE, text])
    except Exception:
        subprocess.run(["say", text])

def cue():
    """Quiet audio cue so you know it heard the wake word."""
    try:
        subprocess.Popen(["afplay", "/System/Library/Sounds/Tink.aiff"])
    except Exception:
        pass

# ----------------------------------------------------------------------------
# Claude brain (handles multi-step tool use)
# ----------------------------------------------------------------------------
client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
history = []  # rolling conversation memory

def think(user_text):
    global history
    history.append({"role": "user", "content": user_text})
    history = history[-12:]
    tools = tool_defs()
    messages = list(history)
    for _ in range(5):  # allow a few tool round-trips
        resp = client.messages.create(
            model=MODEL, max_tokens=400, system=SYSTEM_PROMPT,
            tools=tools, messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason == "tool_use":
            results = []
            for block in resp.content:
                if block.type == "tool_use":
                    out = execute_tool(block.name, block.input)
                    print(f"[action] {block.name} {block.input} -> {out}")
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": out})
            messages.append({"role": "user", "content": results})
            continue
        reply = " ".join(b.text for b in resp.content if b.type == "text").strip()
        history = messages[-12:]
        return reply
    return "I got a little tangled up there, sir. Try that again?"

# ----------------------------------------------------------------------------
# Audio: wake word + utterance capture (simple energy-based endpointing)
# ----------------------------------------------------------------------------
def record_utterance(recorder, frame_length, sample_rate,
                     max_seconds=12, silence_ms=1100, start_grace_ms=2800, rms_threshold=300):
    frames = []
    need_silent = int((silence_ms / 1000) * sample_rate / frame_length)
    max_frames = int(max_seconds * sample_rate / frame_length)
    grace = int((start_grace_ms / 1000) * sample_rate / frame_length)
    silent = 0
    spoke = False
    count = 0
    while count < max_frames:
        pcm = recorder.read()
        frames.extend(pcm)
        count += 1
        arr = np.asarray(pcm, dtype=np.float32)
        rms = float(np.sqrt(np.mean(arr * arr))) if arr.size else 0.0
        if rms > rms_threshold:
            spoke = True
            silent = 0
        else:
            if spoke:
                silent += 1
            elif count > grace:
                break  # nobody actually said anything
        if spoke and silent >= need_silent:
            break
    return frames

def transcribe(frames, whisper):
    if not frames:
        return ""
    audio = np.asarray(frames, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _ = whisper.transcribe(audio, language="en", beam_size=1, vad_filter=True)
    return " ".join(s.text for s in segments).strip()

# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------
def main():
    print("Loading speech model...")
    whisper = WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8")
    porcupine = pvporcupine.create(access_key=PICOVOICE_KEY, keywords=[WAKE_WORD])
    recorder = PvRecorder(device_index=-1, frame_length=porcupine.frame_length)
    recorder.start()
    print(f'J.A.R.V.I.S. online. Say "{WAKE_WORD}" to wake me. (Ctrl-C to quit)')
    try:
        while True:
            pcm = recorder.read()
            if porcupine.process(pcm) >= 0:
                cue()
                print("[awake] listening...")
                frames = record_utterance(recorder, porcupine.frame_length, porcupine.sample_rate)
                text = transcribe(frames, whisper)
                if not text:
                    continue
                print(f"YOU> {text}")
                reply = think(text)
                speak(reply)
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        recorder.stop()
        recorder.delete()
        porcupine.delete()

if __name__ == "__main__":
    main()
