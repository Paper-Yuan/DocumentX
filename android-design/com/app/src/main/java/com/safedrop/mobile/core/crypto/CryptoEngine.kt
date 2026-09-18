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
 * 3. AES-256-GCM per chunk with a fresh random 96-bit nonce. The AAD binds task id, chunk
 *    index, chunk count and the sender's chunk stride, so a chunk cannot be moved between files
 *    or positions, and the two headers the receiver uses to decide when a file is complete cannot
 *    be rewritten on the path without breaking the tag.
 * 4. HMAC-SHA256 proofs, which let each side confirm the peer derived the same key.
 *
 * Every cross-end value comes from [ProtocolConst], which scripts/protocol.js generates from
 * protocol.json; nothing in here may hardcode a number another implementation also needs.
 */
class CryptoEngine {

    companion object {
        private val secureRandom = SecureRandom()

        /** A `{name}` slot in a protocol.json template. */
        private val PLACEHOLDER = Regex("\\{(\\w+)\\}")

        /**
         * Fill a protocol.json template, refusing to invent a value for a missing variable.
         *
         * Unknown placeholders throw instead of being left in the output: a silently unfilled
         * `{count}` still produces a byte string, so both ends would keep interoping - while
         * authenticating a literal brace expression nobody intended. That is exactly how an
         * authenticated field quietly stops being one.
         */
        private fun format(template: String, vararg pairs: Pair<String, String>): String {
            val vars = pairs.toMap()
            return PLACEHOLDER.replace(template) { match ->
                val key = match.groupValues[1]
                vars[key]
                    ?: throw IllegalStateException("template \"$template\" is missing {$key}")
            }
        }

        /**
         * A chunk's geometry is what the completion decision is made from, so it is checked
         * before a single byte is sealed or opened, and rejected rather than repaired. The limits
         * are the same ones the hub applies in `chunkAad()`.
         */
        internal fun checkChunkGeometry(chunkIndex: Int, chunkCount: Int, chunkSize: Int) {
            if (chunkCount < 1 || chunkCount > ProtocolConst.Chunking.MAX_CHUNKS_PER_TASK) {
                throw IllegalArgumentException("chunk count out of range: $chunkCount")
            }
            if (chunkIndex < 0 || chunkIndex >= chunkCount) {
                throw IllegalArgumentException(
                    "chunk index $chunkIndex is outside a $chunkCount-chunk task"
                )
            }
            if (chunkSize < 1 || chunkSize > ProtocolConst.Chunking.MAX_SEALED_CHUNK_BYTES) {
                throw IllegalArgumentException("chunk size out of range: $chunkSize")
            }
        }
    }

    /**
     * Generate mobile ephemeral X25519 keypair
     */
    fun generateEphemeralKeyPair(): KeyPair {
        val kpg = KeyPairGenerator.getInstance("X25519", "BC")
        return kpg.generateKeyPair()
    }

