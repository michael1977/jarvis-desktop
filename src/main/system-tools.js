/**
 * Built-in system tools that Jarvis can use without actions.json.
 * All safe, read-only or low-risk operations.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');

const IS_WIN = process.platform === 'win32';

// ---- Tool definitions for Claude ----

const TOOL_DEFS = [
  {
    name: 'get_datetime',
    description: 'Get the current date, time, day of week, and timezone.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_system_info',
    description: 'Get system information: OS, CPU, total/free memory, uptime, hostname, username, battery level.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_disk_usage',
    description: 'Get disk space usage for all drives.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_network_info',
    description: 'Get network interfaces, IP addresses (local and public), and connection status.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_running_processes',
    description: 'List the top running processes by memory usage.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_weather',
    description: 'Get current weather for a city or location. Uses wttr.in (no API key needed).',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name or location (e.g. "London", "New York")' },
      },
      required: ['location'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate a mathematical expression. Supports basic arithmetic, Math functions (sqrt, pow, sin, cos, PI, etc).',
    input_schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression (e.g. "sqrt(144)", "2**10", "Math.PI * 5**2")' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'clipboard_read',
    description: 'Read the current contents of the system clipboard (text only).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_write',
    description: 'Write text to the system clipboard.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to copy to clipboard' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory. Defaults to user home. Use to explore the filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (e.g. "~/Documents", "C:\\\\Users"). Defaults to home.' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a text file. Returns first 5000 characters. Use for reading notes, configs, small text files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_note',
    description: 'Write or append text to a note file in the user\'s Documents/JarvisNotes folder. Creates the folder if needed.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Note filename (e.g. "shopping-list.txt", "ideas.txt")' },
        content: { type: 'string', description: 'Text content to write' },
        append: { type: 'boolean', description: 'If true, append to existing file instead of overwriting. Default true.' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'set_timer',
    description: 'Set a countdown timer. Jarvis will announce when it completes.',
    input_schema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Duration in seconds' },
        label: { type: 'string', description: 'What the timer is for (e.g. "tea", "break")' },
      },
      required: ['seconds'],
    },
  },
  {
    name: 'web_request',
    description: 'Fetch the text content of a URL (GET request). Useful for checking APIs, getting quick info. Returns first 3000 chars.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (must be http or https)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'find_files',
    description: 'Search for files by name pattern in a directory (recursive). Returns matching file paths.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory to search in (e.g. "~/Documents")' },
        pattern: { type: 'string', description: 'Filename pattern to match (case-insensitive substring, e.g. "invoice", ".pdf")' },
      },
      required: ['directory', 'pattern'],
    },
  },
];

// ---- Tool implementations ----

let timerCallback = null; // set by init

function setTimerCallback(cb) {
  timerCallback = cb;
}

function expandPath(p) {
  if (!p) return os.homedir();
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  p = p.replace(/%([^%]+)%/g, (_m, name) => process.env[name] || '');
  p = p.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => process.env[name] || '');
  return p;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 5000) res.destroy(); });
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? (stderr || err.message) : stdout);
    });
  });
}

async function execute(name, args) {
  try {
    switch (name) {
      case 'get_datetime': {
        const now = new Date();
        return JSON.stringify({
          time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
          date: now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      }

      case 'get_system_info': {
        const cpus = os.cpus();
        const info = {
          platform: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
          os_version: os.release(),
          hostname: os.hostname(),
          username: os.userInfo().username,
          cpu: cpus[0]?.model || 'Unknown',
          cores: cpus.length,
          total_memory_gb: (os.totalmem() / 1e9).toFixed(1),
          free_memory_gb: (os.freemem() / 1e9).toFixed(1),
          memory_used_pct: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(0) + '%',
          uptime_hours: (os.uptime() / 3600).toFixed(1),
        };
        // Try to get battery info on Windows
        if (IS_WIN) {
          try {
            const bat = await runCmd('powershell', ['-NoProfile', '-Command',
              '(Get-WmiObject Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json)']);
            const b = JSON.parse(bat);
            info.battery_pct = b.EstimatedChargeRemaining + '%';
            info.battery_charging = b.BatteryStatus === 2;
          } catch (_) {}
        }
        return JSON.stringify(info);
      }

      case 'get_disk_usage': {
        if (IS_WIN) {
          const out = await runCmd('powershell', ['-NoProfile', '-Command',
            'Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N="UsedGB";E={[math]::Round($_.Used/1GB,1)}}, @{N="FreeGB";E={[math]::Round($_.Free/1GB,1)}} | ConvertTo-Json']);
          return out.trim();
        } else {
          const out = await runCmd('df', ['-h']);
          return out.trim().slice(0, 2000);
        }
      }

      case 'get_network_info': {
        const ifaces = os.networkInterfaces();
        const result = {};
        for (const [name, addrs] of Object.entries(ifaces)) {
          const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
          if (ipv4) result[name] = ipv4.address;
        }
        // Get public IP
        try {
          const pub = await httpGet('https://api.ipify.org');
          result.public_ip = pub.trim();
        } catch (_) {
          result.public_ip = 'unavailable';
        }
        return JSON.stringify(result);
      }

      case 'get_running_processes': {
        if (IS_WIN) {
          const out = await runCmd('powershell', ['-NoProfile', '-Command',
            'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, @{N="MemoryMB";E={[math]::Round($_.WorkingSet64/1MB)}} | ConvertTo-Json']);
          return out.trim();
        } else {
          const out = await runCmd('ps', ['aux', '--sort=-rss']);
          return out.split('\n').slice(0, 16).join('\n');
        }
      }

      case 'get_weather': {
        const loc = encodeURIComponent(args.location || 'London');
        const data = await httpGet(`https://wttr.in/${loc}?format=j1`);
        const w = JSON.parse(data);
        const cur = w.current_condition?.[0];
        if (!cur) return 'Weather data unavailable.';
        return JSON.stringify({
          location: args.location,
          temp_c: cur.temp_C,
          feels_like_c: cur.FeelsLikeC,
          description: cur.weatherDesc?.[0]?.value,
          humidity: cur.humidity + '%',
          wind_kmph: cur.windspeedKmph,
          wind_dir: cur.winddir16Point,
        });
      }

      case 'calculate': {
        const expr = args.expression || '';
        // Allow only safe math characters and functions
        if (/[^0-9+\-*/().,%\s^eE]/.test(expr.replace(/Math\.\w+/g, '').replace(/sqrt|pow|sin|cos|tan|log|abs|ceil|floor|round|PI|E|min|max|random/g, ''))) {
          return 'Expression contains disallowed characters.';
        }
        // Replace common patterns
        let safe = expr
          .replace(/\^/g, '**')
          .replace(/\b(sqrt|pow|sin|cos|tan|log|abs|ceil|floor|round|min|max|random|PI|E)\b/g, 'Math.$1');
        const result = new Function(`"use strict"; return (${safe})`)();
        return `${expr} = ${result}`;
      }

      case 'clipboard_read': {
        if (IS_WIN) {
          const out = await runCmd('powershell', ['-NoProfile', '-Command', 'Get-Clipboard']);
          return out.trim() || '(clipboard is empty)';
        } else {
          const out = await runCmd('pbpaste', []);
          return out.trim() || '(clipboard is empty)';
        }
      }

      case 'clipboard_write': {
        const text = args.text || '';
        if (IS_WIN) {
          await runCmd('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value '${text.replace(/'/g, "''")}'`]);
        } else {
          const proc = require('child_process').spawn('pbcopy');
          proc.stdin.end(text);
        }
        return 'Copied to clipboard.';
      }

      case 'list_directory': {
        const dir = expandPath(args.path || '~');
        if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const list = entries.slice(0, 50).map(e => {
          const type = e.isDirectory() ? '[DIR]' : '[FILE]';
          return `${type} ${e.name}`;
        });
        if (entries.length > 50) list.push(`... and ${entries.length - 50} more`);
        return list.join('\n');
      }

      case 'read_file': {
        const filePath = expandPath(args.path);
        if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;
        const stat = fs.statSync(filePath);
        if (stat.size > 1e6) return `File too large (${(stat.size / 1e6).toFixed(1)} MB). Only files under 1 MB supported.`;
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.slice(0, 5000);
      }

      case 'write_note': {
        const notesDir = path.join(os.homedir(), 'Documents', 'JarvisNotes');
        fs.mkdirSync(notesDir, { recursive: true });
        const filename = path.basename(args.filename || 'note.txt'); // prevent path traversal
        const filePath = path.join(notesDir, filename);
        const append = args.append !== false; // default true
        if (append && fs.existsSync(filePath)) {
          fs.appendFileSync(filePath, '\n' + args.content);
        } else {
          fs.writeFileSync(filePath, args.content);
        }
        return `Note saved to ${filePath}`;
      }

      case 'set_timer': {
        const secs = Math.min(Math.max(args.seconds || 60, 1), 7200); // 1s to 2h
        const label = args.label || 'timer';
        setTimeout(() => {
          if (timerCallback) {
            timerCallback(`Your ${label} timer is up, sir. ${secs >= 60 ? Math.round(secs / 60) + ' minutes' : secs + ' seconds'} have elapsed.`);
          }
        }, secs * 1000);
        return `Timer set for ${secs >= 60 ? Math.round(secs / 60) + ' minutes' : secs + ' seconds'} (${label}).`;
      }

      case 'web_request': {
        const url = args.url || '';
        if (!(url.startsWith('http://') || url.startsWith('https://'))) {
          return 'Only http/https URLs allowed.';
        }
        const data = await httpGet(url);
        return data.slice(0, 3000);
      }

      case 'find_files': {
        const dir = expandPath(args.directory || '~');
        const pattern = (args.pattern || '').toLowerCase();
        if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;
        const results = [];
        function walk(d, depth) {
          if (depth > 4 || results.length >= 30) return;
          try {
            const entries = fs.readdirSync(d, { withFileTypes: true });
            for (const e of entries) {
              if (e.name.startsWith('.')) continue;
              const full = path.join(d, e.name);
              if (e.name.toLowerCase().includes(pattern)) {
                results.push(full);
              }
              if (e.isDirectory() && !e.name.startsWith('node_modules')) {
                walk(full, depth + 1);
              }
            }
          } catch (_) {}
        }
        walk(dir, 0);
        return results.length > 0 ? results.join('\n') : `No files matching "${args.pattern}" found in ${dir}`;
      }

      default:
        return null; // not a system tool
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

module.exports = { TOOL_DEFS, execute, setTimerCallback };
