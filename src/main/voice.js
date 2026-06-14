/**
 * Voice pipeline: Vosk for wake-word detection + open-vocabulary STT.
 *
 * Uses two Vosk recognizers:
 *   1. A grammar-constrained recognizer that only listens for "jarvis" (wake word).
 *      This works even though "jarvis" isn't in the base vocabulary because
 *      grammar mode forces Vosk to match against the provided word list.
 *   2. An open-vocabulary recognizer for transcribing the actual command.
 *
 * Flow:
 *   - Idle: feed mic audio to the wake recognizer.
 *   - On "jarvis" detected: emit 'listening', switch to the open recognizer.
 *   - Capture until silence (Vosk final result) or timeout → hand transcript to caller.
 *   - Pause during brain/TTS, resume after.
 *
 * Uses naudiodon (PortAudio) for mic capture and vosk-koffi for recognition.
 */

const path = require('path');
const fs = require('fs');
const vosk = require('vosk-koffi');
const portAudio = require('naudiodon');

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_SIZE = 4000; // ~250ms of 16-bit mono at 16 kHz

let model = null;
let wakeRecognizer = null;   // grammar-constrained: only "jarvis"
let cmdRecognizer = null;    // open vocabulary for command transcription
let audioStream = null;
let running = false;
let muted = false;
let paused = false;
let awake = false;
let micDeviceId = -1;        // -1 = system default input
let emit = () => {};
let onTranscriptCb = () => {};

// How long to wait for a command after wake before going dormant.
// The timer resets whenever the user is mid-sentence, so this is silence duration.
const COMMAND_TIMEOUT_MS = 8000; // 8s of silence before returning to wake-word detection
let commandTimer = null;

// Brief deafness after (re)arming, so Jarvis doesn't trigger on the tail of its
// own TTS or room echo and appears to "never go dormant".
const WAKE_COOLDOWN_MS = 900;
let deafUntil = 0;

/**
 * Initialize the Vosk model.
 * @param {string} modelPath - path to vosk model directory
 * @param {object} opts
 * @param {function} opts.onEvent - callback(event, data)
 * @returns {boolean} success
 */
function init(modelPath, opts = {}) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    console.warn('[voice] Model path not found:', modelPath);
    return false;
  }

  if (opts.onEvent) emit = opts.onEvent;
  if (typeof opts.deviceId === 'number' && !Number.isNaN(opts.deviceId)) micDeviceId = opts.deviceId;

  // Log available input devices so a specific mic can be chosen via JARVIS_MIC_DEVICE.
  try {
    const inputs = portAudio.getDevices().filter(d => d.maxInputChannels > 0);
    console.log('[voice] Input devices:');
    for (const d of inputs) console.log(`  id ${d.id}: ${d.name}${d.id === micDeviceId ? '  <- selected' : ''}`);
  } catch (_) {}

  try {
    vosk.setLogLevel(-1);
    model = new vosk.Model(modelPath);
    console.log('[voice] Vosk model loaded from', modelPath);
    return true;
  } catch (e) {
    console.error('[voice] Failed to load Vosk model:', e.message);
    model = null;
    return false;
  }
}

/** Create the grammar-constrained wake-word recognizer. */
function createWakeRecognizer() {
  return new vosk.Recognizer({
    model,
    sampleRate: SAMPLE_RATE,
    grammar: ['jarvis', '[unk]'],
  });
}

/** Create the open-vocabulary command recognizer. */
function createCmdRecognizer() {
  return new vosk.Recognizer({ model, sampleRate: SAMPLE_RATE });
}

/**
 * Start the voice loop.
 * @param {function} onTranscript - called with (transcriptString) when command captured
 */
function start(onTranscript) {
  if (!model) return;
  if (running) return;

  onTranscriptCb = onTranscript || (() => {});
  running = true;
  paused = false;
  awake = false;

  wakeRecognizer = createWakeRecognizer();
  deafUntil = Date.now() + WAKE_COOLDOWN_MS;

  try {
    audioStream = portAudio.AudioIO({
      inOptions: {
        channelCount: CHANNELS,
        sampleFormat: portAudio.SampleFormat16Bit,
        sampleRate: SAMPLE_RATE,
        deviceId: micDeviceId,
        framesPerBuffer: FRAME_SIZE,
      },
    });
  } catch (e) {
    console.error('[voice] Failed to open audio stream:', e.message);
    running = false;
    return;
  }

  audioStream.on('data', (buffer) => {
    if (!running || muted || paused) return;
    processAudio(buffer);
  });

  audioStream.on('error', (err) => {
    // PortAudio overflow/underflow errors are non-fatal — just log and continue
    console.warn('[voice] Audio stream warning:', err?.message || err);
  });

  audioStream.start();
  emit('voice:status', 'active');
  console.log('[voice] Listening for wake word "jarvis"...');
}

/**
 * Process a chunk of audio data.
 */
function processAudio(buffer) {
  // Ignore audio for a beat after (re)arming, so TTS tail/echo can't self-trigger
  // the wake word or be captured as a phantom follow-up command.
  if (Date.now() < deafUntil) return;
  if (awake) {
    processCommand(buffer);
  } else {
    processWake(buffer);
  }
}

