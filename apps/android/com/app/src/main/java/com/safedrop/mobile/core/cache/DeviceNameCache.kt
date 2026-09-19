package com.safedrop.mobile.core.cache

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * Device Name Cache Manager
 * Manages cached device custom names from desktop hub using SharedPreferences
 */
class DeviceNameCache(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences("device_name_cache", Context.MODE_PRIVATE)
    private val gson = Gson()

    companion object {
        private const val KEY_DEVICE_NAMES = "device_names_cache"
        private const val KEY_LAST_UPDATED = "last_updated_timestamp"
        private const val CACHE_VALIDITY_MS = 3600000L // 1 hour
    }

    /**
     * Save device names to cache
     */
    fun saveDeviceNames(names: Map<String, String>) {
        val json = gson.toJson(names)
        prefs.edit()
            .putString(KEY_DEVICE_NAMES, json)
            .putLong(KEY_LAST_UPDATED, System.currentTimeMillis())
            .apply()
    }

    /**
     * Get cached device names
     */
    fun getDeviceNames(): Map<String, String> {
        val json = prefs.getString(KEY_DEVICE_NAMES, null) ?: return emptyMap()
        return try {
            val type = object : TypeToken<Map<String, String>>() {}.type
            gson.fromJson(json, type) ?: emptyMap()
        } catch (e: Exception) {
            emptyMap()
        }
    }

    /**
     * Get custom name for a specific device by fingerprint
     */
    fun getCustomName(fingerprint: String): String? {
        return getDeviceNames()[fingerprint]
    }

    /**
     * Check if cache is still valid
     */
    fun isCacheValid(): Boolean {
        val lastUpdated = prefs.getLong(KEY_LAST_UPDATED, 0L)
        val age = System.currentTimeMillis() - lastUpdated
        return age < CACHE_VALIDITY_MS
    }

    /**
     * Clear all cached device names
     */
    fun clear() {
        prefs.edit().clear().apply()
    }

    /**
     * Get display name with priority: customName > defaultName > fallback
     */
    fun getDisplayName(fingerprint: String, defaultName: String?, fallback: String): String {
        val customName = getCustomName(fingerprint)
        return when {
            !customName.isNullOrEmpty() -> customName
            !defaultName.isNullOrEmpty() -> defaultName
            else -> fallback
        }
    }
}
