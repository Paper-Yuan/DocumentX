package com.safedrop.mobile.core.crypto

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import java.nio.charset.StandardCharsets
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Mobile Core Cryptography Engine.
 *
 * Wire-compatible with computer-design/desktop_hub/crypto_protocol.js:
 * 1. Ephemeral X25519 (ECDH) key agreement per session.
 * 2. HKDF-SHA256 with a session-id-derived salt and the pairing secret as `info`, so the
 *    session key is bound to both the ECDH secret and the out-of-band PIN.
 * 3. AES-256-GCM per chunk with a fresh random 96-bit nonce, binding task id + chunk
 *    index as AAD so chunks cannot be reordered or moved between files.
 * 4. HMAC-SHA256 proofs, which let each side confirm the peer derived the same key.
 */
class CryptoEngine {

    companion object {
        const val CHUNK_SIZE = 1024 * 1024 // 1MB chunk size
        const val IV_SIZE = 12 // 96-bit nonce
        const val TAG_SIZE_BITS = 128
        const val TAG_SIZE_BYTES = 16
        const val PROTOCOL = "safedrop-e2e-v1"
        const val KEY_SIZE_BYTES = 32

        private val secureRandom = SecureRandom()
    }

    /**
     * Generate mobile ephemeral X25519 keypair
     */
    fun generateEphemeralKeyPair(): KeyPair {
        val kpg = KeyPairGenerator.getInstance("X25519", "BC")
        return kpg.generateKeyPair()
    }

    /**
     * Extract X25519 raw 32-byte public key
     */
    fun extractRawPublicKey(keyPair: KeyPair): ByteArray {
        val encoded = keyPair.public.encoded
        // DER-encoded X509 public key; the last 32 bytes are the raw X25519 public key
        return encoded.copyOfRange(encoded.size - 32, encoded.size)
    }

    /**
     * Compute public key SHA-256 fingerprint (first 16 uppercase hex chars)
     */
    fun calculateFingerprint(rawPublicKey: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(rawPublicKey)
        return bytesToHex(digest).substring(0, 16).uppercase()
    }

    /**
     * Salt bound to the session id, matching kdfSalt() in crypto_protocol.js:
     * SHA-256("safedrop-e2e-v1|salt|" + sessionId).
     */
    fun deriveSalt(sessionId: String): ByteArray {
        val material = "$PROTOCOL|salt|$sessionId".toByteArray(StandardCharsets.UTF_8)
        return MessageDigest.getInstance("SHA-256").digest(material)
    }

    /**
     * HKDF `info` carrying the pairing secret, matching kdfInfo() in crypto_protocol.js.
     */
    fun deriveInfo(pairingSecret: String): ByteArray {
        return "$PROTOCOL|key|$pairingSecret".toByteArray(StandardCharsets.UTF_8)
    }

    /**
     * Compute the raw X25519 ECDH shared secret with a peer's raw public key.
     */
    fun computeSharedSecret(localKeyPair: KeyPair, remoteRawPublicKey: ByteArray): ByteArray {
        val x509Header = byteArrayOf(
            0x30.toByte(), 0x2a.toByte(), 0x30.toByte(), 0x05.toByte(),
            0x06.toByte(), 0x03.toByte(), 0x2b.toByte(), 0x65.toByte(),
            0x6e.toByte(), 0x03.toByte(), 0x21.toByte(), 0x00.toByte()
        )
        val keyFactory = KeyFactory.getInstance("X25519", "BC")
        val remotePublicKey = keyFactory.generatePublic(X509EncodedKeySpec(x509Header + remoteRawPublicKey))

        val ka = KeyAgreement.getInstance("X25519", "BC")
        ka.init(localKeyPair.private)
        ka.doPhase(remotePublicKey, true)
        return ka.generateSecret()
    }

    /**
     * Derive the 256-bit AES session key from an already-computed ECDH shared secret.
     * The pairing secret (PIN or one-time token) is only ever used locally as HKDF input;
     * it is never transmitted.
     */
    fun deriveSessionKey(
        sharedSecret: ByteArray,
        sessionId: String,
        pairingSecret: String
    ): SecretKey {
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(HKDFParameters(sharedSecret, deriveSalt(sessionId), deriveInfo(pairingSecret)))
        val sessionKeyBytes = ByteArray(KEY_SIZE_BYTES)
        hkdf.generateBytes(sessionKeyBytes, 0, KEY_SIZE_BYTES)
        return SecretKeySpec(sessionKeyBytes, "AES")
    }

    /**
     * Convenience overload: perform ECDH with the peer's raw public key, then derive the key.
     */
    fun deriveSessionKey(
        localKeyPair: KeyPair,
        remoteRawPublicKey: ByteArray,
        sessionId: String,
        pairingSecret: String
    ): SecretKey {
        return deriveSessionKey(
            computeSharedSecret(localKeyPair, remoteRawPublicKey),
            sessionId,
            pairingSecret
        )
    }

