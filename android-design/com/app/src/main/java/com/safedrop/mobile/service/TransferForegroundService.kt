package com.safedrop.mobile.service

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import com.safedrop.mobile.R
import com.safedrop.mobile.SafeDropApp
import com.safedrop.mobile.ui.MainActivity

/**
 * Mobile Foreground Transfer Service
 * Features:
 * 1. Declares foregroundServiceType="dataSync" to guard against Android Low Memory Killer (LMK).
 * 2. Dynamically updates notification progress bar, transfer speed (MB/s), and filename.
 * 3. Provides "Cancel" action intent response.
 * 4. Triggers haptic feedback upon transfer completion and releases foreground state.
 */
class TransferForegroundService : Service() {

    companion object {
        const val NOTIFICATION_ID = 8899
        const val ACTION_START_TRANSFER = "com.safedrop.action.START_TRANSFER"
        const val ACTION_UPDATE_PROGRESS = "com.safedrop.action.UPDATE_PROGRESS"
        const val ACTION_FINISH_TRANSFER = "com.safedrop.action.FINISH_TRANSFER"
        const val ACTION_CANCEL_TRANSFER = "com.safedrop.action.CANCEL_TRANSFER"

        const val EXTRA_FILE_NAME = "extra_file_name"
        const val EXTRA_PROGRESS = "extra_progress"
        const val EXTRA_SPEED_MBPS = "extra_speed"

        fun startTransfer(context: Context, fileName: String) {
            val intent = Intent(context, TransferForegroundService::class.java).apply {
                action = ACTION_START_TRANSFER
                putExtra(EXTRA_FILE_NAME, fileName)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun updateProgress(context: Context, fileName: String, progress: Int, speedMbps: Float) {
            val intent = Intent(context, TransferForegroundService::class.java).apply {
                action = ACTION_UPDATE_PROGRESS
                putExtra(EXTRA_FILE_NAME, fileName)
                putExtra(EXTRA_PROGRESS, progress)
                putExtra(EXTRA_SPEED_MBPS, speedMbps)
            }
            context.startService(intent)
        }

        fun finishTransfer(context: Context, fileName: String) {
            val intent = Intent(context, TransferForegroundService::class.java).apply {
                action = ACTION_FINISH_TRANSFER
                putExtra(EXTRA_FILE_NAME, fileName)
            }
            context.startService(intent)
        }
    }

    private var currentFileName = "file"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_TRANSFER -> {
                currentFileName = intent.getStringExtra(EXTRA_FILE_NAME) ?: "transferring"
                val notification = buildNotification(currentFileName, 0, 0f)
                startForeground(NOTIFICATION_ID, notification)
            }
            ACTION_UPDATE_PROGRESS -> {
                val progress = intent.getIntExtra(EXTRA_PROGRESS, 0)
                val speed = intent.getFloatExtra(EXTRA_SPEED_MBPS, 0f)
                val name = intent.getStringExtra(EXTRA_FILE_NAME) ?: currentFileName
                val notification = buildNotification(name, progress, speed)
                val manager = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                manager.notify(NOTIFICATION_ID, notification)
            }
            ACTION_FINISH_TRANSFER -> {
                triggerHapticFeedback()
                val manager = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                val completeNotification = NotificationCompat.Builder(this, SafeDropApp.CHANNEL_TRANSFER_ID)
                    .setSmallIcon(R.drawable.ic_download)
                    .setContentTitle("SafeDrop 传输完成")
                    .setContentText("文件已安全存入系统沙箱")
                    .setAutoCancel(true)
                    .build()
                manager.notify(NOTIFICATION_ID + 1, completeNotification)
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            ACTION_CANCEL_TRANSFER -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(fileName: String, progress: Int, speed: Float): android.app.Notification {
        val clickIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, clickIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val cancelIntent = Intent(this, TransferForegroundService::class.java).apply {
            action = ACTION_CANCEL_TRANSFER
        }
        val cancelPendingIntent = PendingIntent.getService(
            this, 1, cancelIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val speedText = "%.1f MB/s".format(speed)
        return NotificationCompat.Builder(this, SafeDropApp.CHANNEL_TRANSFER_ID)
            .setSmallIcon(R.drawable.ic_send)
            .setContentTitle("SafeDrop 安全快传中")
            .setContentText("$fileName • $speedText ($progress%)")
            .setProgress(100, progress, false)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .addAction(R.drawable.ic_launcher, "取消传输", cancelPendingIntent)
            .build()
    }

    private fun triggerHapticFeedback() {
        try {
            val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(120, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(120)
            }
        } catch (_: Exception) {}
    }
}
