package com.safedrop.mobile.core.network

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.Collections
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference

/**
 * Local Area Network & Wi-Fi Helper
 * Capabilities:
 * 1. Accurately obtains device IPv4 address in current LAN (Wi-Fi, Ethernet, Hotspot).
 * 2. Calculates subnet gateway and network broadcast prefix.
 * 3. Probes and automatically discovers active Desktop Hub on port 8899.
 */
object NetworkHelper {

    /**
     * Get device IPv4 address on current Wi-Fi or LAN connection.
     * Never returns 127.0.0.1 if connected to a valid network interface.
     */
    fun getLocalWifiIpv4(context: Context): String {
        // 1. Try WifiManager connection info
        try {
            val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val ipInt = wifiManager?.connectionInfo?.ipAddress ?: 0
            if (ipInt != 0) {
                val ip = String.format(
                    Locale.US,
                    "%d.%d.%d.%d",
                    ipInt and 0xff,
                    ipInt shr 8 and 0xff,
                    ipInt shr 16 and 0xff,
                    ipInt shr 24 and 0xff
                )
                if (isValidIpv4(ip)) return ip
            }
        } catch (_: Exception) {}

        // 2. Iterate network interfaces (Wi-Fi wlan0, eth0, ap0)
        try {
            val interfaces = Collections.list(NetworkInterface.getNetworkInterfaces())
            // Prioritize Wi-Fi and mobile hotspot interfaces
            interfaces.sortByDescending { iface ->
                when {
                    iface.name.startsWith("wlan") -> 3
                    iface.name.startsWith("ap") -> 2
                    iface.name.startsWith("eth") -> 1
                    else -> 0
                }
            }

            for (iface in interfaces) {
                if (iface.isLoopback || !iface.isUp) continue
                val addresses = Collections.list(iface.inetAddresses)
                for (addr in addresses) {
                    if (!addr.isLoopbackAddress && addr is Inet4Address) {
                        val host = addr.hostAddress ?: continue
                        if (isValidIpv4(host)) {
                            return host
                        }
                    }
                }
            }
        } catch (_: Exception) {}

        return "127.0.0.1"
    }

    /**
     * Get default gateway or subnet base address
     */
    fun getDefaultGateway(context: Context): String {
        try {
            val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val gatewayInt = wifiManager?.dhcpInfo?.gateway ?: 0
            if (gatewayInt != 0) {
                val gw = String.format(
                    Locale.US,
                    "%d.%d.%d.%d",
                    gatewayInt and 0xff,
                    gatewayInt shr 8 and 0xff,
                    gatewayInt shr 16 and 0xff,
                    gatewayInt shr 24 and 0xff
                )
                if (isValidIpv4(gw)) return gw
            }
        } catch (_: Exception) {}

        val localIp = getLocalWifiIpv4(context)
        if (localIp != "127.0.0.1" && localIp.contains(".")) {
            return localIp.substringBeforeLast(".") + ".1"
        }
        return "127.0.0.1"
    }

    /**
     * Get subnet directed broadcast address (e.g. 192.168.10.255)
     */
    fun getSubnetBroadcast(context: Context): String {
        try {
            val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val dhcp = wifiManager?.dhcpInfo
            if (dhcp != null && dhcp.ipAddress != 0 && dhcp.netmask != 0) {
                val broadcast = (dhcp.ipAddress and dhcp.netmask) or (dhcp.netmask.inv())
                val quads = ByteArray(4)
                for (k in 0..3) quads[k] = (broadcast shr (k * 8) and 0xFF).toByte()
                val addr = java.net.InetAddress.getByAddress(quads).hostAddress
                if (!addr.isNullOrEmpty() && isValidIpv4(addr)) return addr
            }
        } catch (_: Exception) {}

        val localIp = getLocalWifiIpv4(context)
        if (localIp != "127.0.0.1" && localIp.contains(".")) {
            return localIp.substringBeforeLast(".") + ".255"
        }
        return "255.255.255.255"
    }

    /**
     * Extract /24 subnet prefix, e.g. "192.168.10." from "192.168.10.42"
     */
    fun getSubnetPrefix(ip: String): String {
        return if (ip.contains(".")) {
            ip.substringBeforeLast(".") + "."
        } else {
            "192.168.1."
        }
    }

    /**
     * Test whether target TCP port is open and listening
     */
    fun testPort(ip: String, port: Int, timeoutMs: Int = 150): Boolean {
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(ip, port), timeoutMs)
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Concurrently probe active subnet to discover ALL SafeDrop nodes on port 8899.
     * Returns list of all responding IP addresses across the local /24 subnet.
     */
    suspend fun probeAllLanNodes(context: Context, port: Int = 8899): List<String> = withContext(Dispatchers.IO) {
        val localIp = getLocalWifiIpv4(context)
        if (localIp == "127.0.0.1" || !localIp.contains(".")) return@withContext emptyList()

        val prefix = getSubnetPrefix(localIp)
        val discoveredNodes = Collections.synchronizedList(mutableListOf<String>())

        coroutineScope {
            for (i in 1..254) {
                val targetIp = "$prefix$i"
                if (targetIp == localIp) continue
                launch {
                    if (testPort(targetIp, port, 120)) {
                        discoveredNodes.add(targetIp)
                    }
                }
            }
        }

        discoveredNodes.toList()
    }

    /**
     * Concurrently probe active subnet to discover Desktop Hub on port 8899.
     * Returns discovered IP address or null if not found.
     */
    suspend fun discoverDesktopHub(context: Context, port: Int = 8899): String? = withContext(Dispatchers.IO) {
        val allNodes = probeAllLanNodes(context, port)
        allNodes.firstOrNull()
    }

    private fun isValidIpv4(ip: String): Boolean {
        if (ip.isBlank() || ip == "0.0.0.0" || ip == "127.0.0.1" || ip.startsWith("169.254")) {
            return false
        }
        val parts = ip.split(".")
        if (parts.size != 4) return false
        return parts.all { it.toIntOrNull() in 0..255 }
    }
}