    /**
     * Extract X25519 raw public key: the trailing bytes of the DER-encoded X509 SPKI.
     */
    fun extractRawPublicKey(keyPair: KeyPair): ByteArray {
        val encoded = keyPair.public.encoded
        val rawLen = ProtocolConst.X25519_RAW_LEN_BYTES
        if (encoded.size < rawLen) {
            throw IllegalArgumentException("unexpected SPKI length: ${encoded.size} bytes")
        }
        return encoded.copyOfRange(encoded.size - rawLen, encoded.size)
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
     * SHA-256("{protocol}|salt|{sessionId}").
     */
    fun deriveSalt(sessionId: String): ByteArray {
        val material = format(ProtocolConst.TPL_KDF_SALT, "protocol" to ProtocolConst.PROTOCOL, "sessionId" to sessionId)
        return MessageDigest.getInstance("SHA-256").digest(material.toByteArray(StandardCharsets.UTF_8))
    }

    /**
     * HKDF `info` carrying the pairing secret, matching kdfInfo() in crypto_protocol.js.
     */
    fun deriveInfo(pairingSecret: String): ByteArray {
        return format(
            ProtocolConst.TPL_KDF_INFO,
            "protocol" to ProtocolConst.PROTOCOL,
            "pairingSecret" to pairingSecret
        ).toByteArray(StandardCharsets.UTF_8)
    }

    /**
     * Compute the raw X25519 ECDH shared secret with a peer's raw public key.
     */
    fun computeSharedSecret(localKeyPair: KeyPair, remoteRawPublicKey: ByteArray): ByteArray {
        if (remoteRawPublicKey.size != ProtocolConst.X25519_RAW_LEN_BYTES) {
            throw IllegalArgumentException(
                "raw x25519 public key must be ${ProtocolConst.X25519_RAW_LEN_BYTES} bytes, " +
                        "got ${remoteRawPublicKey.size}"
            )
        }
        val keyFactory = KeyFactory.getInstance("X25519", "BC")
        val remotePublicKey = keyFactory.generatePublic(
            X509EncodedKeySpec(ProtocolConst.X25519_SPKI_PREFIX + remoteRawPublicKey)
        )

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
        val sessionKeyBytes = ByteArray(ProtocolConst.KEY_LEN_BYTES)
        hkdf.generateBytes(sessionKeyBytes, 0, ProtocolConst.KEY_LEN_BYTES)
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

    /** Proof the client derived the session key: HMAC(key, "{protocol}|verify|{sessionId}"). */
    fun clientProof(sessionKey: SecretKey, sessionId: String): ByteArray {
        return hmac(sessionKey, kdfTemplate(ProtocolConst.TPL_CLIENT_PROOF, sessionId))
    }

    /** Proof returned by the hub: HMAC(key, "{protocol}|server|{sessionId}"). */
    fun serverProof(sessionKey: SecretKey, sessionId: String): ByteArray {
        return hmac(sessionKey, kdfTemplate(ProtocolConst.TPL_SERVER_PROOF, sessionId))
    }

    private fun kdfTemplate(template: String, sessionId: String): String =
        format(template, "protocol" to ProtocolConst.PROTOCOL, "sessionId" to sessionId)

    /** Verify the hub's proof in constant time. */
    fun verifyServerProof(sessionKey: SecretKey, sessionId: String, proofHex: String): Boolean {
        return try {
            MessageDigest.isEqual(serverProof(sessionKey, sessionId), hexToBytes(proofHex))
        } catch (_: Exception) {
            false
        }
    }

    /**
     * AAD for one chunk: task id, index, count and the sender's stride, all four authenticated.
     *
     * The count and the stride are what turn "a chunk claiming to be the last one arrived" into
     * "the sender committed to this many chunks and every one of them showed up". A receiver that
     * reads them from plain headers instead cannot tell those two apart, because anything on the
     * path can rewrite a header that is not covered by the tag.
     */
    fun chunkAad(taskId: String, chunkIndex: Int, chunkCount: Int, chunkSize: Int): ByteArray {
        checkChunkGeometry(chunkIndex, chunkCount, chunkSize)
        return format(
            ProtocolConst.TPL_CHUNK_AAD,
            "protocol" to ProtocolConst.PROTOCOL,
            "taskId" to taskId,
            "index" to chunkIndex.toString(),
            "count" to chunkCount.toString(),
            "chunkSize" to chunkSize.toString()
        ).toByteArray(StandardCharsets.UTF_8)
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
        chunkIndex: Int,
        chunkCount: Int,
        chunkSize: Int
    ): ByteArray {
        val nonce = ByteArray(ProtocolConst.NONCE_LEN_BYTES)
        secureRandom.nextBytes(nonce)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding", "BC")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            sessionKey,
            GCMParameterSpec(ProtocolConst.TAG_LEN_BITS, nonce)
        )
        cipher.updateAAD(chunkAad(taskId, chunkIndex, chunkCount, chunkSize))
        val encryptedData = cipher.doFinal(plaintextChunk)

        return nonce + encryptedData
    }

    /**
     * AES-256-GCM decrypt a chunk and verify its authentication tag. Throws if the tag does
     * not verify, which covers tampering and a chunk replayed under a different task id, index,
     * count or stride alike.
     */
    fun decryptChunk(
        encryptedChunk: ByteArray,
        sessionKey: SecretKey,
        taskId: String,
        chunkIndex: Int,
        chunkCount: Int,
        chunkSize: Int
    ): ByteArray {
        require(encryptedChunk.isNotEmpty()) {
            "Encrypted chunk cannot be empty"
        }

        val minSize = ProtocolConst.NONCE_LEN_BYTES + ProtocolConst.TAG_LEN_BYTES
        require(encryptedChunk.size >= minSize) {
            "sealed chunk too short: expected at least $minSize bytes " +
                    "(${ProtocolConst.NONCE_LEN_BYTES}B nonce + ${ProtocolConst.TAG_LEN_BYTES}B tag), " +
                    "got ${encryptedChunk.size} bytes"
        }

        val nonce = encryptedChunk.copyOfRange(0, ProtocolConst.NONCE_LEN_BYTES)
        val ciphertextWithTag = encryptedChunk.copyOfRange(ProtocolConst.NONCE_LEN_BYTES, encryptedChunk.size)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding", "BC")
        cipher.init(
            Cipher.DECRYPT_MODE,
            sessionKey,
            GCMParameterSpec(ProtocolConst.TAG_LEN_BITS, nonce)
        )
        cipher.updateAAD(chunkAad(taskId, chunkIndex, chunkCount, chunkSize))

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
