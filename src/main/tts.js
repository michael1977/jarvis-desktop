/**
 * Neural TTS via Microsoft Edge's Read Aloud API (free, no key needed).
 * Uses en-GB-RyanNeural for a British male voice with natural intonation.
 * Generates MP3 audio buffers sent to the renderer for playback.
 */

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

let currentVoice = 'en-GB-RyanNeural';
let ready = false;

async function init(voice) {
  if (voice) currentVoice = voice;
  // Don't open a test WebSocket connection here — the local MsEdgeTTS instance
  // would be GC'd by V8 after init() returns while the underlying TLS stream is
  // still live, causing a null-callback crash (PC=0) on macOS 26.
  // First real synthesize() call will surface any voice errors naturally.
  ready = true;
  console.log('[tts] Initialized with voice:', currentVoice);
  return true;
}

/**
 * Synthesize text to an MP3 buffer.
 * Creates a fresh MsEdgeTTS instance each time (required — reuse causes crashes).
 * @param {string} text - plain text to speak
 * @returns {Promise<Buffer|null>} MP3 audio data, or null on failure
 */
async function synthesize(text) {
  if (!ready || !text) return null;

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(currentVoice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

    const { audioStream } = tts.toStream(text);

    const chunks = [];
    return new Promise((resolve) => {
      audioStream.on('data', (chunk) => chunks.push(chunk));
      audioStream.on('end', () => {
        if (chunks.length === 0) return resolve(null);
        resolve(Buffer.concat(chunks));
      });
      audioStream.on('error', (e) => {
        console.error('[tts] Stream error:', e.message);
        resolve(null);
      });
    });
  } catch (e) {
    console.error('[tts] Synthesis failed:', e.message);
    return null;
  }
}

function isReady() {
  return ready;
}

module.exports = { init, synthesize, isReady };
