/**
 * SafeDrop Desktop Hub - Lightweight Embedded Hub Server
 * 100% native Node.js, zero external dependencies, rapid startup.
 * Features UDP beacon device discovery, chunked streaming transfer (4MB chunks) with
 * optional gzip, and pairing via a rotating PIN / one-time token.
 * Note: transfer payloads are currently unencrypted - the X25519 key pair is used for
 * the device fingerprint and handshake identity only, not for payload encryption.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const https = require('https');
const cryptoProtocol = require('./crypto_protocol');
const tlsSelfSigned = require('./tls_selfsigned');
const lanGuard = require('./lan_guard');

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8899;
const UDP_PORT = 8890;
// Single source of truth for the reported version, kept in step with tauri-app/package.json
// and the Android versionName so the three platforms cannot drift apart.
const APP_VERSION = '1.3.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = process.env.SAFEDROP_CONFIG
  ? path.resolve(process.env.SAFEDROP_CONFIG)
  : path.join(__dirname, 'config.json');
const TEMP_DIR = path.join(__dirname, 'temp_transfers');
const PROGRESS_FILE = path.join(TEMP_DIR, 'progress.json');

/**
 * Browsers only expose WebCrypto in a secure context, and plain http:// on a LAN address is
 * not one. The portal therefore needs HTTPS, otherwise the browser cannot encrypt uploads
 * at all. Set SAFEDROP_TLS=off to skip the listener, in which case the portal shows a
 * warning and falls back to plaintext transport rather than failing outright.
 */
const TLS_ENABLED = process.env.SAFEDROP_TLS !== 'off';
const TLS_PORT = process.env.TLS_PORT ? parseInt(process.env.TLS_PORT) : PORT + 1;

// Discover all valid local IPv4 LAN addresses, filtering virtual / TUN adapters
function getAllLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase();
    if (lower.includes('clash') || lower.includes('tap') || lower.includes('tun') || lower.includes('virtual') || lower.includes('vethernet')) {
      continue;
    }
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254') && !iface.address.startsWith('198.18.')) {
        ips.push({ name, ip: iface.address });
      }
    }
  }
  return ips;
}

// Discover all active subnet broadcast addresses (e.g. 192.168.1.255)
function getSubnetBroadcastIps() {
  const interfaces = os.networkInterfaces();
  const bcasts = [];
  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase();
    if (lower.includes('clash') || lower.includes('tap') || lower.includes('tun') || lower.includes('virtual') || lower.includes('vethernet')) {
      continue;
    }
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254') && !iface.address.startsWith('198.18.')) {
        if (iface.address && iface.netmask) {
          try {
            const ipParts = iface.address.split('.').map(Number);
            const maskParts = iface.netmask.split('.').map(Number);
            const bcast = ipParts.map((p, i) => (p | (~maskParts[i] & 255))).join('.');
            if (!bcasts.includes(bcast)) bcasts.push(bcast);
          } catch (_) {}
        }
      }
    }
  }
  return bcasts;
}

// Discover primary local IPv4 address with priority for Wi-Fi/Ethernet LAN subnets
function getLocalIp() {
  const all = getAllLocalIps();
  // 1. Prioritize 192.168.x.x or 10.x.x.x
  const lan = all.find(i => i.ip.startsWith('192.168.') || i.ip.startsWith('10.'));
  if (lan) return lan.ip;
  // 2. Subnet 172.16-31
  const subnet172 = all.find(i => i.ip.startsWith('172.'));
  if (subnet172) return subnet172.ip;
  // 3. Fallback to any non-internal IP or localhost
  return all.length > 0 ? all[0].ip : '127.0.0.1';
}

let LOCAL_IP = getLocalIp();

// Ensure safe download vault directory exists (supports persistent config)
let DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'SafeDrop');
// Device custom names storage (fingerprint -> custom name mapping)
let DEVICE_NAMES = {};

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.downloadDir && typeof cfg.downloadDir === 'string') {
      DOWNLOAD_DIR = path.resolve(cfg.downloadDir);
    }
    if (cfg.deviceNames && typeof cfg.deviceNames === 'object') {
      DEVICE_NAMES = cfg.deviceNames;
    }
  }
} catch (_) {}

// A configured vault path can be stale (moved, on a removed drive, or carried over from
// another machine). Creating it must not abort startup: fall back to the default location.
if (!fs.existsSync(DOWNLOAD_DIR)) {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  } catch (err) {
    const fallback = path.join(os.homedir(), 'Downloads', 'SafeDrop');
    console.warn(`[SafeDrop] Cannot use vault directory "${DOWNLOAD_DIR}" (${err.message}); falling back to ${fallback}`);
    DOWNLOAD_DIR = fallback;
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
}

// Save device custom names to config file
function saveDeviceNames() {
  try {
    const existingConfig = fs.existsSync(CONFIG_FILE) 
      ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) 
      : {};
    existingConfig.deviceNames = DEVICE_NAMES;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(existingConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save device names:', err);
  }
}

// SSRF validation for relay targets: RFC1918 ranges, a destination on one of this machine's
// own subnets, or an explicitly allowlisted address. See lan_guard.js for the reasoning.
function isPrivateLanIp(ip) {
  return lanGuard.isAllowedRelayTarget(ip);
}

// Path traversal and Windows reserved filename defense filter
function sanitizeFileName(inputName) {
  if (typeof inputName !== 'string') return `file_${Date.now()}`;
  // Strip null bytes and control characters
  let safe = inputName.replace(/[\x00-\x1f\x7f]/g, '');
  safe = path.basename(safe);
  // Replace illegal Windows characters: \ / : * ? " < > |
  safe = safe.replace(/[\\/:*?"<>|]/g, '_');
  // Strip relative traversal symbols
  safe = safe.replace(/\.\./g, '').trim();
  // Strip trailing dots and spaces (Windows filesystem restriction)
  safe = safe.replace(/[. ]+$/, '');
  
  // Guard against Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const reservedRegex = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
  if (reservedRegex.test(safe)) {
    safe = `safe_${safe}`;
  }

  if (!safe || safe === '.' || safe === '..') {
    safe = `file_${Date.now()}`;
  }
  return safe;
}

// Auto-increment naming to prevent file overwrites
function resolveUniqueFilePath(fileName) {
  const parsed = path.parse(fileName);
  let candidatePath = path.join(DOWNLOAD_DIR, fileName);
  let counter = 1;
  while (fs.existsSync(candidatePath)) {
    const newName = `${parsed.name} (${counter})${parsed.ext}`;
    candidatePath = path.join(DOWNLOAD_DIR, newName);
    counter++;
  }
  return candidatePath;
}

// Generate persistent/session-level X25519 identity keypair
const hostKeyPair = crypto.generateKeyPairSync('x25519');
const hostPubDer = hostKeyPair.publicKey.export({ type: 'spki', format: 'der' });
const hostPubRaw = hostPubDer.subarray(hostPubDer.length - 32); // Extract 32-byte raw public key
const hostFingerprint = crypto.createHash('sha256').update(hostPubRaw).digest('hex').substring(0, 16).toUpperCase();

// Dynamic pairing credentials with 60s transition grace period
let currentOneTimeToken = crypto.randomBytes(6).toString('hex');
let currentPin = String(Math.floor(100000 + Math.random() * 900000));
let prevPin = null;
let prevToken = null;
let prevPinTime = 0;

// Online devices cache with last-seen timestamps
const onlineDevices = new Map();

// Ephemeral E2E sessions created by the handshake. Session keys live in memory only.
const e2eSessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

// Pairing attempts are rate limited per source IP to bound online guessing of the PIN.
const pairingAttempts = new Map();
const PAIRING_MAX_FAILURES = 8;
const PAIRING_WINDOW_MS = 5 * 60 * 1000;
const PAIRING_BLOCK_MS = 5 * 60 * 1000;

const sessionGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of e2eSessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) e2eSessions.delete(id);
  }
  for (const [ip, attempt] of pairingAttempts.entries()) {
    const settled = (!attempt.blockedUntil || now > attempt.blockedUntil);
    if (now - attempt.windowStart > PAIRING_WINDOW_MS && settled) pairingAttempts.delete(ip);
  }
}, 60 * 1000);
if (sessionGcTimer.unref) sessionGcTimer.unref();

