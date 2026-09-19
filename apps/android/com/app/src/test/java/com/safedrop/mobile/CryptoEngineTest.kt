package com.safedrop.mobile

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.safedrop.mobile.core.crypto.CryptoEngine
import com.safedrop.mobile.core.crypto.ProtocolConst
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.security.Security
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Mobile Cryptography and Security Test Suite.
 *
 * Two kinds of expectations live here. The behavioural ones mirror
 * apps/desktop/desktop_hub/crypto_protocol.js so the two implementations stay wire-compatible.
 * The golden-vector ones read the bytes Node generated into test/vectors/e2e-v2.json, which is the
 * only way to prove that the Kotlin constants and the Kotlin crypto agree with the hub and the
 * browser at the same time, rather than merely agreeing with each other.
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

        // 5. Sender seals a chunk; the receiver opens it. The geometry the sender committed to is
        //    part of what is authenticated, so both sides have to agree on it.
        val taskId = "task_phone_phone"
        val chunkSize = ProtocolConst.Chunking.PREFERRED_CHUNK_SIZE_BYTES
        val payload = ByteArray(200 * 1024) { (it % 251).toByte() }
        val sealed = sender.encryptChunk(payload, senderKey, taskId, 0, 3, chunkSize)
        val opened = receiver.decryptChunk(sealed, receiverKey, taskId, 0, 3, chunkSize)
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

        assertEquals(ProtocolConst.X25519_RAW_LEN_BYTES, aliceRawPub.size)
        assertEquals(ProtocolConst.X25519_RAW_LEN_BYTES, bobRawPub.size)

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
    fun testAesGcmChunkEncryptionAndDecryption() {
        val alicePair = crypto.generateEphemeralKeyPair()
        val bobPair = crypto.generateEphemeralKeyPair()
        val bobRawPub = crypto.extractRawPublicKey(bobPair)

        val sessionKey = crypto.deriveSessionKey(alicePair, bobRawPub, "sess_test_0004", "246813")

        // Construct a full-size chunk at this device's preferred stride.
        val chunkSize = ProtocolConst.Chunking.PREFERRED_CHUNK_SIZE_BYTES
        val testData = ByteArray(chunkSize)
        for (i in testData.indices) {
            testData[i] = (i % 256).toByte()
        }

        val taskId = "task_chunk_test"

        // Encrypt chunk
        val encrypted = crypto.encryptChunk(testData, sessionKey, taskId, 0, 1, chunkSize)
        assertEquals(
            "A sealed chunk is nonce || ciphertext || tag",
            ProtocolConst.NONCE_LEN_BYTES + testData.size + ProtocolConst.TAG_LEN_BYTES,
            encrypted.size
        )

        // Decrypt chunk and verify tag
        val decrypted = crypto.decryptChunk(encrypted, sessionKey, taskId, 0, 1, chunkSize)
        assertArrayEquals(testData, decrypted)
    }

    @Test
    fun testNonceIsRandomPerChunk() {
        val pair = crypto.generateEphemeralKeyPair()
        val sessionKey = crypto.deriveSessionKey(pair, crypto.extractRawPublicKey(crypto.generateEphemeralKeyPair()), "sess_test_0005", "112233")

        val data = ByteArray(64) { it.toByte() }
        val first = crypto.encryptChunk(data, sessionKey, "task_nonce", 0, 1, 64)
        val second = crypto.encryptChunk(data, sessionKey, "task_nonce", 0, 1, 64)

        val firstNonce = first.copyOfRange(0, ProtocolConst.NONCE_LEN_BYTES)
        val secondNonce = second.copyOfRange(0, ProtocolConst.NONCE_LEN_BYTES)

        // A deterministic nonce would repeat here and leak the AES-GCM keystream, so the
        // nonce must differ even for identical input at the same chunk index.
        assertFalse(firstNonce.contentEquals(secondNonce))
        assertFalse(first.contentEquals(second))
    }

    @Test
    fun testTamperedChunkIsRejected() {
        val pair = crypto.generateEphemeralKeyPair()
        val sessionKey = crypto.deriveSessionKey(pair, crypto.extractRawPublicKey(crypto.generateEphemeralKeyPair()), "sess_test_0006", "998877")

        val encrypted = crypto.encryptChunk(ByteArray(32) { 7 }, sessionKey, "task_tamper", 0, 1, 32)
        encrypted[encrypted.size - 1] = (encrypted[encrypted.size - 1] + 1).toByte()

        val failed = try {
            crypto.decryptChunk(encrypted, sessionKey, "task_tamper", 0, 1, 32)
            false
        } catch (e: Exception) {
            true
        }
        assertTrue("A modified authentication tag must fail verification", failed)
    }

    /**
     * The three numbers a receiver reassembles a file from. A chunk sealed for one geometry must
     * not open under another, otherwise the headers that decide when a file is finished are still
     * forgeable even though they are named in the AAD.
     */
    @Test
    fun testChunkGeometryIsBoundAsAad() {
        val pair = crypto.generateEphemeralKeyPair()
        val sessionKey = crypto.deriveSessionKey(pair, crypto.extractRawPublicKey(crypto.generateEphemeralKeyPair()), "sess_test_0007", "556677")

        val taskId = "task_aad"
        val sealed = crypto.encryptChunk(ByteArray(32) { 3 }, sessionKey, taskId, 1, 4, 32)

        val rewrites = listOf(
            Triple(0, 4, 32) to "index",
            Triple(1, 1, 32) to "count",
            Triple(1, 4, 33) to "stride",
            Triple(1, 4, 1024) to "stride"
        )
        for ((rewrite, what) in rewrites) {
            val (index, count, chunkSize) = rewrite
            val accepted = try {
                crypto.decryptChunk(sealed, sessionKey, taskId, index, count, chunkSize)
                true
            } catch (e: Exception) {
                false
            }
            assertFalse("A chunk sealed for one $what must not open under another", accepted)
        }

        // Nor under a different task.
        val moved = try {
            crypto.decryptChunk(sealed, sessionKey, "task_aad_other", 1, 4, 32)
            true
        } catch (e: Exception) {
            false
        }
        assertFalse("A chunk cannot be moved between transfers", moved)
    }

    /** Bounds a receiver would otherwise take on faith from headers it has no reason to trust. */
    @Test
    fun testImpossibleGeometryIsRefused() {
        val taskId = "task_geometry"
        val key = keyFor(taskId)
        val sealed = crypto.encryptChunk(ByteArray(8), key, taskId, 0, 1, 8)

        val cases = listOf(
            intArrayOf(0, 0, 8) to "zero chunks",
            intArrayOf(0, -1, 8) to "negative count",
            intArrayOf(0, ProtocolConst.Chunking.MAX_CHUNKS_PER_TASK + 1, 8) to "count above the cap",
            intArrayOf(-1, 3, 8) to "negative index",
            intArrayOf(3, 3, 8) to "index equal to count",
            intArrayOf(0, 3, 0) to "zero stride",
            intArrayOf(0, 3, ProtocolConst.Chunking.MAX_SEALED_CHUNK_BYTES + 1) to "stride above the cap"
        )
        for ((case, why) in cases) {
            val (index, count, chunkSize) = case

            val aadAccepted = try {
                crypto.chunkAad(taskId, index, count, chunkSize)
                true
            } catch (e: Exception) {
                false
            }
            assertFalse("$why must be refused before it reaches the wire", aadAccepted)

            val opened = try {
                crypto.decryptChunk(sealed, key, taskId, index, count, chunkSize)
                true
            } catch (e: Exception) {
                false
            }
            assertFalse("$why must be refused on the receiving side too", opened)

            val sealedAgain = try {
                crypto.encryptChunk(ByteArray(8), key, taskId, index, count, chunkSize)
                true
            } catch (e: Exception) {
                false
            }
            assertFalse("$why must never be sealed here either", sealedAgain)
        }
    }

    private fun keyFor(label: String): SecretKeySpec =
        SecretKeySpec(crypto.sha256(label.toByteArray()), "AES")

    // ------------------------------------------------------------------
    // Cross-end contract: the vectors Node generated, Kotlin must reproduce.
    // ------------------------------------------------------------------

    /**
     * test/vectors/e2e-v2.json is generated by scripts/gen-vectors.js and is the same file the hub
     * and the browser check themselves against. Reading it here is the only proof the Kotlin side
     * agrees with them byte for byte.
     *
     * A missing file is a failure, not a skip: a contract test that silently passes when the
     * contract is not on disk is worse than no test, because it looks like coverage.
     */
    @Test
    fun testVectorsAreCommittedAndReadable() {
        val vectors = loadVectors()
        assertEquals(ProtocolConst.PROTOCOL, vectors.get("protocol").asString)
        val constants = vectors.getAsJsonObject("constants")
        assertEquals(ProtocolConst.KEY_LEN_BYTES, constants.get("keyLen").asInt)
        assertEquals(ProtocolConst.NONCE_LEN_BYTES, constants.get("nonceLen").asInt)
        assertEquals(ProtocolConst.TAG_LEN_BYTES, constants.get("tagLen").asInt)
    }

    /** The five protocol.json templates, as the Kotlin code renders them. */
    @Test
    fun testGoldenVectorKdfTemplates() {
        val vectors = loadVectors()
        val kdf = vectors.getAsJsonObject("kdf")
        val sessionId = vectors.get("sessionId").asString
        val pairingSecret = vectors.get("pairingSecret").asString
        val key = sessionKeyOf(vectors)

        // The salt template is consumed as a SHA-256 digest; the info template is used verbatim.
        assertEquals(
            "kdfSalt template must match Node",
            kdf.get("saltDigestHex").asString,
            crypto.bytesToHex(crypto.deriveSalt(sessionId))
        )
        assertEquals(
            "kdfInfo template must match Node",
            kdf.get("infoHex").asString,
            crypto.bytesToHex(crypto.deriveInfo(pairingSecret))
        )

        // Chaining the vector's own recorded inputs through the same primitives is what pins the
        // pre-image strings, not merely their digests.
        assertEquals(
            "the recorded salt input must be what Node hashed",
            kdf.get("saltDigestHex").asString,
            crypto.bytesToHex(crypto.sha256(crypto.hexToBytes(kdf.get("saltInputHex").asString)))
        )
        assertEquals(
            "clientProof template must match Node",
            kdf.get("clientProofHex").asString,
            crypto.bytesToHex(crypto.clientProof(key, sessionId))
        )
        assertEquals(
            "serverProof template must match Node",
            kdf.get("serverProofHex").asString,
            crypto.bytesToHex(crypto.serverProof(key, sessionId))
        )
        assertEquals(
            "the recorded client proof input must be what Node signed",
            kdf.get("clientProofHex").asString,
            crypto.bytesToHex(hmacSha256(key.encoded, crypto.hexToBytes(kdf.get("clientProofInputHex").asString)))
        )
        assertEquals(
            "the recorded server proof input must be what Node signed",
            kdf.get("serverProofHex").asString,
            crypto.bytesToHex(hmacSha256(key.encoded, crypto.hexToBytes(kdf.get("serverProofInputHex").asString)))
        )
    }

    @Test
    fun testGoldenVectorChunkAad() {
        val vectors = loadVectors()
        val cases = vectors.getAsJsonArray("aad")
        assertTrue("the vector file must carry AAD cases", cases.size() > 0)
        for (element in cases) {
            val item = element.asJsonObject
            val label = "${item.get("taskId").asString}[${item.get("index").asString}/${item.get("count").asString}]@${item.get("chunkSize").asString}"
            assertEquals(
                "chunkAad must match Node for $label",
                item.get("hex").asString,
                crypto.bytesToHex(
                    crypto.chunkAad(
                        item.get("taskId").asString,
                        item.get("index").asInt,
                        item.get("count").asInt,
                        item.get("chunkSize").asInt
                    )
                )
            )
        }
    }

    /** Kotlin only ever has to open these: the sealed bytes carry a fixed vector nonce. */
    @Test
    fun testGoldenVectorChunksDecrypt() {
        val vectors = loadVectors()
        val key = sessionKeyOf(vectors)
        val cases = vectors.getAsJsonArray("chunks")
        assertTrue("the vector file must carry chunk cases", cases.size() > 0)
        for (element in cases) {
            val item = element.asJsonObject
            val taskId = item.get("taskId").asString
            val index = item.get("index").asInt
            val count = item.get("count").asInt
            val chunkSize = item.get("chunkSize").asInt
            val label = "$taskId[$index/$count]@$chunkSize"
            val sealed = crypto.hexToBytes(item.get("sealedHex").asString)

            // Wire format first: a packet that is not nonce || ciphertext || tag is a different
            // protocol however well it decrypts.
            assertEquals(
                "sealed length must be overhead + ciphertext for $label",
                ProtocolConst.NONCE_LEN_BYTES + item.get("ciphertextLen").asInt + ProtocolConst.TAG_LEN_BYTES,
                sealed.size
            )
            assertArrayEquals(
                "the nonce must lead the packet for $label",
                crypto.hexToBytes(item.get("nonceHex").asString),
                sealed.copyOfRange(0, ProtocolConst.NONCE_LEN_BYTES)
            )
            assertArrayEquals(
                "the tag must trail the packet for $label",
                crypto.hexToBytes(item.get("tagHex").asString),
                sealed.copyOfRange(sealed.size - ProtocolConst.TAG_LEN_BYTES, sealed.size)
            )

            assertArrayEquals(
                "Kotlin must open the bytes Node sealed for $label",
                crypto.hexToBytes(item.get("plaintextHex").asString),
                crypto.decryptChunk(sealed, key, taskId, index, count, chunkSize)
            )
        }
    }

    /**
     * Each reject case is a packet plus a plausible-looking geometry that must not open it: a
     * re-labelled index, a shrunken count, a different stride, another task id, and raw tampering.
     * Anything that decrypts here is a hole the hub does not have.
     */
    @Test
    fun testGoldenVectorRejectsAreRejected() {
        val vectors = loadVectors()
        val key = sessionKeyOf(vectors)
        val cases = vectors.getAsJsonArray("reject")
        assertTrue("the vector file must carry reject cases", cases.size() > 0)
        for (element in cases) {
            val item = element.asJsonObject
            val why = item.get("why").asString
            val accepted = try {
                crypto.decryptChunk(
                    crypto.hexToBytes(item.get("sealedHex").asString),
                    key,
                    item.get("taskId").asString,
                    item.get("index").asInt,
                    item.get("count").asInt,
                    item.get("chunkSize").asInt
                )
                true
            } catch (e: Exception) {
                false
            }
            assertFalse("must not decrypt: $why", accepted)
        }
    }

    private fun loadVectors(): JsonObject {
        // JUnit's working directory is the Gradle module directory, and the vectors sit at the
        // repository root. The distance between the two was a hardcoded ../../../ until this
        // project moved the module and silently broke five contract tests; walk up until the file
        // is found instead, so renaming or relocating a directory cannot disconnect the two ends
        // from the vectors that prove they agree.
        val start = File(".").absoluteFile
        var dir: File? = start
        var found: File? = null
        while (dir != null && found == null) {
            val candidate = File(dir, "test/vectors/e2e-v2.json")
            if (candidate.isFile) found = candidate
            dir = dir.parentFile
        }
        assertTrue(
            "cross-end vectors not found in any directory above ${start.path}; they are committed " +
                    "under test/vectors and must be present for this contract test",
            found != null
        )
        return Gson().fromJson(found!!.readText(Charsets.UTF_8), JsonObject::class.java)
    }

    private fun sessionKeyOf(vectors: JsonObject): SecretKeySpec =
        SecretKeySpec(crypto.hexToBytes(vectors.get("keyHex").asString), "AES")

    private fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }
}
