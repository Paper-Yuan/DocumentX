const http = require('http');

console.log('=== Testing SafeDrop Multi-Device & Web Portal Features ===\n');

process.env.PORT = '9977';
require('../../apps/desktop/desktop_hub/server.js');

setTimeout(async () => {
  let pass = 0;
  let fail = 0;
  function assert(cond, msg) {
    if (cond) {
      console.log(`[PASS] ${msg}`);
      pass++;
    } else {
      console.error(`[FAIL] ${msg}`);
      fail++;
    }
  }

  try {
    // 1. Announce Mobile Device A
    const devA = await fetch('http://127.0.0.1:9977/api/v1/devices/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'phone-xiaomi-13-uuid',
        name: '小米 13 (Android)',
        ip: '192.168.10.101',
        port: 8899,
        fingerprint: 'MOBI-FP-AAAAAA',
        os: 'android'
      })
    }).then(r => r.json());
    assert(devA.code === 0, 'Device A announced successfully');

    // 2. Announce Mobile Device B with different ID and IP
    const devB = await fetch('http://127.0.0.1:9977/api/v1/devices/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'phone-huawei-mate60-uuid',
        name: '华为 Mate 60 (HarmonyOS)',
        ip: '192.168.10.102',
        port: 8899,
        fingerprint: 'MOBI-FP-BBBBBB',
        os: 'android'
      })
    }).then(r => r.json());
    assert(devB.code === 0, 'Device B announced successfully');

    // 3. Query /api/v1/devices - BOTH devices must exist simultaneously!
    const devList = await fetch('http://127.0.0.1:9977/api/v1/devices').then(r => r.json());
    const devices = devList.devices || [];
    assert(devices.length >= 2, `Multiple devices retained simultaneously: count = ${devices.length}`);
    const hasA = devices.some(d => d.id === 'phone-xiaomi-13-uuid');
    const hasB = devices.some(d => d.id === 'phone-huawei-mate60-uuid');
    assert(hasA && hasB, 'Both Device A and Device B coexist without purging each other');

    // 4. Test /portal returns the standalone Web File Transfer & Receive Portal
    const portalRes = await fetch('http://127.0.0.1:9977/portal');
    const portalHtml = await portalRes.text();
    assert(portalRes.status === 200, '/portal returns HTTP 200');
    assert(portalHtml.includes('SafeDrop 极速快传'), 'portal.html contains SafeDrop header');
    assert(portalHtml.includes('投送文件到对方端'), 'portal.html contains upload section');
    assert(portalHtml.includes('浏览并接收对方文件'), 'portal.html contains download section');
    assert(portalHtml.includes('id="uploadDropZone"'), 'portal.html contains upload dropzone');
    assert(portalHtml.includes('id="pinModalOverlay"'), 'portal.html contains PIN modal');

    // 5. Test Web Portal Upload via /api/v1/transfer/upload
    const testTaskId = `test_portal_${Date.now()}`;
    const testFileName = 'portal_test.txt';
    const testFileContent = Buffer.from('SafeDrop independent Web Portal transfer test content');
    const uploadRes = await fetch('http://127.0.0.1:9977/api/v1/transfer/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Task-Id': testTaskId,
        'X-File-Name': testFileName,
        'X-File-Size': testFileContent.length.toString(),
        'X-Chunk-Index': '0',
        'X-Chunk-Count': '1'
      },
      body: testFileContent
    });
    const uploadJson = await uploadRes.json();
    assert(uploadJson.code === 0 && uploadJson.status === 'completed', 'Chunked upload via portal endpoint succeeded');

    // 6. Test File List & Download
    const filesRes = await fetch('http://127.0.0.1:9977/api/v1/files/list');
    const filesJson = await filesRes.json();
    assert(filesJson.code === 0 && Array.isArray(filesJson.files), 'Files list retrieved successfully');
    const hasUploadedFile = filesJson.files.some(f => f.name === testFileName);
    assert(hasUploadedFile, `Uploaded test file "${testFileName}" appears in vault list`);

    const downloadRes = await fetch(`http://127.0.0.1:9977/api/v1/files/download/${encodeURIComponent(testFileName)}`);
    const downloadContent = await downloadRes.text();
    assert(downloadRes.status === 200 && downloadContent === testFileContent.toString(), 'Downloaded file matches uploaded content');

    console.log(`\n========================================`);
    console.log(`Results: ${pass} Passed, ${fail} Failed`);
    console.log(`========================================`);
    process.exit(fail > 0 ? 1 : 0);
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  }
}, 800);
