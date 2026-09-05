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
import java.util.UUID

/**
 * Embedded lightweight HTTP server running on Android.
 * Features:
 * 1. P2P Handshake & Key Exchange (init / verify / pin refresh)
 * 2. 1MB Chunked Streaming Upload receiver
 * 3. Vault file listing & download stream
 * 4. Standalone Web File Transfer Portal (/portal & /) for browser direct transfer
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
    var currentPin: String = (100000 + (Math.random() * 900000).toInt()).toString()
        private set
    var currentToken: String = UUID.randomUUID().toString().substring(0, 12)
        private set

    fun refreshPairingPin(): Pair<String, String> {
        currentPin = (100000 + (Math.random() * 900000).toInt()).toString()
        currentToken = UUID.randomUUID().toString().substring(0, 12)
        return Pair(currentPin, currentToken)
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
                if (path == "/api/v1/info" && method == "GET") {
                    val localIp = NetworkHelper.getLocalWifiIpv4(context)
                    val qrUri = "safedrop://pair?ip=$localIp&port=$port&fp=$fingerprint&token=$currentToken&pin=$currentPin"
                    val webUrl = "http://$localIp:$port/portal?pin=$currentPin&token=$currentToken&fp=$fingerprint"

                    val infoObj = JSONObject().apply {
                        put("code", 0)
                        put("name", deviceName)
                        put("device_name", deviceName)
                        put("device_type", "android")
                        put("os", "android")
                        put("localIp", localIp)
                        put("port", port)
                        put("fingerprint", fingerprint)
                        put("pin", currentPin)
                        put("token", currentToken)
                        put("qrUri", qrUri)
                        put("webUrl", webUrl)
                        put("host", JSONObject().apply {
                            put("id", deviceId)
                            put("name", deviceName)
                            put("ip", localIp)
                            put("port", port)
                            put("fingerprint", fingerprint)
                            put("os", "android")
                        })
                    }
                    sendHttpResponse(outputStream, 200, "OK", "application/json", infoObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/handshake/init
                if (path == "/api/v1/handshake/init" && method == "POST") {
                    val sessionId = "sess_${System.currentTimeMillis()}_${(1000..9999).random()}"
                    val respObj = JSONObject().apply {
                        put("code", 0)
                        put("session_id", sessionId)
                        put("server_public_key", rawPubKeyHex)
                        put("pin_required", true)
                        put("fingerprint", fingerprint)
                    }
                    sendHttpResponse(outputStream, 200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    return
                }

                // POST /api/v1/handshake/verify
                if (path == "/api/v1/handshake/verify" && method == "POST") {
                    val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
                    val bodyStr = readBodyString(inputStream, contentLength)
                    val bodyJson = try { JSONObject(bodyStr) } catch (_: Exception) { JSONObject() }
                    val pin = bodyJson.optString("pin", "")
                    val token = bodyJson.optString("token", "")

                    if ((pin.isNotEmpty() && pin == currentPin) || (token.isNotEmpty() && token == currentToken)) {
                        // Success: Rotate credentials for subsequent pairing sessions
                        refreshPairingPin()
                        val respObj = JSONObject().apply {
                            put("code", 0)
                            put("status", "verified")
                            put("message", "Trust established successfully")
                        }
                        sendHttpResponse(outputStream, 200, "OK", "application/json", respObj.toString().toByteArray(StandardCharsets.UTF_8))
                    } else {
                        val errObj = JSONObject().apply {
                            put("code", 403)
                            put("error", "PIN or token verification failed")
                        }
                        sendHttpResponse(outputStream, 403, "Forbidden", "application/json", errObj.toString().toByteArray(StandardCharsets.UTF_8))
                    }
                    return
                }

                // POST /api/v1/pin/refresh
                if (path == "/api/v1/pin/refresh" && method == "POST") {
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

                // POST /api/v1/transfer/upload (1MB chunked streaming upload)
                if (path == "/api/v1/transfer/upload" && method == "POST") {
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
                "Access-Control-Allow-Headers: Content-Type, X-Task-Id, X-Chunk-Index, X-Chunk-Count, X-File-Name, X-File-Size\r\n" +
                "Connection: close\r\n\r\n"
        out.write(header.toByteArray(StandardCharsets.UTF_8))
        if (body.isNotEmpty()) {
            out.write(body)
        }
        out.flush()
    }
}
