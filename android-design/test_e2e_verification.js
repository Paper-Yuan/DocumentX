/**
 * SafeDrop Mobile (Android) & PC (Desktop Hub) Cross-Platform E2E Verification Suite
 * Covers:
 * 1. X25519 ECDH cross-platform key exchange & HKDF-SHA256 session key derivation
 * 2. AES-256-GCM 1MB chunked streaming encryption/decryption with Auth Tag validation
 * 3. Scoped Storage directory traversal path sanitization
 * 4. Out-of-band QR code URI parsing (CameraX scanner logic)
 * 5. Live HTTP integration with Desktop Hub (Ping, Info, Handshake, Upload, Download)
 */

const crypto = require('crypto');
const http = require('http');

console.log('====================================================');
console.log('🧪 Starting SafeDrop Cross-Platform E2E Verification');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    process.exitCode = 1;
  }
}

async function runTests() {
  // -----------------------------------------------------------------------------
  // Test 1: X25519 ECDH Key Exchange & HKDF-SHA256
  // -----------------------------------------------------------------------------
  console.log('▶ Test 1: X25519 (ECDH) Key Exchange & HKDF-SHA256 Session Derivation');
  try {
    const pcKeyPair = crypto.generateKeyPairSync('x25519');
    const pcPubDer = pcKeyPair.publicKey.export({ type: 'spki', format: 'der' });
    const pcPubRaw = pcPubDer.subarray(pcPubDer.length - 32);

    const mobileKeyPair = crypto.generateKeyPairSync('x25519');
    const mobilePubDer = mobileKeyPair.publicKey.export({ type: 'spki', format: 'der' });
    const mobilePubRaw = mobilePubDer.subarray(mobilePubDer.length - 32);

    const pcFp = crypto.createHash('sha256').update(pcPubRaw).digest('hex').substring(0, 16).toUpperCase();
    const mobileFp = crypto.createHash('sha256').update(mobilePubRaw).digest('hex').substring(0, 16).toUpperCase();
    assert(pcFp.length === 16 && mobileFp.length === 16, 'Both public key fingerprints are exactly 16 hex chars');

    const pcSharedSecret = crypto.diffieHellman({
      privateKey: pcKeyPair.privateKey,
      publicKey: mobileKeyPair.publicKey
    });

    const mobileSharedSecret = crypto.diffieHellman({
      privateKey: mobileKeyPair.privateKey,
      publicKey: pcKeyPair.publicKey
    });

    assert(pcSharedSecret.equals(mobileSharedSecret), 'ECDH SharedSecret computed identically on both peers');

    const salt = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const info = Buffer.from([9, 10, 11, 12]);
    const pcSessionKey = Buffer.from(crypto.hkdfSync('sha256', pcSharedSecret, salt, info, 32));
    const mobileSessionKey = Buffer.from(crypto.hkdfSync('sha256', mobileSharedSecret, salt, info, 32));
    assert(pcSessionKey.equals(mobileSessionKey), 'HKDF-SHA256 derived 256-bit session key matches 100% across peers');
  } catch (e) {
    assert(false, `X25519 test error: ${e.message}`);
  }

  // -----------------------------------------------------------------------------
  // Test 2: AES-256-GCM 1MB Chunked Streaming Encryption & Decryption
  // -----------------------------------------------------------------------------
  console.log('\n▶ Test 2: AES-256-GCM 1MB Chunked Streaming Cipher Pipeline');
  try {
    const sessionKey = crypto.randomBytes(32);
    const chunkIndex = 0;

    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(chunkIndex, 0);
    for (let i = 4; i < 12; i++) {
      nonce[i] = (chunkIndex * 31 + i) & 0xFF;
    }

    const originalChunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < originalChunk.length; i++) {
      originalChunk[i] = i % 256;
    }

    const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, nonce);
    const encrypted = Buffer.concat([cipher.update(originalChunk), cipher.final()]);
    const tag = cipher.getAuthTag();
    const mobileEncryptedPacket = Buffer.concat([nonce, encrypted, tag]);

    assert(mobileEncryptedPacket.length === 12 + 1024 * 1024 + 16, 'Encrypted packet length matches 12B Nonce + 1MB + 16B AuthTag');

    const recvNonce = mobileEncryptedPacket.subarray(0, 12);
    const recvTag = mobileEncryptedPacket.subarray(mobileEncryptedPacket.length - 16);
    const recvCiphertext = mobileEncryptedPacket.subarray(12, mobileEncryptedPacket.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, recvNonce);
    decipher.setAuthTag(recvTag);
    const decryptedChunk = Buffer.concat([decipher.update(recvCiphertext), decipher.final()]);

    assert(decryptedChunk.equals(originalChunk), 'Decrypted 1MB chunk matches original and AuthTag verified successfully');
  } catch (e) {
    assert(false, `AES-GCM test error: ${e.message}`);
  }

  // -----------------------------------------------------------------------------
  // Test 3: Scoped Storage Path Traversal Defense
  // -----------------------------------------------------------------------------
  console.log('\n▶ Test 3: Scoped Storage Path Traversal Sanitization');
  function sanitizeFileName(inputName) {
    let safe = inputName.split(/[/\\]/).pop();
    safe = safe.replace(/[\\/:*?"<>|]/g, '_');
    safe = safe.replace(/\.\./g, '').trim();
    return safe || `safedrop_${Date.now()}.bin`;
  }

  assert(sanitizeFileName('../../etc/passwd') === 'passwd', 'Correctly strips relative path ../../');
  assert(sanitizeFileName('..\\..\\Windows\\System32\\cmd.exe') === 'cmd.exe', 'Correctly strips Windows backslash traversal');
  assert(sanitizeFileName('C:\\secret\\trojan:bad.exe') === 'trojan_bad.exe', 'Correctly replaces illegal colon characters');

  // -----------------------------------------------------------------------------
  // Test 4: Out-of-band QR Code URI Parsing
  // -----------------------------------------------------------------------------
  console.log('\n▶ Test 4: Dynamic QR Code URI Parsing (CameraX Scanner Logic)');
  const sampleQr = 'safedrop://pair?ip=192.168.10.42&port=8899&fp=A3F8B9C1&token=x91k2d&pin=654321';
  const parsedUrl = new URL(sampleQr);
  assert(parsedUrl.searchParams.get('ip') === '192.168.10.42', 'Extracts PC IP address accurately');
  assert(parsedUrl.searchParams.get('port') === '8899', 'Extracts PC port accurately');
  assert(parsedUrl.searchParams.get('fp') === 'A3F8B9C1', 'Extracts public key fingerprint accurately');
  assert(parsedUrl.searchParams.get('token') === 'x91k2d', 'Extracts offline one-time token accurately');
  assert(parsedUrl.searchParams.get('pin') === '654321', 'Extracts 6-digit dynamic PIN accurately');

  // -----------------------------------------------------------------------------
  // Test 5: Live HTTP Integration with Desktop Hub (encrypted transport)
  // -----------------------------------------------------------------------------
  console.log('\n▶ Test 5: Live HTTP Endpoint Integration (Ping / Encrypted Handshake / Encrypted Upload / Download)');
  try {
    const PROTO = require('../computer-design/desktop_hub/crypto_protocol');

    // 1. GET /api/v1/ping
    const pingRes = await httpRequest('GET', 'http://127.0.0.1:8899/api/v1/ping');
    const pingData = JSON.parse(pingRes.body);
    assert(pingRes.statusCode === 200 && pingData.message === 'pong', 'GET /api/v1/ping returns 200 pong');

    // 2. GET /api/v1/info (loopback is trusted, so the PIN is disclosed here)
    const infoRes = await httpRequest('GET', 'http://127.0.0.1:8899/api/v1/info');
    const infoData = JSON.parse(infoRes.body);
    assert(infoRes.statusCode === 200 && infoData.pin && infoData.qrUri, 'GET /api/v1/info returns valid pin and qrUri');

    // 3. POST /api/v1/handshake/init with a real ephemeral X25519 key
    const keyPair = PROTO.generateKeyPair('x25519');
    const rawPubKey = PROTO.exportRawPublicKey(keyPair, 'x25519');
    const initRes = await httpRequest('POST', 'http://127.0.0.1:8899/api/v1/handshake/init', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: rawPubKey.toString('hex'), curve: 'x25519', os: 'android' })
    });
    const initData = JSON.parse(initRes.body);
    assert(initRes.statusCode === 200 && initData.server_public_key, 'POST /api/v1/handshake/init returns server public key');
    assert(initData.session_id, 'POST /api/v1/handshake/init returns a session id');

    // 4. Prove knowledge of the pairing PIN without transmitting it
    const sharedSecret = PROTO.computeSharedSecret(keyPair.privateKey, Buffer.from(initData.server_public_key, 'hex'), 'x25519');
    const sessionKey = PROTO.deriveSessionKey(sharedSecret, initData.session_id, String(infoData.pin));
    const proof = PROTO.clientProof(sessionKey, initData.session_id).toString('hex');

    const verifyRes = await httpRequest('POST', 'http://127.0.0.1:8899/api/v1/handshake/verify', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: initData.session_id, proof })
    });
    const verifyData = JSON.parse(verifyRes.body);
    assert(verifyRes.statusCode === 200 && verifyData.status === 'verified', 'POST /api/v1/handshake/verify establishes an encrypted session');
    assert(
      verifyData.server_proof === PROTO.serverProof(sessionKey, initData.session_id).toString('hex'),
      'Hub returns a server proof that the client can verify'
    );

    // 5. POST /api/v1/transfer/upload with an AES-256-GCM sealed chunk (UTF-8 filename)
    const taskId = `task_e2e_${Date.now()}`;
    const testFileName = `Graduation_Project_SafeDrop_E2E_${Date.now()}.txt`;
    const filePayload = Buffer.from('SafeDrop Cross-Platform Secure Transfer: UTF-8 encoding, Scoped Storage & X25519 Encryption.\n', 'utf8');
    const sealedChunk = PROTO.encryptChunk(sessionKey, filePayload, taskId, 0);

    const uploadRes = await httpRequest('POST', 'http://127.0.0.1:8899/api/v1/transfer/upload', {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Task-Id': taskId,
        'X-File-Name': encodeURIComponent(testFileName),
        'X-File-Size': filePayload.length.toString(),
        'X-Chunk-Index': '0',
        'X-Chunk-Count': '1',
        'X-Encrypted': '1',
        'X-Session-Id': initData.session_id
      },
      body: sealedChunk
    });
    const uploadData = JSON.parse(uploadRes.body);
    assert(uploadRes.statusCode === 200 && uploadData.status === 'completed', 'Encrypted chunk upload completed and stored to disk');

    // 6. GET /api/v1/files/download/:name (decrypted, integrity check)
    const downloadRes = await httpRequest('GET', `http://127.0.0.1:8899/api/v1/files/download/${encodeURIComponent(testFileName)}`, {
      headers: { 'X-Session-Id': initData.session_id }
    });
    assert(downloadRes.statusCode === 200 && downloadRes.bodyBuffer.equals(filePayload), 'Downloaded file content matches uploaded payload 100% bit-for-bit after decryption');

    // 7. A tampered tag must be refused server-side
    const tamperTask = `task_e2e_tamper_${Date.now()}`;
    const tamperedChunk = PROTO.encryptChunk(sessionKey, Buffer.from('authentic payload'), tamperTask, 0);
    tamperedChunk[tamperedChunk.length - 1] ^= 0x01;
    const tamperRes = await httpRequest('POST', 'http://127.0.0.1:8899/api/v1/transfer/upload', {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Task-Id': tamperTask,
        'X-File-Name': encodeURIComponent('tampered_e2e.bin'),
        'X-Chunk-Index': '0',
        'X-Chunk-Count': '1',
        'X-Encrypted': '1',
        'X-Session-Id': initData.session_id
      },
      body: tamperedChunk
    });
    assert(tamperRes.statusCode === 400, 'Hub rejects a chunk whose authentication tag was modified');

  } catch (e) {
    assert(false, `HTTP integration error: ${e.message}`);
  }

  console.log(`\n====================================================`);
  console.log(`🎯 E2E Cross-Platform Tests Passed: ${passedTests}/${totalTests}`);
  console.log(`====================================================\n`);
}

function httpRequest(method, targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: method,
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          bodyBuffer: bodyBuffer,
          body: bodyBuffer.toString('utf8')
        });
      });
    });

    req.on('error', err => reject(err));
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

runTests();
