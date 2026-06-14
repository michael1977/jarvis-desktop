/* =========================================================
   J.A.R.V.I.S. HUD — renderer script
   Milestone 1: static HUD with animations, no audio/brain
   ========================================================= */

// Global error handler — catches anything the console-message event misses
window.onerror = (msg, src, line) => {
  document.title = 'ERROR: ' + msg + ' @ line ' + line;
  console.error('UNCAUGHT:', msg, src, line);
};

const reduce = window.matchMedia('(prefers-reduced-motion:reduce)').matches;
const rand = (a, b) => a + Math.random() * (b - a);
const pad = n => String(n).padStart(2, '0');

// ---- Shared state (declared early to avoid temporal dead zone) ----
let speaking = false;
let voiceOn = true;
let voiceActive = false; // mic pipeline up → wake word gates activation
let boost = 0;
let audioCtx = null;
let analyser = null;
let audioFreqData = null;
let audioTimeData = null;
let audioAmplitude = 0;

// ---- Window controls (frameless) ----
document.getElementById('btn-min').addEventListener('click', () => window.jarvis.windowMinimize());
document.getElementById('btn-max').addEventListener('click', () => window.jarvis.windowMaximize());
document.getElementById('btn-close').addEventListener('click', () => window.jarvis.windowClose());

// ---- Clock + uptime ----
const startTime = Date.now();
function tick() {
  const d = new Date();
  document.getElementById('clock').textContent =
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  document.getElementById('date').textContent = d.toDateString().toUpperCase();
  const up = Math.floor((Date.now() - startTime) / 1000);
  document.getElementById('uptime').textContent = `UP ${pad(Math.floor(up / 60))}:${pad(up % 60)}`;
}
setInterval(tick, 1000);
tick();

// ---- Vitals (real system telemetry from main process) ----

function setVital(key, text, barPct) {
  const label = document.querySelector(`[data-v="${key}"]`);
  const bar = document.querySelector(`[data-bar="${key}"] i`);
  if (label) label.textContent = text;
  if (bar) bar.style.width = Math.max(2, Math.min(100, barPct)) + '%';
}

// Disk drives are dynamic (one row per fixed drive). Build rows once, then update
// values/bars in place so the bar transitions stay smooth.
const diskRows = {};
function renderDisks(disks) {
  const cont = document.getElementById('disk-vitals');
  if (!cont) return;
  const sig = disks.map(d => d.name).join(',');
  if (cont.dataset.sig !== sig) {
    cont.innerHTML = '';
    for (const k of Object.keys(diskRows)) delete diskRows[k];
    for (const d of disks) {
      const el = document.createElement('div');
      el.className = 'vital';
      el.innerHTML =
        `<div class="row"><span>DISK ${d.name}</span><span class="v"></span></div>` +
        `<div class="bar"><i style="width:0"></i></div>`;
      cont.appendChild(el);
      diskRows[d.name] = { val: el.querySelector('.v'), barWrap: el.querySelector('.bar'), bar: el.querySelector('.bar i') };
    }
    cont.dataset.sig = sig;
  }
  for (const d of disks) {
    const r = diskRows[d.name];
    if (!r) continue;
    r.val.textContent = `${d.usedGb} / ${d.totalGb} GB`;
    r.bar.style.width = Math.max(2, Math.min(100, d.pct)) + '%';
    r.barWrap.classList.toggle('warn', d.pct > 90);
  }
}

