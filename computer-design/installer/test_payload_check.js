/**
 * Installer payload integrity tests.
 *
 * The installer bundles a copy of the Node backend. If a module is referenced but not
 * copied, the failure only appears after a user installs and launches the app, so these
 * checks run at build time instead.
 *
 * Run: node computer-design/installer/test_payload_check.js
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

console.log(`\n====================================================`);
console.log(`  Passed: ${passed}    Failed: ${failed}`);
console.log(`====================================================\n`);
process.exit(failed === 0 ? 0 : 1);
