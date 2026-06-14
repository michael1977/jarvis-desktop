/**
 * Native module loader for packaged Electron apps.
 *
 * All node_modules are unpacked to app.asar.unpacked, but require() still
 * resolves paths into app.asar first. This patches Module._resolveFilename
 * to redirect all node_modules requires to the unpacked directory.
 */

const path = require('path');
const Module = require('module');
const { app } = require('electron');

let patched = false;
let segfaultDisabled = false;

/**
 * Neutralize `segfault-handler`.
 *
 * `naudiodon` (our mic-capture lib) does, at module load:
 *     require('segfault-handler').registerHandler("crash.log");
 * That installs an ancient, Electron-incompatible native SIGSEGV handler whose
 * own stack-walker faults with 0xc0000409 — turning minor/benign signals into
 * hard app shutdowns. We don't want a global native crash handler at all (we use
 * Electron's child/render-process-gone events instead), so intercept the require
 * and hand back a harmless stub. Must run BEFORE naudiodon is required.
 */
function disableSegfaultHandler() {
  if (segfaultDisabled) return;
  segfaultDisabled = true;
  const stub = { registerHandler() {}, setSignal() {} };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain, options) {
    if (request === 'segfault-handler') return stub;
    return originalLoad.call(this, request, parent, isMain, options);
  };
}

function patchRequire() {
  if (patched || !app.isPackaged) return;
  patched = true;

  const originalResolve = Module._resolveFilename;
  const asarPath = path.join(process.resourcesPath, 'app.asar', 'node_modules');
  const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');

  Module._resolveFilename = function (request, parent, isMain, options) {
    // First, let the original resolver find the path
    const resolved = originalResolve.call(this, request, parent, isMain, options);

    // If it resolved into app.asar/node_modules, redirect to app.asar.unpacked
    if (resolved && resolved.includes('app.asar') && !resolved.includes('app.asar.unpacked') && resolved.includes('node_modules')) {
      const redirected = resolved.replace(
        path.join(process.resourcesPath, 'app.asar'),
        path.join(process.resourcesPath, 'app.asar.unpacked')
      );
      return redirected;
    }

    return resolved;
  };

  console.log('[native] Patched require resolution for asar.unpacked');
}

module.exports = { patchRequire, disableSegfaultHandler };
