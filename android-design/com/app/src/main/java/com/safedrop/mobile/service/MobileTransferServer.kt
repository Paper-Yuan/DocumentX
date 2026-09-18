package com.safedrop.mobile.service

import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Log
import com.safedrop.mobile.core.crypto.CryptoEngine
import com.safedrop.mobile.core.crypto.ProtocolConst
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
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
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

    /** Cap on one request body; also the protocol's own ceiling is never exceeded. */
    private val maxUploadBodyBytes = 8 * 1024 * 1024

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

    /**
     * One chunk already accepted for an in-flight upload: its content digest and byte length.
     * The digest is what makes a retry idempotent instead of duplicated, and the length of the
     * final chunk is what the real file size is computed from.
     */
    private class AcceptedChunk(val digest: ByteArray, val length: Int)

    /**
     * An upload in flight, keyed by task id plus destination name.
     *
     * The phone no longer finalizes a file because "a chunk claiming to be the last one arrived":
     * that decision is made from the authenticated chunk set, so the accounting has to live
     * somewhere. Mirrors `activeTransfers` in computer-design/desktop_hub/server.js.
     */
    private class IncomingTransfer(
        val clientIp: String,
        val partFile: File,
        val count: Int,
        val chunkSize: Int,
        val fileName: String
    ) {
        val received = HashMap<Int, AcceptedChunk>()
        var lastSeen: Long = System.currentTimeMillis()
        var bytesAccepted: Long = 0L
    }

    /** Failures against the pairing handshake, per source IP: a window plus a block, never a counter. */
    private class PairingAttempt(var windowStart: Long, var failures: Int, var blockedUntil: Long)

    private val e2eSessions = mutableMapOf<String, E2eSession>()
    private val activeTransfers = mutableMapOf<String, IncomingTransfer>()
    private val pairingAttempts = mutableMapOf<String, PairingAttempt>()

    /** Guards the transfer map and the positional writes, which one per-chunk request only partly orders. */
    private val transferLock = Any()

    /** A transfer whose sender disappeared; its `.part` is removed once this long passes. */
    private val transferIdleMs = TimeUnit.HOURS.toMillis(1)

    /** How often the sweep runs; the hub's equivalent timer is the GC interval in server.js. */
    private val transferSweepIntervalMs = TimeUnit.MINUTES.toMillis(1)

    /** Only loopback is trusted; it can only come from this device. */
    private fun isTrustedLocal(ip: String?): Boolean {
        val value = ip ?: return false
        return value == "127.0.0.1" || value == "::1" || value.startsWith("127.") || value == "localhost"
    }

    /**
     * RFC1918 addresses, i.e. the ones a browser on the same LAN could be calling from. Loopback
     * is covered by [isTrustedLocal] and link-local is deliberately not accepted here.
     */
    private fun isPrivateLanHost(host: String): Boolean {
        val octets = host.split('.')
        if (octets.size != 4) return false
        val a = octets.map { it.toIntOrNull() ?: return false }
        if (a.any { it < 0 || it > 255 }) return false
        return a[0] == 10 ||
                (a[0] == 172 && a[1] in 16..31) ||
                (a[0] == 192 && a[1] == 168)
    }

    /** A session lives until it goes idle, with an absolute cap on total lifetime. */
    private fun sessionExpired(session: E2eSession, now: Long): Boolean {
        if (now - session.createdAt > ProtocolConst.Session.MAX_TTL_MS) return true
        return now - session.lastSeen > ProtocolConst.Session.IDLE_TTL_MS
    }

    private fun pruneSessions() {
        val now = System.currentTimeMillis()
        for (id in e2eSessions.filter { sessionExpired(it.value, now) }.keys.toList()) {
            e2eSessions.remove(id)
        }
        // A blocked peer stays in the map until its block has run out and its window is stale,
        // otherwise clearing the counts would also clear the penalty.
        for (ip in pairingAttempts.filter {
                       val attempt = it.value
                       now - attempt.windowStart > ProtocolConst.Pairing.FAILURE_WINDOW_MS &&
                               now > attempt.blockedUntil
                   }.keys.toList()) {
            pairingAttempts.remove(ip)
        }
    }

    /** Seconds this IP still has to wait before another pairing attempt, or 0 when it may try. */
    private fun pairingBlockedFor(ip: String): Long {
        val attempt = pairingAttempts[ip] ?: return 0L
        val now = System.currentTimeMillis()
        return if (attempt.blockedUntil > now) {
            TimeUnit.MILLISECONDS.toSeconds(attempt.blockedUntil - now).coerceAtLeast(1L)
        } else 0L
    }

    private fun notePairingFailure(ip: String) {
        val now = System.currentTimeMillis()
        var attempt = pairingAttempts[ip]
        if (attempt == null || now - attempt.windowStart > ProtocolConst.Pairing.FAILURE_WINDOW_MS) {
            attempt = PairingAttempt(now, 0, 0L)
            pairingAttempts[ip] = attempt
        }
        attempt.failures += 1
        if (attempt.failures >= ProtocolConst.Pairing.MAX_FAILURES) {
            attempt.blockedUntil = now + ProtocolConst.Pairing.BLOCK_MS
            attempt.failures = 0
            attempt.windowStart = now
        }
    }

    /** A successful pairing wipes the slate, so a legitimate peer never inherits a penalty. */
    private fun clearPairingFailures(ip: String) {
        pairingAttempts.remove(ip)
    }

    /** Abandoned uploads are removed and their `.part` deleted, mirroring the hub's sweeper. */
    private fun pruneTransfers() {
        val now = System.currentTimeMillis()
        for ((key, task) in activeTransfers.filter { now - it.value.lastSeen > transferIdleMs }) {
            discardTransfer(key, task, "abandoned")
        }
    }

    private fun discardTransfer(key: String, task: IncomingTransfer, why: String) {
        synchronized(transferLock) { activeTransfers.remove(key) }
        if (task.partFile.exists() && !task.partFile.delete()) {
            Log.w(tag, "Could not remove abandoned ${task.partFile.name} ($why)")
        }
    }

    /**
     * Positional write: chunk *i* always lands at `i * chunkSize`, so arrival order stops
     * mattering and a replayed chunk overwrites itself instead of duplicating bytes. `"rw"`
     * creates the file when missing and never truncates, which is what keeps the chunks that
     * arrived before this one.
     */
    private fun writeChunkAtPosition(target: File, payload: ByteArray, position: Long) {
        if (payload.isEmpty()) return
        RandomAccessFile(target, "rw").use { raf ->
            raf.seek(position)
            raf.write(payload)
        }
    }

    /**
     * Per-chunk decompression, mirroring the hub: a sender that compresses gzips each slice before
     * sealing it, so the stride the file is reassembled at is the *uncompressed* slice size.
     *
     * Reading stops at [limit] bytes on purpose. A sealed packet is capped by the request limit,
     * but what it inflates to is only bounded by the decoder, and a 1 MB packet that promises a
     * gigabyte is an attack on this phone's memory rather than a transfer.
     */
    private fun inflateChunk(payload: ByteArray, limit: Int): ByteArray {
        GZIPInputStream(ByteArrayInputStream(payload)).use { gzip ->
            val out = ByteArrayOutputStream(minOf(limit, 64 * 1024))
            val buffer = ByteArray(8192)
            var total = 0
            while (true) {
                val read = gzip.read(buffer)
                if (read == -1) break
                total += read
                if (total > limit) throw IOException("inflated chunk exceeds the $limit-byte stride")
                out.write(buffer, 0, read)
            }
            return out.toByteArray()
        }
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

    private fun sendUnauthorized(outputStream: OutputStream, message: String, allowedOrigin: String?) {
        val body = """{"code":401,"error":"$message"}""".toByteArray(StandardCharsets.UTF_8)
        sendHttpResponse(outputStream, 401, "Unauthorized", "application/json", body, allowedOrigin)
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
    var currentToken: String = newPairingToken()
        private set

    // Every successful handshake rotates the credentials, so a value that is still on screen
    // (or in a QR code already being scanned) goes stale the moment any device pairs. Retired
    // credentials therefore stay accepted for a grace period, and more than one generation is
    // kept: with a single previous slot, a second pairing inside the window evicted the value
    // still displayed on this device and the next peer was rejected even though the user had
    // just read it correctly. The window stays bounded, so this is not an accept-anything path.
    private val pairingGraceMs = ProtocolConst.Pairing.GRACE_MS
    private val pairingGraceGenerations = ProtocolConst.Pairing.GRACE_GENERATIONS
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
        currentToken = newPairingToken()
    }

    /**
     * A six-digit pairing code. Drawn from SecureRandom rather than Math.random(): the code is
     * an authorization factor, and a predictable generator would let an observer who can
     * reconstruct its state anticipate the value the user is about to read off the screen.
     */
    private fun newPairingPin(): String {
        val range = ProtocolConst.Pairing.PIN_MAX_EXCLUSIVE - ProtocolConst.Pairing.PIN_MIN
        return (ProtocolConst.Pairing.PIN_MIN + secureRandom.nextInt(range)).toString()
    }

    /**
     * The QR pairing token: the protocol's byte count rendered as lowercase hex, so it carries
     * the full entropy the field is sized for. A UUID prefix would look just as long while
     * offering fewer distinct values and a '-' inside an alphabet the parser has to allow.
     */
    private fun newPairingToken(): String {
        val raw = ByteArray(ProtocolConst.Pairing.TOKEN_HEX_CHARS / 2)
        secureRandom.nextBytes(raw)
        return cryptoEngine.bytesToHex(raw)
    }

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

        // A sender that disappears leaves no further requests behind, so sweeping only when a chunk
        // arrives would never fire for exactly the transfers the sweep exists to clean up.
        scope.launch {
            while (isRunning) {
                delay(transferSweepIntervalMs)
                synchronized(transferLock) { pruneTransfers() }
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

                // CORS is answered per request and only for a local origin. Replying
                // `Access-Control-Allow-Origin: *` made this phone's vault readable and writable
                // from any page the user happens to open while on the same LAN.
                val allowedOrigin = allowedCorsOrigin(headers["origin"])

                // Local shorthands, so no response on this path can forget the origin it was
                // negotiated with.
                fun respond(code: Int, status: String, contentType: String, body: ByteArray) =
                    sendHttpResponse(outputStream, code, status, contentType, body, allowedOrigin)

                fun reject(code: Int, status: String, message: String) =
                    respond(code, status, "application/json", """{"code":$code,"error":"$message"}"""
                        .toByteArray(StandardCharsets.UTF_8))

                /** Look up a request header by its canonical protocol name. */
                fun header(name: String): String? = headers[name.lowercase()]

                // OPTIONS preflight
                if (method == "OPTIONS") {
                    respond(204, "No Content", "text/plain", ByteArray(0))
                    return
                }

                // GET /api/v1/ping
                if (path == "/api/v1/ping" && method == "GET") {
                    val json = """{"code":0,"server":"SafeDrop Mobile Client","device_name":"$deviceName","device_type":"android","port":$port,"fingerprint":"$fingerprint","os":"android"}"""
                    respond(200, "OK", "application/json", json.toByteArray(StandardCharsets.UTF_8))
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
                            // This portal is served over plain HTTP, where a browser has no
                            // WebCrypto and refuses to pair, so the link is an address only and
                            // never carries the credentials.
                            put("webUrl", "http://$localIp:$port/portal")
                        }
                    }
                    respond(200, "OK", "application/json", infoObj.toString().toByteArray(StandardCharsets.UTF_8))
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
                    if (clientRawPub == null || clientRawPub.size != ProtocolConst.X25519_RAW_LEN_BYTES) {
                        reject(400, "Bad Request", "public_key must be a ${ProtocolConst.X25519_RAW_LEN_BYTES}-byte hex X25519 key")
                        return
                    }

                    pruneSessions()

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
                        put("protocol", ProtocolConst.PROTOCOL)
                        put("session_id", sessionId)
                        put("curve", "x25519")
                        put("server_public_key", sessionRawPubHex)
                        put("pin_required", true)
                        put("fingerprint", fingerprint)
                    }
                    respond(200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/handshake/verify
                // The pairing secret never crosses the wire: the peer proves it derived the same
                // session key by sending an HMAC over the session id.
                if (path == "/api/v1/handshake/verify" && method == "POST") {
                    pruneSessions()
                    val blockedFor = pairingBlockedFor(clientIp)
                    if (blockedFor > 0) {
                        respond(
                            429, "Too Many Requests", "application/json",
                            """{"code":429,"error":"Too many pairing attempts. Try again in ${blockedFor}s.","retry_after_seconds":$blockedFor}"""
                                .toByteArray(StandardCharsets.UTF_8)
                        )
                        return
                    }

                    val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
                    val bodyStr = readBodyString(inputStream, contentLength)
                    val bodyJson = try { JSONObject(bodyStr) } catch (_: Exception) { JSONObject() }
                    val sessionId = bodyJson.optString("session_id", "")
                    val proof = bodyJson.optString("proof", "")

                    val session = e2eSessions[sessionId]
                    if (session == null || session.clientIp != clientIp) {
                        notePairingFailure(clientIp)
                        reject(403, "Forbidden", "Unknown or expired session")
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
                        notePairingFailure(clientIp)
                        reject(403, "Forbidden", "Pairing proof verification failed")
                        return
                    }

                    session.key = matchedKey
                    session.verified = true
                    session.lastSeen = System.currentTimeMillis()
                    clearPairingFailures(clientIp)

                    // Rotate credentials only after a successful pairing.
                    refreshPairingPin()

                    val respObj = JSONObject().apply {
                        put("code", 0)
                        put("status", "verified")
                        put("session_id", sessionId)
                        put("server_proof", cryptoEngine.bytesToHex(cryptoEngine.serverProof(matchedKey, sessionId)))
                        put("message", "Encrypted session established")
                    }
                    respond(200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/pin/refresh
                if (path == "/api/v1/pin/refresh" && method == "POST") {
                    if (!isTrustedLocal(clientIp)) {
                        reject(403, "Forbidden", "Pairing credentials can only be refreshed on the device itself")
                        return
                    }
                    refreshPairingPin()
                    val localIp = NetworkHelper.getLocalWifiIpv4(context)
                    val qrUri = "safedrop://pair?ip=$localIp&port=$port&fp=$fingerprint&token=$currentToken&pin=$currentPin"
                    val webUrl = "http://$localIp:$port/portal"

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
                    respond(200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/transfer/upload
                // Remote senders must be inside a verified session; their chunks are
                // AES-256-GCM sealed and are decrypted here before touching disk. Loopback
                // callers may still post plaintext (local tooling and tests), and that path keeps
                // the simpler append-then-rename behaviour it has always used.
                if (path == "/api/v1/transfer/upload" && method == "POST") {
                    val isLocal = isTrustedLocal(clientIp)
                    val session = getVerifiedSession(header(ProtocolConst.Headers.SESSIONID), clientIp)
                    val isEncrypted = header(ProtocolConst.Headers.ENCRYPTED) == "1"

                    if (!isLocal && session == null) {
                        sendUnauthorized(outputStream, "Encrypted session required. Complete the pairing handshake before uploading.", allowedOrigin)
                        return
                    }
                    // Same rule the hub applies: a paired peer that could opt out of using its key
                    // could also opt out of the authenticated chunk set, and the plaintext branch
                    // below has none of it. This device's own loopback is the exception.
                    if (!isLocal && !isEncrypted) {
                        reject(400, "Bad Request", "Transfers from the LAN must be encrypted (X-Encrypted: 1). Pair first.")
                        return
                    }
                    if (isEncrypted && session?.key == null) {
                        reject(400, "Bad Request", "X-Encrypted was set but no verified session key is available")
                        return
                    }

                    val rawTaskId = header(ProtocolConst.Headers.TASKID) ?: "task_${System.currentTimeMillis()}"
                    val taskId = rawTaskId.replace(Regex("[^a-zA-Z0-9_-]"), "").ifEmpty { "task_${System.currentTimeMillis()}" }
                    val rawFileName = header(ProtocolConst.Headers.FILENAME) ?: "received_file.bin"
                    val fileName = try {
                        URLDecoder.decode(rawFileName, "UTF-8")
                    } catch (_: Exception) {
                        rawFileName
                    }
                    val safeName = storageHelper.sanitizeFileName(fileName)
                    val chunkIndex = header(ProtocolConst.Headers.CHUNKINDEX)?.toIntOrNull() ?: 0
                    val totalChunks = header(ProtocolConst.Headers.CHUNKCOUNT)?.toIntOrNull() ?: 1
                    val chunkSize = header(ProtocolConst.Headers.CHUNKSIZE)?.toIntOrNull() ?: 0
                    val fileSize = header(ProtocolConst.Headers.FILESIZE)?.toLongOrNull() ?: 0L
                    val isCompressed = header(ProtocolConst.Headers.COMPRESSED) == "gzip"
                    val contentLength = headers["content-length"]?.toIntOrNull() ?: -1

                    // Never below the protocol ceiling, and never above the 8 MB this server has
                    // always accepted: the stricter of the two applies.
                    val maxBodyBytes = minOf(
                        maxUploadBodyBytes.toLong(),
                        (ProtocolConst.Chunking.MAX_SEALED_CHUNK_BYTES + ProtocolConst.Chunking.SEALED_OVERHEAD_BYTES).toLong()
                    ).toInt()
                    if (contentLength > maxBodyBytes) {
                        respond(413, "Payload Too Large", "application/json", """{"error":"Chunk size exceeds ${maxBodyBytes}B limit"}""".toByteArray(StandardCharsets.UTF_8))
                        return
                    }

                    val now = System.currentTimeMillis()
                    val staleKeys = taskStartTimeMap.filter { now - it.value > 300000 }.keys.toList()
                    for (k in staleKeys) {
                        taskStartTimeMap.remove(k)
                        taskBytesMap.remove(k)
                    }

                    val partFile = storageHelper.getTempPartFile(taskId, fileName)

                    if (isEncrypted) {
                        receiveEncryptedChunk(
                            inputStream = inputStream,
                            sessionKey = session!!.key!!,
                            clientIp = clientIp,
                            taskId = taskId,
                            fileName = fileName,
                            safeName = safeName,
                            partFile = partFile,
                            chunkIndex = chunkIndex,
                            totalChunks = totalChunks,
                            chunkSize = chunkSize,
                            fileSize = fileSize,
                            contentLength = contentLength,
                            compressed = isCompressed,
                            respond = { code, status, contentType, body -> respond(code, status, contentType, body) }
                        )
                        return
                    }

                    val chunkBuffer = ByteArray(8192)
                    var bytesRemaining = if (contentLength in 1..maxBodyBytes) contentLength else (1024 * 1024)

                    // The plaintext path still keys its progress accounting off the first chunk,
                    // because it has no authenticated chunk set to derive it from.
                    if (chunkIndex == 0) {
                        taskBytesMap[taskId] = 0L
                        taskStartTimeMap[taskId] = now
                    }

                    FileOutputStream(partFile, true).use { fos ->
                        while (bytesRemaining > 0) {
                            val toRead = minOf(chunkBuffer.size, bytesRemaining)
                            val read = inputStream.read(chunkBuffer, 0, toRead)
                            if (read == -1) break
                            fos.write(chunkBuffer, 0, read)
                            bytesRemaining -= read
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
                    respond(200, "OK", "application/json", respJson.toByteArray(StandardCharsets.UTF_8))
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
                    respond(200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // GET /api/v1/files/list
                if (path == "/api/v1/files/list" && method == "GET") {
                    if (!isTrustedLocal(clientIp) && getVerifiedSession(header(ProtocolConst.Headers.SESSIONID), clientIp) == null) {
                        sendUnauthorized(outputStream, "Encrypted session required", allowedOrigin)
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
                    respond(200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // GET /api/v1/files/download/:name
                if (path.startsWith("/api/v1/files/download/") && method == "GET") {
                    if (!isTrustedLocal(clientIp) && getVerifiedSession(header(ProtocolConst.Headers.SESSIONID), clientIp) == null) {
                        sendUnauthorized(outputStream, "Encrypted session required", allowedOrigin)
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
                                corsHeaders(allowedOrigin) +
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
                        respond(404, "Not Found", "application/json", """{"error":"File not found"}""".toByteArray(StandardCharsets.UTF_8))
                        return
                    }
                }

                // GET / or /portal or /web: Serve Standalone Web Transfer Portal!
                if ((path == "/" || path == "/portal" || path == "/web" || path == "/index.html") && method == "GET") {
                    val portalHtml = loadPortalHtml()
                    if (portalHtml == null) {
                        // No fallback page: an upload form that silently stopped encrypting would
                        // look exactly like the real one, and the user cannot tell the difference.
                        respond(
                            500, "Internal Server Error", "application/json",
                            """{"code":500,"error":"Transfer portal unavailable: portal.html could not be loaded from the app bundle. Refusing to serve an unencrypted fallback."}"""
                                .toByteArray(StandardCharsets.UTF_8)
                        )
                        return
                    }
                    respond(200, "OK", "text/html; charset=utf-8", portalHtml.toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // 404 Not Found
                respond(404, "Not Found", "application/json", """{"error":"Not Found"}""".toByteArray(StandardCharsets.UTF_8))
            } catch (e: Exception) {
                Log.e(tag, "Error handling client: ${e.message}")
            }
        }
    }

    /**
     * One authenticated chunk of a transfer destined for this phone.
     *
     * Port of `handleEncryptedChunk` / `writeChunkAtPosition` in
     * computer-design/desktop_hub/server.js, so a phone receiving a transfer enforces exactly what
     * the hub does. The count and the stride travel inside the AAD as well as in the headers, which
     * is what makes the rules below enforceable: a header that nothing authenticates cannot be
     * trusted to decide when a file is finished, and "a chunk claiming to be the last one arrived"
     * used to be the only rule this server had.
     */
    private fun receiveEncryptedChunk(
        inputStream: InputStream,
        sessionKey: SecretKey,
        clientIp: String,
        taskId: String,
        fileName: String,
        safeName: String,
        partFile: File,
        chunkIndex: Int,
        totalChunks: Int,
        chunkSize: Int,
        fileSize: Long,
        contentLength: Int,
        compressed: Boolean,
        respond: (code: Int, status: String, contentType: String, body: ByteArray) -> Unit
    ) {
        fun reject(code: Int, status: String, message: String) {
            Log.w(tag, "Rejected chunk $chunkIndex of $taskId: $message")
            respond(
                code, status, "application/json",
                """{"code":$code,"error":"$message"}""".toByteArray(StandardCharsets.UTF_8)
            )
        }

        fun json(body: JSONObject) =
            respond(200, "OK", "application/json", body.toString().toByteArray(StandardCharsets.UTF_8))

        fun notifyProgress(task: IncomingTransfer) {
            taskBytesMap[taskId] = task.bytesAccepted
            val startTime = taskStartTimeMap[taskId] ?: System.currentTimeMillis()
            val elapsedSec = (System.currentTimeMillis() - startTime) / 1000f
            val speedMbps = if (elapsedSec > 0) (task.bytesAccepted / (1024f * 1024f)) / elapsedSec else 0f
            val progress = if (fileSize > 0) {
                ((task.bytesAccepted * 100) / fileSize).toInt().coerceIn(0, 100)
            } else {
                (task.received.size * 100 / totalChunks).coerceIn(0, 100)
            }
            onProgress(taskId, fileName, progress, speedMbps)
        }

        fun respondProgress(task: IncomingTransfer) {
            notifyProgress(task)
            json(JSONObject().apply {
                put("code", 0)
                put("chunk_index", chunkIndex)
                put("total_chunks", totalChunks)
                put("chunks_received", task.received.size)
                put("status", "chunk_received")
                put("compressed", compressed)
                put("encrypted", true)
            })
        }

        // Indices are validated against count and are unique in this map, so a full map can only
        // hold 0..count-1 - which is what makes the size computed below trustworthy.
        fun completeTransfer(key: String, task: IncomingTransfer) {
            val lastEntry = task.received[task.count - 1]
                ?: return reject(409, "Conflict", "Transfer bookkeeping is inconsistent; the file was not saved")
            val derivedSize = (task.count - 1L) * task.chunkSize + lastEntry.length
            if (fileSize > 0 && fileSize != derivedSize) {
                discardTransfer(key, task, "size mismatch")
                taskBytesMap.remove(taskId)
                taskStartTimeMap.remove(taskId)
                return reject(
                    400, "Bad Request",
                    "Declared file size $fileSize does not match the $derivedSize bytes that arrived"
                )
            }

            // A positional write only guarantees the bytes it wrote. If a .part left by an earlier,
            // interrupted attempt at the same task id is longer than this transfer, its stale tail
            // would be committed along with the reassembled chunks.
            try {
                RandomAccessFile(task.partFile, "rw").use { it.setLength(derivedSize) }
            } catch (e: Exception) {
                discardTransfer(key, task, "truncate failed")
                return reject(507, "Insufficient Storage", "Failed to finalize $fileName: ${e.message}")
            }

            val uri = try {
                storageHelper.finalizeReceivedFile(taskId, fileName)
            } catch (e: Exception) {
                Log.w(tag, "Finalize failed for $taskId: ${e.message}")
                null
            }
            // A 0-byte transfer has nothing for the storage layer to commit, so it completes with
            // no uri; anything else that comes back null is a real failure and must not be
            // reported as a saved file.
            if (uri == null && derivedSize > 0) {
                discardTransfer(key, task, "finalize failed")
                return reject(500, "Internal Server Error", "Failed to finalize the received file")
            }

            synchronized(transferLock) { activeTransfers.remove(key) }
            taskBytesMap.remove(taskId)
            taskStartTimeMap.remove(taskId)
            notifyProgress(task)
            onCompleted(taskId, fileName, uri)
            json(JSONObject().apply {
                put("code", 0)
                put("chunk_index", chunkIndex)
                put("total_chunks", totalChunks)
                put("chunks_received", task.count)
                put("status", "completed")
                put("compressed", compressed)
                put("encrypted", true)
                put("file_size", derivedSize)
            })
        }

        // 1. Geometry, checked before anything else and with the same bounds the seal uses.
        try {
            cryptoEngine.chunkAad(taskId, chunkIndex, totalChunks, chunkSize)
        } catch (e: Exception) {
            return reject(400, "Bad Request", "Invalid chunk geometry: ${e.message}")
        }

        // 2. The body is read outside the lock; everything that mutates a shared .part is inside.
        val packet = ByteArray(if (contentLength > 0) contentLength else 0)
        if (packet.isNotEmpty()) {
            var read = 0
            while (read < packet.size) {
                val r = inputStream.read(packet, read, packet.size - read)
                if (r == -1) break
                read += r
            }
            if (read < packet.size) {
                return reject(400, "Bad Request", "Upload stream ended after $read of ${packet.size} bytes")
            }
        }

        val key = "$taskId|$safeName"
        synchronized(transferLock) {
            pruneTransfers()
            val existing = activeTransfers[key]
            val task = if (existing == null) {
                IncomingTransfer(clientIp, partFile, totalChunks, chunkSize, fileName).also {
                    activeTransfers[key] = it
                    taskStartTimeMap[taskId] = it.lastSeen
                }
            } else {
                // 3. A task id names one transfer. A second peer reusing it, or one peer changing
                //    the geometry mid-flight, would both yield a file that is nobody's, so both
                //    are refused instead of reconciled.
                if (existing.clientIp != clientIp) {
                    return reject(409, "Conflict", "That task id is already in use by another peer")
                }
                if (existing.count != totalChunks || existing.chunkSize != chunkSize) {
                    return reject(409, "Conflict", "Chunk geometry changed mid-transfer; the task must be restarted")
                }
                existing.lastSeen = System.currentTimeMillis()
                existing
            }

            // 4. Opening the packet is what authenticates the headers: a rewritten count or
            //    stride, a chunk moved to another task, or edited ciphertext all fail the tag.
            val decrypted = try {
                cryptoEngine.decryptChunk(packet, sessionKey, taskId, chunkIndex, task.count, task.chunkSize)
            } catch (e: Exception) {
                return reject(400, "Bad Request", "Chunk rejected: ${e.message}")
            }
            // Decompression happens after the tag check and before the length check: the stride
            // this index is written at is the sender's uncompressed slice size.
            val plaintext = if (!compressed) decrypted else try {
                inflateChunk(decrypted, task.chunkSize)
            } catch (e: Exception) {
                return reject(400, "Bad Request", "Decompression failed: ${e.message}")
            }

            // 5. Only the final chunk may be short; every earlier one defines the stride the file
            //    is reassembled at, so a short middle chunk means the sender lied about geometry.
            val isLast = chunkIndex == task.count - 1
            if (plaintext.size > task.chunkSize || (!isLast && plaintext.size != task.chunkSize)) {
                return reject(
                    400, "Bad Request",
                    "Chunk $chunkIndex must carry ${if (isLast) "at most ${task.chunkSize}" else "exactly ${task.chunkSize}"} bytes, got ${plaintext.size}"
                )
            }

            val digest = MessageDigest.getInstance("SHA-256").digest(plaintext)
            val seen = task.received[chunkIndex]
            if (seen != null) {
                // 6. A byte-identical resend is answered as if it worked, because it did and the
                //    file on disk is unchanged: that is what makes a client retry safe. Different
                //    bytes under the same index cannot both be true, so that is a conflict.
                if (seen.length == plaintext.size && MessageDigest.isEqual(seen.digest, digest)) {
                    return respondProgress(task)
                }
                return reject(409, "Conflict", "Chunk $chunkIndex was already sent with different content")
            }

            // 7. Positional write, then completeness. Arrival order no longer matters and a
            //    replayed chunk overwrites itself rather than duplicating bytes.
            try {
                writeChunkAtPosition(task.partFile, plaintext, chunkIndex.toLong() * task.chunkSize)
            } catch (e: Exception) {
                discardTransfer(key, task, "write failed")
                return reject(507, "Insufficient Storage", "Failed to store chunk $chunkIndex: ${e.message}")
            }
            task.received[chunkIndex] = AcceptedChunk(digest, plaintext.size)
            task.bytesAccepted += plaintext.size

            if (task.received.size < task.count) return respondProgress(task)
            completeTransfer(key, task)
        }
    }

    /**
     * The bundled portal page, or null when the asset cannot be read.
     *
     * There used to be a hand-written copy of the page here for exactly that case, and it carried
     * an upload script with no crypto in it at all: a packaging slip or a corrupted asset turned
     * the "encrypted transfer" page into a plaintext one without any visible difference. Failing
     * the request is the only safe answer - this project prefers a transfer that refuses to start
     * over one that quietly stops being encrypted.
     */
    private fun loadPortalHtml(): String? {
        return try {
            context.assets.open("portal.html").use { stream ->
                stream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
            }
        } catch (e: Exception) {
            Log.e(tag, "Could not load portal.html from assets: ${e.message}")
            null
        }
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

    /**
     * Request headers a browser may send. Spelled out of [ProtocolConst.Headers] rather than typed
     * by hand, because this list is exactly where a new chunk header used to be forgotten - and a
     * header missing here fails in the browser, not in the server, which makes it hard to trace.
     */
    private val corsAllowHeaders = listOf(
        "Content-Type",
        ProtocolConst.Headers.TASKID,
        ProtocolConst.Headers.FILENAME,
        ProtocolConst.Headers.FILESIZE,
        ProtocolConst.Headers.CHUNKINDEX,
        ProtocolConst.Headers.CHUNKCOUNT,
        ProtocolConst.Headers.CHUNKSIZE,
        ProtocolConst.Headers.ENCRYPTED,
        ProtocolConst.Headers.COMPRESSED,
        ProtocolConst.Headers.ORIGINALSIZE,
        ProtocolConst.Headers.SESSIONID,
        ProtocolConst.Headers.TARGETIP,
        ProtocolConst.Headers.TARGETPORT,
        ProtocolConst.Headers.TARGETNAME,
        ProtocolConst.Headers.TARGETSESSIONID
    ).joinToString(", ")

    /**
     * Echo the caller's origin, but only when it is a page on this machine's own loopback or LAN
     * address. This server's UI is always loaded from one of those, so a wildcard bought nothing
     * except the ability for any site visited on the same network to read the vault.
     */
    private fun allowedCorsOrigin(origin: String?): String? {
        if (origin.isNullOrEmpty()) return null
        val authority = origin.substringAfter("://", "").ifEmpty { return null }
        var host = authority.substringBefore('/').substringBefore('?')
        host = if (host.startsWith("[")) {
            host.removePrefix("[").substringBefore(']')
        } else {
            host.substringBefore(':')
        }
        return if (isTrustedLocal(host) || isPrivateLanHost(host)) origin else null
    }

    /** CORS headers for one request; empty when the caller's origin is not a local one. */
    private fun corsHeaders(allowedOrigin: String?): String {
        if (allowedOrigin == null) return ""
        return "Access-Control-Allow-Origin: $allowedOrigin\r\n" +
                "Vary: Origin\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: $corsAllowHeaders\r\n"
    }

    private fun sendHttpResponse(
        out: OutputStream,
        code: Int,
        status: String,
        contentType: String,
        body: ByteArray,
        allowedOrigin: String?
    ) {
        val header = "HTTP/1.1 $code $status\r\n" +
                "Content-Type: $contentType\r\n" +
                "Content-Length: ${body.size}\r\n" +
                corsHeaders(allowedOrigin) +
                "Connection: close\r\n\r\n"
        out.write(header.toByteArray(StandardCharsets.UTF_8))
        if (body.isNotEmpty()) {
            out.write(body)
        }
        out.flush()
    }
}
