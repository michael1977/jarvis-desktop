const os = require('os');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getActions, executeTool } = require('./actions');
const systemTools = require('./system-tools');

const SYSTEM_PROMPT_BASE = `You are J.A.R.V.I.S., a personal AI assistant running on the user's computer.
Personality: dry, understated British wit; calm and unflappable; quietly loyal. Address the user as "sir" occasionally, not in every reply. You may be wry or lightly sardonic when the moment calls for it — think Tony Stark's right hand.
Style: this is a SPOKEN interface, so keep replies short — usually one or two sentences. No markdown, no lists, no emoji. Speak plainly so it sounds natural read aloud. Numbers should be spoken naturally (e.g. "half past three" not "15:30").

You have extensive control over this computer via tools. Use them proactively whenever the user's request implies an action:

SYSTEM QUERIES: get_datetime (current time/date), get_system_info (CPU/RAM/battery/uptime), get_disk_usage, get_network_info (IPs), get_running_processes, get_weather (any city).
MATH & DATA: calculate (evaluate expressions), clipboard_read, clipboard_write, web_request (fetch any URL).
FILES & NOTES: list_directory, read_file, write_note (save notes to Documents/JarvisNotes), find_files (search by name).
APPS & URLS: open_app (launch any application), open_url (open website in browser).
SYSTEM ACTIONS: run_action (predefined actions for volume, media playback, screenshots, lock screen, brightness, open folders, etc.).
TIMERS: set_timer (countdown with spoken announcement when done).

Be proactive — "play some music" means use media_playpause, "turn it up" means volume_up, "what's the weather" means get_weather, "what time is it" means get_datetime. After an action, confirm briefly.
Never invent actions that aren't available. Never mention being a language model or AI.`;

function buildSystemPrompt() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  let memText = '';
  if (memoryFacts.length) {
    memText = `\n\nLong-term memory — things you have remembered about the user across previous conversations:\n- ${memoryFacts.join('\n- ')}`;
  }
  if (history.length) {
    memText += `\n\nYou retain the recent conversation history below, so you can refer back to earlier exchanges naturally.`;
  }

  // Stable block is cached; the volatile date/time + memory go in a trailing block
  // so they don't invalidate the cached prefix on every call (prefix-match caching).
  return [
    {
      type: 'text',
      text: SYSTEM_PROMPT_BASE,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `Current date and time: ${dateStr}, ${timeStr}. Platform: ${process.platform === 'win32' ? 'Windows' : 'macOS'}. User: ${os.userInfo().username}.${memText}`,
    },
  ];
}

const FALLBACKS = [
  'My uplink appears to be down, sir. I shall improvise until it returns.',
  'I seem to have lost my connection. Bear with me a moment.',
  'Communications are a touch unstable right now, sir. Consider it noted.',
  'I am temporarily flying blind on the network front. Standing by.',
];

let client = null;
let model = 'claude-opus-4-8';
let history = [];        // [{ role: 'user'|'assistant', content: string }] — clean text turns
let memoryFacts = [];    // durable facts the user asked Jarvis to remember
let emitCallback = null;

// Persistence (paths set from init opts.storeDir, e.g. app userData).
let historyPath = null;
let memoryPath = null;
const MAX_HISTORY = 30;  // keep the last ~15 exchanges across restarts
const MAX_FACTS = 100;

function loadJson(file, fallbackVal) {
  try {
    if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[brain] failed to load', file, e.message);
  }
  return fallbackVal;
}

function saveJson(file, data) {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (e) {
    console.error('[brain] failed to save', file, e.message);
  }
}

function init(apiKey, opts = {}) {
  if (!apiKey) return false;
  client = new Anthropic({ apiKey });
  if (opts.model) model = opts.model;
  if (opts.onEvent) emitCallback = opts.onEvent;

  if (opts.storeDir) {
    historyPath = path.join(opts.storeDir, 'conversation.json');
    memoryPath = path.join(opts.storeDir, 'memory.json');
    // Restore prior conversation + long-term memory so Jarvis remembers across restarts.
    const h = loadJson(historyPath, []);
    history = Array.isArray(h) ? h.filter(m => m && typeof m.content === 'string').slice(-MAX_HISTORY) : [];
    const m = loadJson(memoryPath, []);
    memoryFacts = Array.isArray(m) ? m.filter(x => typeof x === 'string') : [];
    console.log(`[brain] memory loaded: ${history.length} messages, ${memoryFacts.length} facts`);
  }
  return true;
}