/**
 * Enter command-listening mode: stop wake detection, open the command recognizer,
 * and start the silence window. Used both on wake-word and on the post-reply
 * follow-up window so a conversation can continue without repeating "Jarvis".
 */
function enterCommandMode() {
  if (!model || !running) return;
  awake = true;
  try { wakeRecognizer?.free(); } catch (_) {}
  wakeRecognizer = null;
  try { cmdRecognizer?.free(); } catch (_) {}
  cmdRecognizer = createCmdRecognizer();
  deafUntil = Date.now() + WAKE_COOLDOWN_MS; // skip any TTS echo at the start
  emit('state', 'listening');
  resetCommandTimeout();
}

/**
 * Wake-word detection using grammar-constrained recognizer.
 */
function processWake(buffer) {
  if (!wakeRecognizer) return;

  const done = wakeRecognizer.acceptWaveform(buffer);

  // Check partial results for "jarvis"
  const partial = wakeRecognizer.partialResult();
  const partialText = (partial.partial || '').toLowerCase().trim();

  if (partialText.includes('jarvis')) {
    triggerWake();
    return;
  }

  // Also check final results
  if (done) {
    const result = wakeRecognizer.result();
    const finalText = (result.text || '').toLowerCase().trim();
    if (finalText.includes('jarvis')) {
      triggerWake();
    }
  }
}

function triggerWake() {
  console.log('[voice] Wake word detected!');
  enterCommandMode();
}

/**
 * Command transcription using open-vocabulary recognizer.
 */
function processCommand(buffer) {
  if (!cmdRecognizer) return;

  const done = cmdRecognizer.acceptWaveform(buffer);

  if (done) {
    const result = cmdRecognizer.result();
    const text = (result.text || '').trim();

    if (text.length > 0) {
      // Real command — hand it off. The reply pipeline pauses voice and, when it
      // finishes speaking, resume() reopens the follow-up window for a reply.
      clearTimeout(commandTimer);
      commandTimer = null;
      try { cmdRecognizer.free(); } catch (_) {}
      cmdRecognizer = null;
      awake = false;
      console.log('[voice] Command:', text);
      onTranscriptCb(text);
      wakeRecognizer = createWakeRecognizer(); // fallback; resume() reopens the window
    } else {
      // Silence/noise with no words — keep the conversation window open and let
      // the silence timer decide when to go dormant (≥ COMMAND_TIMEOUT_MS).
      try { cmdRecognizer.free(); } catch (_) {}
      cmdRecognizer = createCmdRecognizer();
      resetCommandTimeout();
    }
  } else {
    // Show partial transcript while user speaks
    const partial = cmdRecognizer.partialResult();
    if (partial.partial) {
      emit('transcript:partial', partial.partial);
      resetCommandTimeout();
    }
  }
}

function resetCommandTimeout() {
  clearTimeout(commandTimer);
  commandTimer = setTimeout(() => {
    if (awake) {
      console.log('[voice] Command timeout, returning to idle.');

      // Flush any remaining text from command recognizer
      if (cmdRecognizer) {
        const result = cmdRecognizer.result();
        const text = (result.text || '').trim();
        try { cmdRecognizer.free(); } catch (_) {}
        cmdRecognizer = null;

        if (text.length > 0) {
          console.log('[voice] Timeout with text:', text);
          awake = false;
          onTranscriptCb(text);
          wakeRecognizer = createWakeRecognizer();
          return;
        }
      }

      awake = false;
      emit('state', 'idle');
      wakeRecognizer = createWakeRecognizer();
    }
  }, COMMAND_TIMEOUT_MS);
}

/** Pause the voice loop (during brain thinking / TTS). */
function pause() {
  paused = true;
  awake = false;
  clearTimeout(commandTimer);
}

/**
 * Resume the voice loop after a reply. Returns to wake-word detection (DORMANT)
 * so Jarvis only activates again when explicitly called by name.
 */
function resume() {
  paused = false;
  awake = false;
  clearTimeout(commandTimer);
  try { cmdRecognizer?.free(); } catch (_) {}
  cmdRecognizer = null;
  if (!wakeRecognizer && model) wakeRecognizer = createWakeRecognizer();
  // Brief deaf period so Jarvis doesn't hear its own TTS echo as a wake word
  deafUntil = Date.now() + 1500;
  emit('state', 'idle');
}

/** Toggle mute. Returns new muted state. */
function toggleMute() {
  muted = !muted;
  emit('voice:muted', muted);
  if (muted) {
    awake = false;
    clearTimeout(commandTimer);
  }
  return muted;
}

function isMuted() {
  return muted;
}

function isRunning() {
  return running;
}

/** Stop the voice loop and release resources. */
function stop() {
  running = false;
  clearTimeout(commandTimer);
  try { audioStream?.quit(); } catch (_) {}
  try { wakeRecognizer?.free(); } catch (_) {}
  try { cmdRecognizer?.free(); } catch (_) {}
  try { model?.free(); } catch (_) {}
  audioStream = null;
  wakeRecognizer = null;
  cmdRecognizer = null;
  model = null;
  emit('voice:status', 'stopped');
  console.log('[voice] Stopped.');
}

module.exports = { init, start, stop, pause, resume, toggleMute, isMuted, isRunning };
