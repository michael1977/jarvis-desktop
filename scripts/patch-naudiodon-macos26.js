#!/usr/bin/env node
/**
 * Patches naudiodon/index.js to throw a catchable JS error on macOS 26+
 * instead of SIGSEGV-crashing the process. Run as postinstall.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '../node_modules/naudiodon/index.js');
if (!fs.existsSync(target)) { console.log('[patch] naudiodon not found — skipping'); process.exit(0); }

const src = fs.readFileSync(target, 'utf8');
const MARKER = '// [mac26-patched]';
if (src.includes(MARKER)) { console.log('[patch] naudiodon already patched'); process.exit(0); }

const patch = `${MARKER}
const os = require('os');
function _checkPortAudioCompat() {
  if (process.platform === 'darwin') {
    const major = parseInt(os.release().split('.')[0], 10);
    if (major >= 25) throw new Error(
      'naudiodon: bundled PortAudio is incompatible with macOS 26+ (Darwin ' + major + '). ' +
      'Rebuild naudiodon against a newer PortAudio to enable audio.'
    );
  }
}
`;

const patched = src.replace(
  'function AudioIO(options) {',
  patch + '\nfunction AudioIO(options) {\n  _checkPortAudioCompat();'
);

fs.writeFileSync(target, patched, 'utf8');
console.log('[patch] naudiodon patched for macOS 26 compatibility');
