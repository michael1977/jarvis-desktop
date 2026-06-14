/**
 * Network discovery: find other computers on the local Windows network.
 * Returns hostnames and IPs of discovered devices.
 */

const { execFile } = require('child_process');
const os = require('os');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

/**
 * Discover network devices using multiple methods.
 * Returns array of { name, ip, type } objects.
 */
async function discover() {
  const devices = new Map(); // keyed by IP to deduplicate
  const thisHost = os.hostname().toUpperCase();

  // Method 1: ARP table — fast, shows all recently-contacted hosts
  try {
    const arp = await run('arp', ['-a']);
    for (const line of arp.split('\n')) {
      const match = line.match(/^\s+([\d.]+)\s+([\w-]+)/);
      if (match && !match[1].endsWith('.255') && match[1] !== '255.255.255.255') {
        const ip = match[1];
        const mac = match[2];
        if (mac !== 'ff-ff-ff-ff-ff-ff' && !devices.has(ip)) {
          devices.set(ip, { name: ip, ip, type: 'device', mac });
        }
      }
    }
  } catch (_) {}

  // Method 2: net view — finds SMB-visible computers
  try {
    const nv = await run('net', ['view']);
    for (const line of nv.split('\n')) {
      const match = line.match(/^\\\\(\S+)/);
      if (match) {
        const name = match[1].toUpperCase();
        if (name !== thisHost) {
          // Try to resolve IP
          const existing = [...devices.values()].find(d => d.name === name);
          if (existing) {
            existing.type = 'computer';
          } else {
            devices.set(name, { name, ip: '', type: 'computer' });
          }
        }
      }
    }
  } catch (_) {}

  // Method 3: PowerShell DNS/NetBIOS resolution for ARP entries
  if (process.platform === 'win32') {
    try {
      const ps = await run('powershell', ['-NoProfile', '-Command',
        `Get-NetNeighbor -State Reachable -AddressFamily IPv4 | ` +
        `Select-Object IPAddress, LinkLayerAddress | ConvertTo-Json`
      ]);
      const entries = JSON.parse(ps);
      const list = Array.isArray(entries) ? entries : [entries];
      for (const e of list) {
        if (e.IPAddress && !devices.has(e.IPAddress)) {
          devices.set(e.IPAddress, {
            name: e.IPAddress,
            ip: e.IPAddress,
            type: 'device',
            mac: e.LinkLayerAddress,
          });
        }
      }
    } catch (_) {}
  }

  // Try to resolve hostnames for IP-only entries
  const results = [...devices.values()].filter(d => d.name !== thisHost);

  // Attempt reverse DNS for IPs without names
  for (const d of results) {
    if (d.name === d.ip && d.ip) {
      try {
        const ns = await run('powershell', ['-NoProfile', '-Command',
          `(Resolve-DnsName '${d.ip}' -ErrorAction SilentlyContinue | Select-Object -First 1).NameHost`
        ]);
        const resolved = ns.trim();
        if (resolved && resolved !== d.ip) {
          d.name = resolved.split('.')[0].toUpperCase();
          d.type = 'computer';
        }
      } catch (_) {}
    }
  }

  return results.slice(0, 20); // cap at 20 devices
}

module.exports = { discover };
