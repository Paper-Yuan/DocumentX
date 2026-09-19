/**
 * SafeDrop transport crypto protocol.
 *
 * Every cross-end constant lives in protocol.json and is generated into protocol.gen.js; nothing
 * here may hardcode a value another implementation also needs.
 *
 * Design notes:
 * - Key agreement: ephemeral ECDH per session (X25519 by default, P-256 for browsers
 *   whose WebCrypto predates X25519).
 * - The pairing secret (the 6-digit PIN the user reads off the desktop screen, or the
 *   one-time token from the QR code) is fed into HKDF as `info`. It is never sent over
 *   the wire: the peer proves knowledge by sending an HMAC over the derived key. A
 *   passive eavesdropper cannot derive the key (no ECDH private key), and an active
 *   man-in-the-middle cannot derive it either without knowing the pairing secret.
 * - Each HTTP chunk is sealed with AES-256-GCM using a fresh random 96-bit nonce. The AAD binds
 *   task id, chunk index, chunk count and chunk size, so a chunk cannot be moved between files
 *   or positions, and the two headers the receiver uses to decide when a file is complete cannot
 *   be rewritten on the path without breaking the tag. Binding the count is what turns "the last
 *   chunk arrived" into "the sender committed to this many chunks and every one of them showed
 *   up"; a bare index only proves the byte stream was not edited, not that it is whole.
 *
 * Wire format of a sealed chunk: nonce(12) || ciphertext || tag(16).
 * This matches CryptoEngine.kt on Android, which produces nonce + doFinal() output.
 *
 * Kept dependency-free to preserve the hub's "no node_modules" property.
 */
const crypto = require('crypto');
const protocolSpec = require('./protocol.gen');

const PROTOCOL = protocolSpec.PROTOCOL;
const KEY_LEN = protocolSpec.KEY_LEN;
const NONCE_LEN = protocolSpec.NONCE_LEN;
const TAG_LEN = protocolSpec.TAG_LEN;

/** Substitute a protocol.json template, refusing to invent a value for a missing variable. */
function format(name, vars) {
  const template = protocolSpec.TEMPLATES[name];
  if (!template) throw new Error(`unknown template: ${name}`);
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (!(key in vars)) throw new Error(`template ${name} is missing ${match}`);
    return String(vars[key]);
  });
}

const CURVES = protocolSpec.CURVES;

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
  return crypto.createHash('sha256')
    .update(format('kdfSalt', { protocol: PROTOCOL, sessionId }))
    .digest();
}

function kdfInfo(pairingSecret) {
  return Buffer.from(format('kdfInfo', { protocol: PROTOCOL, pairingSecret }), 'utf8');
}

/** HKDF-SHA256 (RFC 5869), identical to the Android BouncyCastle and WebCrypto paths. */
function deriveSessionKey(sharedSecret, sessionId, pairingSecret) {
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, kdfSalt(sessionId), kdfInfo(pairingSecret), KEY_LEN));
}

function clientProof(key, sessionId) {
  return crypto.createHmac('sha256', key)
    .update(format('clientProof', { protocol: PROTOCOL, sessionId }))
    .digest();
}

function serverProof(key, sessionId) {
  return crypto.createHmac('sha256', key)
    .update(format('serverProof', { protocol: PROTOCOL, sessionId }))
    .digest();
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

/**
 * AAD for one chunk. All four values are authenticated: the task id stops chunks being moved
 * between transfers, the index stops them being replayed at another position, and count plus
 * chunkSize stop the two headers that decide when a file is finished from being rewritten by
 * anything between the peers.
 */
function chunkAad(taskId, chunkIndex, chunkCount, chunkSize) {
  const index = Number(chunkIndex);
  const count = Number(chunkCount);
  const size = Number(chunkSize);
  if (!Number.isInteger(index) || !Number.isInteger(count) || !Number.isInteger(size)) {
    throw new Error('chunk index, count and size must be integers');
  }
  if (count < 1 || count > protocolSpec.MAX_CHUNKS_PER_TASK) {
    throw new Error(`chunk count out of range: ${count}`);
  }
  if (index < 0 || index >= count) {
    throw new Error(`chunk index ${index} is outside a ${count}-chunk task`);
  }
  if (size < 1 || size > protocolSpec.MAX_SEALED_CHUNK) {
    throw new Error(`chunk size out of range: ${size}`);
  }
  return Buffer.from(format('chunkAad', {
    protocol: PROTOCOL,
    taskId,
    index,
    count,
    chunkSize: size
  }), 'utf8');
}

/**
 * Seal one chunk: nonce(12) || ciphertext || tag(16).
 *
 * The nonce is generated here and nowhere else, because reusing one under a key is the one way to
 * break GCM outright. `sealWithNonce` below exists only to make the committed test vectors
 * reproducible; no transfer path may call it.
 */
function encryptChunk(key, plaintext, taskId, chunkIndex, chunkCount, chunkSize) {
  return sealWithNonce(key, plaintext, taskId, chunkIndex, chunkCount, chunkSize, crypto.randomBytes(NONCE_LEN));
}

/** Vector-generation only: seal with a caller-supplied nonce so golden bytes can be committed. */
function sealWithNonce(key, plaintext, taskId, chunkIndex, chunkCount, chunkSize, nonce) {
  if (nonce.length !== NONCE_LEN) throw new Error(`nonce must be ${NONCE_LEN} bytes`);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(chunkAad(taskId, chunkIndex, chunkCount, chunkSize));
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]);
}

/**
 * Open one chunk. Throws if the tag does not verify, which covers tampering as well as a chunk
 * replayed under a different task id, index, count or chunk size.
 */
function decryptChunk(key, packet, taskId, chunkIndex, chunkCount, chunkSize) {
  const buf = Buffer.from(packet);
  if (buf.length < NONCE_LEN + TAG_LEN) {
    throw new Error(`sealed chunk too short: ${buf.length} bytes`);
  }
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(chunkAad(taskId, chunkIndex, chunkCount, chunkSize));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = {
  PROTOCOL,
  KEY_LEN,
  NONCE_LEN,
  TAG_LEN,
  CURVES,
  MAX_SEALED_CHUNK: protocolSpec.MAX_SEALED_CHUNK,
  MAX_CHUNKS_PER_TASK: protocolSpec.MAX_CHUNKS_PER_TASK,
  SEALED_OVERHEAD: protocolSpec.SEALED_OVERHEAD,
  PAIRING: protocolSpec.PAIRING,
  SESSION: protocolSpec.SESSION,
  HEADERS: protocolSpec.HEADERS,
  format,
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
  sealWithNonce,
  decryptChunk
};
