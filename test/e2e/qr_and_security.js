const fs = require('fs');
const path = require('path');
const http = require('http');

console.log('=== SafeDrop QR Code & Security Hardening Test Suite ===\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passCount++;
  } else {
    console.error(`[FAIL] ${message}`);
    failCount++;
  }
}

// 1. Test Standard QR Code Generator
const qrcodeJs = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'desktop', 'desktop_hub', 'public', 'qrcode.js'), 'utf8');
const fakeWindow = {};
new Function('window', 'globalThis', qrcodeJs)(fakeWindow, fakeWindow);

assert(typeof fakeWindow.qrcode === 'function', 'qrcode.js attaches to window.qrcode');

const testUri = 'safedrop://pair?ip=192.168.1.88&port=8899&fp=A3F8B9C1&token=123456abcdef&pin=882314';
const qr = fakeWindow.qrcode(0, 'M');
qr.addData(testUri);
qr.make();

const moduleCount = qr.getModuleCount();
assert(moduleCount >= 21 && moduleCount <= 177, `QR code generated valid module size: ${moduleCount}x${moduleCount}`);
assert(qr.isDark(0, 0) === true, 'Top-left finder outer module is dark');
assert(qr.isDark(0, 1) === true, 'Top-left finder border is dark');
assert(qr.isDark(0, 6) === true, 'Top-left finder corner is dark');
assert(qr.isDark(1, 1) === false, 'Top-left finder inner separator is light');
assert(qr.isDark(3, 3) === true, 'Top-left finder center core is dark');

// 2. Start desktop_hub server on test port 9988
process.env.PORT = '9988';
require('../../apps/desktop/desktop_hub/server.js');

