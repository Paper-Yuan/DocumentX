package com.safedrop.mobile.core.network

import android.content.Context
import android.util.Log
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.nio.charset.StandardCharsets

/**
 * Mobile LAN UDP Discovery Helper
 * Broadcasts Android presence on port 8890 and listens for Desktop Hub beacons.
 */
class UdpDiscoveryHelper(
    private val context: Context,
    private val onDeviceFound: (ip: String, port: Int, name: String, fp: String, devType: String, devId: String) -> Unit
) {
    private val tag = "UdpDiscoveryHelper"
    private val udpPort = 8890
    private var socket: DatagramSocket? = null
    private var isRunning = false
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun start(localServerPort: Int = 8899, deviceId: String = "", fingerprint: String = "") {
        if (isRunning) return
        isRunning = true

        try {
            socket = DatagramSocket(udpPort).apply {
                broadcast = true
                soTimeout = 4000
            }
            Log.i(tag, "UDP discovery listening on port $udpPort")
        } catch (e: Exception) {
            // Port might be in use, fallback to dynamic port for transmission
            try {
                socket = DatagramSocket().apply {
                    broadcast = true
                    soTimeout = 4000
                }
                Log.w(tag, "Fallback UDP socket opened on port ${socket?.localPort}")
            } catch (ex: Exception) {
                Log.e(tag, "Failed to create DatagramSocket: ${ex.message}")
            }
        }

        // 1. Receiver loop: listens for beacons from ALL platforms (PC and other Android phones)
        scope.launch {
            val buffer = ByteArray(2048)
            while (isRunning && socket != null) {
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket?.receive(packet)
                    val text = String(packet.data, 0, packet.length, StandardCharsets.UTF_8)
                    val json = JSONObject(text)
                    if (json.optString("type") == "safedrop_beacon") {
                        val ip = json.optString("ip", packet.address?.hostAddress ?: "")
                        val localIp = NetworkHelper.getLocalWifiIpv4(context)
                        // Ignore own packets
                        if (ip.isNotEmpty() && ip != "127.0.0.1" && ip != localIp) {
                            val devType = json.optString("device_type", json.optString("os", "android")).lowercase()
                            val isPc = devType == "pc" || devType == "windows"
                            val port = json.optInt("port", 8899)
                            val name = json.optString("name", if (isPc) "Desktop Hub ($ip)" else "Android 手机 ($ip)")
                            val fp = json.optString("fingerprint", "")
                            val devId = json.optString("id", if (isPc) "pc-$ip" else "android-$ip")

                            withContext(Dispatchers.Main) {
                                onDeviceFound(ip, port, name, fp, if (isPc) "pc" else "android", devId)
                            }
                        }
                    }
                } catch (_: Exception) {}
            }
        }

        // 2. Periodic broadcast beacon loop (every 3 seconds) with dual-channel broadcast
        scope.launch {
            while (isRunning && socket != null) {
                try {
                    val localIp = NetworkHelper.getLocalWifiIpv4(context)
                    if (localIp != "127.0.0.1") {
                        val devModel = android.os.Build.MODEL ?: "Android"
                        val myDevId = deviceId.ifEmpty { "android-${localIp.replace('.', '-')}" }
                        val myFp = fingerprint.ifEmpty { "ANDR-LAN" }

                        val beaconJson = JSONObject().apply {
                            put("type", "safedrop_beacon")
                            put("id", myDevId)
                            put("device_type", "android")
                            put("os", "android")
                            put("name", "Android $devModel")
                            put("ip", localIp)
                            put("port", localServerPort)
                            put("fingerprint", myFp)
                        }.toString()

                        val bytes = beaconJson.toByteArray(StandardCharsets.UTF_8)

                        // Channel 1: 255.255.255.255
                        val broadcastAddr = InetAddress.getByName("255.255.255.255")
                        val packet = DatagramPacket(bytes, bytes.size, broadcastAddr, udpPort)
                        socket?.send(packet)

                        // Channel 2: Subnet directed broadcast (e.g. 192.168.10.255)
                        val subnetBcast = NetworkHelper.getSubnetBroadcast(context)
                        if (subnetBcast.isNotEmpty() && subnetBcast != "255.255.255.255") {
                            try {
                                val directedAddr = InetAddress.getByName(subnetBcast)
                                socket?.send(DatagramPacket(bytes, bytes.size, directedAddr, udpPort))
                            } catch (_: Exception) {}
                        }
                    }
                } catch (_: Exception) {}
                delay(3000)
            }
        }
    }

    fun stop() {
        isRunning = false
        try {
            socket?.close()
        } catch (_: Exception) {}
        socket = null
        scope.cancel()
    }
}
