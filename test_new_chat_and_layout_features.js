const fs = require('fs');
const path = require('path');
const http = require('http');

console.log('====================================================');
console.log('🧪 Testing New Desktop & Mobile Per-Device Chat & Layout Features');
console.log('====================================================\n');

let passCount = 0;
let totalCount = 0;

function assert(condition, message) {
  totalCount++;
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    process.exitCode = 1;
  }
}

async function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function runAllChecks() {
  // 1. Desktop Hub Chat & Window UI checks
  console.log('▶ Check 1: Desktop Hub HTML & CSS Chat / Window UI Integration');
  const indexHtml = fs.readFileSync(path.join(__dirname, 'computer-design', 'desktop_hub', 'public', 'index.html'), 'utf8');
  assert(indexHtml.includes('data-tab="chatTab"'), 'Navigation contains Chat / Transfer Window tab button (data-tab="chatTab")');
  assert(indexHtml.includes('id="chatTab"'), 'index.html includes dedicated #chatTab section');
  assert(indexHtml.includes('id="chatPeersList"'), 'index.html includes #chatPeersList peer selector sidebar');
  assert(indexHtml.includes('id="chatTimeline"'), 'index.html includes #chatTimeline message stream container');
  assert(indexHtml.includes('class="chat-input-bar"'), 'index.html includes .chat-input-bar message & file input bar');
  assert(indexHtml.includes('id="chatFileInput"'), 'index.html includes direct file picker in chat window');

  const styleCss = fs.readFileSync(path.join(__dirname, 'computer-design', 'desktop_hub', 'public', 'style.css'), 'utf8');
  assert(styleCss.includes('.chat-layout'), 'style.css contains .chat-layout styling');
  assert(styleCss.includes('.chat-bubble.outgoing') && styleCss.includes('.chat-bubble.incoming'), 'style.css contains chat bubble styling for incoming/outgoing');
  assert(styleCss.includes('.chat-file-card'), 'style.css contains interactive file transfer card styling');
  assert(styleCss.includes('body.eyecare-theme .chat-bubble'), 'style.css contains eyecare theme styling for chat');
  assert(styleCss.includes('body.light-theme .chat-bubble'), 'style.css contains light theme styling for chat');

  // 2. Desktop Hub Server Messaging Endpoint
  console.log('\n▶ Check 2: Desktop Hub Message Relay API Endpoint');
  const postMsgRes = await requestJson('http://127.0.0.1:8899/api/v1/message/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetPeerId: 'test-mobile-peer-01',
      text: 'Hello from automated test!',
      senderId: 'pc-test',
      senderName: 'Windows Desktop Hub'
    })
  });
  assert(postMsgRes.status === 200 && postMsgRes.data.code === 0, 'POST /api/v1/message/send returns code 0 success');

  const listMsgRes = await requestJson('http://127.0.0.1:8899/api/v1/messages/list?peerId=test-mobile-peer-01');
  assert(listMsgRes.status === 200 && Array.isArray(listMsgRes.data.messages), 'GET /api/v1/messages/list returns messages array');
  assert(listMsgRes.data.messages.some(m => m.text === 'Hello from automated test!'), 'Message was saved into peer conversation history');

  // 3. Mobile Android Top Bar & Radar Spacing
  console.log('\n▶ Check 3: Mobile Layout - Compact Icon-Only Top Buttons & Breathing Room');
  const mainLayout = fs.readFileSync(path.join(__dirname, 'android-design', 'com', 'app', 'src', 'main', 'res', 'layout', 'activity_main.xml'), 'utf8');
  const btnQrMatch = mainLayout.match(/<com\.google\.android\.material\.button\.MaterialButton[\s\S]*?id="\@\+id\/btnShowMyQr"[\s\S]*?\/>/);
  assert(btnQrMatch && !btnQrMatch[0].includes('android:text='), 'btnShowMyQr is icon-only without text');
  
  const btnPinMatch = mainLayout.match(/<com\.google\.android\.material\.button\.MaterialButton[\s\S]*?id="\@\+id\/btnInputPin"[\s\S]*?\/>/);
  assert(btnPinMatch && !btnPinMatch[0].includes('android:text='), 'btnInputPin is icon-only without text');

  const btnScanMatch = mainLayout.match(/<com\.google\.android\.material\.button\.MaterialButton[\s\S]*?id="\@\+id\/btnScanQr"[\s\S]*?\/>/);
  assert(btnScanMatch && !btnScanMatch[0].includes('android:text='), 'btnScanQr is icon-only without text');

  assert(mainLayout.includes('id="@+id/cardRadar"'), 'cardRadar is present');
  assert(mainLayout.includes('id="@+id/tvOnlineCountTag"'), 'cardRadar has modern online count tag badge');
  assert(mainLayout.includes('android:layout_marginTop="20dp"') && mainLayout.includes('id="@+id/tvDeviceSectionTitle"'), 'tvDeviceSectionTitle has comfortable breathing room (20dp margin)');

  // 4. Mobile Android Page 2 - Dedicated Per-Peer Transfer & Chat Window
  console.log('\n▶ Check 4: Mobile Page 2 - Merged Per-Device Transfer & Chat Window');
  assert(mainLayout.includes('id="@+id/layoutTransferPage"'), 'layoutTransferPage container exists');
  assert(mainLayout.includes('id="@+id/rvPeerChips"'), 'rvPeerChips horizontal peer selector exists');
  assert(mainLayout.includes('id="@+id/cardActivePeerInfo"'), 'cardActivePeerInfo active peer banner exists');
  assert(mainLayout.includes('id="@+id/rvChannelMessages"'), 'rvChannelMessages message & transfer timeline exists');
  assert(mainLayout.includes('id="@+id/layoutChatInputBar"'), 'layoutChatInputBar bottom action bar exists');
  assert(mainLayout.includes('id="@+id/btnChannelPickFile"'), 'btnChannelPickFile quick transfer button exists');
  assert(mainLayout.includes('id="@+id/etChannelMessage"'), 'etChannelMessage text input exists');
  assert(mainLayout.includes('id="@+id/btnChannelSendMessage"'), 'btnChannelSendMessage send button exists');

  // 5. Mobile Kotlin Components & Theme Consistency
  console.log('\n▶ Check 5: Mobile Code Consistency & 3-State Theme Adaptation');
  const mainKt = fs.readFileSync(path.join(__dirname, 'android-design', 'com', 'app', 'src', 'main', 'java', 'com', 'safedrop', 'mobile', 'ui', 'MainActivity.kt'), 'utf8');
  assert(mainKt.includes('peerChipAdapter.setThemeMode(theme)'), 'peerChipAdapter theme mode is updated');
  assert(mainKt.includes('channelMessageAdapter.setThemeMode(theme)'), 'channelMessageAdapter theme mode is updated');
  assert(mainKt.includes('cardActivePeerInfo.setCardBackgroundColor(eyecareCardBg)'), 'cardActivePeerInfo adapts to eyecare theme');
  assert(mainKt.includes('cardActivePeerInfo.setCardBackgroundColor(lightCardBg)'), 'cardActivePeerInfo adapts to light theme');
  assert(mainKt.includes('cardActivePeerInfo.setCardBackgroundColor(darkCardBg)'), 'cardActivePeerInfo adapts to dark theme');
  assert(mainKt.includes('openPeerChatWindow'), 'MainActivity has openPeerChatWindow navigation logic');

  // 6. Device List item_device.xml Chat button
  console.log('\n▶ Check 6: Device Card Quick-Chat Action Button');
  const itemDevice = fs.readFileSync(path.join(__dirname, 'android-design', 'com', 'app', 'src', 'main', 'res', 'layout', 'item_device.xml'), 'utf8');
  assert(itemDevice.includes('id="@+id/btnOpenChat"'), 'item_device.xml has dedicated btnOpenChat (会话) button');
  assert(itemDevice.includes('id="@+id/btnConnectDevice"'), 'item_device.xml retains btnConnectDevice (投送) button');

  console.log('\n====================================================');
  console.log(`🎯 All New Features Checks Passed: ${passCount}/${totalCount}`);
  console.log('====================================================');
}

runAllChecks().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