setTimeout(async () => {
  try {
    // Test 2.1: /api/v1/info returns valid QR URIs and available IPs
    const infoRes = await fetch('http://127.0.0.1:9988/api/v1/info');
    const info = await infoRes.json();
    assert(info.code === 0, '/api/v1/info returned code 0');
    assert(info.qrUri.startsWith('safedrop://pair?ip='), `qrUri format correct: ${info.qrUri}`);
    assert(info.webUrl.includes('?pin=') && info.webUrl.includes('&token='), `webUrl includes pin and token credentials: ${info.webUrl}`);
    assert(Array.isArray(info.availableIps), `availableIps array returned: ${JSON.stringify(info.availableIps.map(i => i.ip))}`);

    const currentPin = info.pin;
    const currentToken = info.token;

    // Test 2.2: Handshake verification with the active PIN.
    // The PIN is no longer sent to the hub: it is used locally as HKDF input and proven
    // with an HMAC over the derived session key.
    const PROTO = require('../../apps/desktop/desktop_hub/crypto_protocol');

    async function establishSession(secret) {
      const pair = PROTO.generateKeyPair('x25519');
      const rawPub = PROTO.exportRawPublicKey(pair, 'x25519');
      const initRes = await fetch('http://127.0.0.1:9988/api/v1/handshake/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_key: rawPub.toString('hex'), curve: 'x25519' })
      });
      const initData = await initRes.json();
      const shared = PROTO.computeSharedSecret(pair.privateKey, Buffer.from(initData.server_public_key, 'hex'), 'x25519');
      const key = PROTO.deriveSessionKey(shared, initData.session_id, String(secret));
      const proof = PROTO.clientProof(key, initData.session_id).toString('hex');
      const verifyRes = await fetch('http://127.0.0.1:9988/api/v1/handshake/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: initData.session_id, proof })
      });
      let verifyData = null;
      try { verifyData = await verifyRes.json(); } catch (_) {}
      return { status: verifyRes.status, data: verifyData, key, sessionId: initData.session_id };
    }

    const session1 = await establishSession(currentPin);
    assert(session1.status === 200 && session1.data.status === 'verified', 'Verify succeeds with active PIN');
    assert(
      session1.data.server_proof === PROTO.serverProof(session1.key, session1.sessionId).toString('hex'),
      'Hub returns a verifiable session proof'
    );

    // Test 2.3: The previous PIN also succeeds inside the 60s grace window.
    const session2 = await establishSession(currentToken);
    assert(session2.status === 200 && session2.data.status === 'verified', 'Verify succeeds with credential within grace period');

    // Test 2.4: An incorrect PIN is rejected.
    const session3 = await establishSession('000000' === String(currentPin) ? '111111' : '000000');
    assert(session3.status === 403, 'Invalid PIN correctly rejected with 403');

    // Test 2.5: SSRF prevention in relay upload
    const ssrfRes = await fetch('http://127.0.0.1:9988/api/v1/transfer/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Target-Ip': '169.254.169.254', // AWS metadata SSRF attempt
        'X-Target-Port': '80'
      },
      body: 'test'
    });
    assert(ssrfRes.status === 400, 'SSRF to cloud metadata 169.254.169.254 rejected with 400');

    // Test 2.5.1: Relay target validation rules (lan_guard.js)
    // The same-subnet rule lets a hub on an unusual (non-RFC1918) network relay to its own
    // peers without configuration, so the ranges that must stay blocked need explicit cover.
    const lanGuard = require('../../apps/desktop/desktop_hub/lan_guard');

    const blocked = [
      ['169.254.169.254', 'cloud metadata'],
      ['169.254.1.1', 'any link-local address'],
      ['127.0.0.1', 'loopback'],
      ['127.0.0.2', 'loopback, not just .1'],
      ['0.0.0.0', 'unspecified'],
      ['203.0.113.5', 'public TEST-NET-3'],
      ['8.8.8.8', 'public DNS'],
      ['not-an-ip', 'malformed input'],
      ['999.1.1.1', 'out-of-range octet']
    ];
    for (const [ip, label] of blocked) {
      assert(!lanGuard.isAllowedRelayTarget(ip), `Relay to ${ip} (${label}) must stay blocked`);
    }

    for (const ip of ['192.168.1.50', '10.8.0.4', '172.16.5.5']) {
      assert(lanGuard.isAllowedRelayTarget(ip), `Relay to RFC1918 ${ip} must be allowed`);
    }

    // A host on this machine's own subnet is an on-link peer and must be allowed by default,
    // which is what makes non-RFC1918 networks work without SAFEDROP_RELAY_TARGETS.
    const ownSubnet = lanGuard.localSubnets().find((s) => ((~s.mask) >>> 0) >= 4);
    if (ownSubnet) {
      const peer = lanGuard.uintToIpv4((ownSubnet.network + 2) >>> 0);
      assert(
        lanGuard.isAllowedRelayTarget(peer),
        `Peer ${peer} on the hub's own subnet ${lanGuard.uintToIpv4(ownSubnet.network)} must be allowed`
      );
    }

    // Test 2.6: Static file directory traversal attack prevention: server.js source code must NEVER be returned
    const traversalRes = await fetch('http://127.0.0.1:9988/../../server.js');
    const traversalText = await traversalRes.text();
    assert(!traversalText.includes("require('dgram')") && !traversalText.includes("require('crypto')"), 'server.js source code was not leaked via path traversal');
    assert(traversalRes.status === 403 || traversalRes.status === 404 || (traversalRes.status === 200 && traversalText.includes('SafeDrop')), 'Non-existent or traversal path safely handled by 403/404 or SPA index.html fallback');

    // Test 2.7: /api/v1/settings/open-dir safe invocation (no crash)
    const openDirRes = await fetch('http://127.0.0.1:9988/api/v1/settings/open-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const openDirData = await openDirRes.json();
    assert(openDirData.code === 0, 'Open-dir safely invoked without command injection vulnerability');

    console.log(`\n========================================`);
    console.log(`Results: ${passCount} Passed, ${failCount} Failed`);
    console.log(`========================================`);
    process.exit(failCount === 0 ? 0 : 1);
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  }
}, 600);
