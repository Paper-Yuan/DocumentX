package com.safedrop.mobile.ui.share

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.safedrop.mobile.databinding.ActivityShareReceiverBinding
import com.safedrop.mobile.service.TransferForegroundService

/**
 * System Share Sheet Receiver Activity
 * Features:
 * 1. Responds to Android global ACTION_SEND and ACTION_SEND_MULTIPLE intents.
 * 2. Receives file streams shared from third-party apps (photos, file managers, chat apps).
 * 3. Extracts Uri metadata and invokes the foreground transfer service.
 */
class ShareReceiverActivity : AppCompatActivity() {

    private lateinit var binding: ActivityShareReceiverBinding
    private val pendingUris = mutableListOf<Uri>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityShareReceiverBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnCancelShare.setOnClickListener { finish() }

        handleIncomingShareIntent(intent)
    }

    private fun handleIncomingShareIntent(intent: Intent?) {
        if (intent == null) {
            finish()
            return
        }

        when (intent.action) {
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                if (uri != null) pendingUris.add(uri)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                @Suppress("DEPRECATION")
                val uris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                if (uris != null) pendingUris.addAll(uris)
            }
        }

        if (pendingUris.isEmpty()) {
            Toast.makeText(this, "未能获取到有效的分享文件", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        val firstFileName = resolveFileName(pendingUris.first())
        binding.tvShareFileInfo.text = "已选取 ${pendingUris.size} 个文件: $firstFileName"

        // Forward to MainActivity to initiate the streaming upload
        val forwardIntent = Intent(this, com.safedrop.mobile.ui.MainActivity::class.java).apply {
            putParcelableArrayListExtra("EXTRA_SHARED_URIS", ArrayList(pendingUris))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(forwardIntent)
        finish()
    }

    private fun resolveFileName(uri: Uri): String {
        var name = "shared_file.bin"
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (nameIndex != -1 && cursor.moveToFirst()) {
                name = cursor.getString(nameIndex)
            }
        }
        return name
    }
}
