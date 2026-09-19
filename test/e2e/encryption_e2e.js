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
const zlib = require('zlib');
const { spawn } = require('child_process');

const PROTO = require('../../apps/desktop/desktop_hub/crypto_protocol');

/**
 * Seal one chunk the way a sender has to: the index, the chunk count and the stride all go into
 * the AAD, so a receiver can tell "this chunk is genuine" apart from "this file is complete".
 * `stride` is the sender's slice size, i.e. the offset step, not the length of this packet.
 */
function sealChunk(key, plaintext, taskId, index, count, stride) {
  return PROTO.encryptChunk(key, plaintext, taskId, index, count, stride);
}

/** The chunk geometry headers that go with a sealed chunk. */
function chunkHeaders(taskId, index, count, stride) {
  return {
    'X-Task-Id': taskId,
    'X-Chunk-Index': String(index),
    'X-Chunk-Count': String(count),
    'X-Chunk-Size': String(stride)
  };
}

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
let skipped = 0;

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

/**
 * A check this machine cannot run. Loud, counted, and never a pass: a section that quietly
 * disappears from the tally is how the relay path stopped being covered in the first place.
 */
function skip(name, why) {
  skipped++;
  console.log(`  - SKIPPED ${name}\n      ${why}`);
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

  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'apps', 'desktop', 'desktop_hub', 'server.js')], {
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
  // Deliberately not a multiple of the chunk stride, so the short final chunk is exercised.
  const payload = crypto.randomBytes(300 * 1024 + 7);
  const chunkSize = 100 * 1024;
  const totalChunks = Math.ceil(payload.length / chunkSize);

  const uploadStatuses = [];
  for (let i = 0; i < totalChunks; i++) {
    const slice = payload.subarray(i * chunkSize, Math.min(payload.length, (i + 1) * chunkSize));
    const sealed = sealChunk(paired.key, slice, taskId, i, totalChunks, chunkSize);
    const res = await request('POST', '/api/v1/transfer/upload', {
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(fileName),
        'X-File-Size': String(payload.length),
        'X-Encrypted': '1',
        'X-Session-Id': paired.sessionId
      }, chunkHeaders(taskId, i, totalChunks, chunkSize)),
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
    const sealed = sealChunk(paired.key, firstSlice, taskId, 0, totalChunks, chunkSize);
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

  // Compression is per chunk and happens before the seal, so the stride the receiver reassembles
  // at is the *uncompressed* slice size. Nothing else in the suite touches that branch.
  console.log('\n▶ Section 3b: compressed chunks');
  const gzTask = `task_gz_${Date.now()}`;
  const gzName = 'compressed_payload.bin';
  const gzPlain = crypto.randomBytes(250 * 1024 + 11);
  const gzStride = 100 * 1024;
  const gzCount = Math.ceil(gzPlain.length / gzStride);

  const gzStatuses = [];
  for (let i = 0; i < gzCount; i++) {
    const slice = gzPlain.subarray(i * gzStride, Math.min(gzPlain.length, (i + 1) * gzStride));
    const sealed = sealChunk(paired.key, zlib.gzipSync(slice), gzTask, i, gzCount, gzStride);
    const res = await request('POST', '/api/v1/transfer/upload', {
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(gzName),
        'X-File-Size': String(gzPlain.length),
        'X-Encrypted': '1',
        'X-Compressed': 'gzip',
        'X-Session-Id': paired.sessionId
      }, chunkHeaders(gzTask, i, gzCount, gzStride)),
      body: sealed
    });
    gzStatuses.push(res.status);
  }
  check('every compressed chunk is accepted', () => {
    assert.ok(gzStatuses.every((s) => s === 200), `statuses: ${gzStatuses.join(',')}`);
  });

  check('the vault holds the inflated file, not the gzip stream', () => {
    const stored = fs.readFileSync(path.join(VAULT_DIR, gzName));
    assert.strictEqual(stored.length, gzPlain.length, `stored ${stored.length} bytes, expected ${gzPlain.length}`);
    assert.ok(stored.equals(gzPlain), 'reassembled bytes differ from the original plaintext');
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
  const tamperPlain = Buffer.from('authentic payload');
  const sealedTamper = sealChunk(paired.key, tamperPlain, tamperTask, 0, 1, tamperPlain.length);
  sealedTamper[sealedTamper.length - 1] ^= 0x01; // flip one bit of the GCM tag
  const tamperRes = await request('POST', '/api/v1/transfer/upload', {
    headers: Object.assign({
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('tampered.bin'),
      'X-Encrypted': '1',
      'X-Session-Id': paired.sessionId
    }, chunkHeaders(tamperTask, 0, 1, tamperPlain.length)),
    body: sealedTamper
  });
  check('tampered ciphertext is rejected', () => {
    assert.strictEqual(tamperRes.status, 400, `expected 400, got ${tamperRes.status}`);
  });

  const reorderTask = `task_reorder_${Date.now()}`;
  const sealedForIndex1 = sealChunk(paired.key, Buffer.from('chunk one'), reorderTask, 1, 2, 9);
  const reorderRes = await request('POST', '/api/v1/transfer/upload', {
    headers: Object.assign({
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('reordered.bin'),
      'X-Encrypted': '1',
      'X-Session-Id': paired.sessionId
    }, chunkHeaders(reorderTask, 0, 2, 9)), // claiming index 0 while sealed for index 1
    body: sealedForIndex1
  });
  check('a chunk presented under the wrong index is rejected (AAD binding)', () => {
    assert.strictEqual(reorderRes.status, 400, `expected 400, got ${reorderRes.status}`);
  });

  // The three cases below are what binding count and stride into the AAD buys: previously the
  // headers decided when a file was finished, and nothing authenticated the headers.
  const lieTask = `task_countlie_${Date.now()}`;
  const lieStride = 16;
  const lieChunks = [Buffer.from('0123456789abcdef'), Buffer.from('0123456789abcdef'), Buffer.from('xy')];
  const lieStatuses = [];
  for (let i = 0; i < lieChunks.length; i++) {
    const sealed = sealChunk(paired.key, lieChunks[i], lieTask, i, lieChunks.length, lieStride);
    lieStatuses.push((await request('POST', '/api/v1/transfer/upload', {
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('count_lie.bin'),
        'X-File-Size': String(lieChunks[0].length * 2 + lieChunks[2].length),
        'X-Encrypted': '1',
        'X-Session-Id': paired.sessionId
      }, chunkHeaders(lieTask, i, i === 0 ? lieChunks.length : 1, lieStride)), // from chunk 1 on it claims count=1
      body: sealed
    })).status);
  }
  check('rewriting X-Chunk-Count to finalize early is rejected', () => {
    assert.strictEqual(lieStatuses[0], 200, `first chunk should be accepted, got ${lieStatuses[0]}`);
    assert.strictEqual(lieStatuses[1], 400, `a chunk sealed for count=3 must not pass as count=1, got ${lieStatuses[1]}`);
    assert.ok(!fs.existsSync(path.join(VAULT_DIR, 'count_lie.bin')), 'the file must not appear in the vault');
  });

  const dropTask = `task_drop_${Date.now()}`;
  const dropStride = 16;
  const dropChunks = [Buffer.from('0123456789abcdef'), Buffer.from('0123456789abcdef'), Buffer.from('end')];
  for (let i = 0; i < dropChunks.length; i++) {
    if (i === 1) continue; // silently lose the middle chunk
    const sealed = sealChunk(paired.key, dropChunks[i], dropTask, i, dropChunks.length, dropStride);
    await request('POST', '/api/v1/transfer/upload', {
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('dropped.bin'),
        'X-Encrypted': '1',
        'X-Session-Id': paired.sessionId
      }, chunkHeaders(dropTask, i, dropChunks.length, dropStride)),
      body: sealed
    });
  }
  check('a file with a missing middle chunk is never finalized', () => {
    assert.ok(!fs.existsSync(path.join(VAULT_DIR, 'dropped.bin')), 'a truncated file must not be renamed into the vault');
  });

  const dupTask = `task_dup_${Date.now()}`;
  const dupStride = 8;
  const dupA = Buffer.from('aaaaaaaa');
  const sendDup = async (payload, index, count, stride) => (await request('POST', '/api/v1/transfer/upload', {
    headers: Object.assign({
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('dup.bin'),
      'X-Encrypted': '1',
      'X-Session-Id': paired.sessionId
    }, chunkHeaders(dupTask, index, count, stride)),
    body: sealChunk(paired.key, payload, dupTask, index, count, stride)
  })).status;
  const dupStatuses = [];
  dupStatuses.push(await sendDup(dupA, 0, 2, dupStride));
  dupStatuses.push(await sendDup(dupA, 0, 2, dupStride));
  dupStatuses.push(await sendDup(Buffer.from('bbbbbbbb'), 0, 2, dupStride));
  dupStatuses.push(await sendDup(Buffer.from('z'), 1, 2, dupStride));
  check('resending an identical chunk is idempotent, resending different bytes is refused', () => {
    assert.deepStrictEqual(dupStatuses, [200, 200, 409, 200], `statuses: ${dupStatuses.join(',')}`);
    const stored = fs.readFileSync(path.join(VAULT_DIR, 'dup.bin'));
    assert.ok(stored.equals(Buffer.concat([dupA, Buffer.from('z')])), `retry must not corrupt the file, got ${stored.toString('hex')}`);
  });

  const oooTask = `task_ooo_${Date.now()}`;
  const oooStride = 8;
  const oooChunks = [Buffer.from('first--1'), Buffer.from('second-2'), Buffer.from('tail')];
  const oooOrder = [2, 0, 1];
  const oooStatuses = [];
  for (const i of oooOrder) {
    oooStatuses.push(await request('POST', '/api/v1/transfer/upload', {
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('out_of_order.bin'),
        'X-Encrypted': '1',
        'X-Session-Id': paired.sessionId
      }, chunkHeaders(oooTask, i, oooChunks.length, oooStride)),
      body: sealChunk(paired.key, oooChunks[i], oooTask, i, oooChunks.length, oooStride)
    }).then((r) => r.status));
  }
  check('chunks applied out of order still reassemble in the right order', () => {
    assert.ok(oooStatuses.every((s) => s === 200), `statuses: ${oooStatuses.join(',')}`);
    const stored = fs.readFileSync(path.join(VAULT_DIR, 'out_of_order.bin'));
    assert.ok(stored.equals(Buffer.concat(oooChunks)), `got ${JSON.stringify(stored.toString())}`);
  });

  const sizeTask = `task_size_${Date.now()}`;
  const sizePlain = Buffer.from('0123456789abcdef');
  const sizeRes = await request('POST', '/api/v1/transfer/upload', {
    headers: Object.assign({
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('stride.bin'),
      'X-Encrypted': '1',
      'X-Session-Id': paired.sessionId
    }, chunkHeaders(sizeTask, 0, 1, sizePlain.length)),
    body: sealChunk(paired.key, sizePlain, sizeTask, 0, 1, sizePlain.length + 1) // header stride != AAD stride
  });
  check('a rewritten X-Chunk-Size breaks the tag and is rejected', () => {
    assert.strictEqual(sizeRes.status, 400, `expected 400, got ${sizeRes.status}`);
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

  // Having a session key and using it are two different things, and the plaintext branch has no
  // authenticated chunk set behind it at all, so a paired peer must not be able to choose it.
  const plaintextWithSession = await request('POST', '/api/v1/transfer/upload', {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Task-Id': `task_plain_sess_${Date.now()}`,
      'X-File-Name': 'plain_with_session.bin',
      'X-Chunk-Index': '0',
      'X-Chunk-Count': '1',
      'X-Session-Id': paired.sessionId
    },
    body: Buffer.from('plaintext from a paired peer')
  });
  check('a paired peer cannot downgrade its own upload to plaintext', () => {
    assert.strictEqual(plaintextWithSession.status, 400, `expected 400, got ${plaintextWithSession.status}`);
    assert.ok(!fs.existsSync(path.join(VAULT_DIR, 'plain_with_session.bin')), 'nothing should reach the vault');
  });

  // The sealed packet below is a couple of hundred bytes, well inside every size limit, but it
  // claims to inflate to 200 KB while committing to a 1 KB stride. Decompressing it to check that
  // would be the attack, so the inflate stops at the stride the AAD already authenticated.
  const bombTask = `task_bomb_${Date.now()}`;
  const bombBody = zlib.gzipSync(Buffer.alloc(200 * 1024, 7));
  const bombRes = await request('POST', '/api/v1/transfer/upload', {
    headers: Object.assign({
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('bomb.bin'),
      'X-Encrypted': '1',
      'X-Compressed': 'gzip',
      'X-Session-Id': paired.sessionId
    }, chunkHeaders(bombTask, 0, 1, 1024)),
    body: sealChunk(paired.key, bombBody, bombTask, 0, 1, 1024)
  });
  check('a chunk that inflates past its authenticated stride is refused', () => {
    assert.strictEqual(bombRes.status, 400, `expected 400, got ${bombRes.status}`);
    assert.ok(/exceeds the 1024-byte stride/.test(bombRes.body.toString('utf8')),
      `expected the inflate to be capped, got: ${bombRes.body.toString('utf8')}`);
    assert.ok(!fs.existsSync(path.join(VAULT_DIR, 'bomb.bin')), 'nothing should reach the vault');
  });

  // A .part left by an earlier, interrupted attempt at the same task id is a state that really
  // happens - the hub forgets its bookkeeping on restart but the file on disk survives. A
  // positional write only guarantees the bytes it wrote, so unless the finished file is cut back
  // to the size the authenticated chunks add up to, the tail of the old, longer one is renamed
  // into the vault and reported as the new file's size.
  const staleTask = `task_stale_${Date.now()}`;
  const staleName = 'stale_tail.bin';
  const staleBody = Buffer.from('the second attempt was shorter');
  fs.writeFileSync(path.join(VAULT_DIR, `.${staleTask}_${staleName}.part`), Buffer.alloc(64 * 1024, 0xdd));
  const staleRes = await request('POST', '/api/v1/transfer/upload', {
    headers: Object.assign({
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(staleName),
      'X-File-Size': String(staleBody.length),
      'X-Encrypted': '1',
      'X-Session-Id': paired.sessionId
    }, chunkHeaders(staleTask, 0, 1, staleBody.length)),
    body: sealChunk(paired.key, staleBody, staleTask, 0, 1, staleBody.length)
  });
  check('a stale .part cannot leave a tail on the finished file', () => {
    assert.strictEqual(staleRes.status, 200, `expected 200, got ${staleRes.status}: ${staleRes.body}`);
    const stored = fs.readFileSync(path.join(VAULT_DIR, staleName));
    assert.strictEqual(stored.length, staleBody.length,
      `finished file carries ${stored.length - staleBody.length} bytes of stale tail`);
    assert.ok(stored.equals(staleBody), 'content differs from the transferred bytes');
  });

  // ---------------------------------------------------------------------------
  // Sections 5-6 run here, before the rate-limit test, because that test deliberately locks
  // out this source IP for five minutes and every later handshake would return 429.
  // ---------------------------------------------------------------------------
  console.log('\n▶ Section 4b: endpoints that read or write user state');
  // The file endpoints were the first to be guarded, and asserting only those would leave the
  // rest unguarded again the next time somebody adds one - device names were exactly the ones
  // still open to an unpaired host on the LAN.
  const fakeFingerprint = 'probefingerprint0001';
  const namePath = `/api/v1/devices/names/${fakeFingerprint}`;
  const putName = await request('PUT', namePath, {
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': paired.sessionId },
    body: JSON.stringify({ customName: 'probe-name' })
  });
  const anonDelete = await request('DELETE', namePath);
  const anonSend = await request('POST', '/api/v1/message/send', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'from an unpaired host', peerId: 'probe-peer', senderName: 'probe' })
  });
  const anonList = await request('GET', '/api/v1/messages/list?peerId=probe-peer');
  const namesBeforeDelete = json(await request('GET', '/api/v1/devices/names', {
    headers: { 'X-Session-Id': paired.sessionId }
  }));
  check('unpaired hosts cannot send, read or wipe anything', () => {
    assert.strictEqual(putName.status, 200, `the sessioned PUT should work, got ${putName.status}`);
    assert.strictEqual(anonSend.status, 401, `message/send: ${anonSend.status}`);
    assert.strictEqual(anonList.status, 401, `messages/list: ${anonList.status}`);
    assert.strictEqual(anonDelete.status, 401, `devices/names DELETE: ${anonDelete.status}`);
  });
  check('a refused delete leaves the stored name alone', () => {
    assert.strictEqual(namesBeforeDelete.deviceNames[fakeFingerprint], 'probe-name',
      `unpaired DELETE took effect: ${JSON.stringify(namesBeforeDelete)}`);
  });
  const sessionedDelete = await request('DELETE', namePath, { headers: { 'X-Session-Id': paired.sessionId } });
  const namesAfterDelete = json(await request('GET', '/api/v1/devices/names', {
    headers: { 'X-Session-Id': paired.sessionId }
  }));
  check('a paired session can undo it', () => {
    assert.strictEqual(sessionedDelete.status, 200, `expected 200, got ${sessionedDelete.status}`);
    assert.strictEqual(namesAfterDelete.deviceNames[fakeFingerprint], undefined,
      'the name survived a sessioned delete');
  });

  console.log('\n▶ Section 5: pairing-secret rotation grace');
  // The hub rotates PIN and token on every successful handshake while the desktop UI refreshes
  // on a timer. When the retired credentials were stored in a single slot, a second pairing
  // inside the grace window evicted the value still displayed on screen, and the next device
  // was rejected with "Pairing proof verification failed" despite reading it correctly.

  // Each rotation step reads the live PIN rather than reusing the startup HUB_PIN, so the test
  // does not depend on where the startup value happens to sit relative to the grace window.
  const livePinNow = async () => json(await request('GET', '/api/v1/info', { host: LOOPBACK })).pin;

  // Every successful pairing both retires the credential it used and rotates in a new one, so
  // each pair() call below advances the retirement history by one generation.
  const beforeRotation = await livePinNow();
  await pair(beforeRotation);
  const afterFirst = json(await request('GET', '/api/v1/info', { host: LOOPBACK }));
  check('a successful pairing rotates the PIN', () => {
    assert.notStrictEqual(afterFirst.pin, beforeRotation, 'PIN should have rotated');
  });

  // Retirement #2: the value the user is still looking at must keep working.
  const stalePin = await pair(beforeRotation);
  check('the just-retired PIN is still accepted inside the grace window', () => {
    assert.strictEqual(stalePin.verifyRes.status, 200,
      `stale-but-displayed PIN rejected: ${stalePin.verifyRes.status} ${stalePin.verifyRes.body}`);
  });

  // Retirement #3 puts the displayed credential at the very edge of the retained history.
  await pair(await livePinNow());
  const atBoundary = await pair(beforeRotation);
  check('a displayed credential is accepted up to the grace generation cap', () => {
    assert.strictEqual(atBoundary.verifyRes.status, 200,
      `credential at the cap was rejected: ${atBoundary.verifyRes.status}`);
  });

  // Retirement #4 pushes it out. Asserting the failure keeps the window provably bounded:
  // without this, an accidentally unbounded history would pass the checks above.
  await pair(await livePinNow());
  const beyondCap = await pair(beforeRotation);
  check('a credential past the cap is no longer accepted', () => {
    assert.strictEqual(beyondCap.verifyRes.status, 403,
      `expected the window to be bounded, got ${beyondCap.verifyRes.status}`);
  });

  // A credential that was never issued must still be refused, or the grace window would have
  // turned the proof check into an accept-anything path.
  const neverIssued = beforeRotation === '000000' ? '000001' : '000000';
  const junk = await pair(neverIssued);
  check('a credential that was never issued is still rejected', () => {
    assert.strictEqual(junk.verifyRes.status, 403, `expected 403, got ${junk.verifyRes.status}`);
  });

  console.log('\n▶ Section 6: session binding');
  // Section 5 rotated the credentials several times, so the startup HUB_PIN captured at the top
  // of this run now sits outside the grace window. Read the live value instead, which is also
  // what the desktop UI does on its refresh timer.
  const livePin = json(await request('GET', '/api/v1/info', { host: LOOPBACK })).pin;
  const session = await pair(livePin);
  const listing = await request('GET', '/api/v1/files/list', {
    headers: { 'X-Session-Id': session.sessionId }
  });
  check('a negotiated session authenticates an authorized endpoint', () => {
    assert.strictEqual(listing.status, 200, `got ${listing.status}: ${listing.body}`);
  });

  // Sessions are bound to the peer address, so replaying one from another local address must
  // fail. Skipped on a host with only one address.
  const otherIps = localCandidates.filter((ip) => ip !== LAN_HOST && ip !== LOOPBACK);
  if (otherIps.length > 0) {
    const foreign = await request('GET', '/api/v1/files/list', {
      headers: { 'X-Session-Id': session.sessionId },
      host: otherIps[0]
    });
    check('the same session id is refused from a different peer address', () => {
      assert.strictEqual(foreign.status, 401, `expected 401, got ${foreign.status}`);
    });
  } else {
    console.log('    (skipped: host has a single LAN address)');
  }

  console.log('\n▶ Section 7: rate limiting');
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const attempt = await pair('123456' === String(HUB_PIN) ? '654321' : '123456');
    if (attempt.verifyRes.status === 429) { limited = true; break; }
  }
  check('repeated wrong PINs trigger 429 rate limiting', () => {
    assert.ok(limited, 'expected the hub to rate limit repeated pairing failures');
  });

  console.log('\n▶ Section 8: phone-to-phone relay (sealed bytes forwarded untouched)');
  if (!RELAY_DEST_HOST) {
    skip('phone-to-phone relay',
      'this host has no second local IPv4 address, so there is no destination that is not the hub; '
      + 'CI adds one (see .github/workflows/ci.yml) so the relay path stays covered');
  } else {
  // The sender negotiates its own session with the destination phone; the hub holds no such
  // key, so it must forward the sealed bytes without unwrapping them.
  // The destination is on this machine's own subnet and was NOT allowlisted via the
  // environment, so reaching it also proves the same-subnet rule works by default.
  const lanGuard = require('../../apps/desktop/desktop_hub/lan_guard');
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
        encrypted: req.headers['x-encrypted'],
        chunkSize: req.headers['x-chunk-size'],
        chunkCount: req.headers['x-chunk-count']
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, status: 'chunk_received' }));
    });
  });
  await new Promise((resolve) => destPhone.listen(DEST_PORT, '0.0.0.0', resolve));

  const relayTaskId = `relay_${Date.now()}`;
  const relayPlaintext = crypto.randomBytes(4096);
  const relaySealed = sealChunk(senderToDestKey, relayPlaintext, relayTaskId, 0, 1, relayPlaintext.length);

  const relayRes = await request('POST', '/api/v1/transfer/upload', {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Task-Id': relayTaskId,
      'X-File-Name': 'relayed.bin',
      'X-Chunk-Index': '0',
      'X-Chunk-Count': '1',
      'X-Chunk-Size': String(relayPlaintext.length),
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

  check('the chunk geometry headers survive the relay hop', () => {
    assert.strictEqual(received[0].chunkSize, String(relayPlaintext.length), 'X-Chunk-Size was not forwarded');
    assert.strictEqual(received[0].chunkCount, '1', 'X-Chunk-Count was not forwarded');
  });

  check('the destination can decrypt with the key it negotiated with the sender', () => {
    const opened = PROTO.decryptChunk(destKey, received[0].body, relayTaskId, 0, 1, relayPlaintext.length);
    assert.ok(opened.equals(relayPlaintext), 'decrypted content differs from the original plaintext');
  });

  check('the destination session id is forwarded, not the hub session id', () => {
    assert.strictEqual(received[0].sessionId, destSessionId);
    assert.notStrictEqual(received[0].sessionId, paired.sessionId);
  });

  await new Promise((resolve) => destPhone.close(resolve));
  }

  console.log('\n▶ Section 9: HTTPS portal (needed for browser WebCrypto)');
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
  const tlsStride = 100 * 1024 + 1;
  const tlsChunks = Math.ceil(tlsPayload.length / tlsStride);
  const tlsUploads = [];
  for (let i = 0; i < tlsChunks; i++) {
    const slice = tlsPayload.subarray(i * tlsStride, Math.min(tlsPayload.length, (i + 1) * tlsStride));
    tlsUploads.push(await request('POST', '/api/v1/transfer/upload', {
      host: LOOPBACK, tls: true, port: TLS_PORT,
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'tls_encrypted.bin',
        'X-File-Size': String(tlsPayload.length),
        'X-Encrypted': '1',
        'X-Session-Id': tlsInit.session_id
      }, chunkHeaders(tlsTaskId, i, tlsChunks, tlsStride)),
      body: sealChunk(tlsKey, slice, tlsTaskId, i, tlsChunks, tlsStride)
    }));
  }
  check('encrypted uploads are accepted over HTTPS', () => {
    assert.ok(tlsUploads.every((r) => r.status === 200), `statuses: ${tlsUploads.map((r) => r.status).join(',')}`);
  });
  check('the final HTTPS response reports completion', () => {
    const last = JSON.parse(String(tlsUploads[tlsUploads.length - 1].body));
    assert.strictEqual(last.status, 'completed', `got ${JSON.stringify(last)}`);
    assert.strictEqual(last.file_size, tlsPayload.length, `reported ${last.file_size} bytes`);
  });
  check('HTTPS upload is decrypted correctly on disk', () => {
    const stored = fs.readFileSync(path.join(VAULT_DIR, 'tls_encrypted.bin'));
    assert.ok(stored.equals(tlsPayload), 'stored bytes differ from the plaintext sent');
  });

  console.log('\n▶ Section 10: the portal page browser crypto, executed as written');
  // portal.html is self-contained on purpose (it is also copied verbatim into the APK assets), so
  // its crypto cannot be imported. Lift the SafeDropCrypto block out of the HTML and run it
  // unchanged against the hub, which is what actually proves the browser end speaks v2.
  const portalSource = fs.readFileSync(path.join(__dirname, '..', '..', 'apps/desktop/desktop_hub/public/portal.html'), 'utf8');
  const blockStart = portalSource.indexOf('const SafeDropCrypto = (() => {');
  const blockEnd = portalSource.indexOf('\n      })();', blockStart);
  check('the portal crypto block can be located in portal.html', () => {
    assert.ok(blockStart > 0 && blockEnd > blockStart, 'SafeDropCrypto block not found - did portal.html change shape?');
  });

  const PortalCrypto = new Function('crypto', 'TextEncoder',
    `${portalSource.slice(blockStart, blockEnd + '\n      })();'.length)}\nreturn SafeDropCrypto;`)(
    require('crypto').webcrypto, TextEncoder
  );

  const fileBytes = crypto.randomBytes(1320);
  const portalStride = 64;
  const portalCount = Math.max(1, Math.ceil(fileBytes.length / portalStride));
  const portalTaskId = `portal_${Date.now()}`;
  let portalSession = null;

  // Read the PIN off the screen the way a user would: every successful pairing rotates it, so the
  // value captured at boot is only accepted while it stays inside the grace window.
  const portalPin = String(json(await request('GET', '/api/v1/info', { host: LOOPBACK })).pin);

  {
    const pair = await PortalCrypto.generateKeyPair();
    const rawPub = await PortalCrypto.exportPublicKey(pair);
    const init = json(await request('POST', '/api/v1/handshake/init', {
      host: LOOPBACK, tls: true, port: TLS_PORT,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: PortalCrypto.toHex(rawPub), curve: PortalCrypto.getCurve() })
    }));
    const shared = await PortalCrypto.deriveSharedSecret(pair, PortalCrypto.fromHex(init.server_public_key));
    const keyBytes = await PortalCrypto.deriveSessionKeyBytes(shared, init.session_id, portalPin);
    const proof = PortalCrypto.toHex(await PortalCrypto.clientProof(keyBytes, init.session_id));
    const verify = json(await request('POST', '/api/v1/handshake/verify', {
      host: LOOPBACK, tls: true, port: TLS_PORT,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: init.session_id, proof })
    }));
    const expectedServerProof = PortalCrypto.toHex(await PortalCrypto.serverProof(keyBytes, init.session_id));
    check('the portal establishes a session the hub accepts, and authenticates the hub back', () => {
      assert.strictEqual(verify.status, 'verified', `handshake gave ${JSON.stringify(verify)}`);
      assert.strictEqual(verify.server_proof, expectedServerProof, 'the portal would have rejected this hub');
    });
    portalSession = { id: init.session_id, key: keyBytes };
  }

  const portalStatuses = [];
  for (let i = 0; i < portalCount; i++) {
    const slice = fileBytes.subarray(i * portalStride, Math.min(fileBytes.length, (i + 1) * portalStride));
    const sealed = await PortalCrypto.encryptChunk(portalSession.key, slice, portalTaskId, i, portalCount, portalStride);
    const res = await request('POST', '/api/v1/transfer/upload', {
      host: LOOPBACK, tls: true, port: TLS_PORT,
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'from_portal.bin',
        'X-File-Size': String(fileBytes.length),
        'X-Encrypted': '1',
        'X-Session-Id': portalSession.id
      }, chunkHeaders(portalTaskId, i, portalCount, portalStride)),
      body: Buffer.from(sealed)
    });
    portalStatuses.push(res.status);
  }
  check('the hub reassembles a multi-chunk upload sealed by the browser code', () => {
    assert.ok(portalStatuses.every((s) => s === 200), `statuses: ${portalStatuses.join(',')}`);
    const stored = fs.readFileSync(path.join(VAULT_DIR, 'from_portal.bin'));
    assert.ok(stored.equals(fileBytes), `stored ${stored.length} bytes differ from the 1320 sent`);
  });

  // Every rule above is asserted one request at a time. The receiver's guarantees are made across
  // requests, so they also have to hold when two of them are in flight together - which is what a
  // client that retries after a dropped response actually does.
  console.log('\n▶ Section 11: chunks that arrive at the same time');
  const raceStride = 4096;
  const raceA = Buffer.concat([Buffer.from('AAAA'), crypto.randomBytes(raceStride - 4)]);
  const raceB = Buffer.concat([Buffer.from('BBBB'), crypto.randomBytes(raceStride - 4)]);

  const raceSend = (taskId, index, count, payload, name, size) => request('POST', '/api/v1/transfer/upload', {
    headers: Object.assign({
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(name),
      'X-File-Size': String(size),
      'X-Encrypted': '1',
      'X-Session-Id': paired.sessionId
    }, chunkHeaders(taskId, index, count, raceStride)),
    body: sealChunk(paired.key, payload, taskId, index, count, raceStride)
  });

  const creationTask = `task_creation_${Date.now()}`;
  const creation = await Promise.all([
    raceSend(creationTask, 0, 2, raceA, 'concurrent_creation.bin', raceStride * 2),
    raceSend(creationTask, 1, 2, raceA, 'concurrent_creation.bin', raceStride * 2)
  ]);
  check('two chunks that both find no .part still produce the whole file', () => {
    assert.ok(creation.every((r) => r.status === 200), `statuses: ${creation.map((r) => r.status).join(',')}`);
    const stored = fs.readFileSync(path.join(VAULT_DIR, 'concurrent_creation.bin'));
    assert.strictEqual(stored.length, raceStride * 2, `stored ${stored.length} bytes`);
    assert.ok(stored.equals(Buffer.concat([raceA, raceA])), 'content differs');
  });

  const clashTask = `task_clash_${Date.now()}`;
  const clash = await Promise.all([
    raceSend(clashTask, 0, 2, raceA, 'concurrent_clash.bin', raceStride * 2),
    raceSend(clashTask, 0, 2, raceB, 'concurrent_clash.bin', raceStride * 2)
  ]);
  const clashFirst = clash.findIndex((r) => r.status === 200);
  const clashTail = await raceSend(clashTask, 1, 2, raceA, 'concurrent_clash.bin', raceStride * 2);
  check('one index cannot be accepted twice with different content', () => {
    assert.strictEqual(clashFirst, 0, `expected exactly one acceptance, got ${clash.map((r) => r.status).join('/')}`);
    assert.strictEqual(clash[1].status, 409, `the conflicting chunk was accepted: ${clash[1].status}`);
  });
  check('the saved file is made of the chunks that were accepted, not the ones refused', () => {
    assert.strictEqual(clashTail.status, 200, `final chunk: ${clashTail.status} ${clashTail.body.toString('utf8')}`);
    const stored = fs.readFileSync(path.join(VAULT_DIR, 'concurrent_clash.bin'));
    assert.strictEqual(stored.length, raceStride * 2, `stored ${stored.length} bytes`);
    assert.ok(stored.equals(Buffer.concat([raceA, raceA])),
      `stored chunk 0 is ${stored.subarray(0, 4).toString('utf8')}, but ${clashFirst === 0 ? 'AAAA' : 'BBBB'} was the accepted copy`);
  });

  const geometryCases = [
    ['a chunk count above the protocol cap', 0, 1000001, 16],
    ['an index equal to the chunk count', 1, 1, 16],
    ['a zero stride', 0, 1, 0],
    ['a stride above the sealed-chunk cap', 0, 1, 67108865]
  ];
  const geometryResults = [];
  for (const [label, idx, count, size] of geometryCases) {
    const badTask = `task_geom_${Date.now()}_${idx}_${count}`;
    // Seal with a legal geometry and send the headers the attack claims: the receiver has to
    // refuse on its own reading of the numbers, not because the sender agreed with it.
    const res = await request('POST', '/api/v1/transfer/upload', {
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(`geom_${geometryResults.length}.bin`),
        'X-Encrypted': '1',
        'X-Session-Id': paired.sessionId
      }, chunkHeaders(badTask, idx, count, size)),
      body: sealChunk(paired.key, Buffer.from('0123456789abcdef'), badTask, 0, 1, 16)
    });
    geometryResults.push({ label, status: res.status });
  }
  check('impossible chunk geometry is refused before anything is stored', () => {
    for (const r of geometryResults) {
      assert.strictEqual(r.status, 400, `${r.label}: expected 400, got ${r.status}`);
    }
  });
  check('a refused chunk leaves neither a file nor a .part behind', () => {
    const leftovers = fs.readdirSync(VAULT_DIR).filter((n) => n.startsWith('geom_') || n.includes('task_geom_'));
    assert.deepStrictEqual(leftovers, [], `left on disk: ${leftovers.join(', ')}`);
  });

  shutdown();
  fs.rmSync(VAULT_DIR, { recursive: true, force: true });

  console.log(`\n====================================================`);
  console.log(`  Passed: ${passed}    Failed: ${failed}`
    + (skipped ? `    Skipped: ${skipped}` : ''));
  console.log(`====================================================\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nTest harness error:', e);
  process.exit(1);
});
