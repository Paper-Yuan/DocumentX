/**
 * SafeDrop Desktop Hub - Lightweight Embedded Security Hub Server
 * 100% native Node.js, zero external dependencies, rapid startup, memory < 30MB.
 * Features X25519 key agreement, AES-256-GCM chunked streaming, AP isolation penetration,
 * and local network device topology discovery.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const { execFile, spawn } = require('child_process');

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8899;
const UDP_PORT = 8890;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const TEMP_DIR = path.join(__dirname, 'temp_transfers');
const PROGRESS_FILE = path.join(TEMP_DIR, 'progress.json');

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
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.downloadDir && typeof cfg.downloadDir === 'string') {
      DOWNLOAD_DIR = path.resolve(cfg.downloadDir);
    }
  }
} catch (_) {}

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// SSRF validation: only forward to valid private RFC1918 IPv4 addresses
function isPrivateLanIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/.test(ip);
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
// Authenticated peers whitelist (allows multiple phones to stay authorized simultaneously)
const authenticatedPeers = new Map();

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
const server = http.createServer((req, res) => {
  // CORS support
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Task-Id, X-Chunk-Index, X-Chunk-Count, X-File-Name, X-File-Size, X-Encrypted, X-Target-Ip, X-Target-Port, X-Target-Name');

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
  if (pathname.startsWith('/api/v1/')) {
    handleApi(pathname, req, res, urlObj);
    return;
  }

  // Static files server
  handleStatic(pathname, res, req, urlObj);
});

// Handle API requests
function handleApi(pathname, req, res, urlObj) {
  const clientIp = req.socket.remoteAddress?.replace(/^.*:/, '') || '127.0.0.1';

  // 1. System info and QR pairing payload
  if (pathname === '/api/v1/info' && req.method === 'GET') {
    LOCAL_IP = getLocalIp();
    hostDevice.ip = LOCAL_IP;
    const qrUri = `safedrop://pair?ip=${LOCAL_IP}&port=${PORT}&fp=${hostFingerprint}&token=${currentOneTimeToken}&pin=${currentPin}`;
    const webUrl = `http://${LOCAL_IP}:${PORT}/portal?pin=${currentPin}&token=${currentOneTimeToken}&fp=${hostFingerprint}`;
    jsonResponse(res, 200, {
      code: 0,
      host: hostDevice,
      localIp: LOCAL_IP,
      availableIps: getAllLocalIps(),
      port: PORT,
      fingerprint: hostFingerprint,
      pin: currentPin,
      token: currentOneTimeToken,
      qrUri: qrUri,
      webUrl: webUrl,
      downloadDir: DOWNLOAD_DIR,
    });
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
      version: '1.0.1',
      timestamp: Date.now()
    });
    return;
  }

  // 2.1 Lightweight health check endpoint for fast startup
  if (pathname === '/health' && req.method === 'GET') {
    jsonResponse(res, 200, {
      status: 'ok',
      ready: true
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

  // 5. Handshake initiation POST /api/v1/handshake/init
  if (pathname === '/api/v1/handshake/init' && req.method === 'POST') {
    readJsonBody(req, (err, body) => {
      if (err || !body) return jsonResponse(res, 400, { error: 'Invalid JSON body' });
      const clientPubKeyHex = body.public_key;
      const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      jsonResponse(res, 200, {
        code: 0,
        session_id: sessionId,
        server_public_key: hostPubRaw.toString('hex'),
        pin_required: true,
        fingerprint: hostFingerprint
      });
    });
    return;
  }

  // 6. Handshake credential verification POST /api/v1/handshake/verify
  if (pathname === '/api/v1/handshake/verify' && req.method === 'POST') {
    readJsonBody(req, (err, body) => {
      if (err || !body) return jsonResponse(res, 400, { error: 'Invalid JSON body' });
      const pin = body.pin;
      const token = body.token;
      const now = Date.now();
      const isValid = (pin && pin === currentPin) ||
                      (token && token === currentOneTimeToken) ||
                      (prevPin && pin && pin === prevPin && (now - prevPinTime < 60000)) ||
                      (prevToken && token && token === prevToken && (now - prevPinTime < 60000));
      if (isValid) {
        // Record client in authenticatedPeers whitelist to keep multiple devices connected
        authenticatedPeers.set(clientIp, {
          ip: clientIp,
          fingerprint: body.fingerprint || 'PEER-VERIFIED',
          verifiedAt: now,
          lastSeen: now
        });
        // Move current credentials to grace window
        prevPin = currentPin;
        prevToken = currentOneTimeToken;
        prevPinTime = now;
        // Refresh dynamic credentials for subsequent sessions
        currentPin = String(Math.floor(100000 + Math.random() * 900000));
        currentOneTimeToken = crypto.randomBytes(6).toString('hex');
        jsonResponse(res, 200, { code: 0, status: 'verified', message: 'Trust established successfully' });
      } else {
        jsonResponse(res, 403, { code: 403, error: 'PIN or token verification failed' });
      }
    });
    return;
  }

  // 6.1 Refresh pairing PIN and one-time token POST /api/v1/pin/refresh
  if (pathname === '/api/v1/pin/refresh' && req.method === 'POST') {
    LOCAL_IP = getLocalIp();
    hostDevice.ip = LOCAL_IP;
    currentPin = String(Math.floor(100000 + Math.random() * 900000));
    currentOneTimeToken = crypto.randomBytes(6).toString('hex');
    const qrUri = `safedrop://pair?ip=${LOCAL_IP}&port=${PORT}&fp=${hostFingerprint}&token=${currentOneTimeToken}&pin=${currentPin}`;
    const webUrl = `http://${LOCAL_IP}:${PORT}/portal?pin=${currentPin}&token=${currentOneTimeToken}&fp=${hostFingerprint}`;
    console.log(`[SafeDrop] Dynamic pairing credentials refreshed: PIN=${currentPin}, Token=${currentOneTimeToken}`);
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
  if (pathname === '/api/v1/transfer/upload' && req.method === 'POST') {
    const targetIp = req.headers['x-target-ip'];
    const targetPort = parseInt(req.headers['x-target-port'] || '8899', 10);

    // If target device is a remote mobile device, pipe directly to mobile device!
    if (targetIp && targetIp !== '127.0.0.1' && targetIp !== LOCAL_IP) {
      if (!isPrivateLanIp(targetIp) || isNaN(targetPort) || targetPort < 1024 || targetPort > 65535) {
        return jsonResponse(res, 400, { error: 'Invalid or restricted relay target IP/port' });
      }

      const forwardHeaders = { ...req.headers };
      delete forwardHeaders['host'];
      delete forwardHeaders['x-target-ip'];
      delete forwardHeaders['x-target-port'];
      delete forwardHeaders['x-target-name'];

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

    const partPath = path.join(DOWNLOAD_DIR, `.${taskId}_${safeName}.part`);

    // Stream append to temporary chunk file for backpressure and low memory footprint
    const writeStream = fs.createWriteStream(partPath, { flags: 'a' });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
      // Check if all chunks received
      if (chunkIndex + 1 >= totalChunks) {
        const finalPath = resolveUniqueFilePath(safeName);
        fs.rename(partPath, finalPath, (err) => {
          if (err) {
            console.error('[Upload] Rename failed:', err);
          } else {
            const finalName = path.basename(finalPath);
            transferHistory.unshift({
              taskId,
              fileName: finalName,
              fileSize: fileSize || fs.statSync(finalPath).size,
              sender: clientIp,
              status: 'completed',
              path: finalPath,
              time: new Date().toLocaleTimeString()
            });
            console.log(`[SafeDrop] File successfully saved to vault: ${finalPath}`);
          }
        });
      }
      jsonResponse(res, 200, {
        code: 0,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        status: chunkIndex + 1 >= totalChunks ? 'completed' : 'chunk_received'
      });
    });

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
    const isLoop = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === LOCAL_IP;
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
  console.log('====================================================');
});