window.jarvis.onTelemetry((d) => {
  const cpuPct = Math.round(d.cpu);
  setVital('cpu', cpuPct + ' %', cpuPct + (boost > 0 ? boost * 0.4 : 0));
  // Warn colour when CPU > 80%
  const cpuBar = document.querySelector('[data-bar="cpu"]');
  if (cpuBar) cpuBar.classList.toggle('warn', cpuPct > 80);

  const memPct = Math.round(d.mem);
  setVital('mem', memPct + ' %', memPct);

  const used = d.memUsedGb.toFixed(1);
  const total = d.memTotalGb.toFixed(1);
  setVital('memdetail', `${used} / ${total} GB`, d.mem);

  setVital('cores', d.cores + ' THREADS', Math.min(100, d.cores * 6.25));

  const hrs = Math.floor(d.uptime);
  const mins = Math.round((d.uptime - hrs) * 60);
  setVital('sysup', `${hrs}h ${pad(mins)}m`, Math.min(100, d.uptime * 0.5));

  if (d.disks) renderDisks(d.disks);

  // Update the uptime display in the header too
  document.getElementById('uptime').textContent = `UP ${hrs}h ${pad(mins)}m`;

  // Update reactor readouts
  const rCpu = document.getElementById('r-cpu');
  const rMem = document.getElementById('r-mem');
  const rSys = document.getElementById('r-sys');
  const oCores = document.getElementById('o-cores');
  const oHost = document.getElementById('o-host');
  const oOs = document.getElementById('o-os');
  if (rCpu) rCpu.textContent = cpuPct + '%';
  if (rMem) rMem.textContent = memPct + '%';
  if (rSys) rSys.textContent = cpuPct > 90 ? 'HIGH LOAD' : cpuPct > 70 ? 'ELEVATED' : 'NOMINAL';
  if (oCores) oCores.textContent = d.cores;
  if (oHost && d.platform) oHost.textContent = d.platform.toUpperCase();
  if (oOs && d.platform) oOs.textContent = d.platform === 'Windows' ? 'WIN 11' : 'macOS';

  // Pulse reactor energy based on CPU load
  if (typeof targetEnergy !== 'undefined') {
    const coreEl = document.getElementById('coreState');
    if (coreEl && coreEl.textContent === 'ONLINE') {
      targetEnergy = 0.4 + (cpuPct / 100) * 0.5;
    }
  }

  if (boost > 0) boost = Math.max(0, boost - 2);
});

// ---- Transcript log ----
const logEl = document.getElementById('log');
const LOG_MAX = 200;
// Only auto-scroll if the user is already near the bottom (so they can scroll
// up to read history without being yanked back down).
function logAtBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
}
function logScroll(stick) {
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}
function logLine(who, text, cls) {
  const stick = logAtBottom();
  const t = new Date();
  const stamp = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  const div = document.createElement('div');
  div.className = 'ln' + (cls ? (' ' + cls) : '');
  div.innerHTML = `<b>${stamp}</b> ${who} \u2014 <em>${text.replace(/</g, '&lt;')}</em>`;
  logEl.appendChild(div);
  while (logEl.children.length > LOG_MAX) logEl.removeChild(logEl.firstChild);
  logScroll(stick);
}

// ---- Network nodes ----
const netNodesEl = document.getElementById('net-nodes');
const nodeCountEl = document.getElementById('nodecount');

window.jarvis.onNetworkDevices((devices) => {
  if (!netNodesEl) return;
  netNodesEl.innerHTML = '';
  if (nodeCountEl) nodeCountEl.textContent = devices.length;

  devices.forEach(d => {
    const el = document.createElement('div');
    el.className = 'net-node ' + (d.type || 'device');
    const icon = d.type === 'computer' ? '\u25A3' : '\u25C6'; // filled square or diamond
    const ipText = d.ip && d.ip !== d.name ? ` <span class="node-ip">${d.ip}</span>` : '';
    el.innerHTML = `<span class="node-icon">${icon}</span><span class="node-name">${d.name}</span>${ipText}`;
    el.title = `${d.name}${d.ip ? ' (' + d.ip + ')' : ''}${d.mac ? ' [' + d.mac + ']' : ''}`;
    netNodesEl.appendChild(el);
  });
});

// ---- Desktop icons ----
const dskIconsEl = document.getElementById('desktop-icons');
const appCountEl = document.getElementById('appcount');

window.jarvis.onDesktopItems((items) => {
  if (!dskIconsEl) return;
  dskIconsEl.innerHTML = '';
  if (appCountEl) appCountEl.textContent = items.length;

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'dsk-icon ' + (item.type || 'file');

    let glyph;
    switch (item.type) {
      case 'folder':   glyph = '\u25A1'; break; // hollow square
      case 'shortcut': glyph = '\u25C8'; break; // target dot
      case 'url':      glyph = '\u25CE'; break; // bullseye
      case 'app':      glyph = '\u25A3'; break; // filled square
      default:         glyph = '\u25C7'; break; // diamond
    }

    el.innerHTML = `<span class="di-glyph">${glyph}</span><span>${item.name}</span>`;
    el.title = item.path;
    el.addEventListener('click', () => window.jarvis.launchDesktopItem(item.path));
    dskIconsEl.appendChild(el);
  });
});