/**
 * Only loopback traffic is trusted. A TCP source address cannot be spoofed, so loopback
 * means the request really came from this machine, where the user already has direct
 * access to the vault and the pairing PIN. The desktop UI is served from localhost, so it
 * qualifies; anything arriving over the LAN must complete the encrypted handshake even if
 * it originates from this same host's LAN address.
 */
function isTrustedLocal(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '::ffff:127.0.0.1';
}

function clientIpOf(req) {
  return req.socket.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';
}

/** Look up a verified session, bound to the requesting IP so an id cannot be replayed. */
function getVerifiedSession(req) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || typeof sessionId !== 'string') return null;
  const session = e2eSessions.get(sessionId);
  if (!session || !session.verified || !session.key) return null;
  if (session.clientIp !== clientIpOf(req)) return null;
  session.lastSeen = Date.now();
  return session;
}

/**
 * Guard for endpoints that expose or mutate user data. Returns true when the request may
 * proceed; otherwise it has already written the error response.
 */
function ensureAuthorized(req, res) {
  const ip = clientIpOf(req);
  if (isTrustedLocal(ip)) return true;
  if (getVerifiedSession(req)) return true;
  jsonResponse(res, 401, {
    code: 401,
    error: 'Encrypted session required. Complete the pairing handshake before using this endpoint.'
  });
  return false;
}

function pairingRateLimited(ip) {
  const attempt = pairingAttempts.get(ip);
  if (!attempt) return 0;
  const now = Date.now();
  if (attempt.blockedUntil && now < attempt.blockedUntil) {
    return Math.ceil((attempt.blockedUntil - now) / 1000);
  }
  return 0;
}

function notePairingFailure(ip) {
  const now = Date.now();
  let attempt = pairingAttempts.get(ip);
  if (!attempt || now - attempt.windowStart > PAIRING_WINDOW_MS) {
    attempt = { windowStart: now, failures: 0, blockedUntil: 0 };
  }
  attempt.failures += 1;
  if (attempt.failures >= PAIRING_MAX_FAILURES) {
    attempt.blockedUntil = now + PAIRING_BLOCK_MS;
    attempt.failures = 0;
    attempt.windowStart = now;
  }
  pairingAttempts.set(ip, attempt);
}

function clearPairingFailures(ip) {
  pairingAttempts.delete(ip);
}

// Register host desktop hub device
const hostDevice = {
  id: `pc-${os.hostname().toLowerCase()}`,
  name: `${os.hostname()} (Desktop Hub)`,
  ip: LOCAL_IP,
  port: PORT,
  fingerprint: hostFingerprint,
  os: 'windows',
  isHost: true,
  lastSeen: Date.now()
};

/**
 * Smart device merging & registration
 * Uniquely tracks each remote physical node by distinct ID or distinct IP.
 * Does not evict other active devices.
 */
function upsertOrMergeDevice(data) {
  if (!data || !data.ip) return null;
  const ip = String(data.ip).replace(/^.*:/, '').trim();
  if (ip === '127.0.0.1' || ip === 'localhost' || ip === LOCAL_IP || data.isHost) {
    return null; // Do not register host PC as a remote peer
  }

  const now = Date.now();
  let matchedKey = null;
  let matchedDev = null;

  // Search existing active devices: Key strictly by distinct ID, IP, or fingerprint
  for (const [key, existing] of onlineDevices.entries()) {
    if (existing.isHost) continue;

    const sameId = (data.id && existing.id && data.id === existing.id);
    const sameIp = (ip && existing.ip && ip === existing.ip);
    // Add fingerprint matching to prevent duplicate entries from same physical device
    const sameFingerprint = (
      data.fingerprint && 
      existing.fingerprint && 
      data.fingerprint === existing.fingerprint &&
      !['LAN-BEACON', 'HTTP-CLIENT', 'LAN-NODE', 'VERIFIED'].includes(data.fingerprint.toUpperCase())
    );

    if (sameId || sameIp || sameFingerprint) {
      matchedKey = key;
      matchedDev = existing;
      break;
    }
  }

  const isGenericName = (n) => !n || n.startsWith('Remote Client') || n.startsWith('Device (') || n.startsWith('局域网设备');

  if (matchedDev) {
    // Merge directly into this specific device record
    if (data.name && (!matchedDev.name || isGenericName(matchedDev.name))) {
      matchedDev.name = data.name;
    }
    if (data.port) matchedDev.port = data.port;
    if (data.os && data.os !== 'unknown') matchedDev.os = data.os;
    if (data.fingerprint && !['LAN-BEACON', 'HTTP-CLIENT', 'VERIFIED'].includes(data.fingerprint.toUpperCase())) {
      matchedDev.fingerprint = data.fingerprint;
    }
    matchedDev.ip = ip;
    matchedDev.lastSeen = now;
    matchedDev.status = 'online';
    
    // NEW: Load custom name from persistent storage if exists
    if (matchedDev.fingerprint && DEVICE_NAMES[matchedDev.fingerprint]) {
      matchedDev.customName = DEVICE_NAMES[matchedDev.fingerprint];
    }
    
    return matchedDev;
  }

  // Register clean separate device entry
  const devId = data.id || `dev-${ip.replace(/\./g, '-')}`;
  const newDev = {
    id: devId,
    name: data.name || (data.os === 'android' ? 'Android 便携手机' : `局域网设备 (${ip})`),
    ip: ip,
    port: data.port || 8899,
    fingerprint: data.fingerprint || 'LAN-NODE',
    os: data.os || 'android',
    isHost: false,
    lastSeen: now,
    status: 'online'
  };

  // NEW: Load custom name from persistent storage if exists
  if (newDev.fingerprint && DEVICE_NAMES[newDev.fingerprint]) {
    newDev.customName = DEVICE_NAMES[newDev.fingerprint];
  }

  onlineDevices.set(devId, newDev);
  return newDev;
}

