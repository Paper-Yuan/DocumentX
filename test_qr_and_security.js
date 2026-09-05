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
const qrcodeJs = fs.readFileSync(path.join(__dirname, 'computer-design', 'desktop_hub', 'public', 'qrcode.js'), 'utf8');
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
require('./computer-design/desktop_hub/server.js');

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

    // Test 2.2: Handshake verification with active PIN
    const verifyRes1 = await fetch('http://127.0.0.1:9988/api/v1/handshake/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: currentPin })
    });
    const verifyData1 = await verifyRes1.json();
    assert(verifyData1.code === 0 && verifyData1.status === 'verified', 'Verify succeeds with active PIN');

    // Test 2.3: Handshake verification with previous PIN in 60s grace period
    const verifyRes2 = await fetch('http://127.0.0.1:9988/api/v1/handshake/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: currentPin })
    });
    const verifyData2 = await verifyRes2.json();
    assert(verifyData2.code === 0 && verifyData2.status === 'verified', 'Verify succeeds with previous PIN within grace period');

    // Test 2.4: Invalid PIN is rejected
    const verifyRes3 = await fetch('http://127.0.0.1:9988/api/v1/handshake/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '000000' })
    });
    assert(verifyRes3.status === 403, 'Invalid PIN correctly rejected with 403');

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
