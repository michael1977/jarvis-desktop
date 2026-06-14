/**
 * electron-builder afterSign hook.
 *
 * Runs after the app bundle is assembled but BEFORE the DMG / ZIP are created,
 * so the final artifacts ship with a proper ad-hoc signature.
 *
 * On macOS CI there is no developer certificate, so we use an ad-hoc signature
 * (`codesign --sign -`). This is enough for:
 *   - gatekeeper-bypass via `xattr -d com.apple.quarantine` (first launch only)
 *   - electron-updater to replace the bundle on subsequent auto-updates
 *   - the app to spawn helper processes (Electron helpers, jarvis-voice, etc.)
 *
 * On a local machine with a real developer cert, electron-builder signs first
 * and this hook overwrites with ad-hoc — which is fine because we re-sign
 * everything locally anyway.
 */

const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName  = context.packager.appInfo.productFilename;
  const appPath  = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterSign] Ad-hoc signing: ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  console.log('[afterSign] Done.');
};
