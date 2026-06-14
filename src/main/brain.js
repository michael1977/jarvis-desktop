const os = require('os');
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
  // Stable block is cached; the volatile date/time goes in a trailing block so it
  // doesn't invalidate the cached prefix on every call (prefix-match caching).
  return [
    {
      type: 'text',
      text: SYSTEM_PROMPT_BASE,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `Current date and time: ${dateStr}, ${timeStr}. Platform: ${process.platform === 'win32' ? 'Windows' : 'macOS'}. User: ${os.userInfo().username}.`,
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
let history = [];
let emitCallback = null;

function init(apiKey, opts = {}) {
  if (!apiKey) return false;
  client = new Anthropic({ apiKey });
  if (opts.model) model = opts.model;
  if (opts.onEvent) emitCallback = opts.onEvent;
  return true;
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

  history.push({ role: 'user', content: userText });
  if (history.length > 12) history = history.slice(-12);

  const tools = buildToolDefs();
  // Cache the (stable) tool definitions so the model doesn't re-process them every turn.
  tools[tools.length - 1].cache_control = { type: 'ephemeral' };
  const messages = [...history];

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
            // Check built-in tools first
            const builtinResult = await executeBuiltinTool(block.name, block.input);
            if (builtinResult !== null) {
              console.log(`[action] ${block.name} ->`, builtinResult.slice(0, 200));
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: builtinResult,
              });
            } else {
              emit('action:running', { tool: block.name, args: block.input });
              const out = await executeTool(block.name, block.input);
              console.log(`[action] ${block.name}`, block.input, '->', out);
              emit('action:ran', { tool: block.name, args: block.input, result: out });
              results.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: out,
              });
            }
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

      history = messages.slice(-12);
      return reply;
    }

    return 'I got a little tangled up there, sir. Try that again?';
  } catch (e) {
    console.error('[brain] error:', e.message, e.status || '', e.error?.message || '');
    const fb = fallback();
    history.push({ role: 'assistant', content: fb });
    return fb;
  }
}

module.exports = { init, isReady, think };