// ---- Wallpaper / windowed mode ----
window.jarvis.onMode((mode) => {
  document.body.classList.toggle('wallpaper-mode', mode === 'wallpaper');
});

// ---- Iron Man Arc Reactor (canvas) ----
const rc = document.getElementById('reactor');
const rx = rc.getContext('2d');
const N = 520, CX = N / 2, CY = N / 2;
let energy = 0.5, targetEnergy = 0.5, t = 0;

const particles = [];
for (let i = 0; i < 180; i++) {
  particles.push({
    ang: Math.random() * Math.PI * 2,
    base: rand(35, 145),
    sp: rand(.002, .008) * (Math.random() < .5 ? -1 : 1),
    sz: rand(.5, 2.0),
  });
}

function ring(r, seg, rot, col, w) {
  rx.strokeStyle = col;
  rx.lineWidth = w;
  const gap = Math.PI * 2 / seg;
  for (let i = 0; i < seg; i++) {
    const a = rot + i * gap;
    rx.beginPath();
    rx.arc(CX, CY, r, a, a + gap * 0.62);
    rx.stroke();
  }
}

function drawReactor() {
  rx.clearRect(0, 0, N, N);
  energy += (targetEnergy - energy) * 0.05;
  // Voice-reactive: when Jarvis speaks, amplitude drives the reactor intensity
  const voiceBoost = speaking ? audioAmplitude * 3.0 : 0;
  const effectiveEnergy = Math.min(1.2, energy + voiceBoost);
  const pulse = reduce ? 0.5 : (0.5 + 0.5 * Math.sin(t * 0.05)) * effectiveEnergy;

  // Outer chest plate ring — dark metallic red
  rx.strokeStyle = 'rgba(139,26,26,0.3)';
  rx.lineWidth = 18;
  rx.beginPath();
  rx.arc(CX, CY, 240, 0, Math.PI * 2);
  rx.stroke();

  // Outer gold segmented ring
  ring(232, 48, t * 0.002, 'rgba(212,175,55,0.3)', 1.4);

  // Red accent ring
  ring(215, 3, -t * 0.005, `rgba(192,57,43,${0.4 + pulse * 0.3})`, 2.5);

  // Gold segmented ring
  ring(195, 32, t * 0.008, 'rgba(212,175,55,0.45)', 1.2);

  // Inner red ring — pulses with energy
  rx.strokeStyle = `rgba(231,76,60,${0.3 + pulse * 0.4})`;
  rx.lineWidth = 3;
  rx.beginPath();
  rx.arc(CX, CY, 170, 0, Math.PI * 2);
  rx.stroke();

  // Thick gold structural ring
  ring(155, 2, -t * 0.01, 'rgba(212,175,55,0.6)', 2.8);

  // Inner structural ring — bright gold
  rx.strokeStyle = `rgba(212,175,55,${0.2 + pulse * 0.3})`;
  rx.lineWidth = 2;
  rx.beginPath();
  rx.arc(CX, CY, 130, 0, Math.PI * 2);
  rx.stroke();

  // Tick marks — gold
  rx.strokeStyle = 'rgba(212,175,55,0.2)';
  rx.lineWidth = 1;
  for (let i = 0; i < 72; i++) {
    const a = i * (Math.PI / 36) + t * 0.001;
    const r1 = 235, r2 = i % 6 === 0 ? 248 : 242;
    rx.beginPath();
    rx.moveTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1);
    rx.lineTo(CX + Math.cos(a) * r2, CY + Math.sin(a) * r2);
    rx.stroke();
  }

  // Energy particles — mix of gold and red
  particles.forEach(p => {
    if (!reduce) p.ang += p.sp;
    const r = p.base + Math.sin(t * 0.04 + p.base) * 6 * energy;
    const x = CX + Math.cos(p.ang) * r;
    const y = CY + Math.sin(p.ang) * r;
    const isRed = p.base < 80;
    if (isRed) {
      rx.fillStyle = `rgba(231,76,60,${0.3 + 0.5 * pulse})`;
    } else {
      rx.fillStyle = `rgba(245,200,80,${0.3 + 0.5 * pulse})`;
    }
    rx.beginPath();
    rx.arc(x, y, p.sz, 0, Math.PI * 2);
    rx.fill();
  });

  // Arc reactor core — white-gold centre glow, expands with voice
  const cr = 65 + pulse * 30 + voiceBoost * 25;
  const g = rx.createRadialGradient(CX, CY, 0, CX, CY, cr);
  g.addColorStop(0, 'rgba(255,255,240,0.95)');
  g.addColorStop(0.15, 'rgba(255,235,180,0.85)');
  g.addColorStop(0.35, 'rgba(212,175,55,0.6)');
  g.addColorStop(0.6, 'rgba(192,57,43,0.3)');
  g.addColorStop(1, 'rgba(139,26,26,0)');
  rx.fillStyle = g;
  rx.beginPath();
  rx.arc(CX, CY, cr, 0, Math.PI * 2);
  rx.fill();

  // Centre triangle — Iron Man signature
  rx.save();
  rx.translate(CX, CY);
  rx.rotate(t * 0.008);
  rx.strokeStyle = `rgba(255,235,180,${0.6 + pulse * 0.3})`;
  rx.lineWidth = 2.5;
  rx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = i * (Math.PI * 2 / 3);
    rx.lineTo(Math.cos(a) * 32, Math.sin(a) * 32);
  }
  rx.closePath();
  rx.stroke();

  // Inner inverted triangle
  rx.strokeStyle = `rgba(212,175,55,${0.4 + pulse * 0.2})`;
  rx.lineWidth = 1.5;
  rx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = i * (Math.PI * 2 / 3) + Math.PI / 3;
    rx.lineTo(Math.cos(a) * 20, Math.sin(a) * 20);
  }
  rx.closePath();
  rx.stroke();
  rx.restore();

  if (!reduce) t++;
  requestAnimationFrame(drawReactor);
}
drawReactor();

