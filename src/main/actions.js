const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

let actions = {};

/**
 * Expand ~ and environment variables in a single argument string.
 * Handles ~/..., $VAR, and %VAR% (Windows-style).
 */
function expandArg(arg) {
  // Expand leading ~/ or standalone ~
  if (arg === '~') {
    return os.homedir();
  }
  if (arg.startsWith('~/') || arg.startsWith('~\\')) {
    arg = path.join(os.homedir(), arg.slice(2));
  }
  // Expand $VAR or ${VAR}
  arg = arg.replace(/\$\{([^}]+)\}/g, (_m, name) => process.env[name] || '');
  arg = arg.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => process.env[name] || '');
  // Expand %VAR% (Windows convention)
  arg = arg.replace(/%([^%]+)%/g, (_m, name) => process.env[name] || '');
  return arg;
}

/**
 * Load actions from actions.json (and optionally actions-powerful.json).
 * @param {string} appDir - directory containing the JSON files
 * @param {boolean} powerful - if true, merge actions-powerful.json
 */
function loadActions(appDir, powerful = false) {
  actions = {};
  const base = path.join(appDir, 'actions.json');
  if (fs.existsSync(base)) {
    try {
      Object.assign(actions, JSON.parse(fs.readFileSync(base, 'utf-8')));
    } catch (e) {
      console.warn('[actions] could not read actions.json:', e.message);
    }
  }
  if (powerful) {
    const ext = path.join(appDir, 'actions-powerful.json');
    if (fs.existsSync(ext)) {
      try {
        Object.assign(actions, JSON.parse(fs.readFileSync(ext, 'utf-8')));
      } catch (e) {
        console.warn('[actions] could not read actions-powerful.json:', e.message);
      }
    }
  }
  return actions;
}

function getActions() {
  return actions;
}

/**
 * Execute a whitelisted tool. Returns a short result string.
 * Never uses shell:true. Never interpolates model text into commands.
 */
function executeTool(name, args) {
  return new Promise((resolve) => {
    try {
      if (name === 'open_app') {
        const app = String(args.name || '').trim();
        if (!app) return resolve('No app name given.');
        if (IS_MAC) {
          execFile('open', ['-a', app], { timeout: 10000 }, (err) => {
            resolve(err ? `Could not open ${app}: ${err.message}` : `Opened ${app}.`);
          });
        } else {
          // Windows: use start command via cmd to find apps by name
          const child = spawn('cmd', ['/c', 'start', '', app], {
            stdio: 'ignore',
            timeout: 10000,
          });
          child.on('error', (err) => resolve(`Could not open ${app}: ${err.message}`));
          child.on('close', (code) => {
            resolve(code === 0 ? `Opened ${app}.` : `Could not open ${app} (exit ${code}).`);
          });
        }
        return;
      }

      if (name === 'open_url') {
        const url = String(args.url || '').trim();
        if (!(url.startsWith('http://') || url.startsWith('https://'))) {
          return resolve('Refused: only http/https URLs are allowed.');
        }
        const cmd = IS_MAC ? 'open' : 'cmd';
        const cmdArgs = IS_MAC ? [url] : ['/c', 'start', '', url];
        execFile(cmd, cmdArgs, { timeout: 10000 }, (err) => {
          resolve(err ? `Could not open URL: ${err.message}` : `Opened ${url}.`);
        });
        return;
      }

      if (name === 'run_action') {
        const aid = String(args.action_id || '').trim();
        const action = actions[aid];
        if (!action) return resolve(`No such action '${aid}'.`);

        // Pick platform-specific command, fall back to generic
        let cmd = IS_MAC ? action.command_mac : action.command_win;
        if (!cmd) cmd = action.command;
        if (!Array.isArray(cmd) || cmd.length === 0) {
          return resolve(`Action '${aid}' has no command for this platform.`);
        }

        // Expand ~ and env vars in each argument
        const expanded = cmd.map(expandArg);

        execFile(expanded[0], expanded.slice(1), {
          timeout: 120000,
          windowsHide: true,
        }, (err, stdout, stderr) => {
          if (err) return resolve(`Action '${aid}' failed: ${err.message}`);
          const tail = (stdout || stderr || '').trim().slice(-300);
          resolve(tail ? `Ran ${aid}. ${tail}` : `Ran ${aid}.`);
        });
        return;
      }

      resolve(`Unknown tool ${name}.`);
    } catch (e) {
      resolve(`Error running ${name}: ${e.message}`);
    }
  });
}

module.exports = { loadActions, getActions, executeTool };