// Transfer history record store
const transferHistory = [];
// Chat & instant transfer timeline messages store
const chatMessages = [];

// Transfer progress storage (memory + persistence)
const transferProgress = new Map();

// Ensure temporary directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Load persisted progress on startup
function loadPersistedProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      Object.entries(data).forEach(([id, progress]) => {
        transferProgress.set(id, progress);
      });
      console.log(`[SafeDrop] Loaded ${transferProgress.size} incomplete transfer progress records`);
    }
  } catch (error) {
    console.error('[Progress] Load failed:', error);
  }
}

// Persist progress to disk
function persistProgress() {
  try {
    const data = Object.fromEntries(transferProgress);
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[Progress] Persist failed:', error);
  }
}

// Find missing chunks
function findMissingChunks(uploadedChunks, totalChunks) {
  const missing = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!uploadedChunks.includes(i)) {
      missing.push(i);
    }
  }
  return missing;
}

loadPersistedProgress();

// MIME types dictionary
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

// Create HTTP server
const server = http.createServer(handleIncomingRequest);

/**
 * HTTP and HTTPS share one request handler, so behaviour cannot drift between them.
 * `req.socket.encrypted` distinguishes the two when a response needs to know.
 */
function handleIncomingRequest(req, res) {
  // CORS support
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Task-Id, X-Chunk-Index, X-Chunk-Count, X-File-Name, X-File-Size, X-Encrypted, X-Session-Id, X-Target-Session-Id, X-Target-Ip, X-Target-Port, X-Target-Name');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // Track client device activity: merge if already known
  const userAgent = req.headers['user-agent'] || '';
  const clientIp = req.socket.remoteAddress?.replace(/^.*:/, '') || 'unknown';
  if (clientIp !== '127.0.0.1' && clientIp !== 'localhost' && clientIp !== LOCAL_IP) {
    const isMobile = /Android|iPhone|iPad|Mobile/i.test(userAgent);
    upsertOrMergeDevice({
      id: `client-${clientIp.replace(/\./g, '-')}`,
      name: isMobile ? (userAgent.includes('Android') ? 'Android 便携手机' : 'iOS 便携设备') : `局域网设备 (${clientIp})`,
      ip: clientIp,
      port: 8899,
      fingerprint: 'HTTP-CLIENT',
      os: isMobile ? (userAgent.includes('Android') ? 'android' : 'ios') : 'unknown',
      isHost: false
    });
  }

  // API router
  if (pathname === '/health') {
    // Kept outside the /api/v1 prefix, so it must be routed explicitly: otherwise it falls
    // through to the static handler and returns index.html instead of a health payload.
    jsonResponse(res, 200, { status: 'ok', ready: true });
    return;
  }

  if (pathname.startsWith('/api/v1/')) {
    handleApi(pathname, req, res, urlObj);
    return;
  }

  // Static files server
  handleStatic(pathname, res, req, urlObj);
}

