package com.safedrop.mobile.service

import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Log
import com.safedrop.mobile.core.crypto.CryptoEngine
import com.safedrop.mobile.core.network.NetworkHelper
import com.safedrop.mobile.core.storage.ScopedStorageHelper
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.SecretKey

/**
 * Embedded lightweight HTTP server running on Android.
 * Features:
 * 1. Encrypted P2P handshake (ECDH + HKDF + HMAC proof) and key agreement
 * 2. Chunked streaming upload receiver (AES-256-GCM sealed chunks)
 * 3. Vault file listing & download stream
 * 4. Standalone Web File Transfer Portal (/portal & /) for browser direct transfer
 *
 * The transport protocol mirrors computer-design/desktop_hub/crypto_protocol.js, so the
 * hub, the desktop UI, a browser and another phone can all talk to this server the same way.
 */
class MobileTransferServer(
    private val context: Context,
    private val storageHelper: ScopedStorageHelper,
    private val onProgress: (taskId: String, fileName: String, progress: Int, speedMbps: Float) -> Unit,
    private val onCompleted: (taskId: String, fileName: String, uri: Uri?) -> Unit,
    private val onMessageReceived: (senderId: String, senderName: String, text: String, timestamp: Long) -> Unit = { _, _, _, _ -> }
) {
    private val tag = "MobileTransferServer"
    private var serverSocket: ServerSocket? = null
    private var isRunning = false
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val taskBytesMap = mutableMapOf<String, Long>()
    private val taskStartTimeMap = mutableMapOf<String, Long>()
    private val cryptoEngine = CryptoEngine()
    private val secureRandom = SecureRandom()

    /** Ephemeral E2E sessions created by the handshake. Keys live in memory only. */
    private class E2eSession(
        /** The peer's raw X25519 public key, kept so the shared secret can be derived at verify time. */
        val peerRawPublicKey: ByteArray,
        /** The peer's ephemeral key pair, unique to this session. */
        val keyPair: java.security.KeyPair,
        val clientIp: String
    ) {
        var key: SecretKey? = null
        var verified: Boolean = false
        val createdAt: Long = System.currentTimeMillis()
        var lastSeen: Long = createdAt
    }

    private val e2eSessions = mutableMapOf<String, E2eSession>()
    private val pairingAttempts = mutableMapOf<String, Int>()
    private val sessionTtlMs = 10 * 60 * 1000L
    private val pairingMaxFailures = 8

    /** Only loopback is trusted; it can only come from this device. */
    private fun isTrustedLocal(ip: String?): Boolean {
        val value = ip ?: return false
        return value == "127.0.0.1" || value == "::1" || value.startsWith("127.") || value == "localhost"
    }

    private fun pruneSessions() {
        val now = System.currentTimeMillis()
        val expired = e2eSessions.filter { now - it.value.createdAt > sessionTtlMs }.keys.toList()
        for (id in expired) e2eSessions.remove(id)
    }

    /** Look up a verified session, bound to the requesting IP so an id cannot be replayed. */
    private fun getVerifiedSession(sessionId: String?, clientIp: String?): E2eSession? {
        if (sessionId.isNullOrEmpty()) return null
        pruneSessions()
        val session = e2eSessions[sessionId] ?: return null
        if (!session.verified || session.key == null) return null
        if (session.clientIp != (clientIp ?: "")) return null
        session.lastSeen = System.currentTimeMillis()
        return session
    }

    private fun sendUnauthorized(outputStream: OutputStream, message: String) {
        val body = """{"code":401,"error":"$message"}""".toByteArray(StandardCharsets.UTF_8)
        sendHttpResponse(outputStream, 401, "Unauthorized", "application/json", body)
    }

    var port: Int = 8899
        private set

    // Device Identity & Cryptographic Keys
    private val keyPair = cryptoEngine.generateEphemeralKeyPair()
    private val rawPublicKey = cryptoEngine.extractRawPublicKey(keyPair)
    val rawPubKeyHex: String = cryptoEngine.bytesToHex(rawPublicKey)
    val fingerprint: String = cryptoEngine.bytesToHex(
        MessageDigest.getInstance("SHA-256").digest(rawPublicKey)
    ).substring(0, 16).uppercase()

    val deviceName: String = "Android " + (Build.MODEL ?: "Phone")
    val deviceId: String = "android-" + (Build.MODEL ?: "dev").replace(" ", "_").lowercase() + "-" + fingerprint.take(6).lowercase()

    // Dynamic Pairing Credentials
    var currentPin: String = newPairingPin()
        private set
    var currentToken: String = UUID.randomUUID().toString().substring(0, 12)
        private set

    // Every successful handshake rotates the credentials, so a value that is still on screen
    // (or in a QR code already being scanned) goes stale the moment any device pairs. Retired
    // credentials therefore stay accepted for a grace period, and more than one generation is
    // kept: with a single previous slot, a second pairing inside the window evicted the value
    // still displayed on this device and the next peer was rejected even though the user had
    // just read it correctly. The window stays bounded, so this is not an accept-anything path.
    private val pairingGraceMs = 60_000L
    private val pairingGraceGenerations = 3
    /** Retired credentials, newest first: Triple(pin, token, retiredAtMs). */
    private val retiredCredentialHistory = ArrayDeque<Triple<String, String, Long>>()

    fun refreshPairingPin(): Pair<String, String> {
        rotateCredentials()
        return Pair(currentPin, currentToken)
    }

    /** Retire the credentials in use, then issue a fresh pair. */
    private fun rotateCredentials() {
        val now = System.currentTimeMillis()
        retiredCredentialHistory.addFirst(Triple(currentPin, currentToken, now))
        // Drop anything outside the window, then keep only the newest few generations.
        val fresh = retiredCredentialHistory
            .filter { now - it.third < pairingGraceMs }
            .take(pairingGraceGenerations)
        retiredCredentialHistory.clear()
        retiredCredentialHistory.addAll(fresh)

        currentPin = newPairingPin()
        currentToken = UUID.randomUUID().toString().substring(0, 12)
    }

    /**
     * A six-digit pairing code. Drawn from SecureRandom rather than Math.random(): the code is
     * an authorization factor, and a predictable generator would let an observer who can
     * reconstruct its state anticipate the value the user is about to read off the screen.
     */
    private fun newPairingPin(): String = (100_000 + secureRandom.nextInt(900_000)).toString()

    /** Candidate secrets accepted by the handshake, including the recent grace window. */
    private fun pairingSecretCandidates(): List<String> {
        val now = System.currentTimeMillis()
        val candidates = mutableListOf(currentPin, currentToken)
        for ((pin, token, retiredAt) in retiredCredentialHistory) {
            if (now - retiredAt >= pairingGraceMs) continue
            candidates.add(pin)
            candidates.add(token)
        }
        return candidates
    }

    fun start(preferPort: Int = 8899): Int {
        if (isRunning) return port
        var targetPort = preferPort
        for (attempt in 0 until 5) {
            try {
                serverSocket = ServerSocket(targetPort)
                port = targetPort
                isRunning = true
                Log.i(tag, "MobileTransferServer listening on port $port (FP: $fingerprint, PIN: $currentPin)")
                break
            } catch (e: Exception) {
                targetPort++
            }
        }

        scope.launch {
            while (isRunning && serverSocket != null) {
                try {
                    val clientSocket = serverSocket?.accept() ?: break
                    launch { handleClient(clientSocket) }
                } catch (e: Exception) {
                    if (!isRunning) break
                }
            }
        }
        return port
    }

    fun stop() {
        isRunning = false
        try {
            serverSocket?.close()
        } catch (_: Exception) {}
        serverSocket = null
        scope.cancel()
    }

    private fun handleClient(socket: Socket) {
        socket.use { s ->
            try {
                s.soTimeout = 15000
                val inputStream = BufferedInputStream(s.getInputStream())
                val outputStream = BufferedOutputStream(s.getOutputStream())

                // TCP source address of the peer, used to bind sessions and rate limit pairing.
                val clientIp = s.inetAddress?.hostAddress?.removePrefix("::ffff:") ?: "unknown"

                // 1. Parse HTTP Request Line & Headers
                val headers = mutableMapOf<String, String>()
                val requestLine = readLine(inputStream) ?: return
                var line = readLine(inputStream)
                while (!line.isNullOrEmpty()) {
                    val colonIdx = line.indexOf(':')
                    if (colonIdx != -1) {
                        val key = line.substring(0, colonIdx).trim().lowercase()
                        val value = line.substring(colonIdx + 1).trim()
                        headers[key] = value
                    }
                    line = readLine(inputStream)
                }

                val parts = requestLine.split(" ")
                if (parts.size < 2) return
                val method = parts[0].uppercase()
                val fullPath = parts[1]
                val path = fullPath.substringBefore('?')

                // OPTIONS preflight
                if (method == "OPTIONS") {
                    sendHttpResponse(outputStream, 204, "No Content", "text/plain", ByteArray(0))
                    return
                }

                // GET /api/v1/ping
                if (path == "/api/v1/ping" && method == "GET") {
                    val json = """{"code":0,"server":"SafeDrop Mobile Client","device_name":"$deviceName","device_type":"android","port":$port,"fingerprint":"$fingerprint","os":"android"}"""
                    sendHttpResponse(outputStream, 200, "OK", "application/json", json.toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // GET /api/v1/info
                // Pairing secrets are disclosed only to loopback callers; remote devices must
                // read them from this device's screen or QR code, which is what gives the
                // pairing step its value.
                if (path == "/api/v1/info" && method == "GET") {
                    val localIp = NetworkHelper.getLocalWifiIpv4(context)
                    val trusted = isTrustedLocal(clientIp)

                    val infoObj = JSONObject().apply {
                        put("code", 0)
                        put("name", deviceName)
                        put("device_name", deviceName)
                        put("device_type", "android")
                        put("os", "android")
                        put("localIp", localIp)
                        put("port", port)
                        put("fingerprint", fingerprint)
                        put("pinRequired", true)
                        put("secretsDisclosed", trusted)
                        put("host", JSONObject().apply {
                            put("id", deviceId)
                            put("name", deviceName)
                            put("ip", localIp)
                            put("port", port)
                            put("fingerprint", fingerprint)
                            put("os", "android")
                        })
                        if (trusted) {
                            put("pin", currentPin)
                            put("token", currentToken)
                            put("qrUri", "safedrop://pair?ip=$localIp&port=$port&fp=$fingerprint&token=$currentToken&pin=$currentPin")
                            put("webUrl", "http://$localIp:$port/portal?pin=$currentPin&token=$currentToken&fp=$fingerprint")
                        }
                    }
                    sendHttpResponse(outputStream, 200, "OK", "application/json", infoObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/handshake/init
                // The peer sends an ephemeral public key; we answer with ours and keep the
                // ECDH shared secret for this session only.
                if (path == "/api/v1/handshake/init" && method == "POST") {
                    val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
                    val bodyStr = readBodyString(inputStream, contentLength)
                    val bodyJson = try { JSONObject(bodyStr) } catch (_: Exception) { JSONObject() }
                    val clientPubHex = bodyJson.optString("public_key", "")

                    val clientRawPub = try {
                        cryptoEngine.hexToBytes(clientPubHex)
                    } catch (_: Exception) {
                        null
                    }
                    if (clientRawPub == null || clientRawPub.size != 32) {
                        val err = """{"code":400,"error":"public_key must be a 32-byte hex X25519 key"}"""
                        sendHttpResponse(outputStream, 400, "Bad Request", "application/json", err.toByteArray(StandardCharsets.UTF_8))
                        return
                    }

                    // Each session gets its own ephemeral key pair, so forward secrecy holds
                    // even though the device identity key above is long-lived.
                    val sessionKeyPair = cryptoEngine.generateEphemeralKeyPair()
                    val sessionRawPubHex = cryptoEngine.bytesToHex(cryptoEngine.extractRawPublicKey(sessionKeyPair))
                    val sessionId = cryptoEngine.bytesToHex(secureRandom.generateSeed(16))
                    e2eSessions[sessionId] = E2eSession(
                        peerRawPublicKey = clientRawPub,
                        keyPair = sessionKeyPair,
                        clientIp = clientIp
                    )

                    val respObj = JSONObject().apply {
                        put("code", 0)
                        put("protocol", CryptoEngine.PROTOCOL)
                        put("session_id", sessionId)
                        put("curve", "x25519")
                        put("server_public_key", sessionRawPubHex)
                        put("pin_required", true)
                        put("fingerprint", fingerprint)
                    }
                    sendHttpResponse(outputStream, 200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/handshake/verify
                // The pairing secret never crosses the wire: the peer proves it derived the same
                // session key by sending an HMAC over the session id.
                if (path == "/api/v1/handshake/verify" && method == "POST") {
                    if ((pairingAttempts[clientIp] ?: 0) >= pairingMaxFailures) {
                        val err = """{"code":429,"error":"Too many pairing attempts. Try again later."}"""
                        sendHttpResponse(outputStream, 429, "Too Many Requests", "application/json", err.toByteArray(StandardCharsets.UTF_8))
                        return
                    }

                    val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
                    val bodyStr = readBodyString(inputStream, contentLength)
                    val bodyJson = try { JSONObject(bodyStr) } catch (_: Exception) { JSONObject() }
                    val sessionId = bodyJson.optString("session_id", "")
                    val proof = bodyJson.optString("proof", "")

                    val session = e2eSessions[sessionId]
                    if (session == null || session.clientIp != clientIp) {
                        pairingAttempts[clientIp] = (pairingAttempts[clientIp] ?: 0) + 1
                        val err = """{"code":403,"error":"Unknown or expired session"}"""
                        sendHttpResponse(outputStream, 403, "Forbidden", "application/json", err.toByteArray(StandardCharsets.UTF_8))
                        return
                    }

                    var matchedKey: SecretKey? = null
                    for (secret in pairingSecretCandidates()) {
                        val candidate = try {
                            cryptoEngine.deriveSessionKey(session.keyPair, session.peerRawPublicKey, sessionId, secret)
                        } catch (_: Exception) {
                            continue
                        }
                        val expected = cryptoEngine.clientProof(candidate, sessionId)
                        val provided = try { cryptoEngine.hexToBytes(proof) } catch (_: Exception) { null }
                        if (provided != null && MessageDigest.isEqual(expected, provided)) {
                            matchedKey = candidate
                            break
                        }
                    }

                    if (matchedKey == null) {
                        pairingAttempts[clientIp] = (pairingAttempts[clientIp] ?: 0) + 1
                        val err = """{"code":403,"error":"Pairing proof verification failed"}"""
                        sendHttpResponse(outputStream, 403, "Forbidden", "application/json", err.toByteArray(StandardCharsets.UTF_8))
                        return
                    }

                    session.key = matchedKey
                    session.verified = true
                    session.lastSeen = System.currentTimeMillis()
                    pairingAttempts.remove(clientIp)

                    // Rotate credentials only after a successful pairing.
                    refreshPairingPin()

                    val respObj = JSONObject().apply {
                        put("code", 0)
                        put("status", "verified")
                        put("session_id", sessionId)
                        put("server_proof", cryptoEngine.bytesToHex(cryptoEngine.serverProof(matchedKey, sessionId)))
                        put("message", "Encrypted session established")
                    }
                    sendHttpResponse(outputStream, 200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/pin/refresh
                if (path == "/api/v1/pin/refresh" && method == "POST") {
                    if (!isTrustedLocal(clientIp)) {
                        val err = """{"code":403,"error":"Pairing credentials can only be refreshed on the device itself"}"""
                        sendHttpResponse(outputStream, 403, "Forbidden", "application/json", err.toByteArray(StandardCharsets.UTF_8))
                        return
                    }
                    refreshPairingPin()
                    val localIp = NetworkHelper.getLocalWifiIpv4(context)
                    val qrUri = "safedrop://pair?ip=$localIp&port=$port&fp=$fingerprint&token=$currentToken&pin=$currentPin"
                    val webUrl = "http://$localIp:$port/portal?pin=$currentPin&token=$currentToken&fp=$fingerprint"

                    val respObj = JSONObject().apply {
                        put("code", 0)
                        put("pin", currentPin)
                        put("token", currentToken)
                        put("qrUri", qrUri)
                        put("webUrl", webUrl)
                        put("localIp", localIp)
                        put("fingerprint", fingerprint)
                        put("message", "Pairing credentials refreshed successfully")
                    }
                    sendHttpResponse(outputStream, 200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/transfer/upload
                // Remote senders must be inside a verified session; their chunks are
                // AES-256-GCM sealed and are decrypted here before touching disk. Loopback
                // callers may still post plaintext (local tooling and tests).
                if (path == "/api/v1/transfer/upload" && method == "POST") {
                    val isLocal = isTrustedLocal(clientIp)
                    val session = getVerifiedSession(headers["x-session-id"], clientIp)
                    val isEncrypted = headers["x-encrypted"] == "1"

                    if (!isLocal && session == null) {
                        sendUnauthorized(outputStream, "Encrypted session required. Complete the pairing handshake before uploading.")
                        return
                    }
                    if (isEncrypted && session == null) {
                        val err = """{"code":400,"error":"X-Encrypted was set but no verified session key is available"}"""
                        sendHttpResponse(outputStream, 400, "Bad Request", "application/json", err.toByteArray(StandardCharsets.UTF_8))
                        return
                    }

                    val rawTaskId = headers["x-task-id"] ?: "task_${System.currentTimeMillis()}"
                    val taskId = rawTaskId.replace(Regex("[^a-zA-Z0-9_-]"), "").ifEmpty { "task_${System.currentTimeMillis()}" }
                    val rawFileName = headers["x-file-name"] ?: "received_file.bin"
                    val fileName = try {
                        URLDecoder.decode(rawFileName, "UTF-8")
                    } catch (_: Exception) {
                        rawFileName
                    }
                    val chunkIndex = headers["x-chunk-index"]?.toIntOrNull() ?: 0
                    val totalChunks = headers["x-chunk-count"]?.toIntOrNull() ?: 1
                    val fileSize = headers["x-file-size"]?.toLongOrNull() ?: 0L
                    val contentLength = headers["content-length"]?.toIntOrNull() ?: -1

                    if (contentLength > 8 * 1024 * 1024) {
                        sendHttpResponse(outputStream, 413, "Payload Too Large", "application/json", """{"error":"Chunk size exceeds 8MB limit"}""".toByteArray(StandardCharsets.UTF_8))
                        return
                    }

                    val now = System.currentTimeMillis()
                    val staleKeys = taskStartTimeMap.filter { now - it.value > 300000 }.keys.toList()
                    for (k in staleKeys) {
                        taskStartTimeMap.remove(k)
                        taskBytesMap.remove(k)
                    }

                    if (chunkIndex == 0) {
                        taskBytesMap[taskId] = 0L
                        taskStartTimeMap[taskId] = now
                    }

                    val partFile = storageHelper.getTempPartFile(taskId, fileName)

                    if (isEncrypted) {
                        // Read the whole sealed packet, verify the tag, then append the plaintext.
                        // GCM verification is all-or-nothing, so nothing is written on failure.
                        val bodyBytes = ByteArray(if (contentLength > 0) contentLength else 0)
                        if (bodyBytes.isNotEmpty()) {
                            var read = 0
                            while (read < bodyBytes.size) {
                                val r = inputStream.read(bodyBytes, read, bodyBytes.size - read)
                                if (r == -1) break
                                read += r
                            }
                        }
                        val plaintext = try {
                            cryptoEngine.decryptChunk(bodyBytes, session!!.key!!, taskId, chunkIndex)
                        } catch (e: Exception) {
                            Log.w(tag, "Rejected encrypted chunk $chunkIndex of $taskId: ${e.message}")
                            val err = """{"code":400,"error":"Decryption failed: ${e.message}"}"""
                            sendHttpResponse(outputStream, 400, "Bad Request", "application/json", err.toByteArray(StandardCharsets.UTF_8))
                            return
                        }
                        FileOutputStream(partFile, true).use { fos ->
                            if (plaintext.isNotEmpty()) fos.write(plaintext)
                        }
                    } else {
                        val chunkBuffer = ByteArray(8192)
                        var bytesRemaining = if (contentLength in 1..(8 * 1024 * 1024)) contentLength else (1024 * 1024)

                        FileOutputStream(partFile, true).use { fos ->
                            while (bytesRemaining > 0) {
                                val toRead = minOf(chunkBuffer.size, bytesRemaining)
                                val read = inputStream.read(chunkBuffer, 0, toRead)
                                if (read == -1) break
                                fos.write(chunkBuffer, 0, read)
                                bytesRemaining -= read
                            }
                        }
                    }

                    val currentUploaded = (taskBytesMap[taskId] ?: 0L) + (contentLength.coerceAtLeast(0))
                    taskBytesMap[taskId] = currentUploaded

                    val progress = if (fileSize > 0) {
                        ((currentUploaded * 100) / fileSize).toInt().coerceIn(0, 100)
                    } else {
                        ((chunkIndex + 1) * 100 / totalChunks).coerceIn(0, 100)
                    }

                    val startTime = taskStartTimeMap[taskId] ?: System.currentTimeMillis()
                    val elapsedSec = (System.currentTimeMillis() - startTime) / 1000f
                    val speedMbps = if (elapsedSec > 0) (currentUploaded / (1024f * 1024f)) / elapsedSec else 0f

                    onProgress(taskId, fileName, progress, speedMbps)

                    var resultUri: Uri? = null
                    if (chunkIndex + 1 >= totalChunks) {
                        resultUri = storageHelper.finalizeReceivedFile(taskId, fileName)
                        taskBytesMap.remove(taskId)
                        taskStartTimeMap.remove(taskId)
                        onCompleted(taskId, fileName, resultUri)
                    }

                    val respJson = """{"code":0,"chunk_index":$chunkIndex,"total_chunks":$totalChunks,"status":"${if (chunkIndex + 1 >= totalChunks) "completed" else "chunk_received"}"}"""
                    sendHttpResponse(outputStream, 200, "OK", "application/json", respJson.toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/message/send
                if (path == "/api/v1/message/send" && method == "POST") {
                    val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
                    val bodyStr = readBodyString(inputStream, contentLength)
                    val bodyJson = try { JSONObject(bodyStr) } catch (_: Exception) { JSONObject() }
                    val text = bodyJson.optString("text", "").trim()
                    val senderId = bodyJson.optString("senderId", "").ifEmpty {
                        socket.inetAddress?.hostAddress ?: "remote_peer"
                    }
                    val senderName = bodyJson.optString("senderName", "对端设备")
                    val timestamp = bodyJson.optLong("timestamp", System.currentTimeMillis())

                    if (text.isNotEmpty()) {
                        onMessageReceived(senderId, senderName, text, timestamp)
                    }

                    val respObj = JSONObject().apply {
                        put("code", 0)
                        put("status", "received")
                        put("message", "Message received")
                    }
                    sendHttpResponse(outputStream, 200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // GET /api/v1/files/list
                if (path == "/api/v1/files/list" && method == "GET") {
                    if (!isTrustedLocal(clientIp) && getVerifiedSession(headers["x-session-id"], clientIp) == null) {
                        sendUnauthorized(outputStream, "Encrypted session required")
                        return
                    }
                    val vaultFiles = storageHelper.getVaultFiles()
                    val filesArray = JSONArray()
                    for (f in vaultFiles) {
                        filesArray.put(JSONObject().apply {
                            put("name", f.name)
                            put("size", f.sizeBytes)
                            put("mtime", f.lastModified)
                        })
                    }
                    val respObj = JSONObject().apply {
                        put("code", 0)
                        put("files", filesArray)
                    }
                    sendHttpResponse(outputStream, 200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // GET /api/v1/files/download/:name
                if (path.startsWith("/api/v1/files/download/") && method == "GET") {
                    if (!isTrustedLocal(clientIp) && getVerifiedSession(headers["x-session-id"], clientIp) == null) {
                        sendUnauthorized(outputStream, "Encrypted session required")
                        return
                    }
                    val rawName = path.removePrefix("/api/v1/files/download/")
                    val safeName = storageHelper.sanitizeFileName(try { URLDecoder.decode(rawName, "UTF-8") } catch (_: Exception) { rawName })
                    val vaultFiles = storageHelper.getVaultFiles()
                    val targetItem = vaultFiles.find { it.name == safeName }

                    if (targetItem != null && targetItem.path.isNotEmpty() && File(targetItem.path).exists()) {
                        val file = File(targetItem.path)
                        val header = "HTTP/1.1 200 OK\r\n" +
                                "Content-Type: application/octet-stream\r\n" +
                                "Content-Length: ${file.length()}\r\n" +
                                "Content-Disposition: attachment; filename=\"${java.net.URLEncoder.encode(safeName, "UTF-8")}\"\r\n" +
                                "Access-Control-Allow-Origin: *\r\n" +
                                "Connection: close\r\n\r\n"
                        outputStream.write(header.toByteArray(StandardCharsets.UTF_8))
                        FileInputStream(file).use { fis ->
                            val buf = ByteArray(16384)
                            var len: Int
                            while (fis.read(buf).also { len = it } != -1) {
                                outputStream.write(buf, 0, len)
                            }
                        }
                        outputStream.flush()
                        return
                    } else {
                        sendHttpResponse(outputStream, 404, "Not Found", "application/json", """{"error":"File not found"}""".toByteArray(StandardCharsets.UTF_8))
                        return
                    }
                }

                // GET / or /portal or /web: Serve Standalone Web Transfer Portal!
                if ((path == "/" || path == "/portal" || path == "/web" || path == "/index.html") && method == "GET") {
                    val portalHtml = loadPortalHtml()
                    sendHttpResponse(outputStream, 200, "OK", "text/html; charset=utf-8", portalHtml.toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // 404 Not Found
                sendHttpResponse(outputStream, 404, "Not Found", "application/json", """{"error":"Not Found"}""".toByteArray(StandardCharsets.UTF_8))
            } catch (e: Exception) {
                Log.e(tag, "Error handling client: ${e.message}")
            }
        }
    }

    private fun loadPortalHtml(): String {
        try {
            context.assets.open("portal.html").use { stream ->
                return stream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
            }
        } catch (_: Exception) {}

        // Safe in-memory fallback template if asset stream is unavailable
        val localIp = NetworkHelper.getLocalWifiIpv4(context)
        return """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>SafeDrop 极速快传 - 手机直连门户</title><style>body{font-family:sans-serif;background:#0B0F19;color:#F8FAFC;padding:30px 20px;text-align:center;}h1{color:#6366F1;}p{color:#94A3B8;}.card{background:#151D2F;border-radius:16px;padding:24px;max-width:500px;margin:20px auto;border:1px solid rgba(255,255,255,0.1);}button,label{background:#6366F1;color:#fff;padding:12px 24px;border-radius:99px;border:none;font-size:15px;cursor:pointer;display:inline-block;margin:10px 0;}</style></head><body><h1>SafeDrop 极速快传</h1><p>已直连手机设备: $deviceName ($localIp:$port)</p><div class="card"><h3>投送文件到此手机</h3><p style="font-size:13px;margin-bottom:12px;">轻触下方按钮选择文件，直接无线存入手机系统相册与下载目录</p><input type="file" id="f" multiple style="display:none;"><label for="f">选择文件投送</label><div id="p" style="margin-top:12px;font-size:13px;color:#10B981;"></div></div><script>document.getElementById('f').onchange=async(e)=>{const files=Array.from(e.target.files);if(!files.length)return;const p=document.getElementById('p');for(const file of files){p.textContent='正在传输: '+file.name;const CHUNK=1024*1024;const total=Math.ceil(file.size/CHUNK);const taskId='mob_'+Date.now();for(let i=0;i<total;i++){const blob=file.slice(i*CHUNK,Math.min(file.size,(i+1)*CHUNK));await fetch('/api/v1/transfer/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','x-task-id':taskId,'x-file-name':encodeURIComponent(file.name),'x-file-size':file.size.toString(),'x-chunk-index':i.toString(),'x-chunk-count':total.toString()},body:blob});p.textContent='传输中: '+Math.round((i+1)/total*100)+'%';}}p.textContent='全部投送成功！';};</script></body></html>"""
    }

    private fun readBodyString(input: InputStream, length: Int): String {
        if (length <= 0) return ""
        val safeLength = minOf(length, 2 * 1024 * 1024) // Cap at 2MB to prevent DoS/memory exhaustion
        val buffer = ByteArray(minOf(safeLength, 65536))
        var totalRead = 0
        val bout = ByteArrayOutputStream()
        while (totalRead < safeLength) {
            val toRead = minOf(buffer.size, safeLength - totalRead)
            val read = input.read(buffer, 0, toRead)
            if (read == -1) break
            bout.write(buffer, 0, read)
            totalRead += read
        }
        return bout.toString("UTF-8")
    }

    private fun readLine(input: InputStream): String? {
        val bout = ByteArrayOutputStream()
        var c: Int
        while (input.read().also { c = it } != -1) {
            if (c == '\n'.code) break
            if (c != '\r'.code) bout.write(c)
        }
        return if (bout.size() == 0 && c == -1) null else bout.toString("UTF-8")
    }

    private fun sendHttpResponse(out: OutputStream, code: Int, status: String, contentType: String, body: ByteArray) {
        val header = "HTTP/1.1 $code $status\r\n" +
                "Content-Type: $contentType\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type, X-Task-Id, X-Chunk-Index, X-Chunk-Count, X-File-Name, X-File-Size, X-Encrypted, X-Session-Id\r\n" +
                "Connection: close\r\n\r\n"
        out.write(header.toByteArray(StandardCharsets.UTF_8))
        if (body.isNotEmpty()) {
            out.write(body)
        }
        out.flush()
    }
}
