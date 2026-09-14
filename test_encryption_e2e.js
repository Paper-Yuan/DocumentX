/**
 * SafeDrop transport encryption end-to-end test.
 *
 * Spawns a real hub process and drives it as a remote LAN client would: pairing
 * handshake, encrypted chunked upload, authenticated download, and the negative cases
 * that matter (wrong PIN, tampered ciphertext, reordered chunks, unauthenticated access).
 *
 * Run: node test_encryption_e2e.js
 */
const assert = require('assert');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PROTO = require('./computer-design/desktop_hub/crypto_protocol');

// Ports are derived from the process id so back-to-back runs cannot collide with a listener
// that a previous hub has not released yet (which would otherwise stall the run).
const PORT_BASE = 17000 + (process.pid % 1000) * 10;
const HUB_PORT = PORT_BASE;
const TLS_PORT = PORT_BASE + 1;
const DEST_PORT = PORT_BASE + 2;
const LOOPBACK = '127.0.0.1';
const VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'safedrop-vault-'));

/**
 * Remote requests target this machine's LAN address. That yields a non-loopback TCP source
 * address, so the hub treats the client as untrusted LAN traffic exactly as it would a
 * phone. Loopback is used for the few checks that assert host-local trust.
 */
let LAN_HOST = LOOPBACK;

/**
 * Address used as the relay *destination*. It must differ from the hub's own LAN address and
 * from loopback, otherwise the hub treats the chunk as a local upload instead of a relay.
 * Any other local IPv4 works, since the stub listener binds 0.0.0.0.
 */
let RELAY_DEST_HOST = null;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function request(method, urlPath, { headers = {}, body = null, host = LAN_HOST, port = HUB_PORT, tls = false, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const transport = tls ? https : http;
    const options = tls
      ? { host, port, path: urlPath, method, headers, rejectUnauthorized: false, timeout: timeoutMs }
      : { host, port, path: urlPath, method, headers, timeout: timeoutMs };
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    // Without this a request to a port nobody is listening on can hang indefinitely on some
    // platforms, turning a clear failure into a stalled test run.
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs}ms: ${method} ${urlPath}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function json(res) {
  try { return JSON.parse(res.body.toString('utf8')); } catch (_) { return null; }
}

/** Perform the full pairing handshake as a LAN peer and return the session key. */
async function pair(pinOverride) {
  const keyPair = PROTO.generateKeyPair('x25519');
  const rawPub = PROTO.exportRawPublicKey(keyPair, 'x25519');

  const initRes = await request('POST', '/api/v1/handshake/init', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: rawPub.toString('hex'), curve: 'x25519' })
  });
  assert.strictEqual(initRes.status, 200, `handshake/init should succeed, got ${initRes.status}`);
  const initBody = json(initRes);
  assert.ok(initBody.session_id && initBody.server_public_key, 'init must return session id and server key');

  const secret = pinOverride !== undefined ? pinOverride : HUB_PIN;
  const shared = PROTO.computeSharedSecret(keyPair.privateKey, Buffer.from(initBody.server_public_key, 'hex'), 'x25519');
  const key = PROTO.deriveSessionKey(shared, initBody.session_id, String(secret));
  const proof = PROTO.clientProof(key, initBody.session_id).toString('hex');

  const verifyRes = await request('POST', '/api/v1/handshake/verify', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: initBody.session_id, proof })
  });

  return { sessionId: initBody.session_id, key, verifyRes };
}

let HUB_PIN = null;