// Handle API requests
function handleApi(pathname, req, res, urlObj) {
  const clientIp = req.socket.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';

  // 1. System info and QR pairing payload
  // Pairing secrets are disclosed only to callers on this machine. Remote devices must
  // obtain them out of band (reading the screen or scanning the QR code), which is exactly
  // what gives the pairing step its value. Serving them to any LAN caller would make the
  // handshake ceremony pointless.
  if (pathname === '/api/v1/info' && req.method === 'GET') {
    LOCAL_IP = getLocalIp();
    hostDevice.ip = LOCAL_IP;
    const trusted = isTrustedLocal(clientIp);
    const payload = {
      code: 0,
      host: hostDevice,
      localIp: LOCAL_IP,
      availableIps: getAllLocalIps(),
      port: PORT,
      tlsPort: TLS_ENABLED ? TLS_PORT : null,
      fingerprint: hostFingerprint,
      pinRequired: true,
      secretsDisclosed: trusted
    };
    if (trusted) {
      payload.pin = currentPin;
      payload.token = currentOneTimeToken;
      payload.qrUri = `safedrop://pair?ip=${LOCAL_IP}&port=${PORT}&fp=${hostFingerprint}&token=${currentOneTimeToken}&pin=${currentPin}`;
      // Point at HTTPS when available: it is the only origin where the browser can encrypt.
      payload.webUrl = TLS_ENABLED
        ? `https://${LOCAL_IP}:${TLS_PORT}/portal?pin=${currentPin}&token=${currentOneTimeToken}&fp=${hostFingerprint}`
        : `http://${LOCAL_IP}:${PORT}/portal?pin=${currentPin}&token=${currentOneTimeToken}&fp=${hostFingerprint}`;
      payload.downloadDir = DOWNLOAD_DIR;
    }
    jsonResponse(res, 200, payload);
    return;
  }

  // 2. Health check ping
  if (pathname === '/api/v1/ping' && req.method === 'GET') {
    jsonResponse(res, 200, {
      code: 0,
      message: 'pong',
      server: 'SafeDrop Desktop Hub',
      device_name: `${os.hostname()} (Desktop Hub)`,
      device_type: 'pc',
      os: 'windows',
      fingerprint: hostFingerprint,
      port: PORT,
      version: APP_VERSION,
      timestamp: Date.now()
    });
    return;
  }

  // 3. Device topology query: strictly return only active peer devices within 12s, no stale records, no host
  if (pathname === '/api/v1/devices' && req.method === 'GET') {
    const now = Date.now();
    const active = [];
    const EXPIRE_TIMEOUT = 12000; // 12 seconds timeout: do not retain previous offline records!

    for (const [id, dev] of onlineDevices.entries()) {
      if (dev.isHost || dev.ip === LOCAL_IP || dev.ip === '127.0.0.1') {
        continue; // PC itself is the host hub, not a peer target
      }
      if (now - dev.lastSeen < EXPIRE_TIMEOUT) {
        active.push(dev);
      } else {
        onlineDevices.delete(id); // Evict stale records immediately!
      }
    }
    jsonResponse(res, 200, { code: 0, devices: active });
    return;
  }

  // 4. Device announcement POST /api/v1/devices/announce: merge with existing device
  if (pathname === '/api/v1/devices/announce' && req.method === 'POST') {
    readJsonBody(req, (err, body) => {
      if (err || !body) return jsonResponse(res, 400, { error: 'Invalid JSON body' });
      const clientIp = body.ip || req.socket.remoteAddress?.replace(/^.*:/, '') || LOCAL_IP;
      const merged = upsertOrMergeDevice({
        id: body.id,
        name: body.name,
        ip: clientIp,
        port: body.port || 8899,
        fingerprint: body.fingerprint,
        os: body.os || 'android',
        isHost: false
      });
      jsonResponse(res, 200, { code: 0, message: 'registered', device: merged });
    });
    return;
  }

  // 4.1 GET /api/v1/devices/names - Get all device custom names
  if (pathname === '/api/v1/devices/names' && req.method === 'GET') {
    if (!ensureAuthorized(req, res)) return;
    jsonResponse(res, 200, { 
      code: 0, 
      deviceNames: DEVICE_NAMES 
    });
    return;
  }

  // 4.2 PUT /api/v1/devices/names/:fingerprint - Set custom name for a device
  if (pathname.startsWith('/api/v1/devices/names/') && req.method === 'PUT') {
    if (!ensureAuthorized(req, res)) return;
    const fingerprint = pathname.replace('/api/v1/devices/names/', '');
    if (!fingerprint || fingerprint.length < 8) {
      return jsonResponse(res, 400, { error: 'Invalid fingerprint' });
    }
    
    readJsonBody(req, (err, body) => {
      if (err || !body) return jsonResponse(res, 400, { error: 'Invalid JSON body' });
      
      const customName = body.customName;
      if (!customName || typeof customName !== 'string' || customName.trim().length === 0) {
        return jsonResponse(res, 400, { error: 'customName is required and must be non-empty' });
      }
      
      // Save custom name
      DEVICE_NAMES[fingerprint] = customName.trim();
      saveDeviceNames();
      
      // Update online devices if this device is currently connected
      for (const [id, dev] of onlineDevices.entries()) {
        if (dev.fingerprint === fingerprint) {
          dev.customName = customName.trim();
        }
      }
      
      jsonResponse(res, 200, { 
        code: 0, 
        message: 'Device name updated',
        fingerprint: fingerprint,
        customName: customName.trim()
      });
    });
    return;
  }

  // 4.3 DELETE /api/v1/devices/names/:fingerprint - Remove custom name
  if (pathname.startsWith('/api/v1/devices/names/') && req.method === 'DELETE') {
    const fingerprint = pathname.replace('/api/v1/devices/names/', '');
    if (!fingerprint || fingerprint.length < 8) {
      return jsonResponse(res, 400, { error: 'Invalid fingerprint' });
    }
    
    if (DEVICE_NAMES[fingerprint]) {
      delete DEVICE_NAMES[fingerprint];
      saveDeviceNames();
      
      // Remove customName from online devices
      for (const [id, dev] of onlineDevices.entries()) {
        if (dev.fingerprint === fingerprint) {
          delete dev.customName;
        }
      }
      
      jsonResponse(res, 200, { 
        code: 0, 
        message: 'Device name removed',
        fingerprint: fingerprint
      });
    } else {
      jsonResponse(res, 404, { error: 'Device name not found' });
    }
    return;
  }

  // 5. Handshake initiation POST /api/v1/handshake/init
  // The client sends an ephemeral public key; the hub answers with its own ephemeral key and
  // keeps the ECDH shared secret for this session only.
  if (pathname === '/api/v1/handshake/init' && req.method === 'POST') {
    readJsonBody(req, (err, body) => {
      if (err || !body) return jsonResponse(res, 400, { error: 'Invalid JSON body' });

      let rawClientKey;
      try {
        rawClientKey = Buffer.from(String(body.public_key || ''), 'hex');
      } catch (_) {
        return jsonResponse(res, 400, { error: 'public_key must be a hex string' });
      }

      let curve;
      try {
        curve = body.curve ? String(body.curve) : cryptoProtocol.curveFromRawLength(rawClientKey.length);
        if (!cryptoProtocol.CURVES[curve]) throw new Error(`unsupported curve: ${curve}`);
      } catch (e) {
        return jsonResponse(res, 400, { error: `Unsupported key material: ${e.message}` });
      }

      let serverPubRaw;
      let sharedSecret;
      try {
        const keyPair = cryptoProtocol.generateKeyPair(curve);
        serverPubRaw = cryptoProtocol.exportRawPublicKey(keyPair, curve);
        sharedSecret = cryptoProtocol.computeSharedSecret(keyPair.privateKey, rawClientKey, curve);
      } catch (e) {
        return jsonResponse(res, 400, { error: `Key agreement failed: ${e.message}` });
      }

      const sessionId = crypto.randomBytes(16).toString('hex');
      e2eSessions.set(sessionId, {
        curve,
        sharedSecret,
        key: null,
        verified: false,
        clientIp,
        createdAt: Date.now(),
        lastSeen: Date.now()
      });

      jsonResponse(res, 200, {
        code: 0,
        protocol: cryptoProtocol.PROTOCOL,
        session_id: sessionId,
        curve,
        server_public_key: serverPubRaw.toString('hex'),
        pin_required: true,
        fingerprint: hostFingerprint
      });
    });
    return;
  }

  // 6. Handshake proof verification POST /api/v1/handshake/verify
  // The pairing secret never crosses the wire. Both sides derive the session key from the
  // ECDH secret plus the pairing secret, and the client proves it derived the same key by
  // sending an HMAC over the session id.
  if (pathname === '/api/v1/handshake/verify' && req.method === 'POST') {
    const blockedFor = pairingRateLimited(clientIp);
    if (blockedFor > 0) {
      return jsonResponse(res, 429, {
        code: 429,
        error: `Too many pairing attempts. Try again in ${blockedFor}s.`
      });
    }

    readJsonBody(req, (err, body) => {
      if (err || !body) return jsonResponse(res, 400, { error: 'Invalid JSON body' });

      const sessionId = String(body.session_id || '');
      const session = e2eSessions.get(sessionId);
      if (!session || session.clientIp !== clientIp) {
        notePairingFailure(clientIp);
        return jsonResponse(res, 403, { code: 403, error: 'Unknown or expired session' });
      }

      const now = Date.now();
      const candidates = [currentPin, currentOneTimeToken];
      if (prevPin && now - prevPinTime < 60000) candidates.push(prevPin);
      if (prevToken && now - prevPinTime < 60000) candidates.push(prevToken);

      let matchedKey = null;
      for (const secret of candidates) {
        if (!secret) continue;
        let candidateKey;
        try {
          candidateKey = cryptoProtocol.deriveSessionKey(session.sharedSecret, sessionId, String(secret));
        } catch (_) {
          continue;
        }
        if (cryptoProtocol.verifyClientProof(candidateKey, sessionId, body.proof)) {
          matchedKey = candidateKey;
          break;
        }
      }

      if (!matchedKey) {
        notePairingFailure(clientIp);
        return jsonResponse(res, 403, { code: 403, error: 'Pairing proof verification failed' });
      }

      session.key = matchedKey;
      session.verified = true;
      session.lastSeen = now;
      clearPairingFailures(clientIp);

      // Move current credentials into the grace window, then rotate them.
      prevPin = currentPin;
      prevToken = currentOneTimeToken;
      prevPinTime = now;
      currentPin = String(Math.floor(100000 + Math.random() * 900000));
      currentOneTimeToken = crypto.randomBytes(6).toString('hex');

      jsonResponse(res, 200, {
        code: 0,
        status: 'verified',
        session_id: sessionId,
        server_proof: cryptoProtocol.serverProof(matchedKey, sessionId).toString('hex'),
        message: 'Encrypted session established'
      });
    });
    return;
  }

  // 6.1 Refresh pairing PIN and one-time token POST /api/v1/pin/refresh
  if (pathname === '/api/v1/pin/refresh' && req.method === 'POST') {
    // Rotating the pairing secret is a local administrative action: the new value is
    // displayed on this machine's screen, so only this machine may trigger or read it.
    if (!isTrustedLocal(clientIp)) {
      return jsonResponse(res, 403, {
        code: 403,
        error: 'Pairing credentials can only be refreshed from the desktop hub itself'
      });
    }
    LOCAL_IP = getLocalIp();
    hostDevice.ip = LOCAL_IP;
    currentPin = String(Math.floor(100000 + Math.random() * 900000));
    currentOneTimeToken = crypto.randomBytes(6).toString('hex');
    const qrUri = `safedrop://pair?ip=${LOCAL_IP}&port=${PORT}&fp=${hostFingerprint}&token=${currentOneTimeToken}&pin=${currentPin}`;
    const webUrl = TLS_ENABLED
      ? `https://${LOCAL_IP}:${TLS_PORT}/portal?pin=${currentPin}&token=${currentOneTimeToken}&fp=${hostFingerprint}`
      : `http://${LOCAL_IP}:${PORT}/portal?pin=${currentPin}&token=${currentOneTimeToken}&fp=${hostFingerprint}`;
    console.log(`[SafeDrop] Dynamic pairing credentials refreshed (PIN=${currentPin})`);
    jsonResponse(res, 200, {
      code: 0,
      pin: currentPin,
      token: currentOneTimeToken,
      qrUri: qrUri,
      webUrl: webUrl,
      localIp: LOCAL_IP,
      availableIps: getAllLocalIps(),
      fingerprint: hostFingerprint,
      message: 'Pairing credentials refreshed successfully'
    });
    return;
  }

  // 7. Streaming chunk upload POST /api/v1/transfer/upload
  // Remote senders must be inside a verified session; their chunks are AES-256-GCM sealed
  // and are decrypted here before touching disk. Loopback callers may still post plaintext
  // (used by local tooling and tests).
  if (pathname === '/api/v1/transfer/upload' && req.method === 'POST') {
    const targetIp = req.headers['x-target-ip'];
    const targetPort = parseInt(req.headers['x-target-port'] || '8899', 10);
    const isLocal = isTrustedLocal(clientIp);
    const session = getVerifiedSession(req);
    const isEncrypted = req.headers['x-encrypted'] === '1';

    if (!isLocal && !session) {
      return jsonResponse(res, 401, {
        code: 401,
        error: 'Encrypted session required. Complete the pairing handshake before uploading.'
      });
    }

    // A non-loopback caller must have proven a session before it may send anything. A
    // loopback caller may send an already-encrypted payload for a relay target without
    // holding a hub session, because in that case the key belongs to the destination.
    if (isEncrypted && !session && !isLocal) {
      return jsonResponse(res, 400, {
        code: 400,
        error: 'X-Encrypted was set but no verified session key is available for this request'
      });
    }

    // If target device is a remote mobile device, forward the chunk to it.
    if (targetIp && targetIp !== '127.0.0.1' && targetIp !== LOCAL_IP) {
      if (!isPrivateLanIp(targetIp) || isNaN(targetPort) || targetPort < 1024 || targetPort > 65535) {
        return jsonResponse(res, 400, { error: 'Invalid or restricted relay target IP/port' });
      }

      const forwardHeaders = { ...req.headers };
      delete forwardHeaders['host'];
      delete forwardHeaders['x-target-ip'];
      delete forwardHeaders['x-target-port'];
      delete forwardHeaders['x-target-name'];

      // The sender holds two independent sessions: one with this hub (used for authorization
      // above) and one with the destination phone. Only the latter is meaningful to the
      // receiver, so swap in the target's session id before forwarding; the hub session id
      // must not leak downstream.
      if (forwardHeaders['x-target-session-id']) {
        forwardHeaders['x-session-id'] = forwardHeaders['x-target-session-id'];
      } else {
        delete forwardHeaders['x-session-id'];
      }
      delete forwardHeaders['x-target-session-id'];

      // The chunk is sealed with the key the sender shares with the destination phone. This
      // hub holds no such key, so the sealed bytes are forwarded untouched: the phone
      // decrypts with the key it negotiated directly with the sender.
      const targetReq = http.request({
        hostname: targetIp,
        port: targetPort,
        path: '/api/v1/transfer/upload',
        method: 'POST',
        headers: forwardHeaders
      }, (targetRes) => {
        let body = '';
        targetRes.on('data', chunk => body += chunk);
        targetRes.on('end', () => {
          res.writeHead(targetRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(body || JSON.stringify({ code: 0, status: 'chunk_relayed_to_mobile' }));
        });
      });

      targetReq.on('error', (err) => {
        console.error(`[Relay Upload] Failed to forward chunk to mobile (${targetIp}:${targetPort}):`, err.message);
        jsonResponse(res, 502, { error: `无法推送到手机端 (${targetIp}:${targetPort}): ${err.message}` });
      });

      req.pipe(targetReq);
      return;
    }

    const rawTaskId = req.headers['x-task-id'] || `task_${Date.now()}`;
    const taskId = rawTaskId.replace(/[^a-zA-Z0-9_\-]/g, '') || `task_${Date.now()}`;
    let rawFileName = 'received_file.bin';
    const headerFileName = req.headers['x-file-name'];
    
    if (headerFileName) {
      try {
        // First attempt: standard URL decode
        rawFileName = decodeURIComponent(headerFileName);
      } catch (_) {
        try {
          // Second attempt: Latin1 to UTF-8 conversion for raw bytes
          rawFileName = Buffer.from(headerFileName, 'latin1').toString('utf8');
        } catch (__) {
          try {
            // Third attempt: decode percent-encoded manually for malformed sequences
            rawFileName = headerFileName.replace(/%([0-9A-F]{2})/gi, (match, hex) => {
              return String.fromCharCode(parseInt(hex, 16));
            });
            // Attempt UTF-8 interpretation
            rawFileName = Buffer.from(rawFileName, 'binary').toString('utf8');
          } catch (___) {
            // Final fallback: use raw header value with basic sanitization
            rawFileName = headerFileName.replace(/[^\x20-\x7E\u4E00-\u9FFF]/g, '_');
          }
        }
      }
    }
    const safeName = sanitizeFileName(rawFileName);
    const chunkIndex = parseInt(req.headers['x-chunk-index'] || '0', 10);
    const totalChunks = parseInt(req.headers['x-chunk-count'] || '1', 10);
    const fileSize = parseInt(req.headers['x-file-size'] || '0', 10);
    
    // NEW: Check if chunk is compressed
    const isCompressed = req.headers['x-compressed'] === 'gzip';

    const partPath = path.join(DOWNLOAD_DIR, `.${taskId}_${safeName}.part`);
    const writeStream = fs.createWriteStream(partPath, { flags: 'a' });

    if (isEncrypted) {
      // Read the whole sealed packet, verify the tag, then append the plaintext. GCM
      // verification is all-or-nothing, so nothing is written until the tag checks out.
      const packets = [];
      let received = 0;
      const MAX_SEALED = 64 * 1024 * 1024; // generous ceiling for a single encrypted chunk
      let aborted = false;

      const fail = (status, message) => {
        if (aborted) return;
        aborted = true;
        writeStream.destroy();
        jsonResponse(res, status, { error: message });
      };

      req.on('data', (chunk) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_SEALED) {
          fail(413, 'Encrypted chunk exceeds the maximum accepted size');
          return;
        }
        packets.push(chunk);
      });

      req.on('error', (e) => fail(400, `Upload stream error: ${e.message}`));

      req.on('end', () => {
        if (aborted) return;

        let plaintext;
        try {
          plaintext = cryptoProtocol.decryptChunk(session.key, Buffer.concat(packets), taskId, chunkIndex);
        } catch (e) {
          console.warn(`[Upload] Rejected chunk ${chunkIndex} of ${taskId}: ${e.message}`);
          fail(400, `Decryption failed: ${e.message}`);
          return;
        }

        // Optional gzip applies to the plaintext, after decryption.
        let payload = plaintext;
        if (isCompressed) {
          try {
            payload = zlib.gunzipSync(plaintext);
          } catch (e) {
            console.error('[Upload] Decompression error:', e.message);
            fail(400, `Decompression failed: ${e.message}`);
            return;
          }
        }

        if (payload.length > 0) {
          writeStream.write(payload);
        }
        writeStream.end();
      });

      writeStream.on('error', (err) => {
        if (aborted) return;
        aborted = true;
        console.error('[Upload] Write error:', err);
        jsonResponse(res, 500, { error: err.message });
      });

      writeStream.on('finish', () => {
        if (aborted) return;
        finalizeUpload();
      });

      return;
    }

    // Plaintext path (loopback only, enforced above).
    let dataStream = req;
    if (isCompressed) {
      const gunzip = zlib.createGunzip();
      dataStream = req.pipe(gunzip);

      gunzip.on('error', (err) => {
        console.error('[Upload] Decompression error:', err);
        writeStream.destroy();
        jsonResponse(res, 500, { error: 'Decompression failed: ' + err.message });
      });
    }

    dataStream.pipe(writeStream);

    writeStream.on('finish', () => {
      finalizeUpload();
    });

    // Shared completion handler for both the encrypted and plaintext paths.
    function finalizeUpload() {
      const respond = (extra) => {
        jsonResponse(res, 200, {
          code: 0,
          chunk_index: chunkIndex,
          total_chunks: totalChunks,
          status: chunkIndex + 1 >= totalChunks ? 'completed' : 'chunk_received',
          compressed: isCompressed,
          encrypted: isEncrypted,
          ...extra
        });
      };

      // Final chunk: promote the .part file to its final name.
      if (chunkIndex + 1 >= totalChunks) {
        const finalPath = resolveUniqueFilePath(safeName);
        // Respond only once the rename has actually happened. Reporting "completed" first
        // would let a client immediately list or download a file that does not exist yet.
        fs.rename(partPath, finalPath, (err) => {
          if (err) {
            console.error('[Upload] Rename failed:', err);
            writeStream.destroy();
            jsonResponse(res, 500, { error: `Failed to finalize file: ${err.message}` });
            return;
          }
          const finalName = path.basename(finalPath);
          let actualSize = fileSize;
          try {
            actualSize = fs.statSync(finalPath).size;
          } catch (_) {}
          transferHistory.unshift({
            taskId,
            fileName: finalName,
            fileSize: actualSize,
            sender: clientIp,
            status: 'completed',
            path: finalPath,
            compressed: isCompressed,
            time: new Date().toLocaleTimeString()
          });
          console.log(`[SafeDrop] File successfully saved to vault: ${finalPath}${isCompressed ? ' (decompressed)' : ''}${isEncrypted ? ' (decrypted)' : ''}`);
          respond({ file_name: finalName, file_size: actualSize });
        });
        return;
      }

      respond();
    }

    writeStream.on('error', (err) => {
      console.error('[Upload] Write error:', err);
      jsonResponse(res, 500, { error: err.message });
    });
    return;
  }

  // 7.1 Send or relay instant message POST /api/v1/message/send
  if (pathname === '/api/v1/message/send' && req.method === 'POST') {
    readJsonBody(req, (err, body) => {
      if (err || !body || !body.text) {
        return jsonResponse(res, 400, { error: 'Message content is required' });
      }
      const text = String(body.text).trim();
      const targetIp = body.targetIp || '';
      const targetPort = parseInt(body.targetPort || '8899', 10);
      const targetId = body.targetId || body.targetPeerId || '';
      const socketIp = req.socket.remoteAddress?.replace(/^.*:/, '') || '';
      const clientIp = body.senderIp || socketIp;
      const senderId = body.senderId || (clientIp ? `client-${clientIp.replace(/\./g, '-')}` : hostDevice.id);
      const senderName = body.senderName || (clientIp ? `移动端 (${clientIp})` : hostDevice.name);

      const msgObj = {
        id: body.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        senderId,
        senderName,
        senderIp: clientIp,
        targetId,
        targetIp,
        text,
        timestamp: body.timestamp || Date.now()
      };

      chatMessages.push(msgObj);
      if (chatMessages.length > 500) chatMessages.shift();
      console.log(`[Chat] Message recorded from ${senderName} (${clientIp || senderId}): "${text}"`);

      // If targetIp is remote, relay HTTP POST to target mobile device
      if (targetIp && targetIp !== '127.0.0.1' && targetIp !== LOCAL_IP) {
        if (!isPrivateLanIp(targetIp) || isNaN(targetPort) || targetPort < 1024 || targetPort > 65535) {
          return jsonResponse(res, 400, { error: 'Invalid or restricted relay target IP/port' });
        }
        const payload = JSON.stringify(msgObj);
        const targetReq = http.request({
          hostname: targetIp,
          port: targetPort,
          path: '/api/v1/message/send',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: 5000
        }, (targetRes) => {
          jsonResponse(res, 200, { code: 0, status: 'relayed', message: msgObj });
        });
        targetReq.on('error', (e) => {
          jsonResponse(res, 200, { code: 0, status: 'stored_local', warning: e.message, message: msgObj });
        });
        targetReq.write(payload);
        targetReq.end();
      } else {
        jsonResponse(res, 200, { code: 0, status: 'stored', message: msgObj });
      }
    });
    return;
  }

  // 7.2 Get messages list GET /api/v1/messages/list?since=...&peerId=...
  if (pathname === '/api/v1/messages/list' && req.method === 'GET') {
    const since = parseInt(urlObj.searchParams.get('since') || '0', 10);
    const peerId = urlObj.searchParams.get('peerId') || '';
    const filtered = chatMessages.filter(m => {
      if (m.timestamp <= since) return false;
      if (peerId) {
        const matchSender = m.senderId === peerId || (m.senderIp && (peerId.includes(m.senderIp) || m.senderIp.includes(peerId)));
        const matchTarget = m.targetId === peerId || (m.targetIp && (peerId.includes(m.targetIp) || m.targetIp.includes(peerId)));
        if (!matchSender && !matchTarget) return false;
      }
      return true;
    });
    jsonResponse(res, 200, { code: 0, messages: filtered });
    return;
  }

  // 8. Transfer history & file vault listing GET /api/v1/files/list
  if (pathname === '/api/v1/files/list' && req.method === 'GET') {
    if (!ensureAuthorized(req, res)) return;
    fs.readdir(DOWNLOAD_DIR, (err, files) => {
      if (err) return jsonResponse(res, 500, { error: err.message });
      const list = [];
      for (const f of files) {
        if (!f.startsWith('.')) {
          const fpath = path.join(DOWNLOAD_DIR, f);
          try {
            const stat = fs.statSync(fpath);
            list.push({
              name: f,
              size: stat.size,
              mtime: stat.mtime
            });
          } catch (_) {}
        }
      }
      jsonResponse(res, 200, {
        code: 0,
        downloadDir: DOWNLOAD_DIR,
        files: list,
        history: transferHistory
      });
    });
    return;
  }

  // 9. File download GET /api/v1/files/download/:name
  if (pathname.startsWith('/api/v1/files/download/')) {
    if (!ensureAuthorized(req, res)) return;
    const rawName = decodeURIComponent(pathname.replace('/api/v1/files/download/', ''));
    const safeName = sanitizeFileName(rawName);
    const targetFile = path.join(DOWNLOAD_DIR, safeName);
    const resolvedTarget = path.resolve(targetFile);
    const resolvedDownloadDir = path.resolve(DOWNLOAD_DIR);
    if (!resolvedTarget.startsWith(resolvedDownloadDir + path.sep) && resolvedTarget !== resolvedDownloadDir) {
      jsonResponse(res, 403, { error: 'Forbidden: access outside vault directory is prohibited' });
      return;
    }
    if (!fs.existsSync(targetFile)) {
      jsonResponse(res, 404, { error: 'File not found' });
      return;
    }
    const stat = fs.statSync(targetFile);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
    });
    fs.createReadStream(targetFile).pipe(res);
    return;
  }

  // Helper to verify that sensitive management commands originate from localhost
  function isLocalClient(ip, r) {
    const isLoop = isTrustedLocal(ip);
    const origin = r.headers['origin'];
    if (origin) {
      try {
        const u = new URL(origin);
        if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' && u.hostname !== LOCAL_IP) {
          return false;
        }
      } catch (_) {
        return false;
      }
    }
    return isLoop;
  }

  // 10. Update download vault directory POST /api/v1/settings/dir
  if (pathname === '/api/v1/settings/dir' && req.method === 'POST') {
    if (!isLocalClient(clientIp, req)) {
      return jsonResponse(res, 403, { error: 'Forbidden: settings can only be managed locally' });
    }
    readJsonBody(req, (err, body) => {
      if (err || !body || !body.dir) {
        return jsonResponse(res, 400, { error: 'Directory path cannot be empty' });
      }
      try {
        const rawDir = body.dir.trim();
        const resolvedDir = path.resolve(rawDir);
        if (!fs.existsSync(resolvedDir)) {
          fs.mkdirSync(resolvedDir, { recursive: true });
        }
        DOWNLOAD_DIR = resolvedDir;
        try {
          fs.writeFileSync(CONFIG_FILE, JSON.stringify({ downloadDir: DOWNLOAD_DIR }, null, 2), 'utf8');
        } catch (_) {}
        console.log(`[SafeDrop] Vault directory updated: ${DOWNLOAD_DIR}`);
        jsonResponse(res, 200, {
          code: 0,
          downloadDir: DOWNLOAD_DIR,
          message: 'Storage directory updated successfully'
        });
      } catch (e) {
        jsonResponse(res, 500, { error: `Failed to switch directory: ${e.message}` });
      }
    });
    return;
  }

  // 11. Open storage folder in system explorer POST /api/v1/settings/open-dir (parameterized, no shell command injection)
  if (pathname === '/api/v1/settings/open-dir' && req.method === 'POST') {
    if (!isLocalClient(clientIp, req)) {
      return jsonResponse(res, 403, { error: 'Forbidden: explorer can only be opened locally' });
    }
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
    if (os.platform() === 'win32') {
      spawn('explorer.exe', [DOWNLOAD_DIR], { detached: true, stdio: 'ignore' }).unref();
    } else if (os.platform() === 'darwin') {
      spawn('open', [DOWNLOAD_DIR], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [DOWNLOAD_DIR], { detached: true, stdio: 'ignore' }).unref();
    }
    jsonResponse(res, 200, { code: 0, message: 'Explorer opened' });
    return;
  }

  jsonResponse(res, 404, { error: 'API Not Found' });
}

