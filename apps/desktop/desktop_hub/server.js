/**
 * SafeDrop Desktop Hub - Lightweight Embedded Hub Server
 * 100% native Node.js, zero external dependencies, rapid startup.
 * Features UDP beacon device discovery, chunked streaming transfer with optional per-chunk gzip,
 * and pairing via a rotating PIN / one-time token.
 * Note: payloads from the LAN arrive AES-256-GCM sealed under an ephemeral X25519 session key (see
 * crypto_protocol.js), and are refused before writing anything if the tag or the chunk geometry
 * does not verify. Only this machine's own loopback may still post plaintext.
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

// Dynamic pairing credentials. A successful handshake rotates both values, so a credential
// that is still on screen (or in a QR code already being scanned) becomes stale the moment any
// device pairs. Recently retired credentials therefore stay accepted for a grace period, and
// more than one generation is kept: with a single previous slot a second pairing inside the
// window evicted the value still displayed, and the next device was rejected with
// "Pairing proof verification failed" even though the user had just read it off the screen.
const PAIRING_GRACE_MS = cryptoProtocol.PAIRING.GRACE_MS;
const PAIRING_GRACE_GENERATIONS = cryptoProtocol.PAIRING.GRACE_GENERATIONS;

/**
 * The PIN is the only input that separates a paired peer from an eavesdropper on the LAN, so it
 * must come from the CSPRNG. Math.random() is a V8 xorshift128+ sequence whose state can be
 * recovered from enough of its other outputs, and this server used to publish such outputs on
 * unauthenticated endpoints. Android made the same switch in a7579df.
 */
function newPairingPin() {
  return String(crypto.randomInt(cryptoProtocol.PAIRING.PIN_MIN, cryptoProtocol.PAIRING.PIN_MAX_EXCLUSIVE));
}

/** The QR counterpart of the PIN: same role as HKDF input, so the same source and width. */
function newPairingToken() {
  return crypto.randomBytes(cryptoProtocol.PAIRING.TOKEN_BYTES).toString('hex');
}

/**
 * The browser portal can only encrypt on a secure origin, so the pairing credentials go into its
 * URL only while TLS is actually listening. On plain HTTP the portal refuses to pair anyway, and
 * appending the PIN there would carry it in cleartext and park it in the browser's history.
 */
function portalWebUrl() {
  const base = TLS_ENABLED
    ? `https://${LOCAL_IP}:${TLS_PORT}/portal`
    : `http://${LOCAL_IP}:${PORT}/portal`;
  return TLS_ENABLED
    ? `${base}?pin=${currentPin}&token=${currentOneTimeToken}&fp=${hostFingerprint}`
    : base;
}

let currentOneTimeToken = newPairingToken();
let currentPin = newPairingPin();
/** Retired credentials, newest first: [{ pin, token, at }]. */
let retiredCredentials = [];

// Online devices cache with last-seen timestamps
const onlineDevices = new Map();

// Ephemeral E2E sessions created by the handshake. Session keys live in memory only.
const e2eSessions = new Map();
// Expiry is driven by inactivity, not by the moment the session was created. A hard deadline
// from createdAt dropped sessions that were still in active use (and any session left idle
// for ten minutes), which left the peer presenting a session id the hub had already
// forgotten — the transfer then failed with 401 and needed a fresh pairing. The absolute cap
// still bounds how long a single negotiation may live, so this stays effectively ephemeral.
// Both windows are overridable so tests can exercise expiry without waiting.
const SESSION_IDLE_TTL_MS = Number(process.env.SAFEDROP_SESSION_IDLE_MS) || cryptoProtocol.SESSION.IDLE_TTL_MS;
const SESSION_MAX_TTL_MS = Number(process.env.SAFEDROP_SESSION_MAX_MS) || cryptoProtocol.SESSION.MAX_TTL_MS;

// Pairing attempts are rate limited per source IP to bound online guessing of the PIN.
const pairingAttempts = new Map();
const PAIRING_MAX_FAILURES = cryptoProtocol.PAIRING.MAX_FAILURES;
const PAIRING_WINDOW_MS = cryptoProtocol.PAIRING.FAILURE_WINDOW_MS;
const PAIRING_BLOCK_MS = cryptoProtocol.PAIRING.BLOCK_MS;