// ---- Radar (canvas) ----
const rad = document.getElementById('radar');
const rdx = rad.getContext('2d');
const RR = 110;
let sweep = 0;
const blips = [];
for (let i = 0; i < 6; i++) {
  blips.push({ a: Math.random() * Math.PI * 2, r: rand(20, 95), life: 0 });
}

function drawRadar() {
  rdx.clearRect(0, 0, 220, 220);
  rdx.strokeStyle = 'rgba(212,175,55,0.25)';
  rdx.lineWidth = 1;
  [30, 60, 90].forEach(r => {
    rdx.beginPath();
    rdx.arc(RR, RR, r, 0, Math.PI * 2);
    rdx.stroke();
  });
  rdx.beginPath();
  rdx.moveTo(RR, 15); rdx.lineTo(RR, 205);
  rdx.moveTo(15, RR); rdx.lineTo(205, RR);
  rdx.stroke();

  if (!reduce) sweep += 0.03;
  rdx.save();
  rdx.translate(RR, RR);
  rdx.rotate(sweep);
  const grad = rdx.createLinearGradient(0, 0, 90, 0);
  grad.addColorStop(0, 'rgba(192,57,43,0.5)');
  grad.addColorStop(1, 'rgba(192,57,43,0)');
  rdx.fillStyle = grad;
  rdx.beginPath();
  rdx.moveTo(0, 0);
  rdx.arc(0, 0, 90, -0.5, 0);
  rdx.closePath();
  rdx.fill();
  rdx.restore();

  blips.forEach(b => {
    const x = RR + Math.cos(b.a) * b.r;
    const y = RR + Math.sin(b.a) * b.r;
    const diff = Math.abs(((sweep % (Math.PI * 2)) - ((b.a + Math.PI * 2) % (Math.PI * 2))));
    if (diff < 0.12) b.life = 1;
    b.life = Math.max(0, b.life - 0.012);
    rdx.fillStyle = `rgba(231,76,60,${0.2 + b.life * 0.8})`;
    rdx.beginPath();
    rdx.arc(x, y, 2.4 + b.life * 2, 0, Math.PI * 2);
    rdx.fill();
  });

  requestAnimationFrame(drawRadar);
}
drawRadar();

