package com.safedrop.mobile.core.network

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log

/**
 * Mobile MulticastLock Lifecycle Manager
 * Purpose:
 * Overcomes Android OS default Wi-Fi chip behavior that drops UDP multicast/broadcast frames to save battery.
 * Power Management Strategy:
 * 1. Calls acquire() only when entering radar discovery screen or active foreground transfer.
 * 2. Calls release() promptly when leaving screen or device goes idle, balancing fast LAN discovery with battery efficiency.
 */
class MulticastLockHelper(context: Context) {

    private val tag = "MulticastLockHelper"
    private val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private var multicastLock: WifiManager.MulticastLock? = null

    init {
        try {
            multicastLock = wifiManager.createMulticastLock("SafeDrop_MulticastLock").apply {
                setReferenceCounted(true)
            }
            Log.d(tag, "MulticastLock initialized successfully")
        } catch (e: Exception) {
            Log.e(tag, "Failed to initialize MulticastLock: ${e.message}")
        }
    }

    /**
     * Acquire multicast lock (called when radar active or transfer in progress)
     */
    @Synchronized
    fun acquire() {
        multicastLock?.let { lock ->
            if (!lock.isHeld) {
                lock.acquire()
                Log.i(tag, "MulticastLock acquired: listening for UDP multicast/broadcast")
            }
        }
    }

    /**
     * Release multicast lock (called when leaving radar or fully idle)
     */
    @Synchronized
    fun release() {
        multicastLock?.let { lock ->
            if (lock.isHeld) {
                lock.release()
                Log.i(tag, "MulticastLock released: Wi-Fi power saving restored")
            }
        }
    }

    /**
     * Query lock status
     */
    fun isHeld(): Boolean {
        return multicastLock?.isHeld ?: false
    }
}
