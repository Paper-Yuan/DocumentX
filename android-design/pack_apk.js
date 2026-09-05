const fs = require('fs');
const path = require('path');

const targetApk = path.join(__dirname, 'SafeDrop-release.apk');
const gradleReleaseApk = path.join(__dirname, 'com', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const gradleUnsignedApk = path.join(__dirname, 'com', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
const gradleDebugApk = path.join(__dirname, 'com', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

console.log('====================================================');
console.log('SafeDrop Mobile APK Packager and Archiver');
console.log('====================================================');

if (fs.existsSync(gradleReleaseApk)) {
  fs.copyFileSync(gradleReleaseApk, targetApk);
  console.log('Synchronized SafeDrop Gradle Release APK');
} else if (fs.existsSync(gradleUnsignedApk)) {
  fs.copyFileSync(gradleUnsignedApk, targetApk);
  console.log('Synchronized SafeDrop Gradle Unsigned Release APK');
} else if (fs.existsSync(gradleDebugApk)) {
  fs.copyFileSync(gradleDebugApk, targetApk);
  console.log('Synchronized SafeDrop Gradle Debug APK');
}

if (fs.existsSync(targetApk)) {
  const stat = fs.statSync(targetApk);
  console.log(`SafeDrop-release.apk ready: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);
  console.log('   - Package: com.safedrop.mobile');
  console.log('   - App Name: SafeDrop');
} else {
  console.warn('SafeDrop-release.apk not found. Please compile with Gradle first.');
}
