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

const SAMPLE_RATE = 16000;   // rate Vosk expects
const CHANNELS = 1;
// Many laptop mics (e.g. Intel Smart Sound array) are natively 48 kHz and reject
// a 16 kHz capture. We try 16 kHz first, then fall back to capturing at the
// device's native rate and downsampling to 16 kHz for Vosk.
const CAPTURE_RATES = [16000, 48000, 44100];
let captureRate = 16000;     // actual open rate (set in start())
const FRAME_SIZE = 4000;     // ~250ms at 16 kHz

let model = null;
let wakeRecognizer = null;   // grammar-constrained: only "jarvis"
let cmdRecognizer = null;    // open vocabulary for command transcription
let audioStream = null;
let running = false;
let muted = false;
let paused = false;
let awake = false;
let micDeviceId = -1;        // -1 = system default input
let micCandidates = [-1];    // ordered device ids to try opening
let dbgBytes = 0, dbgPeak = 0, dbgLast = 0; // audio-activity diagnostics
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

// Boost weak mics (some laptop mics only reach ~7% level). Applied to the 16-bit
// PCM before recognition. Tune with JARVIS_MIC_GAIN; 1 = off.
// Downsample 16-bit PCM by an integer factor (48k->16k = 3) by averaging each
// group of `factor` samples — cheap anti-aliasing, good enough for speech.
function downsample(buffer, factor) {
  const inSamples = Math.floor(buffer.length / 2);
  const outSamples = Math.floor(inSamples / factor);
  const out = Buffer.alloc(outSamples * 2);
  for (let o = 0; o < outSamples; o++) {
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += buffer.readInt16LE((o * factor + k) * 2);
    out.writeInt16LE((sum / factor) | 0, o * 2);
  }
  return out;
}

const MIC_GAIN = Math.max(1, parseFloat(process.env.JARVIS_MIC_GAIN || '4'));
function applyGain(buffer) {
  if (MIC_GAIN === 1) return;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    let s = buffer.readInt16LE(i) * MIC_GAIN;
    if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
    buffer.writeInt16LE(s | 0, i);
  }
}

/**
 * Initialize the Vosk model.
 * @param {string} modelPath - path to vosk model directory
 * @param {object} opts
 * @param {function} opts.onEvent - callback(event, data)
 * @returns {boolean} success
 */
/**
 * Rank real, physical laptop microphones from PortAudio's input list (best first),
 * skipping phones (Bluetooth "Hands-Free"), loopback (Stereo Mix), mappers and
 * virtual devices. Returns an ordered array of device ids to try. start() opens
 * them in order until one accepts the 16 kHz capture format (WASAPI/WDM-KS mics
 * often reject 16 kHz; MME mics resample and work).
 */
function rankInputDevices(inputs) {
  if (!inputs || !inputs.length) return [];
  const bad = /hands-free|iphone|android|airpod|bluetooth|bthhfenum|stereo mix|sound mapper|@system32|virtual|nvidia|vb-audio|voicemeeter|line in|what u hear/i;
  const real = inputs.filter(d => d.name && !bad.test(d.name));
  const rank = (d) => {
    const n = (d.name || '').toLowerCase();
    // MME devices (name truncated to ~31 chars) resample to 16 kHz — prefer them.
    let score = (d.name && d.name.length <= 31) ? 0 : 10;
    if (n.includes('microphone array')) score += 1;
    else if (n.includes('microphone')) score += 2;
    else score += 4;
    return score;
  };
  real.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  return real.map(d => d.id);
}

function init(modelPath, opts = {}) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    console.warn('[voice] Model path not found:', modelPath);
    return false;
  }

  if (opts.onEvent) emit = opts.onEvent;
  const explicitDevice = typeof opts.deviceId === 'number' && !Number.isNaN(opts.deviceId) && opts.deviceId >= 0;

  // Build the ordered list of mic device ids to try. An explicit JARVIS_MIC_DEVICE
  // is tried first; then ranked real mics; then the system default (-1) as a last
  // resort. start() opens them in order until one accepts 16 kHz capture.
  try {
    const inputs = portAudio.getDevices().filter(d => d.maxInputChannels > 0);
    micCandidates = [];
    if (explicitDevice) micCandidates.push(opts.deviceId);
    micCandidates.push(-1); // system default FIRST — matches the mic Windows uses/tests
    for (const id of rankInputDevices(inputs)) if (!micCandidates.includes(id)) micCandidates.push(id);
    console.log('[voice] Input devices:');
    for (const d of inputs) console.log(`  id ${d.id}: ${d.name}`);
    console.log('[voice] Mic candidates (in order):', micCandidates.join(', '));
  } catch (_) { micCandidates = [-1]; }

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

  // Try each candidate device at each capture rate until one opens. WASAPI mics
  // reject 16 kHz and must be captured at their native rate (48 kHz) then
  // downsampled. Skips iPhone/virtual devices (see rankInputDevices).
  audioStream = null;
  outer:
  for (const dev of micCandidates) {
    for (const rate of CAPTURE_RATES) {
      try {
        audioStream = portAudio.AudioIO({
          inOptions: {
            channelCount: CHANNELS,
            sampleFormat: portAudio.SampleFormat16Bit,
            sampleRate: rate,
            deviceId: dev,
            framesPerBuffer: Math.round(FRAME_SIZE * rate / SAMPLE_RATE),
          },
        });
        micDeviceId = dev;
        captureRate = rate;
        console.log('[voice] Opened mic device id:', dev, 'at', rate, 'Hz');
        break outer;
      } catch (e) {
        audioStream = null; // try next rate/device
      }
    }
  }
  if (!audioStream) {
    console.error('[voice] No usable microphone found');
    running = false;
    return;
  }

  const decim = Math.round(captureRate / SAMPLE_RATE); // 1 for 16k, 3 for 48k

  audioStream.on('data', (buffer) => {
    if (!running || muted || paused) return;
    // Downsample to 16 kHz for Vosk when captured at a higher native rate.
    if (decim > 1) buffer = downsample(buffer, decim);
    applyGain(buffer); // boost weak mic signal before recognition
    // Diagnostics: is the mic actually capturing sound? (peak ~0 = silent/wrong device)
    dbgBytes += buffer.length;
    for (let i = 0; i + 1 < buffer.length; i += 2) {
      const s = Math.abs(buffer.readInt16LE(i));
      if (s > dbgPeak) dbgPeak = s;
    }
    const now = Date.now();
    if (now - dbgLast > 3000) {
      console.log(`[voice] audio @${captureRate}Hz: ${dbgBytes} bytes/3s, peak ${dbgPeak}/32767 ${dbgPeak < 200 ? '(SILENT?)' : ''}`);
      dbgBytes = 0; dbgPeak = 0; dbgLast = now;
    }
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

  if (partialText) console.log('[voice] wake heard:', JSON.stringify(partialText));
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