// ---- Waveform (canvas) ----
const wv = document.getElementById('wave');
const wx = wv.getContext('2d');
function sizeWave() {
  wv.width = wv.clientWidth;
  wv.height = wv.clientHeight;
}
sizeWave();
window.addEventListener('resize', sizeWave);

let wt = 0, waveAmp = 1;

function drawWave() {
  wx.clearRect(0, 0, wv.width, wv.height);
  const h = wv.height, w = wv.width, mid = h / 2;

  if (speaking && audioFreqData && audioAmplitude > 0.01) {
    // Real audio waveform from voice — draw frequency bars as a flowing line
    wx.strokeStyle = 'rgba(212,175,55,0.9)';
    wx.lineWidth = 2;
    wx.shadowColor = 'rgba(231,76,60,0.6)';
    wx.shadowBlur = 8;
    wx.beginPath();

    const bins = audioFreqData.length;
    for (let x = 0; x <= w; x += 2) {
      const i = Math.floor((x / w) * bins * 0.7); // use lower 70% of spectrum
      const val = (audioFreqData[i] || 0) / 255;
      const y = mid - val * mid * 0.85 * Math.sin(x * 0.02 + wt)
                    + Math.sin(x * 0.08 + wt * 2) * val * mid * 0.3;
      x === 0 ? wx.moveTo(x, y) : wx.lineTo(x, y);
    }
    wx.stroke();

    // Second line (mirror) for depth — red accent
    wx.strokeStyle = 'rgba(192,57,43,0.4)';
    wx.lineWidth = 1;
    wx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const i = Math.floor((x / w) * bins * 0.7);
      const val = (audioFreqData[i] || 0) / 255;
      const y = mid + val * mid * 0.7 * Math.sin(x * 0.02 + wt * 1.1);
      x === 0 ? wx.moveTo(x, y) : wx.lineTo(x, y);
    }
    wx.stroke();
    wx.shadowBlur = 0;
  } else {
    // Idle ambient wave
    wx.strokeStyle = 'rgba(212,175,55,0.5)';
    wx.lineWidth = 1.2;
    wx.shadowColor = 'rgba(212,175,55,0.3)';
    wx.shadowBlur = 4;
    wx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const y = mid
        + Math.sin(x * 0.06 + wt) * mid * 0.15
        + Math.sin(x * 0.13 - wt * 1.4) * mid * 0.08;
      x === 0 ? wx.moveTo(x, y) : wx.lineTo(x, y);
    }
    wx.stroke();
    wx.shadowBlur = 0;
  }

  if (!reduce) wt += 0.08;
  requestAnimationFrame(drawWave);
}
drawWave();

// ---- HUD state + visual triggers ----
const coreState = document.getElementById('coreState');

function setCore(state, e, hold = 2600) {
  coreState.textContent = state;
  targetEnergy = e;
  if (hold) {
    setTimeout(() => {
      coreState.textContent = 'ONLINE';
      targetEnergy = 0.55;
    }, hold);
  }
}

function localTriggers(c) {
  c = c.toLowerCase();
  if (/diagnost/.test(c)) { setCore('SCANNING', 0.9); }
  else if (/scan|perimeter|proximit|contact/.test(c)) {
    setCore('SCANNING', 1);
    blips.forEach(b => { b.a = Math.random() * Math.PI * 2; b.r = rand(20, 95); });
  }
  else if (/boost|power|overdrive/.test(c)) { boost = 22; setCore('OVERDRIVE', 1); }
  else if (/status|report/.test(c)) { setCore('PROCESSING', 0.8); }
  else if (/shut ?down|sleep|standby|goodnight/.test(c)) { setCore('STANDBY', 0.2); }
  else { setCore('PROCESSING', 0.85); }
}

// ---- Typewriter for Jarvis replies ----
function typeReply(text) {
  const t = new Date();
  const stamp = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  const div = document.createElement('div');
  const stick = logAtBottom();
  div.className = 'ln jarvis';
  div.innerHTML = `<b>${stamp}</b> J.A.R.V.I.S. \u2014 <em></em>`;
  logEl.appendChild(div);
  while (logEl.children.length > LOG_MAX) logEl.removeChild(logEl.firstChild);
  logScroll(stick);
  const em = div.querySelector('em');
  let i = 0;
  (function step() {
    if (i <= text.length) {
      em.textContent = text.slice(0, i);
      i += 2;
      logScroll(stick);
      setTimeout(step, reduce ? 0 : 16);
    }
  })();
}