// Static files server handler with strict directory traversal prevention and portal routing
function handleStatic(pathname, res, req, urlObj) {
  let relativePath = pathname === '/' ? 'index.html' : pathname;
  // Remove leading slash
  relativePath = relativePath.replace(/^\/+/, '');

  // Route /portal and /web explicitly to portal.html
  if (pathname === '/portal' || pathname === '/web') {
    relativePath = 'portal.html';
  } else if (pathname === '/app') {
    relativePath = 'index.html';
  } else if (pathname === '/' || pathname === '/index.html') {
    const clientIp = req?.socket?.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';
    const isLocal = clientIp === '127.0.0.1' || clientIp === 'localhost' || clientIp === LOCAL_IP;
    const forceApp = urlObj && (urlObj.searchParams.has('app') || urlObj.searchParams.get('mode') === 'app');
    const forcePortal = urlObj && (urlObj.searchParams.has('portal') || urlObj.searchParams.has('pin') || urlObj.searchParams.get('mode') === 'portal');

    // If accessed from remote browser (e.g. mobile/other PC via LAN IP), default to standalone file portal
    if (forcePortal || (!isLocal && !forceApp)) {
      relativePath = 'portal.html';
    } else {
      relativePath = 'index.html';
    }
  }

  const resolvedPublicDir = path.resolve(PUBLIC_DIR);
  const resolvedFilePath = path.resolve(PUBLIC_DIR, relativePath);

  // Prevent directory traversal attacks
  if (!resolvedFilePath.startsWith(resolvedPublicDir + path.sep) &&
      resolvedFilePath !== path.join(resolvedPublicDir, 'index.html') &&
      resolvedFilePath !== path.join(resolvedPublicDir, 'portal.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(resolvedFilePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fallback: index.html for app or portal.html for portal
      const fallbackFile = relativePath === 'portal.html' ? 'portal.html' : 'index.html';
      const indexPath = path.join(PUBLIC_DIR, fallbackFile);
      fs.readFile(indexPath, (err2, content) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        }
      });
      return;
    }

    const ext = path.extname(resolvedFilePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(resolvedFilePath).pipe(res);
  });
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, callback) {
  let body = '';
  const MAX_SIZE = 4 * 1024 * 1024; // 4MB payload limit (optimized for LAN transfer)
  let exceeded = false;
  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_SIZE) {
      exceeded = true;
      req.destroy();
      callback(new Error('Payload too large'));
    }
  });
  req.on('end', () => {
    if (exceeded) return;
    try {
      const data = body ? JSON.parse(body) : {};
      callback(null, data);
    } catch (e) {
      callback(e);
    }
  });
}

