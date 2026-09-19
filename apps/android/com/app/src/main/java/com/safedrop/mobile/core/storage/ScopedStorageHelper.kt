package com.safedrop.mobile.core.storage

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/**
 * Android 10+ Scoped Storage Compliance Helper
 * Key compliance features:
 * 1. Media files (JPG/PNG/MP4): Written via MediaStore API, immediate gallery indexing.
 * 2. Documents (ZIP/PDF/APK): Written to system public Download/SafeDrop/ directory.
 * 3. Path traversal defense and auto-increment renaming to avoid collisions.
 * 4. Eliminates the need for high-risk MANAGE_EXTERNAL_STORAGE permission.
 */
class ScopedStorageHelper(private val context: Context) {

    private val tag = "ScopedStorageHelper"

    /**
     * Sanitize input filename against path traversal attacks
     */
    fun sanitizeFileName(inputName: String): String {
        var safe = File(inputName).name
        // Replace illegal filesystem characters
        safe = safe.replace(Regex("[\\\\/:*?\"<>|]"), "_")
        // Strip relative traversal symbols
        safe = safe.replace("..", "").trim()
        if (safe.isEmpty() || safe == "." || safe == "..") {
            safe = "safedrop_${System.currentTimeMillis()}.bin"
        }
        return safe
    }

    /**
     * Determine if filename belongs to media formats
     */
    fun isMediaFile(fileName: String): Boolean {
        val lower = fileName.lowercase()
        return lower.endsWith(".jpg") || lower.endsWith(".jpeg") ||
                lower.endsWith(".png") || lower.endsWith(".webp") ||
                lower.endsWith(".mp4") || lower.endsWith(".mkv") ||
                lower.endsWith(".mp3") || lower.endsWith(".wav")
    }

