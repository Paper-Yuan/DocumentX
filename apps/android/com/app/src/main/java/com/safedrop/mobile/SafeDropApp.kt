package com.safedrop.mobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security

/**
 * SafeDrop Mobile Global Application
 * Handles global initialization:
 * 1. Registers BouncyCastle security provider for modern cryptography (X25519, HKDF-SHA256)
 * 2. Creates foreground service notification channel (Android 8.0+)
 */
class SafeDropApp : Application() {

    companion object {
        const val CHANNEL_TRANSFER_ID = "safedrop_transfer_channel"
        const val CHANNEL_TRANSFER_NAME = "SafeDrop File Transfer"
        lateinit var instance: SafeDropApp
            private set
    }

    override fun onCreate() {
        super.onCreate()
        instance = this

        // 1. Initialize cryptography security provider
        initCryptoProvider()

        // 2. Initialize foreground notification channels (Android 8.0+)
        initNotificationChannels()
    }

    private fun initCryptoProvider() {
        // Ensure BouncyCastle has highest priority for X25519 KeyAgreement
        Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
        Security.insertProviderAt(BouncyCastleProvider(), 1)
    }

    private fun initNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_TRANSFER_ID,
                CHANNEL_TRANSFER_NAME,
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows SafeDrop file transfer progress and transfer speed"
                setShowBadge(false)
                enableVibration(false)
            }

            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }
}
