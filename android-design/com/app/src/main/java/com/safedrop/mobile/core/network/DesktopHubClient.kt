package com.safedrop.mobile.core.network

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.safedrop.mobile.core.crypto.CryptoEngine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.InputStream
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import javax.crypto.SecretKey

/**
 * Mobile HTTP Communication Client to Desktop Hub.
 * Aligned with computer-design/desktop_hub/server.js API definitions:
 * 1. Health check and info retrieval (ping / info)
 * 2. Ephemeral ECDH handshake with an HMAC proof (handshake/init, handshake/verify)
 * 3. Encrypted chunked upload (transfer/upload)
 * 4. Desktop vault file query and download (files/list, files/download)
 *
 * Once [setSession] has been called, requests carry X-Session-Id and upload payloads are
 * sealed with AES-256-GCM. The hub rejects remote uploads that are not inside a session.
 */
class DesktopHubClient {

    private val tag = "DesktopHubClient"
    private val gson = Gson()
    private val cryptoEngine = CryptoEngine()
    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    @Volatile
    private var sessionId: String? = null

    @Volatile
    private var sessionKey: SecretKey? = null

    /** Record the verified session so subsequent calls can be authenticated and encrypted. */
    fun setSession(id: String, key: SecretKey) {
        sessionId = id
        sessionKey = key
    }

    fun clearSession() {
        sessionId = null
        sessionKey = null
    }

    fun hasSession(): Boolean = sessionId != null && sessionKey != null

    private fun Request.Builder.withSession(): Request.Builder {
        sessionId?.let { header("X-Session-Id", it) }
        return this
    }