    /**
     * Write decrypted stream to scoped storage
     * Returns Uri or local file path
     */
    fun saveReceivedFile(
        fileName: String,
        mimeType: String?,
        inputStream: InputStream
    ): Uri? {
        val safeName = sanitizeFileName(fileName)
        val resolver = context.contentResolver

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Android 10+ Scoped Storage pipeline
            val contentValues = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType ?: "application/octet-stream")
                if (isMediaFile(safeName)) {
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/SafeDrop")
                } else {
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SafeDrop")
                }
                put(MediaStore.MediaColumns.IS_PENDING, 1) // Mark as pending
            }

            val targetCollection = if (isMediaFile(safeName)) {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            }

            val itemUri = resolver.insert(targetCollection, contentValues)
            if (itemUri != null) {
                try {
                    resolver.openOutputStream(itemUri)?.use { outputStream ->
                        inputStream.copyTo(outputStream)
                    }

                    // Completed, clear pending state to trigger immediate media indexing
                    contentValues.clear()
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    resolver.update(itemUri, contentValues, null, null)

                    Log.i(tag, "Scoped storage save success: $itemUri ($safeName)")
                    itemUri
                } catch (e: Exception) {
                    Log.e(tag, "Failed to write to scoped storage: ${e.message}")
                    resolver.delete(itemUri, null, null)
                    null
                }
            } else {
                null
            }
        } else {
            // Android 9 and below fallback mode
            val downloadDir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "SafeDrop"
            )
            if (!downloadDir.exists()) downloadDir.mkdirs()
            val targetFile = File(downloadDir, safeName)
            FileOutputStream(targetFile).use { output ->
                inputStream.copyTo(output)
            }
            Uri.fromFile(targetFile)
        }
    }

    /**
     * Get temporary .part file in cache directory for backpressure streaming
     */
    fun getTempPartFile(taskId: String, fileName: String): File {
        val cacheDir = File(context.cacheDir, "transfer_parts")
        if (!cacheDir.exists()) cacheDir.mkdirs()
        val safeTaskId = taskId.replace(Regex("[^a-zA-Z0-9_-]"), "").ifEmpty { "task_${System.currentTimeMillis()}" }
        val safeName = sanitizeFileName(fileName)
        return File(cacheDir, ".${safeTaskId}_${safeName}.part")
    }

    /**
     * Finalize received temporary chunk file and commit to Scoped Storage
     */
    fun finalizeReceivedFile(taskId: String, fileName: String): Uri? {
        val partFile = getTempPartFile(taskId, fileName)
        if (!partFile.exists() || partFile.length() == 0L) return null

        // Deliberately not mimeTypeFor(): that one answers "*/*" for an unknown name, which is
        // fine for an intent filter but not for the MIME column MediaStore indexes on.
        val mimeType = when {
            isMediaFile(fileName) -> if (fileName.lowercase().endsWith(".mp4")) "video/mp4" else "image/jpeg"
            fileName.lowercase().endsWith(".pdf") -> "application/pdf"
            fileName.lowercase().endsWith(".zip") -> "application/zip"
            fileName.lowercase().endsWith(".apk") -> "application/vnd.android.package-archive"
            fileName.lowercase().endsWith(".txt") -> "text/plain"
            else -> "application/octet-stream"
        }

        return try {
            val uri = java.io.FileInputStream(partFile).use { fis ->
                saveReceivedFile(fileName, mimeType, fis)
            }
            partFile.delete()
            uri
        } catch (e: Exception) {
            Log.e(tag, "Failed to finalize part file: ${e.message}")
            null
        }
    }

    private var currentStorageType = "download"

    /**
     * Set customized storage destination type and return the path shown to the user.
     *
     * Path only, no prose: the field it lands in is monospace and holds a filesystem location.
     */
    fun setCustomStorageType(type: String): String {
        currentStorageType = type
        return storagePathFor(type)
    }

    private fun storagePathFor(type: String): String = when (type) {
        "pictures" -> "Pictures/SafeDrop"
        "private" -> "Android/data/com.safedrop.mobile"
        else -> "Download/SafeDrop"
    }

    /**
     * User-facing display description of active storage location
     */
    fun getStorageDisplayPath(): String = storagePathFor(currentStorageType)

    /**
     * The type key the picker is currently on, so a re-opened dialog can mark it.
     */
    fun getStorageType(): String = currentStorageType

    /**
     * Create intent to view downloads folder in system file manager
     */
    fun createOpenFolderIntent(): android.content.Intent {
        val intent = android.content.Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).apply {
            flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
        }
        return intent
    }

    /**
     * Query all received files in SafeDrop vault directories
     */
    fun getVaultFiles(): List<VaultFileItem> {
        val result = mutableListOf<VaultFileItem>()
        val seenNames = mutableSetOf<String>()

        // 1. Check Download/SafeDrop
        val downloadSafeDrop = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "SafeDrop"
        )
        if (downloadSafeDrop.exists() && downloadSafeDrop.isDirectory) {
            downloadSafeDrop.listFiles()?.forEach { file ->
                if (file.isFile && !file.name.startsWith(".") && seenNames.add(file.name)) {
                    result.add(
                        VaultFileItem(
                            name = file.name,
                            sizeBytes = file.length(),
                            formattedSize = formatBytes(file.length()),
                            path = file.absolutePath,
                            isMedia = isMediaFile(file.name),
                            lastModified = file.lastModified()
                        )
                    )
                }
            }
        }

        // 2. Check Pictures/SafeDrop
        val picturesSafeDrop = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
            "SafeDrop"
        )
        if (picturesSafeDrop.exists() && picturesSafeDrop.isDirectory) {
            picturesSafeDrop.listFiles()?.forEach { file ->
                if (file.isFile && !file.name.startsWith(".") && seenNames.add(file.name)) {
                    result.add(
                        VaultFileItem(
                            name = file.name,
                            sizeBytes = file.length(),
                            formattedSize = formatBytes(file.length()),
                            path = file.absolutePath,
                            isMedia = isMediaFile(file.name),
                            lastModified = file.lastModified()
                        )
                    )
                }
            }
        }

        // 3. Check App Private Files
        val privateDir = context.getExternalFilesDir(null)
        if (privateDir != null && privateDir.exists()) {
            privateDir.listFiles()?.forEach { file ->
                if (file.isFile && !file.name.startsWith(".") && seenNames.add(file.name)) {
                    result.add(
                        VaultFileItem(
                            name = file.name,
                            sizeBytes = file.length(),
                            formattedSize = formatBytes(file.length()),
                            path = file.absolutePath,
                            isMedia = isMediaFile(file.name),
                            lastModified = file.lastModified()
                        )
                    )
                }
            }
        }

        result.sortByDescending { it.lastModified }
        return result
    }

    /**
     * Open a file using the system default viewer.
     *
     * @return false when nothing on the device can take this MIME type, so the caller can say so
     *         in the UI instead of swallowing the failure.
     */
    fun openFile(fileItem: VaultFileItem): Boolean {
        val file = File(fileItem.path)
        if (!file.exists()) return false

        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
            setDataAndType(contentUriFor(file), mimeTypeFor(fileItem.name))
            flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        return try {
            context.startActivity(intent)
            true
        } catch (e: Exception) {
            Log.w(tag, "No viewer for ${fileItem.name}: ${e.message}")
            false
        }
    }

    /**
     * Hand a received file to another app (mail, chat, editor) through the system chooser, so a
     * file that arrived in the vault is not trapped there.
     *
     * @return false when the file is gone or no app will take it.
     */
    fun shareFile(fileItem: VaultFileItem): Boolean {
        val file = File(fileItem.path)
        if (!file.exists()) return false
        return try {
            val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = mimeTypeFor(fileItem.name)
                putExtra(android.content.Intent.EXTRA_STREAM, contentUriFor(file))
                flags = android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
            }
            val title = fileItem.name.ifEmpty {
                context.getString(com.safedrop.mobile.R.string.transfer_share_file)
            }
            context.startActivity(
                android.content.Intent.createChooser(intent, title)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            true
        } catch (e: Exception) {
            Log.w(tag, "Nothing accepted a share of ${fileItem.name}: ${e.message}")
            false
        }
    }

    /**
     * Look a received file up by name, for the transfer row that only knows what it was called.
     */
    fun findVaultFile(fileName: String): VaultFileItem? {
        val files = getVaultFiles()
        return files.firstOrNull { it.name == fileName }
            ?: files.firstOrNull { it.name.substringBeforeLast('.') == fileName.substringBeforeLast('.') }
    }

    /**
     * A content:// URI another app may read. FileProvider covers the roots in file_paths.xml;
     * the raw file:// form is only reached on the pre-scoped-storage fallback.
     */
    private fun contentUriFor(file: File): Uri = try {
        androidx.core.content.FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
    } catch (e: Exception) {
        Uri.fromFile(file)
    }

    /**
     * MIME type for a name, shared by the open and the share path so they cannot drift.
     */
    fun mimeTypeFor(fileName: String): String {
        val lower = fileName.lowercase()
        return when {
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".mp4") -> "video/mp4"
            lower.endsWith(".pdf") -> "application/pdf"
            lower.endsWith(".txt") -> "text/plain"
            lower.endsWith(".zip") -> "application/zip"
            lower.endsWith(".apk") -> "application/vnd.android.package-archive"
            else -> "*/*"
        }
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        val kb = bytes / 1024.0
        val mb = kb / 1024.0
        val gb = mb / 1024.0
        return when {
            gb >= 1.0 -> String.format(java.util.Locale.US, "%.2f GB", gb)
            mb >= 1.0 -> String.format(java.util.Locale.US, "%.1f MB", mb)
            kb >= 1.0 -> String.format(java.util.Locale.US, "%.0f KB", kb)
            else -> "$bytes B"
        }
    }
}

/**
 * Vault file metadata item
 */
data class VaultFileItem(
    val name: String,
    val sizeBytes: Long,
    val formattedSize: String,
    val path: String,
    val isMedia: Boolean,
    val lastModified: Long
)