// ---- Fallback replies (used when brain is offline) ----
function fallbackReply(c) {
  c = c.toLowerCase();
  if (/diagnost/.test(c)) return 'Diagnostic sweep complete, sir. All subsystems within tolerance.';
  if (/scan|perimeter|contact/.test(c)) return 'Perimeter scan finished. No hostile contacts detected.';
  if (/boost|power/.test(c)) return 'Diverting auxiliary power to the core. Output is climbing nicely.';
  if (/status|report/.test(c)) return 'All systems nominal. Running well within tolerance.';
  if (/hello|hi|hey|jarvis/.test(c)) return 'At your service, sir. What are we building today?';
  return 'Understood, sir. Standing by for further instructions.';
}

// ---- TTS with real-time audio analysis ----
let currentAudio = null;

// Initialise Web Audio API context (once)
function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    audioFreqData = new Uint8Array(analyser.frequencyBinCount);
    audioTimeData = new Uint8Array(analyser.fftSize);
    analyser.connect(audioCtx.destination);
  }
}

// Main process sends file path to MP3 audio for playback
window.jarvis.onTtsPlay((filePath) => {
  if (!filePath || !voiceOn) {
    speaking = false;
    window.jarvis.ttsEnded();
    return;
  }
  playAudio(filePath);
});

function playAudio(filePath) {
  stopAudio();
  ensureAudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  currentAudio = new Audio('file:///' + filePath.replace(/\\/g, '/'));
  currentAudio.crossOrigin = 'anonymous';

  // Connect to analyser for real-time voice data
  const source = audioCtx.createMediaElementSource(currentAudio);
  source.connect(analyser);
  currentAudio._source = source; // hold reference to prevent GC

  currentAudio.onplay = () => { speaking = true; };
  currentAudio.onended = () => {
    speaking = false;
    audioAmplitude = 0;
    currentAudio = null;
    window.jarvis.ttsEnded();
  };
  currentAudio.onerror = () => {
    speaking = false;
    audioAmplitude = 0;
    currentAudio = null;
    window.jarvis.ttsEnded();
  };
  currentAudio.play().catch(() => {
    speaking = false;
    audioAmplitude = 0;
    currentAudio = null;
    window.jarvis.ttsEnded();
  });
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
    speaking = false;
    audioAmplitude = 0;
  }
}

// Update audio amplitude from analyser — called every frame
function updateAudioAnalysis() {
  if (speaking && analyser) {
    analyser.getByteTimeDomainData(audioTimeData);
    analyser.getByteFrequencyData(audioFreqData);

    // Calculate RMS amplitude from time domain
    let sum = 0;
    for (let i = 0; i < audioTimeData.length; i++) {
      const v = (audioTimeData[i] - 128) / 128;
      sum += v * v;
    }
    audioAmplitude = Math.sqrt(sum / audioTimeData.length);
  } else {
    audioAmplitude *= 0.9; // decay smoothly
  }
  requestAnimationFrame(updateAudioAnalysis);
}
updateAudioAnalysis();


// ---- Command execution ----
const cmdEl = document.getElementById('cmd');
const cmdline = document.getElementById('cmdline');
let busy = false;

function execute(raw) {
  const text = (raw || '').trim();
  if (!text) return;
  cmdline.classList.add('busy');
  cmdEl.value = '';
  logLine('OPERATOR', '"' + text + '"');
  localTriggers(text);
  window.jarvis.submitCommand(text);
}

// ---- IPC listeners from main process ----
window.jarvis.onBrainStatus((ready) => {
  if (!ready) {
    logLine('SYSTEM', 'No API key detected. Running in offline mode.', '');
  }
});

window.jarvis.onTranscriptUser((text) => {
  // Voice-triggered transcripts get logged here (text commands already logged by execute)
});

window.jarvis.onTranscriptJarvis((text) => {
  // Show the reply in the transcript with typewriter effect
  typeReply(text);
});