// UDP LAN Discovery Service on port 8890
function initUdpDiscovery() {
  const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  udpSocket.on('error', (err) => {
    console.warn('[UDP Discovery] Socket error:', err.message);
  });

  udpSocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString('utf8'));
      if (data && (data.type === 'safedrop_beacon' || data.type === 'safedrop_ping')) {
        const devIp = data.ip || rinfo.address;
        if (devIp !== LOCAL_IP && devIp !== '127.0.0.1') {
          upsertOrMergeDevice({
            id: data.id,
            name: data.name || (data.os === 'android' ? 'Android 便携手机' : `局域网设备 (${devIp})`),
            ip: devIp,
            port: data.port || 8899,
            fingerprint: data.fingerprint,
            os: data.os || 'android',
            isHost: false
          });
        }
      }
    } catch (_) {}
  });

  udpSocket.bind(UDP_PORT, () => {
    try {
      udpSocket.setBroadcast(true);
      console.log(`[SafeDrop] UDP 8890 局域网自发现广播服务已启动`);
    } catch (e) {
      console.warn('[UDP Discovery] Failed to set broadcast:', e.message);
    }
  });

  // Periodic broadcast beacon every 3 seconds
  setInterval(() => {
    try {
      const beaconPayload = Buffer.from(JSON.stringify({
        type: 'safedrop_beacon',
        id: hostDevice.id,
        name: hostDevice.name,
        device_type: 'pc',
        os: 'windows',
        ip: LOCAL_IP,
        port: PORT,
        fingerprint: hostFingerprint,
        isHost: true
      }), 'utf8');

      // 1. Send to 255.255.255.255
      udpSocket.send(beaconPayload, 0, beaconPayload.length, UDP_PORT, '255.255.255.255', () => {});

      // 2. Send to all active subnet directed broadcast addresses
      const bcasts = getSubnetBroadcastIps();
      for (const bcast of bcasts) {
        if (bcast && bcast !== '255.255.255.255') {
          udpSocket.send(beaconPayload, 0, beaconPayload.length, UDP_PORT, bcast, () => {});
        }
      }
    } catch (_) {}
  }, 3000);

  // Periodic cache cleanup every 4 seconds: do not retain previous disconnected device records!
  setInterval(() => {
    const now = Date.now();
    for (const [id, dev] of onlineDevices.entries()) {
      if (!dev.isHost && (now - dev.lastSeen >= 12000)) {
        onlineDevices.delete(id);
      }
    }
  }, 4000);
}

