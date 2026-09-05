package com.safedrop.mobile

import com.safedrop.mobile.core.crypto.CryptoEngine
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test
import java.security.Security

/**
 * Mobile Cryptography and Security Test Suite
 */
class CryptoEngineTest {

    companion object {
        @BeforeClass
        @JvmStatic
        fun setup() {
            Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
            Security.insertProviderAt(BouncyCastleProvider(), 1)
        }
    }

    private val crypto = CryptoEngine()

    @Test
    fun testX25519KeyAgreementAndHKDF() {
        // 1. Generate Alice (mobile) and Bob (desktop) ephemeral keypairs
        val alicePair = crypto.generateEphemeralKeyPair()
        val bobPair = crypto.generateEphemeralKeyPair()

        val aliceRawPub = crypto.extractRawPublicKey(alicePair)
        val bobRawPub = crypto.extractRawPublicKey(bobPair)

        assertEquals(32, aliceRawPub.size)
        assertEquals(32, bobRawPub.size)

        // 2. Compute public key fingerprints
        val aliceFp = crypto.calculateFingerprint(aliceRawPub)
        val bobFp = crypto.calculateFingerprint(bobRawPub)
        assertEquals(16, aliceFp.length)
        assertEquals(16, bobFp.length)

        // 3. Derive session key independently on both sides
        val salt = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)
        val info = byteArrayOf(9, 10, 11, 12)

        val aliceSessionKey = crypto.deriveSessionKey(
            localKeyPair = alicePair,
            remoteRawPublicKey = bobRawPub,
            salt = salt,
            info = info
        )

        val bobSessionKey = crypto.deriveSessionKey(
            localKeyPair = bobPair,
            remoteRawPublicKey = aliceRawPub,
            salt = salt,
            info = info
        )

        assertArrayEquals(aliceSessionKey.encoded, bobSessionKey.encoded)
    }

    @Test
    fun testAesGcm1MBChunkEncryptionAndDecryption() {
        val alicePair = crypto.generateEphemeralKeyPair()
        val bobPair = crypto.generateEphemeralKeyPair()
        val bobRawPub = crypto.extractRawPublicKey(bobPair)

        val sessionKey = crypto.deriveSessionKey(
            localKeyPair = alicePair,
            remoteRawPublicKey = bobRawPub
        )

        // Construct 1MB test data
        val testData = ByteArray(1024 * 1024)
        for (i in testData.indices) {
            testData[i] = (i % 256).toByte()
        }

        // Encrypt chunk
        val encrypted = crypto.encryptChunk(testData, sessionKey, 0)
        assertEquals(CryptoEngine.IV_SIZE + testData.size + CryptoEngine.TAG_SIZE_BYTES, encrypted.size)

        // Decrypt chunk and verify tag
        val decrypted = crypto.decryptChunk(encrypted, sessionKey)
        assertArrayEquals(testData, decrypted)
    }
}
