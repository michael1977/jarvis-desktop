const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  // Window controls (frameless)
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose:    () => ipcRenderer.send('window:close'),

  // Listen for state events from main process
  onState:            (cb) => ipcRenderer.on('state',             (_e, s) => cb(s)),
  onTranscriptUser:   (cb) => ipcRenderer.on('transcript:user',   (_e, t) => cb(t)),
  onTranscriptJarvis: (cb) => ipcRenderer.on('transcript:jarvis', (_e, t) => cb(t)),
  onTranscriptPartial:(cb) => ipcRenderer.on('transcript:partial',(_e, t) => cb(t)),
  onActionRan:        (cb) => ipcRenderer.on('action:ran',        (_e, a) => cb(a)),
  onTelemetry:        (cb) => ipcRenderer.on('telemetry',         (_e, d) => cb(d)),
  onBrainStatus:      (cb) => ipcRenderer.on('brain:status',      (_e, s) => cb(s)),
  onVoiceStatus:      (cb) => ipcRenderer.on('voice:status',      (_e, s) => cb(s)),
  onVoiceMuted:       (cb) => ipcRenderer.on('voice:muted',       (_e, m) => cb(m)),
  onTtsPlay:          (cb) => ipcRenderer.on('tts:play',          (_e, b) => cb(b)),
  onFirstRun:         (cb) => ipcRenderer.on('first-run',         (_e, d) => cb(d)),
  onMode:             (cb) => ipcRenderer.on('mode',              (_e, m) => cb(m)),
  onNetworkDevices:   (cb) => ipcRenderer.on('network:devices',   (_e, d) => cb(d)),
  onDesktopItems:     (cb) => ipcRenderer.on('desktop:items',     (_e, d) => cb(d)),
  launchDesktopItem:  (p)  => ipcRenderer.send('desktop:launch', p),
  onUpdateStatus:     (cb) => ipcRenderer.on('update:status',     (_e, s) => cb(s)),
  installUpdate:      ()   => ipcRenderer.send('update:install'),

  // Send commands / signals to main
  submitCommand: (text) => ipcRenderer.send('cmd:submit', text),
  showInputMenu: ()     => ipcRenderer.send('show:input-menu'),
  ttsEnded:      ()     => ipcRenderer.send('tts:ended'),
  micToggle:     ()     => ipcRenderer.send('mic:toggle'),
});
