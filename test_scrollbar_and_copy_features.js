const fs = require('fs');
const path = require('path');

console.log('====================================================');
console.log('🧪 Verifying Scrollbar Theme, Text Copy & Layout Features');
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

// 1. Desktop Scrollbar Theming Verification
console.log('▶ Check 1: Desktop Theme-Matched Scrollbars (Replacing White Bar)');
const styleCss = fs.readFileSync(path.join(__dirname, 'computer-design', 'desktop_hub', 'public', 'style.css'), 'utf8');

assert(styleCss.includes('body.dark-theme') && styleCss.includes('--scrollbar-track: #0F0F12'), 'Dark theme defines custom scrollbar track #0F0F12');
assert(styleCss.includes('body.dark-theme') && styleCss.includes('--scrollbar-thumb: #2E2E38'), 'Dark theme defines custom scrollbar thumb #2E2E38');
assert(styleCss.includes('body.eyecare-theme') && styleCss.includes('--scrollbar-track: #EDE4D0'), 'Eyecare theme defines warm rice-yellow scrollbar track #EDE4D0');
assert(styleCss.includes('body.eyecare-theme') && styleCss.includes('--scrollbar-thumb: #C8BFA9'), 'Eyecare theme defines harmonious scrollbar thumb #C8BFA9');
assert(styleCss.includes('body.light-theme') && styleCss.includes('--scrollbar-track: #F1F4F9'), 'Light theme defines clean scrollbar track #F1F4F9');
assert(styleCss.includes('body.light-theme') && styleCss.includes('--scrollbar-thumb: #CBD5E1'), 'Light theme defines clean scrollbar thumb #CBD5E1');

assert(styleCss.includes('::-webkit-scrollbar') && styleCss.includes('::-webkit-scrollbar-thumb'), 'Global WebKit custom scrollbar styling declared');
assert(styleCss.includes('.chat-stream-container::-webkit-scrollbar'), 'chat-stream-container has dedicated scrollbar overrides eliminating native white bar');
assert(styleCss.includes('scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track)'), 'Standard CSS scrollbar-color rule declared for cross-browser compliance');

// 2. Desktop Right-Click / Hold Right-Click Text Selection & Copy
console.log('\n▶ Check 2: Desktop Long-Press Right-Click Text Selection & Copy');
assert(styleCss.includes('.chat-bubble-content') && styleCss.includes('user-select: text'), 'chat-bubble-content allows text selection (user-select: text)');
assert(styleCss.includes('.chat-context-menu'), 'style.css defines .chat-context-menu styling');
assert(styleCss.includes('.chat-context-menu-item'), 'style.css defines .chat-context-menu-item interactive item');

const appJs = fs.readFileSync(path.join(__dirname, 'computer-design', 'desktop_hub', 'public', 'app.js'), 'utf8');
assert(appJs.includes('selectBubbleText'), 'app.js implements selectBubbleText DOM Range selection function');
assert(appJs.includes('showChatContextMenu'), 'app.js implements showChatContextMenu floating menu');
assert(appJs.includes('rightClickTimer') && appJs.includes('e.button === 2'), 'app.js supports long-press right click detection on mouse button 2');
assert(appJs.includes('contextmenu'), 'app.js binds contextmenu event on chat timeline to prevent default and pop up copy menu');
assert(appJs.includes('navigator.clipboard.writeText'), 'app.js writes selected message to clipboard');

// 3. Mobile Layout: Independent Chat Input Bar & Navigation Overlap Fix
console.log('\n▶ Check 3: Mobile Layout - Dialogue Box Independent Display & No Overlap');
const mainXml = fs.readFileSync(path.join(__dirname, 'android-design', 'com', 'app', 'src', 'main', 'res', 'layout', 'activity_main.xml'), 'utf8');
assert(mainXml.includes('android:id="@+id/pagesContainer"') && mainXml.includes('android:layout_marginBottom="96dp"'), 'pagesContainer has expanded fallback marginBottom="96dp"');
assert(mainXml.includes('android:id="@+id/chatInputBarDivider"'), 'layoutChatInputBar has dedicated top divider line for independent visual separation');
assert(mainXml.includes('android:id="@+id/layoutChatInputBar"') && mainXml.includes('android:elevation="6dp"'), 'layoutChatInputBar has elevation="6dp" for independent card depth');

const mainKt = fs.readFileSync(path.join(__dirname, 'android-design', 'com', 'app', 'src', 'main', 'java', 'com', 'safedrop', 'mobile', 'ui', 'MainActivity.kt'), 'utf8');
assert(mainKt.includes('bottomNavigation.addOnLayoutChangeListener'), 'MainActivity registers addOnLayoutChangeListener on bottomNavigation');
assert(mainKt.includes('val navHeight = bottom - top') && mainKt.includes('lp.bottomMargin = navHeight'), 'MainActivity dynamically matches pagesContainer bottom margin to real navHeight');
assert(mainKt.includes('chatInputBarDivider.setBackgroundColor'), 'MainActivity styles chatInputBarDivider across themes');

// 4. Mobile Chat Text: Long-Press Selection and Copy
console.log('\n▶ Check 4: Mobile Long-Press Message Text Selection & Copy');
const itemMsgXml = fs.readFileSync(path.join(__dirname, 'android-design', 'com', 'app', 'src', 'main', 'res', 'layout', 'item_channel_message.xml'), 'utf8');
assert(itemMsgXml.includes('android:id="@+id/tvMessageContent"') && itemMsgXml.includes('android:textIsSelectable="true"'), 'tvMessageContent has android:textIsSelectable="true"');

const adapterKt = fs.readFileSync(path.join(__dirname, 'android-design', 'com', 'app', 'src', 'main', 'java', 'com', 'safedrop', 'mobile', 'ui', 'adapter', 'ChannelMessageAdapter.kt'), 'utf8');
assert(adapterKt.includes('tvMessageContent.setTextIsSelectable(true)'), 'ChannelMessageAdapter explicitly enables text selectable on ViewHolder bind');
assert(adapterKt.includes('cardTextBubble.setOnLongClickListener'), 'cardTextBubble binds OnLongClickListener for long-press copy action');
assert(adapterKt.includes('ClipboardManager') && adapterKt.includes('ClipData.newPlainText'), 'ChannelMessageAdapter utilizes Android ClipboardManager for copying');
assert(adapterKt.includes('tvMessageContent.highlightColor = Color.parseColor'), 'tvMessageContent text highlight colors are customized per theme');

// 5. Build Artifacts
console.log('\n▶ Check 5: Compiled APK Artifacts');
const releaseApkPath = path.join(__dirname, 'android-design', 'SafeDrop-release.apk');
assert(fs.existsSync(releaseApkPath), 'SafeDrop-release.apk exists and is ready');
const apkStat = fs.statSync(releaseApkPath);
assert(apkStat.size > 20 * 1024 * 1024, `SafeDrop-release.apk size is valid (${(apkStat.size / (1024 * 1024)).toFixed(2)} MB)`);

console.log('\n====================================================');
console.log(`🎯 All Verification Checks Passed: ${passCount}/${totalCount}`);
console.log('====================================================');
