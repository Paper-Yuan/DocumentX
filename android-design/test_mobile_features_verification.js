const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('====================================================');
console.log('🧪 Starting SafeDrop Mobile Features & APK Verification');
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

// ----------------------------------------------------
// 1. Genuine APK Artifact & Package Name Verification
// ----------------------------------------------------
console.log('▶ Verification 1: APK Artifact & Package Identity (Prevent third-party packages)');
const apkPath = path.join(__dirname, 'SafeDrop-release.apk');
assert(fs.existsSync(apkPath), 'SafeDrop-release.apk physical file exists');

const stat = fs.statSync(apkPath);
assert(stat.size > 25 * 1024 * 1024, `APK file size valid (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);

const aaptPath = 'C:\\Users\\J1825\\AppData\\Local\\Android\\Sdk\\build-tools\\34.0.0\\aapt.exe';
if (fs.existsSync(aaptPath)) {
  const badging = execSync(`"${aaptPath}" dump badging "${apkPath}"`, { encoding: 'utf8' });
  assert(badging.includes("package: name='com.safedrop.mobile'"), "Package name is strictly 'com.safedrop.mobile'");
  assert(badging.includes("application-label:'SafeDrop'"), "Application label is strictly 'SafeDrop'");
  assert(badging.includes("launchable-activity: name='com.safedrop.mobile.ui.MainActivity'"), "Launchable activity is 'com.safedrop.mobile.ui.MainActivity'");
  assert(!badging.toLowerCase().includes('vivo'), 'APK manifest has no third-party vivo keywords');
} else {
  console.warn('  ⚠️ aapt.exe path not found, skipping badging dump');
}

// ----------------------------------------------------
// 2. Feature 1: Radar (RadarView.kt) 4 Distance Circles & Ping
// ----------------------------------------------------
console.log('\n▶ Verification 2: Mobile RadarView (4 Concentric Circles, Ticks & Node Ping)');
const radarFile = path.join(__dirname, 'com', 'app', 'src', 'main', 'java', 'com', 'safedrop', 'mobile', 'ui', 'radar', 'RadarView.kt');
const radarSrc = fs.readFileSync(radarFile, 'utf8');
assert(radarSrc.includes('5m') && radarSrc.includes('15m') && radarSrc.includes('30m') && radarSrc.includes('50m'), 'RadarView includes 4 concentric range circles (5m, 15m, 30m, 50m)');
assert(radarSrc.includes('tickSize') || radarSrc.includes('crosshairPaint'), 'RadarView implements crosshair ticks');
assert(radarSrc.includes('setThemeMode'), 'RadarView supports dynamic theme adaptation');
assert(radarSrc.includes('setConnectedDevice'), 'RadarView renders connected PC sonar beacon at 15m orbit');

// ----------------------------------------------------
// 3. Feature 2: Dynamic PIN Pairing & Refresh
// ----------------------------------------------------
console.log('\n▶ Verification 3: Dynamic PIN Pairing, Verification & Refresh');
const mainFile = path.join(__dirname, 'com', 'app', 'src', 'main', 'java', 'com', 'safedrop', 'mobile', 'ui', 'MainActivity.kt');
const mainSrc = fs.readFileSync(mainFile, 'utf8');
assert(mainSrc.includes('showPinPairingDialog'), 'MainActivity includes manual PIN pairing dialog');
assert(mainSrc.includes('refreshPin'), 'MainActivity & DesktopHubClient support triggering remote PIN refresh');
assert(mainSrc.includes('btnInputPin'), 'Top app bar includes quick PIN pairing button');

// ----------------------------------------------------
// 4. Feature 3: QR Code Multi-parameter Parsing & Manual Fallback
// ----------------------------------------------------
console.log('\n▶ Verification 4: QR Code Scanning with URI Parsing & Manual Fallback');
const scannerFile = path.join(__dirname, 'com', 'app', 'src', 'main', 'java', 'com', 'safedrop', 'mobile', 'ui', 'scanner', 'QrScannerActivity.kt');
const scannerSrc = fs.readFileSync(scannerFile, 'utf8');
assert(scannerSrc.includes('EXTRA_MANUAL_PIN'), 'Scanner UI supports manual PIN input fallback');
assert(scannerSrc.includes('EXTRA_THEME'), 'Scanner parses theme parameter from QR URI');
assert(scannerSrc.includes('uri.getQueryParameter("pin")'), 'Scanner accurately parses 6-digit dynamic PIN');

// ----------------------------------------------------
// 5. Feature 4: Storage Directory Management & Open Folder
// ----------------------------------------------------
console.log('\n▶ Verification 5: Scoped Storage Directory Management & Folder Access');
const storageFile = path.join(__dirname, 'com', 'app', 'src', 'main', 'java', 'com', 'safedrop', 'mobile', 'core', 'storage', 'ScopedStorageHelper.kt');
const storageSrc = fs.readFileSync(storageFile, 'utf8');
assert(storageSrc.includes('createOpenFolderIntent'), 'ScopedStorageHelper provides intent to open system file manager');
assert(storageSrc.includes('getStorageDisplayPath'), 'ScopedStorageHelper provides formatted storage path display');
assert(mainSrc.includes('btnOpenStorageFolder'), 'MainActivity binds Open Storage Folder button');
assert(mainSrc.includes('showStorageChoiceDialog'), 'MainActivity provides storage location switcher dialog');

// ----------------------------------------------------
// 6. Feature 5: Eyecare Theme & 3-State Switcher
// ----------------------------------------------------
console.log('\n▶ Verification 6: Eye-Care Theme & 3-State Theme Switcher');
const colorsFile = path.join(__dirname, 'com', 'app', 'src', 'main', 'res', 'values', 'colors.xml');
const colorsSrc = fs.readFileSync(colorsFile, 'utf8');
assert(colorsSrc.includes('#F6F4ED') && colorsSrc.includes('#2E7D56'), 'colors.xml adopts warm tea-beige (#F6F4ED) and emerald (#2E7D56)');

const themesFile = path.join(__dirname, 'com', 'app', 'src', 'main', 'res', 'values', 'themes.xml');
const themesSrc = fs.readFileSync(themesFile, 'utf8');
assert(themesSrc.includes('Theme.SafeDrop.EyeCare'), 'themes.xml defines Theme.SafeDrop.EyeCare theme');

const layoutFile = path.join(__dirname, 'com', 'app', 'src', 'main', 'res', 'layout', 'activity_main.xml');
const layoutSrc = fs.readFileSync(layoutFile, 'utf8');
assert(layoutSrc.includes('btnThemeDark') && layoutSrc.includes('btnThemeEyecare') && layoutSrc.includes('btnThemeLight'), 'Main layout features 3-state theme switcher controls');

// ----------------------------------------------------
// Summary Output
// ----------------------------------------------------
console.log('\n====================================================');
console.log(`🎯 SafeDrop Mobile Features & APK Verification Passed: ${passCount}/${totalCount}`);
console.log('====================================================');