// HTTPS listener, so LAN browsers get a secure context and can encrypt uploads.
let httpsServer = null;

function startTlsListener() {
  if (!TLS_ENABLED) return null;
  try {
    const material = tlsSelfSigned.loadOrCreateCertificate({
      dir: path.join(__dirname, 'tls'),
      commonName: `SafeDrop Hub (${os.hostname()})`,
      ips: [...new Set([LOCAL_IP, '127.0.0.1', ...getAllLocalIps().map((entry) => entry.ip)])],
      dnsNames: ['localhost'],
      logger: console
    });

    const tlsServer = https.createServer({ key: material.key, cert: material.cert }, handleIncomingRequest);
    tlsServer.on('error', (err) => {
      console.warn(`[SafeDrop] HTTPS listener unavailable on ${TLS_PORT}: ${err.message}`);
      console.warn('[SafeDrop] The web portal will not be able to encrypt uploads until HTTPS works.');
    });
    tlsServer.listen(TLS_PORT, '0.0.0.0', () => {
      console.log(`   LAN Portal:  https://${LOCAL_IP}:${TLS_PORT}/portal  (self-signed certificate)`);
      if (material.created) {
        console.log('[SafeDrop] Generated a self-signed TLS certificate for the portal (accept the browser warning once).');
      }
    });
    return tlsServer;
  } catch (e) {
    console.warn(`[SafeDrop] Could not start HTTPS listener: ${e.message}`);
    return null;
  }
}

