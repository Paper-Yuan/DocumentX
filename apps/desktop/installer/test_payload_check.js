/**
 * Installer payload integrity tests.
 *
 * The installer bundles a copy of the Node backend. If a module is referenced but not
 * copied, the failure only appears after a user installs and launches the app, so these
 * checks run at build time instead.
 *
 * Run: node apps/desktop/installer/test_payload_check.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const payloadCheck = require('./payload_check');

const HUB_DIR = path.resolve(__dirname, '..', 'desktop_hub');

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  [PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

console.log('=== SafeDrop Installer Payload Integrity Suite ===\n');

console.log('1. The real backend is self-contained');
const backend = payloadCheck.verifyBackendSource(HUB_DIR);
it('every backend module resolves its local requires', () => {
  assert.deepStrictEqual(backend.missing, [], `unresolved modules: ${backend.missing.join(', ')}`);
});
it('the crypto, relay-guard and TLS modules are all discovered for bundling', () => {
  // Regression guard: these were missing from the installer when files were listed by hand.
  for (const required of ['server.js', 'crypto_protocol.js', 'lan_guard.js', 'tls_selfsigned.js']) {
    assert.ok(
      backend.modules.includes(required),
      `${required} is not in the discovered module list: ${backend.modules.join(', ')}`
    );
  }
});

console.log('\n2. A missing dependency is detected');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safedrop-payload-'));
try {
  fs.writeFileSync(
    path.join(scratch, 'main.js'),
    "const helper = require('./helper');\nconst builtin = require('fs');\nconsole.log(helper, builtin);\n"
  );
  fs.writeFileSync(path.join(scratch, 'helper.js'), 'module.exports = 1;\n');

  it('a complete payload reports no missing modules', () => {
    const result = payloadCheck.verifyStagedPayload(scratch);
    assert.deepStrictEqual(result.missing, []);
    assert.deepStrictEqual(result.jsFiles, ['helper.js', 'main.js']);
  });

  it('removing a required module is reported by name', () => {
    fs.unlinkSync(path.join(scratch, 'helper.js'));
    const result = payloadCheck.verifyStagedPayload(scratch);
    assert.strictEqual(result.missing.length, 1, `expected 1 problem, got ${JSON.stringify(result.missing)}`);
    assert.ok(result.missing[0].includes('main.js'), 'the offending file should be named');
    assert.ok(result.missing[0].includes('./helper'), 'the missing specifier should be named');
  });

  it('Node builtins are not treated as missing', () => {
    fs.writeFileSync(path.join(scratch, 'helper.js'), 'module.exports = 1;\n');
    const result = payloadCheck.verifyStagedPayload(scratch);
    const mentionsBuiltin = result.missing.some((entry) => entry.includes("'fs'") || entry.includes('fs'));
    assert.ok(!mentionsBuiltin, `builtins must be ignored, got: ${result.missing.join(', ')}`);
  });

  it('directory-style requires resolve to index.js', () => {
    fs.mkdirSync(path.join(scratch, 'lib'));
    fs.writeFileSync(path.join(scratch, 'lib', 'index.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(scratch, 'usesDir.js'), "require('./lib');\n");
    const result = payloadCheck.verifyStagedPayload(scratch);
    assert.deepStrictEqual(result.missing, [], `unexpected: ${result.missing.join(', ')}`);
  });

  it('a .json require resolves', () => {
    fs.writeFileSync(path.join(scratch, 'data.json'), '{}\n');
    fs.writeFileSync(path.join(scratch, 'usesJson.js'), "require('./data.json');\n");
    const result = payloadCheck.verifyStagedPayload(scratch);
    assert.deepStrictEqual(result.missing, [], `unexpected: ${result.missing.join(', ')}`);
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('\n3. Component versions agree with APP_VERSION');
const LAUNCHER_CS = path.resolve(__dirname, 'Launcher.cs');
const CS_FILES = [LAUNCHER_CS, path.join(__dirname, 'Installer.cs'), path.join(__dirname, 'Uninstaller.cs')];

it('the shipped C# components declare the current product version', () => {
  // Regression guard: these sat at 1.0.1 for two releases while every other surface moved on,
  // so the Windows file properties and Programs-and-Features entry reported a stale version.
  const result = payloadCheck.verifySourceVersions({
    serverJsPath: path.join(HUB_DIR, 'server.js'),
    csFiles: CS_FILES
  });
  assert.deepStrictEqual(
    result.mismatches,
    [],
    `version drift: ${result.mismatches.join('; ')}`
  );
  assert.match(result.productVersion, /^\d+\.\d+\.\d+$/);
});

const versionScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safedrop-version-'));
try {

it('a drifted version literal is detected', () => {
  const scratchCs = path.join(versionScratch, 'Drifted.cs');
  fs.writeFileSync(scratchCs, [
    '[assembly: AssemblyVersion("1.0.1.0")]',
    '[assembly: AssemblyFileVersion("1.0.1.0")]',
    '[assembly: AssemblyInformationalVersion("1.0.1")]',
    'key.SetValue("DisplayVersion", "1.0.1");'
  ].join('\n'));

  const result = payloadCheck.verifySourceVersions({
    serverJsPath: path.join(HUB_DIR, 'server.js'),
    csFiles: [scratchCs]
  });
  assert.strictEqual(result.mismatches.length, 4, `expected 4 stale literals, got ${result.mismatches.length}`);
  assert.ok(result.mismatches.every((m) => m.includes('Drifted.cs')), 'the offending file should be named');
  assert.ok(result.mismatches.some((m) => m.includes('DisplayVersion') || m.includes('1.0.1')),
    'the stale version should be shown');
});

it('a component declaring no version at all is reported', () => {
  const blankCs = path.join(versionScratch, 'Blank.cs');
  fs.writeFileSync(blankCs, 'class Blank {}\n');
  const result = payloadCheck.verifySourceVersions({
    serverJsPath: path.join(HUB_DIR, 'server.js'),
    csFiles: [blankCs]
  });
  assert.strictEqual(result.mismatches.length, 1);
  assert.ok(result.mismatches[0].includes('declares no version'));
});

it('the four-part assembly version matches the three-part product version', () => {
  // AssemblyVersion carries a trailing build field; comparison must not flag 1.3.0.0 vs 1.3.0.
  const cs = path.join(versionScratch, 'FourPart.cs');
  const product = payloadCheck.productVersionOf(path.join(HUB_DIR, 'server.js'));
  fs.writeFileSync(cs, `[assembly: AssemblyVersion("${product}.0")]\n`);
  const result = payloadCheck.verifySourceVersions({
    serverJsPath: path.join(HUB_DIR, 'server.js'),
    csFiles: [cs]
  });
  assert.deepStrictEqual(result.mismatches, [], `unexpected: ${result.mismatches.join('; ')}`);
});

} finally {
  fs.rmSync(versionScratch, { recursive: true, force: true });
}

console.log(`\n====================================================`);
console.log(`  Passed: ${passed}    Failed: ${failed}`);
console.log(`====================================================\n`);
process.exit(failed === 0 ? 0 : 1);