window.jarvis.onState((state) => {
  const micBtn = document.getElementById('mic');
  if (state === 'thinking') {
    coreState.textContent = 'THINKING';
    targetEnergy = 0.95;
    micBtn.classList.remove('listening');
    busy = true;
    cmdline.classList.add('busy');
  } else if (state === 'speaking') {
    coreState.textContent = 'SPEAKING';
    targetEnergy = 0.7;
    micBtn.classList.remove('listening');
  } else if (state === 'listening') {
    coreState.textContent = 'LISTENING';
    targetEnergy = 0.8;
    micBtn.classList.add('listening');
    cmdEl.value = '';
    cmdEl.placeholder = 'Listening\u2026';
  } else if (state === 'idle') {
    // Back to dormant \u2014 wake word required to activate again.
    coreState.textContent = voiceActive ? 'DORMANT' : 'ONLINE';
    targetEnergy = voiceActive ? 0.4 : 0.55;
    micBtn.classList.remove('listening');
    cmdEl.value = '';
    cmdEl.placeholder = voiceActive
      ? 'Say "Hey J.A.R.V.I.S." to wake me \u2014 or type here'
      : 'Speak or type \u2014 ask J.A.R.V.I.S. anything';
    busy = false;
    cmdline.classList.remove('busy');
  }
});

window.jarvis.onActionRan((info) => {
  logLine('SYSTEM', `Action: ${info.tool} \u2192 ${info.result}`, '');
});

window.jarvis.onTranscriptPartial((text) => {
  // Show live partial transcript while user is speaking
  cmdEl.value = text;
});

window.jarvis.onVoiceStatus((status) => {
  const micBtn = document.getElementById('mic');
  if (status === 'active') {
    voiceActive = true;
    micBtn.title = 'Mic active \u2014 say "Hey Jarvis" to wake';
    if (!busy && coreState.textContent === 'ONLINE') {
      coreState.textContent = 'DORMANT';
      cmdEl.placeholder = 'Say "Hey J.A.R.V.I.S." to wake me \u2014 or type here';
    }
  } else {
    voiceActive = false;
    micBtn.title = 'Voice pipeline unavailable';
  }
});

window.jarvis.onVoiceMuted((muted) => {
  const micBtn = document.getElementById('mic');
  micBtn.classList.toggle('muted', muted);
  micBtn.textContent = muted ? 'MIC OFF' : 'MIC';
});

// Right-click context menu on command input
cmdEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.jarvis.showInputMenu();
});

// Use document-level keydown to guarantee capture regardless of focus
document.addEventListener('keydown', e => {
  if (e.target === cmdEl && e.key === 'Enter') {
    console.log('[hud] ENTER pressed, value:', cmdEl.value);
    execute(cmdEl.value);
  }
});

document.getElementById('send').addEventListener('click', () => {
  console.log('[hud] SEND clicked, value:', cmdEl.value);
  execute(cmdEl.value);
});

// Focus input when clicking anywhere in the cmdline area
cmdline.addEventListener('click', () => cmdEl.focus());

console.log('[hud] All listeners attached');
document.querySelectorAll('.quick button').forEach(b =>
  b.addEventListener('click', () => execute(b.dataset.cmd))
);

// Mic button toggles mute
document.getElementById('mic').addEventListener('click', () => {
  window.jarvis.micToggle();
});

// ---- Voice toggle ----
const voiceBtn = document.getElementById('voiceBtn');
voiceBtn.addEventListener('click', () => {
  voiceOn = !voiceOn;
  voiceBtn.classList.toggle('on', voiceOn);
  voiceBtn.textContent = voiceOn ? 'VOICE ON' : 'VOICE OFF';
  if (!voiceOn) stopAudio();
});

// ---- First-run setup overlay ----
window.jarvis.onFirstRun((info) => {
  const overlay = document.getElementById('first-run');
  const envPath = document.getElementById('fr-env-path');
  if (overlay) overlay.style.display = 'flex';
  if (envPath && info.envPath) envPath.textContent = info.envPath;
});
document.getElementById('fr-dismiss').addEventListener('click', () => {
  document.getElementById('first-run').style.display = 'none';
});

// ---- Boot sequence ----
setTimeout(() => {
  coreState.textContent = 'ONLINE';
  targetEnergy = 0.55;
  const hi = 'Systems online, sir. All subsystems nominal \u2014 standing by for your command.';
  typeReply(hi);
}, 900);
