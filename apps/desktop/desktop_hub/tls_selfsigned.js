/**
 * Self-signed TLS certificate generation for the SafeDrop hub.
 *
 * Why this exists: browsers only expose `crypto.subtle` (WebCrypto) in a secure context,
 * and plain `http://` on a LAN address is not one. Serving the portal over HTTPS gives the
 * browser view real client-side encryption instead of falling back to plaintext.
 *
 * Implemented in pure Node with no dependencies, to preserve the hub's "no node_modules"
 * property. Only the DER/TLV scaffolding is hand-written; key generation and signing use
 * node:crypto, and the SubjectPublicKeyInfo blob is taken straight from Node's SPKI export.
 *
 * The certificate is self-signed, so browsers show a one-time warning the user must accept.
 * That warning is expected: the certificate provides transport encryption, while peer
 * authentication comes from the pairing PIN and the handshake HMAC.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- Minimal DER encoding -------------------------------------------------------------

function derLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const derSequence = (...parts) => tlv(0x30, Buffer.concat(parts));
const derSet = (...parts) => tlv(0x31, Buffer.concat(parts));
const derOctetString = (buf) => tlv(0x04, buf);
const derBitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
const derBoolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const derUtf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const derContext = (n, content) => tlv(0xa0 | n, Buffer.isBuffer(content) ? content : Buffer.concat(content));

/** Encode a positive INTEGER, adding a leading 0x00 when the top bit is set. */
function derIntegerFromBuf(buf) {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start++;
  let body = buf.subarray(start);
  if (body.length === 0) body = Buffer.from([0]);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0x00]), body]);
  return tlv(0x02, body);
}

function derInteger(value) {
  const bytes = [];
  let n = value;
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  return derIntegerFromBuf(Buffer.from(bytes));
}

function derOid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [];
    let v = part;
    do {
      stack.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80;
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function derUtcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const s = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
            `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function pem(label, der) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

// --- Certificate assembly --------------------------------------------------------------

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_CN = '2.5.4.3';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

function rdnsOfCommonName(cn) {
  // RDNSequence -> RDN(SET) -> AttributeTypeAndValue(SEQUENCE{OID, value})
  return derSequence(
    derSet(
      derSequence(derOid(OID_CN), derUtf8(cn))
    )
  );
}

/**
 * subjectAltName needs the IP addresses and hostnames the certificate is used for, otherwise
 * browsers reject it even after the user accepts the self-signed warning.
 */
function subjectAltNameExtension(ips, dnsNames) {
  const generalNames = [];
  for (const ip of ips) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      const octets = ip.split('.').map(Number);
      if (octets.every((o) => o >= 0 && o <= 255)) {
        generalNames.push(tlv(0x87, Buffer.from(octets))); // [7] iPAddress
      }
    }
  }
  for (const name of dnsNames) {
    generalNames.push(tlv(0x82, Buffer.from(name, 'ascii'))); // [2] dNSName
  }
  const value = derSequence(Buffer.concat(generalNames));
  return derSequence(derOid(OID_SUBJECT_ALT_NAME), derBoolean(true), derOctetString(value));
}

function basicConstraintsExtension() {
  // Empty SEQUENCE means CA:FALSE.
  const value = derSequence();
  return derSequence(derOid(OID_BASIC_CONSTRAINTS), derBoolean(true), derOctetString(value));
}

function extendedKeyUsageExtension() {
  const value = derSequence(derOid(OID_SERVER_AUTH));
  return derSequence(derOid(OID_EXT_KEY_USAGE), derOctetString(value));
}

/**
 * Build a self-signed P-256 certificate.
 * @returns {{key: string, cert: string}} PEM-encoded private key and certificate.
 */
function generateSelfSignedCertificate({ commonName = 'SafeDrop Hub', ips = [], dnsNames = [], days = 825 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const signatureAlgorithm = derSequence(derOid(OID_ECDSA_SHA256));

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // keep the integer positive

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const name = rdnsOfCommonName(commonName);

  const extensions = derContext(3, derSequence(
    subjectAltNameExtension(ips, dnsNames),
    basicConstraintsExtension(),
    extendedKeyUsageExtension()
  ));

  const tbsCertificate = derSequence(
    derContext(0, derInteger(2)), // version v3
    derIntegerFromBuf(serial),
    signatureAlgorithm,
    name,
    derSequence(derUtcTime(notBefore), derUtcTime(notAfter)),
    name,
    spki,
    extensions
  );

  // node:crypto returns a DER-encoded ECDSA-Sig-Value for EC keys, which is exactly the
  // BIT STRING payload an X.509 signature expects.
  const signature = crypto.createSign('SHA256').update(tbsCertificate).sign(privateKey);

  const certificate = derSequence(tbsCertificate, signatureAlgorithm, derBitString(signature));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem('CERTIFICATE', certificate)
  };
}

/**
 * Load a cached certificate, or create one and persist it. Caching matters because a new
 * certificate on every restart would force the browser warning again each time. The private
 * key stays on this machine under the user's profile.
 */
function loadOrCreateCertificate({ dir, ips = [], dnsNames = [], commonName = 'SafeDrop Hub', logger = console } = {}) {
  const keyPath = path.join(dir, 'tls-key.pem');
  const certPath = path.join(dir, 'tls-cert.pem');

  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      const key = fs.readFileSync(keyPath, 'utf8');
      const cert = fs.readFileSync(certPath, 'utf8');
      // Confirm the cached pair is usable and still covers the current addresses.
      const parsed = new crypto.X509Certificate(cert);
      const san = parsed.subjectAltName || '';
      const missing = ips.filter((ip) => !san.includes(ip));
      if (key.includes('PRIVATE KEY') && parsed.checkPrivateKey(crypto.createPrivateKey(key)) && missing.length === 0) {
        return { key, cert, created: false };
      }
      logger.log('[SafeDrop] TLS certificate is stale or incomplete; regenerating for current addresses');
    }
  } catch (e) {
    logger.warn(`[SafeDrop] Could not reuse cached TLS certificate: ${e.message}`);
  }

  const generated = generateSelfSignedCertificate({ commonName, ips, dnsNames });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, generated.key, { mode: 0o600 });
    fs.writeFileSync(certPath, generated.cert, { mode: 0o644 });
  } catch (e) {
    logger.warn(`[SafeDrop] Could not persist TLS certificate: ${e.message}`);
  }
  return { ...generated, created: true };
}

module.exports = {
  generateSelfSignedCertificate,
  loadOrCreateCertificate
};
