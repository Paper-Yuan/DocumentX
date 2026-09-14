/**
 * SafeDrop transport crypto protocol (v1).
 *
 * Design notes:
 * - Key agreement: ephemeral ECDH per session (X25519 by default, P-256 for browsers
 *   whose WebCrypto predates X25519).
 * - The pairing secret (the 6-digit PIN the user reads off the desktop screen, or the
 *   one-time token from the QR code) is fed into HKDF as `info`. It is never sent over
 *   the wire: the peer proves knowledge by sending an HMAC over the derived key. A
 *   passive eavesdropper cannot derive the key (no ECDH private key), and an active
 *   man-in-the-middle cannot derive it either without knowing the pairing secret.
 * - Each HTTP chunk is sealed with AES-256-GCM using a fresh random 96-bit nonce, and
 *   the task id + chunk index are bound in as AAD so chunks cannot be reordered or
 *   spliced between files.
 *
 * Wire format of a sealed chunk: nonce(12) || ciphertext || tag(16).
 * This matches CryptoEngine.kt on Android, which produces nonce + doFinal() output.
 *
 * Kept dependency-free to preserve the hub's "no node_modules" property.
 */
const crypto = require('crypto');

const PROTOCOL = 'safedrop-e2e-v1';
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

const CURVES = {
  x25519: {
    node: 'x25519',
    rawLen: 32,
    // SubjectPublicKeyInfo prefix for a raw X25519 public key.
    spkiPrefix: Buffer.from('302a300506032b656e032100', 'hex')
  },
  'p-256': {
    node: 'prime256v1',
    rawLen: 65,
    // SubjectPublicKeyInfo prefix for an uncompressed P-256 point.
    spkiPrefix: Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')
  }
};

function curveSpec(curve) {
  const spec = CURVES[curve || 'x25519'];
  if (!spec) throw new Error(`unsupported curve: ${curve}`);
  return spec;
}

/** Infer the curve from the length of a raw public key. */
function curveFromRawLength(len) {
  if (len === CURVES.x25519.rawLen) return 'x25519';
  if (len === CURVES['p-256'].rawLen) return 'p-256';
  throw new Error(`unsupported raw public key length: ${len}`);
}

function generateKeyPair(curve = 'x25519') {
  const spec = curveSpec(curve);
  const pair = spec.node === 'x25519'
    ? crypto.generateKeyPairSync('x25519')
    : crypto.generateKeyPairSync('ec', { namedCurve: spec.node });
  return pair;
}

/** Export a public key as the raw wire form (32 bytes X25519, 65 bytes P-256). */
function exportRawPublicKey(keyPair, curve = 'x25519') {
  const spec = curveSpec(curve);
  const der = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  if (der.length < spec.rawLen) throw new Error('unexpected SPKI length');
  return Buffer.from(der.subarray(der.length - spec.rawLen));
}

/** Re-import a peer's raw public key by re-attaching the SPKI prefix. */
function importRawPublicKey(raw, curve = 'x25519') {
  const spec = curveSpec(curve);
  const buf = Buffer.from(raw);
  if (buf.length !== spec.rawLen) {
    throw new Error(`raw ${curve} public key must be ${spec.rawLen} bytes, got ${buf.length}`);
  }
  const der = Buffer.concat([spec.spkiPrefix, buf]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function computeSharedSecret(privateKey, peerRawPublicKey, curve = 'x25519') {
  return Buffer.from(crypto.diffieHellman({
    privateKey,
    publicKey: importRawPublicKey(peerRawPublicKey, curve)
  }));
}

/**
 * Salt is derived from the session id so every session gets independent key material.
 * Hashed to a fixed width to keep the input unambiguous.
 */
function kdfSalt(sessionId) {
  return crypto.createHash('sha256').update(`${PROTOCOL}|salt|${sessionId}`).digest();
}

function kdfInfo(pairingSecret) {
  return Buffer.from(`${PROTOCOL}|key|${pairingSecret}`, 'utf8');
}

/** HKDF-SHA256 (RFC 5869), identical to the Android BouncyCastle and WebCrypto paths. */
function deriveSessionKey(sharedSecret, sessionId, pairingSecret) {
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, kdfSalt(sessionId), kdfInfo(pairingSecret), KEY_LEN));
}

function clientProof(key, sessionId) {
  return crypto.createHmac('sha256', key).update(`${PROTOCOL}|verify|${sessionId}`).digest();
}

function serverProof(key, sessionId) {
  return crypto.createHmac('sha256', key).update(`${PROTOCOL}|server|${sessionId}`).digest();
}

/** Constant-time check of a hex-encoded client proof. */
function verifyClientProof(key, sessionId, proofHex) {
  if (typeof proofHex !== 'string' || proofHex.length !== KEY_LEN * 2 || !/^[0-9a-fA-F]+$/.test(proofHex)) {
    return false;
  }
  const expected = clientProof(key, sessionId);
  const provided = Buffer.from(proofHex, 'hex');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function chunkAad(taskId, chunkIndex) {
  return Buffer.from(`${PROTOCOL}|chunk|${taskId}|${chunkIndex}`, 'utf8');
}

/** Seal one chunk: nonce(12) || ciphertext || tag(16). */
function encryptChunk(key, plaintext, taskId, chunkIndex) {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(chunkAad(taskId, chunkIndex));
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]);
}

/**
 * Open one chunk. Throws if the tag does not verify, which covers both tampering and a
 * mismatched task id / chunk index.
 */
function decryptChunk(key, packet, taskId, chunkIndex) {
  const buf = Buffer.from(packet);
  if (buf.length < NONCE_LEN + TAG_LEN) {
    throw new Error(`sealed chunk too short: ${buf.length} bytes`);
  }
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(chunkAad(taskId, chunkIndex));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = {
  PROTOCOL,
  KEY_LEN,
  NONCE_LEN,
  TAG_LEN,
  CURVES,
  curveFromRawLength,
  generateKeyPair,
  exportRawPublicKey,
  importRawPublicKey,
  computeSharedSecret,
  deriveSessionKey,
  clientProof,
  serverProof,
  verifyClientProof,
  chunkAad,
  encryptChunk,
  decryptChunk
};