/** A session lives until it goes idle, with an absolute cap on total lifetime. */
function sessionExpired(session, now) {
  if (!session) return true;
  if (now - session.createdAt > SESSION_MAX_TTL_MS) return true;
  return now - (session.lastSeen || session.createdAt) > SESSION_IDLE_TTL_MS;
}

const sessionGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of e2eSessions.entries()) {
    if (sessionExpired(session, now)) e2eSessions.delete(id);
  }
  for (const [ip, attempt] of pairingAttempts.entries()) {
    const settled = (!attempt.blockedUntil || now > attempt.blockedUntil);
    if (now - attempt.windowStart > PAIRING_WINDOW_MS && settled) pairingAttempts.delete(ip);
  }
  // A transfer whose sender disappeared leaves a .part behind; unlinking here is what keeps an
  // abandoned upload from accumulating in the vault as an invisible dot-file forever.
  for (const [key, task] of activeTransfers.entries()) {
    if (now - task.lastSeen > TRANSFER_IDLE_MS) discardTransfer(key, task, 'abandoned');
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

// Transfer history record store. Bounded like chatMessages below: this array is serialised into
// every /api/v1/files/list response, so an uncapped one grows for as long as the hub runs.
const transferHistory = [];
const TRANSFER_HISTORY_LIMIT = 200;
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

// In-flight encrypted transfers, keyed by task id plus destination name. The hub no longer
// finalizes a file because "a chunk claiming to be the last one arrived": that judgement is made
// from the authenticated chunk set, so the accounting has to live somewhere.
const activeTransfers = new Map();
const TRANSFER_IDLE_MS = 60 * 60 * 1000;

function discardTransfer(key, task, why) {
  activeTransfers.delete(key);
  if (!task.partPath) return;
  fs.unlink(task.partPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error(`[Upload] Could not remove abandoned ${task.partPath} (${why}):`, err.message);
    }
  });
}

/**
 * Positional write. 'r+' keeps an existing file intact, and 'wx' creates it without truncating,
 * because 'w+' would erase every chunk that arrived before this one.
 */
function writeChunkAtPosition(filePath, payload, position, callback) {
  fs.open(filePath, 'r+', (err, fd) => {
    const onFd = (openError, handle) => {
      if (openError) return callback(openError);
      fs.write(handle, payload, 0, payload.length, position, (writeError, written) => {
        fs.close(handle, () => {
          if (writeError) return callback(writeError);
          if (written !== payload.length) return callback(new Error(`short write at offset ${position}`));
          callback(null);
        });
      });
    };
    if (!err) return onFd(null, fd);
    if (err.code !== 'ENOENT') return onFd(err);
    fs.open(filePath, 'wx', (createError, handle) => {
      // Two first chunks of the same task can both find no file, because the open is what
      // creates it and that happens after the request was accepted. The loser then sees a file
      // that exists - which is exactly the 'r+' case - so reopening is the whole fix.
      if (createError && createError.code === 'EEXIST') return fs.open(filePath, 'r+', onFd);
      onFd(createError, handle);
    });
  });
}

/**
 * Decompress one chunk, refusing to hand back more than the sender committed to.
 *
 * The sealed body this hub accepts is capped, but what it inflates to is not, and a length check on
 * the finished output only runs after the whole thing is in memory. The bound is the stride the
 * sender authenticated in the AAD, so a chunk that exceeds it has already broken the geometry —
 * this just stops it from being a violation that costs this machine's memory first.
 */
function inflateChunk(payload, limit, callback) {
  const gunzip = zlib.createGunzip();
  const pieces = [];
  let total = 0;
  let settled = false;

  const settle = (err) => {
    if (settled) return;
    settled = true;
    if (err) gunzip.destroy();
    callback(err, err ? null : Buffer.concat(pieces));
  };

  gunzip.on('data', (piece) => {
    total += piece.length;
    if (total > limit) return settle(new Error(`inflated chunk exceeds the ${limit}-byte stride`));
    pieces.push(piece);
  });
  gunzip.on('error', (err) => settle(err));
  gunzip.on('end', () => settle(null));
  gunzip.end(payload);
}