/** Store a durable fact (deduplicated) and persist it. */
function rememberFact(fact) {
  const f = (fact || '').trim();
  if (!f) return 'Nothing to remember, sir.';
  if (!memoryFacts.some(x => x.toLowerCase() === f.toLowerCase())) {
    memoryFacts.push(f);
    if (memoryFacts.length > MAX_FACTS) memoryFacts = memoryFacts.slice(-MAX_FACTS);
    saveJson(memoryPath, memoryFacts);
  }
  return `Noted and remembered: ${f}`;
}

/** Clear stored conversation history and/or long-term memory. */
function clearMemory(opts = {}) {
  if (opts.history !== false) { history = []; saveJson(historyPath, history); }
  if (opts.facts) { memoryFacts = []; saveJson(memoryPath, memoryFacts); }
}

function isReady() {
  return client !== null;
}

function buildToolDefs() {
  const actions = getActions();
  const actionLines = Object.entries(actions)
    .map(([k, v]) => `  - ${k}: ${v.description || ''}`)
    .join('\n') || '  (none defined)';
  const actionIds = Object.keys(actions);

  return [
    ...systemTools.TOOL_DEFS,
    {
      name: 'remember',
      description:
        'Store a durable fact about the user to recall in future conversations — their name, ' +
        'preferences, ongoing projects, important dates, etc. Use this whenever the user asks you ' +
        'to remember something, or shares a lasting personal detail worth keeping. Keep each fact concise.',
      input_schema: {
        type: 'object',
        properties: { fact: { type: 'string', description: 'The concise fact to remember.' } },
        required: ['fact'],
      },
    },
    {
      name: 'open_app',
      description: 'Open an application by name (e.g. "Notepad", "Chrome", "Spotify", "Calculator").',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Application name' } },
        required: ['name'],
      },
    },
    {
      name: 'open_url',
      description: 'Open a web URL in the default browser. Must start with http:// or https://.',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL including http(s)://' } },
        required: ['url'],
      },
    },
    {
      name: 'run_action',
      description:
        'Run one of the user\'s predefined system actions. Available action ids:\n' + actionLines,
      input_schema: {
        type: 'object',
        properties: {
          action_id: {
            type: 'string',
            enum: actionIds.length > 0 ? actionIds : ['__none__'],
          },
        },
        required: ['action_id'],
      },
    },
  ];
}

async function executeBuiltinTool(name, args) {
  return await systemTools.execute(name, args);
}

function fallback() {
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

function emit(event, data) {
  if (emitCallback) emitCallback(event, data);
}

/**
 * Send user text through Claude with tool-use loop.
 * Returns the final spoken reply string.
 */
async function think(userText) {
  if (!client) return fallback();

  const tools = buildToolDefs();
  // Cache the (stable) tool definitions so the model doesn't re-process them every turn.
  tools[tools.length - 1].cache_control = { type: 'ephemeral' };

  // Build the working message list from persisted history + this turn's input.
  // `history` holds only clean text turns; tool_use/tool_result blocks stay local
  // to this call so a restart never reloads orphaned tool fragments.
  const messages = [...history, { role: 'user', content: userText }];

  try {
    for (let i = 0; i < 5; i++) {
      const resp = await client.messages.create({
        model,
        max_tokens: 400,
        // Low effort + no extended thinking keeps Opus snappy for short spoken replies.
        output_config: { effort: 'low' },
        system: buildSystemPrompt(),
        tools,
        messages,
      });

      messages.push({ role: 'assistant', content: resp.content });

      if (resp.stop_reason === 'tool_use') {
        const results = [];
        for (const block of resp.content) {
          if (block.type === 'tool_use') {
            let out;
            if (block.name === 'remember') {
              // Long-term memory: persist the fact for future conversations.
              out = rememberFact(block.input && block.input.fact);
              emit('action:ran', { tool: 'remember', args: block.input, result: out });
            } else {
              // Check built-in tools first
              const builtinResult = await executeBuiltinTool(block.name, block.input);
              if (builtinResult !== null) {
                console.log(`[action] ${block.name} ->`, builtinResult.slice(0, 200));
                out = builtinResult;
              } else {
                emit('action:running', { tool: block.name, args: block.input });
                out = await executeTool(block.name, block.input);
                console.log(`[action] ${block.name}`, block.input, '->', out);
                emit('action:ran', { tool: block.name, args: block.input, result: out });
              }
            }
            results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
          }
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      const reply = resp.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join(' ')
        .trim();

      if (!reply) throw new Error('empty reply');

      // Persist only the clean user/assistant text turns so memory survives restarts.
      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: reply });
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
      saveJson(historyPath, history);

      return reply;
    }

    return 'I got a little tangled up there, sir. Try that again?';
  } catch (e) {
    console.error('[brain] error:', e.message, e.status || '', e.error?.message || '');
    return fallback();
  }
}

module.exports = { init, isReady, think, rememberFact, clearMemory };