    /**
     * 1. Health check ping endpoint
     */
    suspend fun ping(host: String, port: Int): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = "http://$host:$port/api/v1/ping"
            val request = Request.Builder().url(url).get().build()
            val response = okHttpClient.newCall(request).execute()
            response.isSuccessful
        } catch (e: Exception) {
            Log.w(tag, "Ping failed: ${e.message}")
            false
        }
    }

    /**
     * 2. Fetch desktop hub system info
     */
    suspend fun fetchHubInfo(host: String, port: Int): JsonObject? = withContext(Dispatchers.IO) {
        try {
            val url = "http://$host:$port/api/v1/info"
            val request = Request.Builder().url(url).get().build()
            val response = okHttpClient.newCall(request).execute()
            if (response.isSuccessful) {
                val body = response.body?.string()
                gson.fromJson(body, JsonObject::class.java)
            } else null
        } catch (e: Exception) {
            Log.e(tag, "Failed to fetch hub info: ${e.message}")
            null
        }
    }

    /**
     * 3. Initiate handshake (POST /api/v1/handshake/init)
     * Sends our ephemeral public key and gets back the hub's public key plus a session id.
     */
    suspend fun initHandshake(
        host: String,
        port: Int,
        clientRawPubKeyHex: String
    ): JsonObject? = withContext(Dispatchers.IO) {
        try {
            val url = "http://$host:$port/api/v1/handshake/init"
            val payload = JsonObject().apply {
                addProperty("public_key", clientRawPubKeyHex)
                addProperty("curve", "x25519")
                addProperty("os", "android")
                addProperty("device_name", "SafeDrop Android Mobile")
            }
            val requestBody = payload.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = okHttpClient.newCall(request).execute()
            if (response.isSuccessful) {
                val body = response.body?.string()
                gson.fromJson(body, JsonObject::class.java)
            } else null
        } catch (e: Exception) {
            Log.e(tag, "Handshake init failed: ${e.message}")
            null
        }
    }

    /**
     * 4. Prove possession of the pairing secret (POST /api/v1/handshake/verify).
     *
     * The PIN / token is never transmitted: the caller derives the session key locally from
     * the ECDH secret and the pairing secret, then sends an HMAC proof. On success the hub
     * returns its own proof, which the caller should check before trusting the session.
     */
    suspend fun verifyHandshake(
        host: String,
        port: Int,
        sessionId: String,
        proofHex: String
    ): JsonObject? = withContext(Dispatchers.IO) {
        try {
            val url = "http://$host:$port/api/v1/handshake/verify"
            val payload = JsonObject().apply {
                addProperty("session_id", sessionId)
                addProperty("proof", proofHex)
            }
            val requestBody = payload.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = okHttpClient.newCall(request).execute()
            if (response.isSuccessful) {
                val body = response.body?.string()
                gson.fromJson(body, JsonObject::class.java)
            } else {
                Log.w(tag, "Handshake verify rejected: HTTP ${response.code}")
                null
            }
        } catch (e: Exception) {
            Log.e(tag, "Handshake verify failed: ${e.message}")
            null
        }
    }

    /**
     * 4.1 Refresh dynamic pairing PIN (POST /api/v1/pin/refresh)
     */
    suspend fun refreshPin(host: String, port: Int): JsonObject? = withContext(Dispatchers.IO) {
        try {
            val url = "http://$host:$port/api/v1/pin/refresh"
            val requestBody = "{}".toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = okHttpClient.newCall(request).execute()
            if (response.isSuccessful) {
                val body = response.body?.string()
                gson.fromJson(body, JsonObject::class.java)
            } else null
        } catch (e: Exception) {
            Log.w(tag, "Failed to refresh PIN: ${e.message}")
            null
        }
    }

    /**
     * 5. Encrypted chunked upload (POST /api/v1/transfer/upload).
     *
     * Seals the chunk with AES-256-GCM using the session key when a session is present, and
     * marks the request with X-Encrypted. The hub refuses unencrypted uploads from the LAN,
     * so a missing session fails loudly instead of silently sending plaintext.
     */
    suspend fun uploadChunk(
        host: String,
        port: Int,
        taskId: String,
        fileName: String,
        fileSize: Long,
        chunkIndex: Int,
        chunkCount: Int,
        chunkData: ByteArray
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val key = sessionKey
            if (key == null) {
                Log.e(tag, "Refusing to upload chunk [$chunkIndex/$chunkCount]: no session key")
                return@withContext false
            }

            val encodedFileName = java.net.URLEncoder.encode(fileName, java.nio.charset.StandardCharsets.UTF_8.name()).replace("+", "%20")
            val sealedChunk = cryptoEngine.encryptChunk(chunkData, key, taskId, chunkIndex)
            val url = "http://$host:$port/api/v1/transfer/upload"
            val requestBody = sealedChunk.toRequestBody("application/octet-stream".toMediaType())
            val request = Request.Builder()
                .url(url)
                .header("X-Task-Id", taskId)
                .header("X-File-Name", encodedFileName)
                .header("X-File-Size", fileSize.toString())
                .header("X-Chunk-Index", chunkIndex.toString())
                .header("X-Chunk-Count", chunkCount.toString())
                .header("X-Encrypted", "1")
                .withSession()
                .post(requestBody)
                .build()

            val response = okHttpClient.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.w(tag, "Chunk upload rejected [$chunkIndex/$chunkCount]: HTTP ${response.code} ${response.body?.string()}")
            }
            response.isSuccessful
        } catch (e: Exception) {
            Log.e(tag, "Chunk upload failed [$chunkIndex/$chunkCount]: ${e.message}")
            false
        }
    }

    /**
     * 6. Download file stream from desktop hub (GET /api/v1/files/download/:name)
     */
    suspend fun downloadFileStream(
        host: String,
        port: Int,
        fileName: String
    ): ResponseBody? = withContext(Dispatchers.IO) {
        try {
            val encodedName = java.net.URLEncoder.encode(fileName, java.nio.charset.StandardCharsets.UTF_8.name()).replace("+", "%20")
            val url = "http://$host:$port/api/v1/files/download/$encodedName"
            val request = Request.Builder().url(url).withSession().get().build()
            val response = okHttpClient.newCall(request).execute()
            if (response.isSuccessful) response.body else null
        } catch (e: Exception) {
            Log.e(tag, "Download file stream failed: ${e.message}")
            null
        }
    }

    /**
     * 7. Announce mobile device presence to Desktop Hub (POST /api/v1/devices/announce)
     */
    suspend fun announceDevice(
        host: String,
        port: Int,
        deviceName: String,
        fingerprint: String,
        mobilePort: Int = 8899
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = "http://$host:$port/api/v1/devices/announce"
            val payload = JsonObject().apply {
                addProperty("name", deviceName)
                addProperty("fingerprint", fingerprint)
                addProperty("os", "android")
                addProperty("port", mobilePort)
            }
            val requestBody = payload.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = okHttpClient.newCall(request).execute()
            response.isSuccessful
        } catch (e: Exception) {
            Log.w(tag, "Device announce failed: ${e.message}")
            false
        }
    }

    /**
     * 8. Send instant message to peer (POST /api/v1/message/send)
     */
    suspend fun sendInstantMessage(
        host: String,
        port: Int,
        text: String,
        senderId: String,
        senderName: String,
        targetId: String = "",
        senderIp: String = ""
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = "http://$host:$port/api/v1/message/send"
            val payload = JsonObject().apply {
                addProperty("text", text)
                addProperty("senderId", senderId)
                addProperty("senderName", senderName)
                addProperty("targetId", targetId)
                addProperty("senderIp", senderIp)
                addProperty("timestamp", System.currentTimeMillis())
            }
            val requestBody = payload.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = okHttpClient.newCall(request).execute()
            response.isSuccessful
        } catch (e: Exception) {
            Log.w(tag, "Send message failed: ${e.message}")
            false
        }
    }

    /**
     * 9. Fetch device custom names from desktop (GET /api/v1/devices/names)
     */
    suspend fun fetchDeviceNames(host: String, port: Int): Map<String, String>? = withContext(Dispatchers.IO) {
        try {
            val url = "http://$host:$port/api/v1/devices/names"
            val request = Request.Builder().url(url).withSession().get().build()
            val response = okHttpClient.newCall(request).execute()
            if (response.isSuccessful) {
                val body = response.body?.string()
                val jsonObj = gson.fromJson(body, JsonObject::class.java)
                if (jsonObj != null && jsonObj.has("deviceNames")) {
                    val deviceNamesObj = jsonObj.getAsJsonObject("deviceNames")
                    val result = mutableMapOf<String, String>()
                    for (key in deviceNamesObj.keySet()) {
                        result[key] = deviceNamesObj.get(key).asString
                    }
                    return@withContext result
                }
            }
            null
        } catch (e: Exception) {
            Log.w(tag, "Fetch device names failed: ${e.message}")
            null
        }
    }
}


