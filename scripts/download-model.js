#!/usr/bin/env node
/**
 * Downloads a Vosk English speech model into models/.
 * Default: vosk-model-en-us-0.22-lgraph (~128 MB) — much more accurate than the
 * small model while staying fast. Override with JARVIS_VOSK_MODEL, e.g.:
 *   JARVIS_VOSK_MODEL=vosk-model-small-en-us-0.15   (40 MB, fastest, least accurate)
 *   JARVIS_VOSK_MODEL=vosk-model-en-us-0.22         (1.8 GB, most accurate, heavy)
 * Run: node scripts/download-model.js
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MODEL_NAME = process.env.JARVIS_VOSK_MODEL || 'vosk-model-en-us-0.22-lgraph';
const MODEL_URL = `https://alphacephei.com/vosk/models/${MODEL_NAME}.zip`;
const MODELS_DIR = path.join(__dirname, '..', 'models');
const MODEL_PATH = path.join(MODELS_DIR, MODEL_NAME);
const ZIP_PATH = path.join(MODELS_DIR, `${MODEL_NAME}.zip`);

if (fs.existsSync(MODEL_PATH)) {
  console.log(`Model already exists at ${MODEL_PATH}`);
  process.exit(0);
}

fs.mkdirSync(MODELS_DIR, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url} ...`);
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;

    get(url, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${response.statusCode}`));
      }

      const total = parseInt(response.headers['content-length'], 10) || 0;
      let downloaded = 0;

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total) {
          const pct = ((downloaded / total) * 100).toFixed(1);
          process.stdout.write(`\r  ${pct}% (${(downloaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`);
        }
      });

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('\n  Download complete.');
        resolve();
      });
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function main() {
  try {
    await download(MODEL_URL, ZIP_PATH);

    console.log('Extracting...');
    // Use PowerShell on Windows, unzip on macOS/Linux
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${ZIP_PATH}' -DestinationPath '${MODELS_DIR}' -Force"`,
        { stdio: 'inherit' }
      );
    } else {
      execSync(`unzip -o "${ZIP_PATH}" -d "${MODELS_DIR}"`, { stdio: 'inherit' });
    }

    // Clean up zip
    fs.unlinkSync(ZIP_PATH);
    console.log(`Model ready at ${MODEL_PATH}`);
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
}

main();
