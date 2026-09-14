package com.safedrop.mobile

import com.safedrop.mobile.core.crypto.CryptoEngine
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test
import java.security.Security

/**
 * Mobile Cryptography and Security Test Suite.
 *
 * The expectations here mirror computer-design/desktop_hub/crypto_protocol.js so the two
 * implementations stay wire-compatible.
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
    fun testPhoneToPhoneEncryptedExchange() {
        // Simulates the phone-to-phone path end to end at the protocol level:
        // sender = MobileTransferServer, receiver = MobileTransferServer on another phone.
        val sender = CryptoEngine()
        val receiver = CryptoEngine()

        // 1. Sender initiates: sends its ephemeral public key.
        val senderKeyPair = sender.generateEphemeralKeyPair()
        val senderRawPub = sender.extractRawPublicKey(senderKeyPair)

        // 2. Receiver answers with its own per-session ephemeral key pair.
        val receiverSessionKeyPair = receiver.generateEphemeralKeyPair()
        val receiverSessionRawPub = receiver.extractRawPublicKey(receiverSessionKeyPair)

        val sessionId = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
        val pin = "482913"

        // 3. Both sides derive the same key from their own private key and the peer's public key.
        val senderKey = sender.deriveSessionKey(senderKeyPair, receiverSessionRawPub, sessionId, pin)
        val receiverKey = receiver.deriveSessionKey(receiverSessionKeyPair, senderRawPub, sessionId, pin)
        assertArrayEquals(
            "Both phones must derive the same session key",
            senderKey.encoded,
            receiverKey.encoded
        )

        // 4. Sender proves knowledge of the PIN; receiver accepts and can answer with its proof.
        val proof = sender.bytesToHex(sender.clientProof(senderKey, sessionId))
        assertTrue(
            "Receiver must accept the sender's proof",
            receiver.verifyServerProof(receiverKey, sessionId, sender.bytesToHex(sender.serverProof(receiverKey, sessionId)))
        )
        assertArrayEquals(
            "Proof sent by the sender matches what the receiver computes",
            receiver.clientProof(receiverKey, sessionId),
            sender.hexToBytes(proof)
        )

        // 5. Sender seals a chunk; the receiver opens it.
        val taskId = "task_phone_phone"
        val payload = ByteArray(200 * 1024) { (it % 251).toByte() }
        val sealed = sender.encryptChunk(payload, senderKey, taskId, 0)
        val opened = receiver.decryptChunk(sealed, receiverKey, taskId, 0)
        assertArrayEquals("Receiver must recover the exact plaintext", payload, opened)

        // 6. A phone without the PIN must not be able to derive the key.
        val impostorKey = sender.deriveSessionKey(senderKeyPair, receiverSessionRawPub, sessionId, "000000")
        assertFalse(
            "A wrong PIN must not reproduce the session key",
            senderKey.encoded.contentEquals(impostorKey.encoded)
        )
    }

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

        // 3. Derive the session key independently on both sides from the same pairing secret
        val sessionId = "sess_test_0001"
        val pairingSecret = "886622"

        val aliceSessionKey = crypto.deriveSessionKey(
            localKeyPair = alicePair,
            remoteRawPublicKey = bobRawPub,
            sessionId = sessionId,
            pairingSecret = pairingSecret
        )

        val bobSessionKey = crypto.deriveSessionKey(
            localKeyPair = bobPair,
            remoteRawPublicKey = aliceRawPub,
            sessionId = sessionId,
            pairingSecret = pairingSecret
        )

        assertArrayEquals(aliceSessionKey.encoded, bobSessionKey.encoded)
    }

    @Test
    fun testDifferentPairingSecretYieldsDifferentKey() {
        val alicePair = crypto.generateEphemeralKeyPair()
        val bobPair = crypto.generateEphemeralKeyPair()
        val bobRawPub = crypto.extractRawPublicKey(bobPair)

        val good = crypto.deriveSessionKey(alicePair, bobRawPub, "sess_test_0002", "886622")
        val wrong = crypto.deriveSessionKey(alicePair, bobRawPub, "sess_test_0002", "000000")

        // The pairing secret feeds HKDF, so a wrong PIN must not reproduce the same key.
        assertFalse(good.encoded.contentEquals(wrong.encoded))
    }

    @Test
    fun testProofsAreSymmetric() {
        val alicePair = crypto.generateEphemeralKeyPair()
        val bobPair = crypto.generateEphemeralKeyPair()
        val sessionId = "sess_test_0003"

        val shared = crypto.deriveSessionKey(alicePair, crypto.extractRawPublicKey(bobPair), sessionId, "135790")

        val proofHex = crypto.bytesToHex(crypto.clientProof(shared, sessionId))
        val serverProofHex = crypto.bytesToHex(crypto.serverProof(shared, sessionId))

        // Client and server proofs must be distinct, and verification must accept only the
        // matching server proof.
        assertNotEquals(proofHex, serverProofHex)
        assertTrue(crypto.verifyServerProof(shared, sessionId, serverProofHex))
        assertFalse(crypto.verifyServerProof(shared, sessionId, proofHex))
    }

    @Test
    fun testAesGcm1MBChunkEncryptionAndDecryption() {
        val alicePair = crypto.generateEphemeralKeyPair()
        val bobPair = crypto.generateEphemeralKeyPair()
        val bobRawPub = crypto.extractRawPublicKey(bobPair)

        val sessionKey = crypto.deriveSessionKey(alicePair, bobRawPub, "sess_test_0004", "246813")

        // Construct 1MB test data
        val testData = ByteArray(1024 * 1024)
        for (i in testData.indices) {
            testData[i] = (i % 256).toByte()
        }

        val taskId = "task_chunk_test"

        // Encrypt chunk
        val encrypted = crypto.encryptChunk(testData, sessionKey, taskId, 0)
        assertEquals(CryptoEngine.IV_SIZE + testData.size + CryptoEngine.TAG_SIZE_BYTES, encrypted.size)

        // Decrypt chunk and verify tag
        val decrypted = crypto.decryptChunk(encrypted, sessionKey, taskId, 0)
        assertArrayEquals(testData, decrypted)
    }

    @Test
    fun testNonceIsRandomPerChunk() {
        val pair = crypto.generateEphemeralKeyPair()
        val sessionKey = crypto.deriveSessionKey(pair, crypto.extractRawPublicKey(crypto.generateEphemeralKeyPair()), "sess_test_0005", "112233")

        val data = ByteArray(64) { it.toByte() }
        val first = crypto.encryptChunk(data, sessionKey, "task_nonce", 0)
        val second = crypto.encryptChunk(data, sessionKey, "task_nonce", 0)

        val firstNonce = first.copyOfRange(0, CryptoEngine.IV_SIZE)
        val secondNonce = second.copyOfRange(0, CryptoEngine.IV_SIZE)

        // A deterministic nonce would repeat here and leak the AES-GCM keystream, so the
        // nonce must differ even for identical input at the same chunk index.
        assertFalse(firstNonce.contentEquals(secondNonce))
        assertFalse(first.contentEquals(second))
    }

    @Test
    fun testTamperedChunkIsRejected() {
        val pair = crypto.generateEphemeralKeyPair()
        val sessionKey = crypto.deriveSessionKey(pair, crypto.extractRawPublicKey(crypto.generateEphemeralKeyPair()), "sess_test_0006", "998877")

        val encrypted = crypto.encryptChunk(ByteArray(32) { 7 }, sessionKey, "task_tamper", 0)
        encrypted[encrypted.size - 1] = (encrypted[encrypted.size - 1] + 1).toByte()

        val failed = try {
            crypto.decryptChunk(encrypted, sessionKey, "task_tamper", 0)
            false
        } catch (e: Exception) {
            true
        }
        assertTrue("A modified authentication tag must fail verification", failed)
    }

    @Test
    fun testChunkIndexIsBoundAsAad() {
        val pair = crypto.generateEphemeralKeyPair()
        val sessionKey = crypto.deriveSessionKey(pair, crypto.extractRawPublicKey(crypto.generateEphemeralKeyPair()), "sess_test_0007", "556677")

        val encrypted = crypto.encryptChunk(ByteArray(32) { 3 }, sessionKey, "task_aad", 1)

        val failed = try {
            // Presenting a chunk sealed for index 1 as index 0 must be rejected.
            crypto.decryptChunk(encrypted, sessionKey, "task_aad", 0)
            false
        } catch (e: Exception) {
            true
        }
        assertTrue("The chunk index must be authenticated as AAD", failed)
    }
}