/**
 * One authenticated chunk of a transfer destined for this hub.
 *
 * The chunk count and chunk size travel inside the AAD as well as in headers, which is what makes
 * the rest of this possible: a value that is not authenticated cannot be trusted to decide when a
 * file is finished, and "the sender says this was the last chunk" used to be the only rule. Each
 * chunk is then written at index * chunkSize instead of being appended, so a replayed chunk
 * overwrites itself rather than duplicating bytes, and arrival order stops mattering.
 */
function handleEncryptedChunk(ctx) {
  const { req, res, session, clientIp, taskId, safeName, partPath, chunkIndex, totalChunks, chunkSize, fileSize, isCompressed } = ctx;
  let answered = false;
  const fail = (status, message, extra) => {
    if (answered) return;
    answered = true;
    if (message) console.warn(`[Upload] Rejected chunk ${chunkIndex} of ${taskId}: ${message}`);
    jsonResponse(res, status, { ...(message ? { error: message } : {}), ...(extra || {}) });
  };

  let geometryError = null;
  try {
    cryptoProtocol.chunkAad(taskId, chunkIndex, totalChunks, chunkSize);
  } catch (e) {
    geometryError = e.message;
  }
  if (geometryError) return fail(400, `Invalid chunk geometry: ${geometryError}`);

  const key = `${taskId}|${safeName}`;
  let task = activeTransfers.get(key);
  if (!task) {
    task = {
      clientIp,
      partPath,
      count: totalChunks,
      chunkSize,
      received: new Map(),
      // Chunks whose write has actually completed. `received.size` alone cannot answer that,
      // because an index is recorded before its write finishes (see finish() below).
      written: 0,
      lastSeen: Date.now()
    };
    activeTransfers.set(key, task);
  } else {
    if (task.clientIp !== clientIp) {
      return fail(409, 'That task id is already in use by another peer');
    }
    if (task.count !== totalChunks || task.chunkSize !== chunkSize) {
      return fail(409, 'Chunk geometry changed mid-transfer; the task must be restarted');
    }
    task.lastSeen = Date.now();
  }

  const packets = [];
  let received = 0;
  req.on('data', (chunk) => {
    if (answered) return;
    received += chunk.length;
    if (received > cryptoProtocol.MAX_SEALED_CHUNK + cryptoProtocol.SEALED_OVERHEAD) {
      discardTransfer(key, task, 'oversized chunk');
      fail(413, 'Encrypted chunk exceeds the maximum accepted size');
    }
    packets.push(chunk);
  });
  req.on('error', (e) => fail(400, `Upload stream error: ${e.message}`));

  req.on('end', () => {
    if (answered) return;

    let plaintext;
    try {
      plaintext = cryptoProtocol.decryptChunk(session.key, Buffer.concat(packets), taskId, chunkIndex, totalChunks, chunkSize);
    } catch (e) {
      // An unknown task id, a rewritten X-Chunk-Count / X-Chunk-Size or edited ciphertext all
      // land here, because the header value is compared against bytes inside the sealed packet.
      return fail(400, `Chunk rejected: ${e.message}`);
    }

    const finish = (payload) => {
      const isLast = chunkIndex === totalChunks - 1;
      // Only the final chunk may be short: everything before it defines the stride the file is
      // reassembled at, so a short middle chunk means the sender lied about the geometry.
      if (payload.length > chunkSize || (!isLast && payload.length !== chunkSize)) {
        return fail(400, `Chunk ${chunkIndex} must carry ${isLast ? `at most ${chunkSize}` : `exactly ${chunkSize}`} bytes, got ${payload.length}`);
      }

      const digest = crypto.createHash('sha256').update(payload).digest('hex');
      const seen = task.received.get(chunkIndex);
      if (seen) {
        if (seen.length === payload.length && seen.digest === digest) {
          // Byte-identical resend: answer as if it worked, because it did, and the file on disk
          // is unchanged. This is what makes a client retry safe instead of corrupting.
          return respondProgress();
        }
        return fail(409, `Chunk ${chunkIndex} was already sent with different content`);
      }

      // Claim the index before the write rather than after it. Two requests for one index can
      // both get this far while the first is still inside fs.write, and without the claim the
      // second is judged against a record the first has not made yet - so one index can be
      // "accepted twice with different content", and whichever write lands last decides what the
      // file holds. The claim is taken back if the write fails.
      task.received.set(chunkIndex, { digest, length: payload.length });

      writeChunkAtPosition(task.partPath, payload, chunkIndex * chunkSize, (writeError) => {
        if (writeError) {
          task.received.delete(chunkIndex);
          discardTransfer(key, task, 'write failed');
          return fail(507, `Failed to store chunk ${chunkIndex}: ${writeError.message}`);
        }
        task.written += 1;
        // Completion is decided on chunks that are on disk, not merely claimed: renaming the
        // .part while the final write is still in it would save a file with a hole where that
        // chunk should be. Indices are validated against count and are unique in this map, so a
        // full set is exactly 0..count-1 - which is what makes the size derived below sound.
        if (task.written < totalChunks) return respondProgress();
        completeTransfer();
      });
    };

    if (isCompressed) {
      // Per chunk, after decryption: the stride this index is written at is the sender's
      // uncompressed slice size, so that stride is both the expected length and the ceiling.
      inflateChunk(plaintext, chunkSize, (err, payload) => {
        if (err) return fail(400, `Decompression failed: ${err.message}`);
        finish(payload);
      });
      return;
    }
    finish(plaintext);
  });

  function respondProgress() {
    if (answered) return;
    answered = true;
    jsonResponse(res, 200, {
      code: 0,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      chunks_received: task.written,
      status: 'chunk_received',
      compressed: isCompressed,
      encrypted: true
    });
  }

  function completeTransfer() {
    const lastEntry = task.received.get(totalChunks - 1);
    // Indices are validated against count and unique, so a full set is exactly 0..count-1; the
    // guard only keeps a future change to that reasoning from crashing the hub mid-transfer.
    if (!lastEntry) return fail(409, 'Transfer bookkeeping is inconsistent; the file was not saved');
    const derivedSize = (totalChunks - 1) * chunkSize + lastEntry.length;
    if (fileSize > 0 && fileSize !== derivedSize) {
      discardTransfer(key, task, 'size mismatch');
      return fail(400, `Declared file size ${fileSize} does not match the ${derivedSize} bytes that arrived`);
    }

    const finalPath = resolveUniqueFilePath(safeName);
    // A positional write only guarantees the bytes it wrote. If a .part left by an earlier,
    // interrupted attempt at the same task id is longer than this transfer, the reassembled
    // chunks sit at the front of it and the stale tail would be renamed along with them - a
    // file longer than the size just derived from the authenticated chunk set.
    try {
      fs.truncateSync(task.partPath, derivedSize);
    } catch (truncateError) {
      discardTransfer(key, task, 'truncate failed');
      return fail(507, `Failed to finalize ${safeName}: ${truncateError.message}`);
    }
    fs.rename(task.partPath, finalPath, (err) => {
      if (err) {
        discardTransfer(key, task, 'rename failed');
        return fail(500, `Failed to finalize file: ${err.message}`);
      }
      activeTransfers.delete(key);
      const finalName = path.basename(finalPath);
      transferHistory.unshift({
        taskId,
        fileName: finalName,
        fileSize: derivedSize,
        sender: clientIp,
        status: 'completed',
        path: finalPath,
        compressed: isCompressed,
        time: new Date().toLocaleTimeString()
      });
      if (transferHistory.length > TRANSFER_HISTORY_LIMIT) transferHistory.length = TRANSFER_HISTORY_LIMIT;
      console.log(`[SafeDrop] File successfully saved to vault: ${finalPath}${isCompressed ? ' (decompressed)' : ''} (decrypted)`);
      answered = true;
      jsonResponse(res, 200, {
        code: 0,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        chunks_received: totalChunks,
        status: 'completed',
        compressed: isCompressed,
        encrypted: true,
        file_name: finalName,
        file_size: derivedSize
      });
    });
  }
}