async function main() {
  console.log('\n▶ Booting hub process...');

  // Collect every local IPv4 so the relay destination can be a different address than the
  // hub's own (the hub deliberately refuses to relay to itself).
  const localCandidates = [];
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const iface of os.networkInterfaces()[name] || []) {
      if (iface.family === 'IPv4' && !iface.address.startsWith('127.')) {
        localCandidates.push(iface.address);
      }
    }
  }

  const hub = spawn(process.execPath, [path.join('computer-design', 'desktop_hub', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(HUB_PORT),
      TLS_PORT: String(TLS_PORT),
      // Keep the test from rewriting the repository's config.json.
      SAFEDROP_CONFIG: path.join(VAULT_DIR, 'config.json')
      // Note: no SAFEDROP_RELAY_TARGETS. The stub destination sits on this machine's own
      // subnet, which the relay guard must allow by default.
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let hubLog = '';
  hub.stdout.on('data', (d) => { hubLog += d.toString(); });
  hub.stderr.on('data', (d) => { hubLog += d.toString(); });

  const shutdown = () => { try { hub.kill(); } catch (_) {} };
  process.on('exit', shutdown);

  // Wait for readiness on loopback.
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await request('GET', '/health', { host: LOOPBACK });
      if (r.status === 200) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, `hub did not become ready:\n${hubLog}`);

  // The HTTPS listener starts separately from the HTTP one, so confirm it before later
  // sections depend on it; otherwise a port conflict surfaces as a hang instead of a failure.
  let tlsReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await request('GET', '/health', { host: LOOPBACK, tls: true, port: TLS_PORT, timeoutMs: 2000 });
      if (r.status === 200) { tlsReady = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!tlsReady) {
    console.log(`\n!! HTTPS listener did not come up on ${TLS_PORT}. Hub output:\n${hubLog}\n`);
  }

  // Pick a LAN address so remote requests look like real LAN traffic.
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const iface of os.networkInterfaces()[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('198.18.')) {
        LAN_HOST = iface.address;
        break;
      }
    }
    if (LAN_HOST !== LOOPBACK) break;
  }
  console.log(`\n▶ Hub on ${LOOPBACK}:${HUB_PORT}; simulating a remote LAN peer from ${LAN_HOST}`);

  // The relay destination must not be the hub's own address, or the hub treats the chunk as
  // a local upload rather than a relay.
  const hubSelfIp = json(await request('GET', '/api/v1/info', { host: LOOPBACK }))?.localIp;
  RELAY_DEST_HOST = localCandidates.find((ip) => ip !== hubSelfIp) || null;
  if (RELAY_DEST_HOST) {
    console.log(`▶ Relay destination for the phone-to-phone check: ${RELAY_DEST_HOST}`);
  } else {
    console.log('▶ No alternate local address available; the relay section will report this.');
  }

  console.log('\n▶ Section 1: pairing-secret disclosure');
  const loopInfo = json(await request('GET', '/api/v1/info', { host: LOOPBACK }));
  check('host-local /info discloses the PIN (desktop UI needs it)', () => {
    assert.ok(loopInfo.pin && loopInfo.token, 'loopback caller should receive pin and token');
  });

  const remoteInfo = json(await request('GET', '/api/v1/info'));
  check('remote /info withholds the PIN and token', () => {
    assert.ok(!remoteInfo.pin, 'PIN must not be sent to a LAN caller');
    assert.ok(!remoteInfo.token, 'token must not be sent to a LAN caller');
    assert.strictEqual(remoteInfo.secretsDisclosed, false);
  });

  const remoteRefresh = await request('POST', '/api/v1/pin/refresh', {
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  check('remote pin/refresh is forbidden', () => {
    assert.strictEqual(remoteRefresh.status, 403, `expected 403, got ${remoteRefresh.status}`);
  });

  HUB_PIN = loopInfo.pin;
  console.log(`    (test environment pin = ${HUB_PIN})`);

  // Point the hub at a scratch vault so the on-disk result can be inspected directly.
  const setDir = await request('POST', '/api/v1/settings/dir', {
    host: LOOPBACK,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: VAULT_DIR })
  });
  check('host-local vault reconfiguration is accepted', () => {
    assert.strictEqual(setDir.status, 200, `got ${setDir.status}: ${setDir.body}`);
  });

  console.log('\n▶ Section 2: handshake');
  const paired = await pair();
  check('correct PIN yields a verified session', () => {
    assert.strictEqual(paired.verifyRes.status, 200, `got ${paired.verifyRes.status}: ${paired.verifyRes.body}`);
    const b = json(paired.verifyRes);
    assert.strictEqual(b.status, 'verified');
  });
  check('hub returns a server proof we can verify', () => {
    const b = json(paired.verifyRes);
    const expected = PROTO.serverProof(paired.key, paired.sessionId).toString('hex');
    assert.strictEqual(b.server_proof, expected);
  });

  const badPin = await pair('000000' === String(HUB_PIN) ? '111111' : '000000');
  check('wrong PIN is rejected with 403', () => {
    assert.strictEqual(badPin.verifyRes.status, 403, `got ${badPin.verifyRes.status}`);
  });

  console.log('\n▶ Section 3: uploaded file content');
  const taskId = `task_${Date.now()}`;
  const fileName = 'encrypted_payload.bin';
  const payload = crypto.randomBytes(300 * 1024);
  const chunkSize = 100 * 1024;
  const totalChunks = Math.ceil(payload.length / chunkSize);

  const uploadStatuses = [];
  for (let i = 0; i < totalChunks; i++) {
    const slice = payload.subarray(i * chunkSize, Math.min(payload.length, (i + 1) * chunkSize));
    const sealed = PROTO.encryptChunk(paired.key, slice, taskId, i);
    const res = await request('POST', '/api/v1/transfer/upload', {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Task-Id': taskId,
        'X-File-Name': encodeURIComponent(fileName),
        'X-File-Size': String(payload.length),
        'X-Chunk-Index': String(i),
        'X-Chunk-Count': String(totalChunks),
        'X-Encrypted': '1',
        'X-Session-Id': paired.sessionId
      },
      body: sealed
    });
    uploadStatuses.push(res.status);
  }
  check('all encrypted chunks are accepted', () => {
    assert.ok(uploadStatuses.every((s) => s === 200), `statuses: ${uploadStatuses.join(',')}`);
  });

  check('the file on disk is the plaintext, not the ciphertext', () => {
    const stored = fs.readFileSync(path.join(VAULT_DIR, fileName));
    assert.strictEqual(stored.length, payload.length, `stored ${stored.length} bytes, expected ${payload.length}`);
    assert.ok(stored.equals(payload), 'stored bytes differ from the original plaintext');
  });

  check('the sealed wire packets differ from what was written', () => {
    const firstSlice = payload.subarray(0, chunkSize);
    const sealed = PROTO.encryptChunk(paired.key, firstSlice, taskId, 0);
    const wirePayload = sealed.subarray(PROTO.NONCE_LEN, sealed.length - PROTO.TAG_LEN);
    assert.ok(!wirePayload.equals(firstSlice), 'ciphertext should not equal plaintext');
    assert.strictEqual(wirePayload.length, firstSlice.length, 'GCM ciphertext keeps the plaintext length');
  });

  const dl = await request('GET', `/api/v1/files/download/${encodeURIComponent(fileName)}`, {
    headers: { 'X-Session-Id': paired.sessionId }
  });
  check('authenticated download returns the original bytes', () => {
    assert.strictEqual(dl.status, 200, `got ${dl.status}`);
    assert.strictEqual(dl.body.length, payload.length, `length ${dl.body.length} != ${payload.length}`);
    assert.ok(dl.body.equals(payload), 'content mismatch');
  });

  console.log('\n▶ Section 4: negative cases');
  const noSession = await request('GET', '/api/v1/files/list');
  check('unauthenticated vault listing is rejected', () => {
    assert.strictEqual(noSession.status, 401, `expected 401, got ${noSession.status}`);
  });

  const noSessionDl = await request('GET', `/api/v1/files/download/${encodeURIComponent(fileName)}`);
  check('unauthenticated download is rejected', () => {
    assert.strictEqual(noSessionDl.status, 401, `expected 401, got ${noSessionDl.status}`);
  });

  const tamperTask = `task_tamper_${Date.now()}`;
  const sealedTamper = PROTO.encryptChunk(paired.key, Buffer.from('authentic payload'), tamperTask, 0);
  sealedTamper[sealedTamper.length - 1] ^= 0x01; // flip one bit of the GCM tag
  const tamperRes = await request('POST', '/api/v1/transfer/upload', {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Task-Id': tamperTask,
      'X-File-Name': encodeURIComponent('tampered.bin'),
      'X-Chunk-Index': '0',
      'X-Chunk-Count': '1',
      'X-Encrypted': '1',
      'X-Session-Id': paired.sessionId
    },
    body: sealedTamper
  });
  check('tampered ciphertext is rejected', () => {
    assert.strictEqual(tamperRes.status, 400, `expected 400, got ${tamperRes.status}`);
  });

  const reorderTask = `task_reorder_${Date.now()}`;
  const sealedForIndex1 = PROTO.encryptChunk(paired.key, Buffer.from('chunk one'), reorderTask, 1);
  const reorderRes = await request('POST', '/api/v1/transfer/upload', {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Task-Id': reorderTask,
      'X-File-Name': encodeURIComponent('reordered.bin'),
      'X-Chunk-Index': '0', // claiming index 0 while sealed for index 1
      'X-Chunk-Count': '2',
      'X-Encrypted': '1',
      'X-Session-Id': paired.sessionId
    },
    body: sealedForIndex1
  });
  check('a chunk presented under the wrong index is rejected (AAD binding)', () => {
    assert.strictEqual(reorderRes.status, 400, `expected 400, got ${reorderRes.status}`);
  });

  const noSecretPair = await pair('999999');
  check('a session id cannot be hijacked with a forged proof', () => {
    assert.strictEqual(noSecretPair.verifyRes.status, 403, `expected 403, got ${noSecretPair.verifyRes.status}`);
  });

  const encryptedWithoutSession = await request('POST', '/api/v1/transfer/upload', {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Task-Id': 'task_nosess',
      'X-File-Name': 'nosess.bin',
      'X-Chunk-Index': '0',
      'X-Chunk-Count': '1',
      'X-Encrypted': '1'
    },
    body: Buffer.from('nope')
  });
  check('X-Encrypted without a session is refused', () => {
    assert.ok([400, 401].includes(encryptedWithoutSession.status),
      `expected 400/401, got ${encryptedWithoutSession.status}`);
  });

  const plaintextRemote = await request('POST', '/api/v1/transfer/upload', {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Task-Id': 'task_plain',
      'X-File-Name': 'plain.bin',
      'X-Chunk-Index': '0',
      'X-Chunk-Count': '1'
    },
    body: Buffer.from('plaintext attempt')
  });
  check('plaintext upload without a session is refused', () => {
    assert.strictEqual(plaintextRemote.status, 401, `expected 401, got ${plaintextRemote.status}`);
  });

  console.log('\n▶ Section 5: rate limiting');
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const attempt = await pair('123456' === String(HUB_PIN) ? '654321' : '123456');
    if (attempt.verifyRes.status === 429) { limited = true; break; }
  }
  check('repeated wrong PINs trigger 429 rate limiting', () => {
    assert.ok(limited, 'expected the hub to rate limit repeated pairing failures');
  });

  console.log('\n▶ Section 6: phone-to-phone relay (sealed bytes forwarded untouched)');
  if (!RELAY_DEST_HOST) {
    check('a relay destination distinct from the hub is available', () => {
      assert.fail('no alternate local IPv4 address; cannot exercise the relay path on this host');
    });
  } else {
  // The sender negotiates its own session with the destination phone; the hub holds no such
  // key, so it must forward the sealed bytes without unwrapping them.
  // The destination is on this machine's own subnet and was NOT allowlisted via the
  // environment, so reaching it also proves the same-subnet rule works by default.
  const lanGuard = require('./computer-design/desktop_hub/lan_guard');
  check('the relay destination is on the hub own subnet', () => {
    assert.ok(lanGuard.isOnLocalSubnet(RELAY_DEST_HOST), `${RELAY_DEST_HOST} should be on-link`);
  });
  const destKeyPair = PROTO.generateKeyPair('x25519');
  const destRawPub = PROTO.exportRawPublicKey(destKeyPair, 'x25519');
  const senderKeyPair = PROTO.generateKeyPair('x25519');
  const senderRawPub = PROTO.exportRawPublicKey(senderKeyPair, 'x25519');

  const destSessionId = crypto.randomBytes(16).toString('hex');
  const destPin = '246810';
  const senderToDestKey = PROTO.deriveSessionKey(
    PROTO.computeSharedSecret(senderKeyPair.privateKey, destRawPub, 'x25519'),
    destSessionId, destPin
  );
  const destKey = PROTO.deriveSessionKey(
    PROTO.computeSharedSecret(destKeyPair.privateKey, senderRawPub, 'x25519'),
    destSessionId, destPin
  );
  check('sender and destination phone derive the same key', () => {
    assert.ok(senderToDestKey.equals(destKey));
  });

  // A stub standing in for the destination phone, so the relay hop can be observed.
  const received = [];
  const destPhone = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        body: Buffer.concat(chunks),
        sessionId: req.headers['x-session-id'],
        encrypted: req.headers['x-encrypted']
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, status: 'chunk_received' }));
    });
  });
  await new Promise((resolve) => destPhone.listen(DEST_PORT, '0.0.0.0', resolve));

  const relayTaskId = `relay_${Date.now()}`;
  const relayPlaintext = crypto.randomBytes(4096);
  const relaySealed = PROTO.encryptChunk(senderToDestKey, relayPlaintext, relayTaskId, 0);

  const relayRes = await request('POST', '/api/v1/transfer/upload', {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Task-Id': relayTaskId,
      'X-File-Name': 'relayed.bin',
      'X-Chunk-Index': '0',
      'X-Chunk-Count': '1',
      'X-Encrypted': '1',
      'X-Session-Id': paired.sessionId,        // session with the hub
      'X-Target-Session-Id': destSessionId,    // session with the destination phone
      'X-Target-Ip': RELAY_DEST_HOST,
      'X-Target-Port': String(DEST_PORT)
    },
    body: relaySealed
  });

  check('the hub accepts and forwards the relayed chunk', () => {
    assert.strictEqual(relayRes.status, 200, `got ${relayRes.status}: ${relayRes.body}`);
  });

  check('the destination received the sealed bytes byte-for-byte', () => {
    assert.strictEqual(received.length, 1, `expected 1 forwarded chunk, got ${received.length}`);
    assert.ok(received[0].body.equals(relaySealed), 'forwarded bytes differ from what the sender sealed');
  });

  check('the destination can decrypt with the key it negotiated with the sender', () => {
    const opened = PROTO.decryptChunk(destKey, received[0].body, relayTaskId, 0);
    assert.ok(opened.equals(relayPlaintext), 'decrypted content differs from the original plaintext');
  });

  check('the destination session id is forwarded, not the hub session id', () => {
    assert.strictEqual(received[0].sessionId, destSessionId);
    assert.notStrictEqual(received[0].sessionId, paired.sessionId);
  });

  await new Promise((resolve) => destPhone.close(resolve));
  }

  console.log('\n▶ Section 7: HTTPS portal (needed for browser WebCrypto)');
  const tlsInfo = json(await request('GET', '/api/v1/info', { host: LOOPBACK, tls: true, port: TLS_PORT }));
  check('the hub serves /api/v1/info over HTTPS', () => {
    assert.ok(tlsInfo && tlsInfo.code === 0, 'HTTPS /info should respond');
  });
  check('/info advertises the HTTPS portal URL', () => {
    assert.ok(String(tlsInfo.webUrl).startsWith('https://'), `expected https webUrl, got ${tlsInfo.webUrl}`);
    assert.strictEqual(tlsInfo.tlsPort, TLS_PORT);
  });

  // The portal's own encryption path, exercised against the TLS listener.
  const tlsPair = PROTO.generateKeyPair('x25519');
  const tlsPub = PROTO.exportRawPublicKey(tlsPair, 'x25519');
  const tlsInit = json(await request('POST', '/api/v1/handshake/init', {
    host: LOOPBACK, tls: true, port: TLS_PORT,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: tlsPub.toString('hex'), curve: 'x25519' })
  }));
  const tlsShared = PROTO.computeSharedSecret(tlsPair.privateKey, Buffer.from(tlsInit.server_public_key, 'hex'), 'x25519');
  const tlsKey = PROTO.deriveSessionKey(tlsShared, tlsInit.session_id, String(tlsInfo.pin));
  const tlsProof = PROTO.clientProof(tlsKey, tlsInit.session_id).toString('hex');
  const tlsVerify = await request('POST', '/api/v1/handshake/verify', {
    host: LOOPBACK, tls: true, port: TLS_PORT,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: tlsInit.session_id, proof: tlsProof })
  });
  check('handshake completes over HTTPS', () => {
    assert.strictEqual(tlsVerify.status, 200, `got ${tlsVerify.status}`);
  });

  const tlsTaskId = `tls_task_${Date.now()}`;
  const tlsPayload = crypto.randomBytes(200 * 1024);
  const tlsUpload = await request('POST', '/api/v1/transfer/upload', {
    host: LOOPBACK, tls: true, port: TLS_PORT,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Task-Id': tlsTaskId,
      'X-File-Name': 'tls_encrypted.bin',
      'X-Chunk-Index': '0',
      'X-Chunk-Count': '1',
      'X-Encrypted': '1',
      'X-Session-Id': tlsInit.session_id
    },
    body: PROTO.encryptChunk(tlsKey, tlsPayload, tlsTaskId, 0)
  });
  check('encrypted upload is accepted over HTTPS', () => {
    assert.strictEqual(tlsUpload.status, 200, `got ${tlsUpload.status}: ${tlsUpload.body}`);
  });
  check('HTTPS upload is decrypted correctly on disk', () => {
    const stored = fs.readFileSync(path.join(VAULT_DIR, 'tls_encrypted.bin'));
    assert.ok(stored.equals(tlsPayload), 'stored bytes differ from the plaintext sent');
  });

  shutdown();
  fs.rmSync(VAULT_DIR, { recursive: true, force: true });

  console.log(`\n====================================================`);
  console.log(`  Passed: ${passed}    Failed: ${failed}`);
  console.log(`====================================================\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nTest harness error:', e);
  process.exit(1);
});
