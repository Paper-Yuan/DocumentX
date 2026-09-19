/**
 * SSRF guard tests. The hub will relay a chunk to an address a sender names, so this predicate is
 * the only thing between "forward to my LAN peer" and "forward to an attacker-chosen host".
 *
 * Run: node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const guard = require(path.join(ROOT, 'apps/desktop/desktop_hub/lan_guard'));

test('ipv4ToUint accepts only the canonical dotted-quad form', () => {
  assert.strictEqual(guard.ipv4ToUint('0.0.0.0'), 0);
  assert.strictEqual(guard.ipv4ToUint('192.168.1.5'), (((192 * 256) + 168) * 256 + 1) * 256 + 5);
  assert.strictEqual(guard.uintToIpv4(guard.ipv4ToUint('10.20.30.40')), '10.20.30.40');

  for (const bad of ['', '  ', '1.2.3', '1.2.3.4.5', '256.1.1.1', '999.1.1.1', 'a.b.c.d', '1.2.3.-4', '::1', 'fe80::1']) {
    assert.strictEqual(guard.ipv4ToUint(bad), null, `should not parse: ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(guard.ipv4ToUint(undefined), null);
  assert.strictEqual(guard.ipv4ToUint(1234), null);
});

test('a leading-zero octet is refused rather than guessed at', () => {
  // This function reads "010" as decimal 10; a resolver may read it as octal 8. Accepting it would
  // let the guard approve one address while the socket connects to another.
  for (const octal of ['010.1.2.3', '0177.0.0.1', '000.1.2.3', '0x7f.0.0.1', '01.2.3.4']) {
    assert.strictEqual(guard.ipv4ToUint(octal), null, `should not parse: ${octal}`);
    assert.strictEqual(guard.isAllowedRelayTarget(octal), false, `should not be a relay target: ${octal}`);
  }
});

test('loopback, link-local and the unspecified range are never relay targets', () => {
  const refused = [
    '127.0.0.1', '127.2.3.4', '127.255.255.255',
    '169.254.169.254', '169.254.1.1',
    '0.0.0.0', '0.1.2.3',
    '224.0.0.1', '239.1.2.3', '255.255.255.255',
    '8.8.8.8', '203.0.113.5', '1.1.1.1'
  ];
  for (const ip of refused) {
    assert.strictEqual(guard.isAllowedRelayTarget(ip), false, `must refuse ${ip}`);
  }
});

test('RFC1918 addresses are accepted, and the boundaries of each range are right', () => {
  for (const ip of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.23.9.9', '172.31.255.254', '192.168.0.1', '192.168.255.255']) {
    assert.strictEqual(guard.isAllowedRelayTarget(ip), true, `must accept ${ip}`);
  }
  // 172.16/12 is the private block; the neighbouring public ranges must not slide in.
  for (const ip of ['172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.1.1']) {
    const onOwnSubnet = guard.isOnLocalSubnet(ip);
    assert.strictEqual(guard.isAllowedRelayTarget(ip) && !onOwnSubnet, false, `${ip} is not RFC1918`);
  }
});

test('an on-link destination is allowed because that is what a LAN peer looks like', () => {
  const subnets = guard.localSubnets();
  if (subnets.length === 0) {
    assert.fail('no IPv4 interface found; this test is only meaningful on a machine with a LAN address');
  }
  // localSubnets() stores addresses as integers, so render them back before asking.
  for (const subnet of subnets) {
    const address = guard.uintToIpv4(subnet.address);
    assert.strictEqual(guard.isOnLocalSubnet(address), true, `own address ${address} must be on-link`);

    const hostBits = (~subnet.mask) >>> 0;
    if (hostBits < 3) continue; // a /31 or /32 has no spare neighbouring host to ask about
    const candidate = (subnet.network | 1) >>> 0;
    const neighbour = candidate === subnet.address ? (subnet.network | 2) >>> 0 : candidate;
    const neighbourText = guard.uintToIpv4(neighbour);
    assert.strictEqual((neighbour & subnet.mask) >>> 0, subnet.network,
      `test bug: ${neighbourText} is not inside ${address}'s subnet`);
    assert.strictEqual(guard.isAllowedRelayTarget(neighbourText), true,
      `${neighbourText} is on this machine's own subnet and must be reachable`);
  }
});

test('the operator allowlist is honoured and cannot be bypassed with an unlisted address', () => {
  const out = execFileSync(process.execPath, ['-e', `
    const guard = require(${JSON.stringify(path.join(ROOT, 'apps/desktop/desktop_hub/lan_guard'))});
    console.log(JSON.stringify({
      listed: guard.isAllowedRelayTarget('203.0.113.77'),
      otherPublic: guard.isAllowedRelayTarget('203.0.113.78'),
      listedButLoopback: guard.isAllowedRelayTarget('127.0.0.1')
    }));
  `], { cwd: ROOT, stdio: 'pipe', env: Object.assign({}, process.env, { SAFEDROP_RELAY_TARGETS: '203.0.113.77,127.0.0.1' }) }).toString().trim();
  const result = JSON.parse(out);
  assert.strictEqual(result.listed, true, 'an explicitly allowlisted public address is reachable');
  assert.strictEqual(result.otherPublic, false, 'a neighbouring public address must not be');
  assert.strictEqual(result.listedButLoopback, false, 'the allowlist must not override the forbidden ranges');
});

test('garbage never becomes a target', () => {
  for (const junk of ['', 'http://169.254.169.254', '169.254.169.254:80', 'localhost', '10.0.0.1;rm', '10.0.0.1\n\n203.0.113.9']) {
    assert.strictEqual(guard.isAllowedRelayTarget(junk), false, `must refuse ${JSON.stringify(junk)}`);
  }
});

test('describeLocalSubnets reports one entry per attached network', () => {
  const described = guard.describeLocalSubnets();
  assert.strictEqual(described.length, guard.localSubnets().length);
  for (const entry of described) {
    assert.match(entry, /^\d+\.\d+\.\d+\.\d+\/\d+$/);
  }
  assert.ok(Array.isArray(guard.FORBIDDEN_RANGES) && guard.FORBIDDEN_RANGES.length >= 3);
});
