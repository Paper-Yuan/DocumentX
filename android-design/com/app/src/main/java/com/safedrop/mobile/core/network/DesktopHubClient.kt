package com.safedrop.mobile.core.network

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.InputStream
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Mobile HTTP Communication Client to Desktop Hub
 * Strictly aligned with computer-design/desktop_hub/server.js API definitions:
 * 1. Health check and info retrieval (ping / info)
 * 2. Handshake and out-of-band credential verification (handshake/init, handshake/verify)
 * 3. 1MB chunked streaming upload (transfer/upload)
 * 4. Desktop vault file query and download (files/list, files/download)
 */
class DesktopHubClient {

    private val tag = "DesktopHubClient"
    private val gson = Gson()
    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

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
     * 4. Verify handshake credential (POST /api/v1/handshake/verify)
     */
    suspend fun verifyHandshake(
        host: String,
        port: Int,
        pin: String?,
        token: String?
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = "http://$host:$port/api/v1/handshake/verify"
            val payload = JsonObject().apply {
                if (!pin.isNullOrEmpty()) addProperty("pin", pin)
                if (!token.isNullOrEmpty()) addProperty("token", token)
            }
            val requestBody = payload.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url(url).post(requestBody).build()
            val response = okHttpClient.newCall(request).execute()
            response.isSuccessful
        } catch (e: Exception) {
            Log.e(tag, "Handshake verify failed: ${e.message}")
            false
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
     * 5. 1MB chunked streaming upload (POST /api/v1/transfer/upload)
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
            val encodedFileName = java.net.URLEncoder.encode(fileName, java.nio.charset.StandardCharsets.UTF_8.name()).replace("+", "%20")
            val url = "http://$host:$port/api/v1/transfer/upload"
            val requestBody = chunkData.toRequestBody("application/octet-stream".toMediaType())
            val request = Request.Builder()
                .url(url)
                .header("X-Task-Id", taskId)
                .header("X-File-Name", encodedFileName)
                .header("X-File-Size", fileSize.toString())
                .header("X-Chunk-Index", chunkIndex.toString())
                .header("X-Chunk-Count", chunkCount.toString())
                .post(requestBody)
                .build()

            val response = okHttpClient.newCall(request).execute()
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
            val request = Request.Builder().url(url).get().build()
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
}


