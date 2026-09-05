package com.safedrop.mobile.core.crypto

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Mobile Core Cryptography Engine
 * 100% aligned with desktop specifications (server.js & desktop hub):
 * 1. X25519 (ECDH) dynamic key agreement (Perfect Forward Secrecy - PFS)
 * 2. HKDF-SHA256 derivation of 256-bit session key (SessionKey)
 * 3. AES-256-GCM 1MB chunked streaming encryption/decryption (12-byte Nonce, 16-byte AuthTag)
 * 4. SHA-256 integrity verification and public key fingerprint computation
 */
class CryptoEngine {

    companion object {
        const val CHUNK_SIZE = 1024 * 1024 // 1MB chunk size
        const val IV_SIZE = 12 // 96-bit Nonce
        const val TAG_SIZE_BITS = 128 // 16-byte authentication tag
        const val TAG_SIZE_BYTES = 16
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
        val md = MessageDigest.getInstance("SHA-256")
        val digest = md.digest(rawPublicKey)
        val hex = digest.joinToString("") { "%02X".format(it) }
        return hex.substring(0, 16)
    }

    /**
     * Compute shared secret via X25519 and derive 256-bit AES session key using HKDF-SHA256
     */
    fun deriveSessionKey(
        localKeyPair: KeyPair,
        remoteRawPublicKey: ByteArray,
        salt: ByteArray = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8),
        info: ByteArray = byteArrayOf(9, 10, 11, 12)
    ): SecretKey {
        // Reconstruct remote public key with standard X509 X25519 header: 302a300506032b656e032100 + 32B raw key
        val x509Header = byteArrayOf(
            0x30.toByte(), 0x2a.toByte(), 0x30.toByte(), 0x05.toByte(),
            0x06.toByte(), 0x03.toByte(), 0x2b.toByte(), 0x65.toByte(),
            0x6e.toByte(), 0x03.toByte(), 0x21.toByte(), 0x00.toByte()
        )
        val fullEncodedKey = x509Header + remoteRawPublicKey
        val keyFactory = KeyFactory.getInstance("X25519", "BC")
        val remotePublicKey = keyFactory.generatePublic(X509EncodedKeySpec(fullEncodedKey))

        // Compute ECDH shared secret
        val ka = KeyAgreement.getInstance("X25519", "BC")
        ka.init(localKeyPair.private)
        ka.doPhase(remotePublicKey, true)
        val sharedSecret = ka.generateSecret()

        // HKDF-SHA256 extract and expand
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(HKDFParameters(sharedSecret, salt, info))
        val sessionKeyBytes = ByteArray(32)
        hkdf.generateBytes(sessionKeyBytes, 0, 32)

        return SecretKeySpec(sessionKeyBytes, "AES")
    }

    /**
     * AES-256-GCM encrypt 1MB data chunk
     * Structure: [Nonce 12B] + [Ciphertext N bytes + AuthTag 16B]
     */
    fun encryptChunk(
        plaintextChunk: ByteArray,
        sessionKey: SecretKey,
        chunkIndex: Int
    ): ByteArray {
        val nonce = ByteArray(IV_SIZE)
        val bb = ByteBuffer.wrap(nonce).order(ByteOrder.BIG_ENDIAN)
        bb.putInt(chunkIndex)
        for (i in 4 until IV_SIZE) {
            nonce[i] = ((chunkIndex * 31 + i) and 0xFF).toByte()
        }

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val spec = GCMParameterSpec(TAG_SIZE_BITS, nonce)
        cipher.init(Cipher.ENCRYPT_MODE, sessionKey, spec)
        val encryptedData = cipher.doFinal(plaintextChunk)

        return nonce + encryptedData
    }

    /**
     * AES-256-GCM decrypt chunk data and verify authentication tag integrity
     */
    fun decryptChunk(
        encryptedChunk: ByteArray,
        sessionKey: SecretKey
    ): ByteArray {
        require(encryptedChunk.size >= IV_SIZE + TAG_SIZE_BYTES) {
            "Ciphertext too short to contain Nonce and AuthTag"
        }

        val nonce = encryptedChunk.copyOfRange(0, IV_SIZE)
        val ciphertextWithTag = encryptedChunk.copyOfRange(IV_SIZE, encryptedChunk.size)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val spec = GCMParameterSpec(TAG_SIZE_BITS, nonce)
        cipher.init(Cipher.DECRYPT_MODE, sessionKey, spec)

        return cipher.doFinal(ciphertextWithTag)
    }

    /**
     * Compute SHA-256 hash
     */
    fun sha256(data: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        return md.digest(data)
    }

    /**
     * Utilities: convert byte array to lowercase hex string and vice versa
     */
    fun bytesToHex(bytes: ByteArray): String {
        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun hexToBytes(hex: String): ByteArray {
        val len = hex.length
        val data = ByteArray(len / 2)
        var i = 0
        while (i < len) {
            data[i / 2] = ((Character.digit(hex[i], 16) shl 4) + Character.digit(hex[i + 1], 16)).toByte()
            i += 2
        }
        return data
    }
}