    private fun hmac(key: SecretKey, message: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.encoded, "HmacSHA256"))
        return mac.doFinal(message.toByteArray(StandardCharsets.UTF_8))
    }

    /** Proof the client derived the session key: HMAC(key, "safedrop-e2e-v1|verify|" + sessionId). */
    fun clientProof(sessionKey: SecretKey, sessionId: String): ByteArray {
        return hmac(sessionKey, "$PROTOCOL|verify|$sessionId")
    }

    /** Proof returned by the hub: HMAC(key, "safedrop-e2e-v1|server|" + sessionId). */
    fun serverProof(sessionKey: SecretKey, sessionId: String): ByteArray {
        return hmac(sessionKey, "$PROTOCOL|server|$sessionId")
    }

    /** Verify the hub's proof in constant time. */
    fun verifyServerProof(sessionKey: SecretKey, sessionId: String, proofHex: String): Boolean {
        return try {
            MessageDigest.isEqual(serverProof(sessionKey, sessionId), hexToBytes(proofHex))
        } catch (_: Exception) {
            false
        }
    }

    private fun chunkAad(taskId: String, chunkIndex: Int): ByteArray {
        return "$PROTOCOL|chunk|$taskId|$chunkIndex".toByteArray(StandardCharsets.UTF_8)
    }

    /**
     * AES-256-GCM encrypt one chunk.
     * Structure: [Nonce 12B] + [Ciphertext N bytes + AuthTag 16B]
     *
     * The nonce is drawn from SecureRandom on every call. It must never be derived from
     * the chunk index: with a per-session key, a deterministic nonce would repeat across
     * files transferred in the same session, and GCM nonce reuse leaks the keystream.
     */
    fun encryptChunk(
        plaintextChunk: ByteArray,
        sessionKey: SecretKey,
        taskId: String,
        chunkIndex: Int
    ): ByteArray {
        val nonce = ByteArray(IV_SIZE)
        secureRandom.nextBytes(nonce)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding", "BC")
        val spec = GCMParameterSpec(TAG_SIZE_BITS, nonce)
        cipher.init(Cipher.ENCRYPT_MODE, sessionKey, spec)
        cipher.updateAAD(chunkAad(taskId, chunkIndex))
        val encryptedData = cipher.doFinal(plaintextChunk)

        return nonce + encryptedData
    }

    /**
     * AES-256-GCM decrypt a chunk and verify its authentication tag. Throws if the tag does
     * not verify, which covers tampering and a mismatched task id / chunk index alike.
     */
    fun decryptChunk(
        encryptedChunk: ByteArray,
        sessionKey: SecretKey,
        taskId: String,
        chunkIndex: Int
    ): ByteArray {
        require(encryptedChunk.isNotEmpty()) {
            "Encrypted chunk cannot be empty"
        }

        val minSize = IV_SIZE + TAG_SIZE_BYTES
        require(encryptedChunk.size >= minSize) {
            "Ciphertext too short: expected at least $minSize bytes (${IV_SIZE}B nonce + ${TAG_SIZE_BYTES}B tag), got ${encryptedChunk.size} bytes"
        }

        val nonce = encryptedChunk.copyOfRange(0, IV_SIZE)
        val ciphertextWithTag = encryptedChunk.copyOfRange(IV_SIZE, encryptedChunk.size)

        require(ciphertextWithTag.size >= TAG_SIZE_BYTES) {
            "Ciphertext segment too short to contain authentication tag (got ${ciphertextWithTag.size} bytes)"
        }

        val cipher = Cipher.getInstance("AES/GCM/NoPadding", "BC")
        val spec = GCMParameterSpec(TAG_SIZE_BITS, nonce)
        cipher.init(Cipher.DECRYPT_MODE, sessionKey, spec)
        cipher.updateAAD(chunkAad(taskId, chunkIndex))

        return cipher.doFinal(ciphertextWithTag)
    }

    /**
     * Compute SHA-256 hash
     */
    fun sha256(data: ByteArray): ByteArray {
        return MessageDigest.getInstance("SHA-256").digest(data)
    }

    /**
     * Utilities: convert byte array to lowercase hex string and vice versa
     */
    fun bytesToHex(bytes: ByteArray): String {
        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun hexToBytes(hex: String): ByteArray {
        val len = hex.length
        require(len % 2 == 0) { "hex string must have an even length" }
        val data = ByteArray(len / 2)
        var i = 0
        while (i < len) {
            data[i / 2] = ((Character.digit(hex[i], 16) shl 4) + Character.digit(hex[i + 1], 16)).toByte()
            i += 2
        }
        return data
    }
}