// Start HTTP server listener
server.listen(PORT, '0.0.0.0', () => {
  initUdpDiscovery();
  console.log('====================================================');
  console.log(`SafeDrop Desktop Hub running at:`);
  console.log(`   Local:       http://localhost:${PORT}/`);
  console.log(`   LAN Mobile:  http://${LOCAL_IP}:${PORT}/`);
  console.log(`   Fingerprint: ${hostFingerprint}`);
  console.log(`   Pairing PIN: ${currentPin}`);
  console.log(`   Vault Dir:   ${DOWNLOAD_DIR}`);
  console.log(`   UDP Beacon:  Port ${UDP_PORT}`);

  // Show which destinations the hub will relay to, so an unexpected refusal is diagnosable.
  const relaySubnets = lanGuard.describeLocalSubnets();
  const extraTargets = [...lanGuard.relayTargetAllowlist];
  console.log(`   Relay Scope: RFC1918${relaySubnets.length ? ' + on-link ' + relaySubnets.join(', ') : ''}${extraTargets.length ? ' + allowlist ' + extraTargets.join(', ') : ''}`);
  if (!relaySubnets.length && !extraTargets.length) {
    console.log('   Relay Note:  no local subnet detected; set SAFEDROP_RELAY_TARGETS to relay on this network');
  }

  httpsServer = startTlsListener();
  console.log('====================================================');
});
