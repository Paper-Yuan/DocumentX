#!/usr/bin/env node
'use strict';

/**
 * The version the product reports has one source: APP_VERSION in the hub's server.js.
 * Everything else is a copy, and those copies have already been mis-edited enough times to
 * deserve a machine (eb3b725 aligned the C# assemblies, e70a0b9 the changelog note, 21c3aa5 the
 * download names). Every rule below fails loudly when its pattern stops matching, because a
 * version checker that silently passes on a broken regex is worse than none.
 *
 *   node scripts/version-check.js
 *
 * Zero dependencies, works from any current directory.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_OF_TRUTH = 'apps/desktop/desktop_hub/server.js';

const results = [];
let declared = null;

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function record(file, label, ok, detail) {
  results.push({ file, label, ok, detail });
}

/** Require at least one match; every match must satisfy `expected`. */
function checkAll(relPath, label, pattern, expected, only) {
  let content;
  try {
    content = read(relPath);
  } catch (err) {
    record(relPath, label, false, 'file unreadable: ' + err.code);
    return;
  }
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let matches = [...content.matchAll(globalPattern)];
  if (only && matches.length > 1) matches = [matches[0]];
  if (matches.length === 0) {
    record(relPath, label, false, `pattern ${globalPattern} matched nothing`);
    return;
  }
  let firstBad = null;
  for (const m of matches) {
    const want = typeof expected === 'function' ? expected(m) : expected;
    if (typeof want === 'string' && m[1] !== want) {
      firstBad = `found "${m[1]}", expected "${want}"`;
      break;
    }
  }
  const seen = matches.map((m) => m[1]).join(', ');
  record(relPath, label, firstBad === null, firstBad || `${seen} == ${declared}`);
}

function declareVersion() {
  const m = read(SOURCE_OF_TRUTH).match(/const APP_VERSION = '(\d+\.\d+\.\d+)'/);
  if (!m) {
    console.error(`FAIL ${SOURCE_OF_TRUTH} no longer declares "const APP_VERSION = 'x.y.z'"`);
    process.exit(1);
  }
  declared = m[1];
}

const V = () => declared;
const SEMVER = String.raw`\d+\.\d+\.\d+`;

declareVersion();
console.log(`SafeDrop version check - source of truth ${SOURCE_OF_TRUTH} = ${declared}\n`);

checkAll(SOURCE_OF_TRUTH, 'hub APP_VERSION', new RegExp(`const APP_VERSION = '(${SEMVER})'`), V());

checkAll('apps/desktop/tauri-app/package.json', 'npm package version', new RegExp(`"version": "(${SEMVER})"`), V());
checkAll('apps/desktop/tauri-app/src-tauri/tauri.conf.json', 'Tauri config version', new RegExp(`"version": "(${SEMVER})"`), V());
checkAll('apps/desktop/tauri-app/src-tauri/Cargo.toml', 'crate version', new RegExp(`^version = "(${SEMVER})"`, 'm'), V());
checkAll(
  'apps/desktop/tauri-app/src-tauri/Cargo.lock',
  'crate version in lockfile',
  new RegExp(`name = "safedrop-desktop",?\\r?\\nversion = "(${SEMVER})"`),
  V()
);

checkAll('apps/android/com/app/build.gradle', 'Android versionName', new RegExp(`versionName "(${SEMVER})"`), V());
{
  const m = read('apps/android/com/app/build.gradle').match(/versionCode (\d+)/);
  record('apps/android/com/app/build.gradle', 'Android versionCode', !!m, m ? `versionCode ${m[1]} (must increase on every release)` : 'versionCode not found');
}

for (const cs of ['apps/desktop/installer/Launcher.cs', 'apps/desktop/installer/Installer.cs', 'apps/desktop/installer/Uninstaller.cs']) {
  checkAll(cs, 'AssemblyVersion', new RegExp(`AssemblyVersion\\("(${SEMVER})\\.0"\\)`), V());
  checkAll(cs, 'AssemblyFileVersion', new RegExp(`AssemblyFileVersion\\("(${SEMVER})\\.0"\\)`), V());
  checkAll(cs, 'AssemblyInformationalVersion', new RegExp(`AssemblyInformationalVersion\\("(${SEMVER})"\\)`), V());
}

checkAll('apps/desktop/installer/Installer.cs', 'ARP DisplayVersion', new RegExp(`SetValue\\("DisplayVersion", "(${SEMVER})"\\)`), V());

checkAll('CHANGELOG.md', 'latest released changelog section', new RegExp(`^## \\[(${SEMVER})\\]`, 'm'), V(), true);

// Artifact names are what the release page and README must agree on. Which wire protocol the
// release speaks is a separate question, and scripts/protocol.js owns that assertion.
checkAll(
  'README.md',
  'download artifact names',
  new RegExp(`SafeDrop-(?:Setup|Android)-(${SEMVER})\\.(?:exe|apk)`, 'g'),
  V()
);

const width = Math.max(...results.map((r) => (r.file + ' · ' + r.label).length));
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${(r.file + ' · ' + r.label).padEnd(width)}  ${r.detail}`);
}

console.log(`\n${results.length - failed}/${results.length} checks agree on ${declared}.`);
if (failed > 0) {
  console.log(
    `\n${failed} mismatch(es). Fix the copies, or update scripts/version-check.js if a checked\n` +
      `location genuinely stopped existing. The Android Flutter tree (apps/desktop/com/) is\n` +
      `deliberately not checked: it is unbuilt legacy slated for removal.`
  );
  process.exit(1);
}
