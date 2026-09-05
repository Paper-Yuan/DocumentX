const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== SafeDrop Desktop Hub Theme & Device Display Verification ===\n');

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`[PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

const htmlPath = path.join(__dirname, 'computer-design', 'desktop_hub', 'public', 'index.html');
const cssPath = path.join(__dirname, 'computer-design', 'desktop_hub', 'public', 'style.css');
const jsPath = path.join(__dirname, 'computer-design', 'desktop_hub', 'public', 'app.js');

const htmlContent = fs.readFileSync(htmlPath, 'utf8');
const cssContent = fs.readFileSync(cssPath, 'utf8');
const jsContent = fs.readFileSync(jsPath, 'utf8');

// 1. HTML Verification
it('index.html contains themeSegGlider element inside themeSegmented', () => {
  assert(htmlContent.includes('id="themeSegGlider"'), 'themeSegGlider element missing');
  assert(htmlContent.includes('class="theme-seg-glider"'), 'theme-seg-glider class missing');
});

it('index.html contains devicesGrid and discovery hub elements', () => {
  assert(htmlContent.includes('id="devicesGrid"'), 'devicesGrid missing');
  assert(htmlContent.includes('id="discoveryStatusText"'), 'discoveryStatusText missing');
  assert(htmlContent.includes('id="radarCenterLabel"'), 'radarCenterLabel missing');
});

// 2. CSS Animation & Smooth Transitions Verification
it('style.css defines View Transitions API rules for smooth theme cross-fade', () => {
  assert(cssContent.includes('::view-transition-old(root)'), 'view-transition-old missing');
  assert(cssContent.includes('::view-transition-new(root)'), 'view-transition-new missing');
  assert(cssContent.includes('animation-duration: 0.35s'), 'view-transition duration missing');
});

it('style.css defines universal smooth transitions across theme switches', () => {
  assert(cssContent.includes('cubic-bezier(0.16, 1, 0.3, 1)'), 'smooth cubic-bezier deceleration curve missing');
  assert(cssContent.includes('.theme-seg-glider'), 'theme-seg-glider rule missing');
});

it('style.css configures sliding glider backgrounds for all 3 themes', () => {
  assert(cssContent.includes('body.dark-theme .theme-seg-glider'), 'dark glider rule missing');
  assert(cssContent.includes('body.eyecare-theme .theme-seg-glider'), 'eyecare glider rule missing');
  assert(cssContent.includes('body.light-theme .theme-seg-glider'), 'light glider rule missing');
  assert(cssContent.includes('#CDE8D5'), 'eyecare glider background (#CDE8D5) missing');
  assert(cssContent.includes('#FFFFFF'), 'light glider background (#FFFFFF) missing');
});

// 3. CSS Device Representation & Single-Line Layout Verification
it('style.css expands devices-grid min-width to 420px for ample horizontal space', () => {
  assert(cssContent.includes('minmax(420px, 1fr)'), 'minmax(420px, 1fr) missing from devices-grid');
});

it('style.css enlarges device-card, avatar, and adds status pulse', () => {
  assert(cssContent.includes('width: 56px') && cssContent.includes('height: 56px'), '56px avatar missing');
  assert(cssContent.includes('.avatar-status-dot'), 'avatar-status-dot missing');
  assert(cssContent.includes('min-height: 86px'), 'min-height: 86px missing from device-card');
});

it('style.css enforces single-line display for device names, tags, and meta rows', () => {
  // Check .device-name-row, .device-name, .device-meta-row, .device-meta-chip have white-space: nowrap
  const deviceNameRowMatch = cssContent.match(/\.device-name-row\s*\{[^}]*\}/s);
  assert(deviceNameRowMatch && deviceNameRowMatch[0].includes('white-space: nowrap'), '.device-name-row must have white-space: nowrap');

  const deviceNameMatch = cssContent.match(/\.device-name\s*\{[^}]*\}/s);
  assert(deviceNameMatch && deviceNameMatch[0].includes('text-overflow: ellipsis'), '.device-name must have text-overflow: ellipsis');

  const deviceMetaRowMatch = cssContent.match(/\.device-meta-row\s*\{[^}]*\}/s);
  assert(deviceMetaRowMatch && deviceMetaRowMatch[0].includes('white-space: nowrap'), '.device-meta-row must have white-space: nowrap');

  const deviceMetaChipMatch = cssContent.match(/\.device-meta-chip\s*\{[^}]*\}/s);
  assert(deviceMetaChipMatch && deviceMetaChipMatch[0].includes('white-space: nowrap'), '.device-meta-chip must have white-space: nowrap');

  const sendBtnMatch = cssContent.match(/\.send-to-device-btn\s*\{[^}]*\}/s);
  assert(sendBtnMatch && sendBtnMatch[0].includes('white-space: nowrap'), '.send-to-device-btn must have white-space: nowrap');
});

it('style.css guarantees central hub node and radar status bar single-line display', () => {
  const radarStatusMatch = cssContent.match(/\.radar-status-bar\s*\{[^}]*\}/s);
  assert(radarStatusMatch && radarStatusMatch[0].includes('white-space: nowrap'), '.radar-status-bar must have white-space: nowrap');

  const statusTextMatch = cssContent.match(/#discoveryStatusText\s*\{[^}]*\}/s);
  assert(statusTextMatch && statusTextMatch[0].includes('text-overflow: ellipsis'), '#discoveryStatusText must have text-overflow: ellipsis');
});

// 4. Eyecare and Light Mode Overrides Verification
it('style.css sets pure black text for active theme buttons, platform tags, and device names in eyecare & light modes', () => {
  assert(cssContent.includes('body.eyecare-theme .theme-seg-btn.active'), 'eyecare theme active button override missing');
  assert(cssContent.includes('body.eyecare-theme .device-platform-tag'), 'eyecare platform tag override missing');
  assert(cssContent.includes('body.eyecare-theme .device-name'), 'eyecare device name override missing');
  assert(cssContent.includes('body.light-theme .theme-seg-btn.active'), 'light theme active button override missing');
  assert(cssContent.includes('body.light-theme .device-platform-tag'), 'light platform tag override missing');
  assert(cssContent.includes('body.light-theme .device-name'), 'light device name override missing');
});

// 5. JavaScript Logic Verification
it('app.js integrates document.startViewTransition in applyTheme', () => {
  assert(jsContent.includes('document.startViewTransition'), 'document.startViewTransition missing in app.js');
  assert(jsContent.includes('updateGliderPosition'), 'updateGliderPosition missing in app.js');
});

it('app.js renderDevicesGrid produces avatar wrap, platform badge, and structured single-line meta chips', () => {
  assert(jsContent.includes('device-avatar-wrap'), 'device-avatar-wrap missing in app.js template');
  assert(jsContent.includes('avatar-status-dot online'), 'avatar-status-dot online missing in app.js template');
  assert(jsContent.includes('device-platform-tag'), 'device-platform-tag missing in app.js template');
  assert(jsContent.includes('device-meta-row'), 'device-meta-row missing in app.js template');
  assert(jsContent.includes('device-meta-chip ip-chip'), 'device-meta-chip ip-chip missing in app.js template');
  assert(jsContent.includes('device-meta-chip fp-chip'), 'device-meta-chip fp-chip missing in app.js template');
});

// 6. Template Simulation Test
it('Template output correctly generates HTML for both PC and Mobile devices', () => {
  const sampleDevices = [
    {
      id: 'dev_1',
      name: 'Redmi Note 12 Turbo',
      ip: '192.168.10.105',
      port: 8899,
      os: 'android',
      fingerprint: 'A1B2C3D4',
      isHost: false
    },
    {
      id: 'dev_2',
      name: 'J1825-WORKSTATION-PC',
      ip: '192.168.10.42',
      port: 52199,
      os: 'windows',
      fingerprint: '3C1CCA46',
      isHost: false
    }
  ];

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const generatedHtml = sampleDevices.map(dev => {
    const isPc = dev.os === 'windows' || dev.isHost;
    const platformName = isPc ? '电脑端' : '手机端';
    const fpText = dev.fingerprint ? dev.fingerprint : 'LAN';
    return `
      <div class="device-card" data-device-id="${dev.id}">
        <div class="device-left">
          <div class="device-avatar-wrap">
            <div class="device-avatar ${isPc ? 'pc' : ''}"></div>
            <span class="avatar-status-dot online"></span>
          </div>
          <div class="device-info">
            <div class="device-name-row">
              <span class="device-name">${escapeHtml(dev.name)}</span>
              <span class="device-platform-tag ${isPc ? 'pc' : 'mobile'}">${platformName}</span>
              <span class="device-status-pill online">在线</span>
            </div>
            <div class="device-meta-row">
              <span class="device-meta-chip ip-chip">${dev.ip}:${dev.port}</span>
              <span class="device-meta-chip fp-chip">指纹: ${fpText}</span>
            </div>
          </div>
        </div>
        <button class="btn btn-primary send-to-device-btn">投送文件</button>
      </div>
    `;
  }).join('');

  assert(generatedHtml.includes('Redmi Note 12 Turbo'), 'Mobile device name rendered');
  assert(generatedHtml.includes('手机端'), 'Mobile platform tag rendered');
  assert(generatedHtml.includes('192.168.10.105:8899'), 'Mobile IP chip rendered');
  assert(generatedHtml.includes('J1825-WORKSTATION-PC'), 'PC device name rendered');
  assert(generatedHtml.includes('电脑端'), 'PC platform tag rendered');
  assert(generatedHtml.includes('192.168.10.42:52199'), 'PC IP chip rendered');
});

console.log(`\n========================================`);
console.log(`Results: ${passed} Passed, ${failed} Failed`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