// Create HTTP server
const server = http.createServer(handleIncomingRequest);

/** Request headers the protocol allows a browser to send; derived so none can be forgotten. */
const CORS_ALLOW_HEADERS = ['Content-Type'].concat(Object.values(cryptoProtocol.HEADERS)).join(', ');

/**
 * Every browser that uses this hub loads its UI *from* the hub, so a legitimate caller's origin
 * is always one of this machine's own addresses. Answering `Access-Control-Allow-Origin: *`
 * instead let any page the user happens to visit on the LAN read and post to the API, so the
 * header is now echoed only for loopback and private-LAN origins.
 */
function allowedCorsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch (err) {
    return null;
  }
  host = host.replace(/^\[|\]$/g, '');
  return isTrustedLocal(host) || isPrivateLanIp(host) ? origin : null;
}

/**
 * HTTP and HTTPS share one request handler, so behaviour cannot drift between them.
 * `req.socket.encrypted` distinguishes the two when a response needs to know.
 */
function handleIncomingRequest(req, res) {
  // CORS support
  const allowedOrigin = allowedCorsOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // Derived from the protocol contract, because this list is exactly where a new chunk header
    // used to be forgotten.
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  }

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
      payload.webUrl = portalWebUrl();
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
    if (!ensureAuthorized(req, res)) return;
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
      for (const retired of retiredCredentials) {
        if (now - retired.at >= PAIRING_GRACE_MS) continue;
        candidates.push(retired.pin, retired.token);
      }

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

      // Retire the credentials that just got used, then rotate. Retired values are what is
      // still displayed on screen and in already-rendered QR codes, so they keep working for
      // the grace window instead of failing the next device to pair.
      retiredCredentials.unshift({ pin: currentPin, token: currentOneTimeToken, at: now });
      retiredCredentials = retiredCredentials
        .filter((entry) => now - entry.at < PAIRING_GRACE_MS)
        .slice(0, PAIRING_GRACE_GENERATIONS);
      currentPin = newPairingPin();
      currentOneTimeToken = newPairingToken();

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
    currentPin = newPairingPin();
    currentOneTimeToken = newPairingToken();
    const qrUri = `safedrop://pair?ip=${LOCAL_IP}&port=${PORT}&fp=${hostFingerprint}&token=${currentOneTimeToken}&pin=${currentPin}`;
    const webUrl = portalWebUrl();
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

    // Holding a session key is not the same as using it, and once plaintext is accepted nothing
    // authenticates the headers the receiver finishes a file from. The plaintext branch below is
    // therefore for this machine only; a peer that paired has no reason to leave its key unused.
    if (!isLocal && !isEncrypted) {
      return jsonResponse(res, 400, {
        code: 400,
        error: 'Transfers from the LAN must be encrypted (X-Encrypted: 1). Pair first.'
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
    const chunkSize = parseInt(req.headers['x-chunk-size'] || '0', 10);
    const fileSize = parseInt(req.headers['x-file-size'] || '0', 10);
    
    // NEW: Check if chunk is compressed
    const isCompressed = req.headers['x-compressed'] === 'gzip';

    const partPath = path.join(DOWNLOAD_DIR, `.${taskId}_${safeName}.part`);

    if (isEncrypted) {
      if (!session) {
        return jsonResponse(res, 400, {
          code: 400,
          error: 'X-Encrypted was set but no verified session key is available for this request'
        });
      }
      handleEncryptedChunk({
        req, res, session, clientIp, taskId, safeName, partPath,
        chunkIndex, totalChunks, chunkSize, fileSize, isCompressed
      });
      return;
    }

    // Plaintext path (loopback only, enforced above). This caller is this machine, which already
    // holds the vault and the PIN, so it keeps the simpler append-then-rename behaviour and the
    // completion rule it has always used; nothing on the network can reach this branch.
    const writeStream = fs.createWriteStream(partPath, { flags: 'a' });
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
          if (transferHistory.length > TRANSFER_HISTORY_LIMIT) transferHistory.length = TRANSFER_HISTORY_LIMIT;
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
    if (!ensureAuthorized(req, res)) return;
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
      // Log metadata only: message text is user content, and senderName is whatever the caller
      // claimed, so either would let a peer write arbitrary lines into the hub's log.
      console.log(`[Chat] Message recorded from ${clientIp || senderId} (${text.length} chars)`);

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
    if (!ensureAuthorized(req, res)) return;
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
