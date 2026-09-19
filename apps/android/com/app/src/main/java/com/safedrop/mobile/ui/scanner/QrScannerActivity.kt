package com.safedrop.mobile.ui.scanner

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.safedrop.mobile.R
import com.safedrop.mobile.core.network.NetworkHelper
import com.safedrop.mobile.databinding.ActivityQrScannerBinding

import java.util.concurrent.Executors

/**
 * CameraX + ML Kit viewfinder.
 *
 * 1. Scans the pairing code shown on the other device's screen.
 * 2. Parses `safedrop://pair?ip=…&port=…&fp=…&token=…&pin=…` (plus the legacy JSON and http forms).
 * 3. Hands the parameters back to the pairing sheet, which does the handshake.
 *
 * A refused camera permission is a state with a way out, not a reason to close: the viewfinder is
 * replaced by a short rationale with the system settings, a retry, and the pairing sheet for
 * people who would rather type the six digits.
 */
class QrScannerActivity : AppCompatActivity() {

    private val tag = "QrScannerActivity"
    private lateinit var binding: ActivityQrScannerBinding
    private val cameraExecutor = Executors.newSingleThreadExecutor()
    private var isScanned = false

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) {
            showViewfinder()
            startCamera()
        } else {
            showPermissionState()
        }
    }

    private val openSettingsLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        // The user may have granted it in settings, or may not have. Re-check either way.
        if (hasCameraPermission()) {
            showViewfinder()
            startCamera()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityQrScannerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnBack.setOnClickListener { finish() }
        binding.btnManualPin.setOnClickListener { handOffToPinEntry() }
        binding.btnPermissionManualPin.setOnClickListener { handOffToPinEntry() }

        binding.btnRetryPermission.setOnClickListener {
            if (shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
                requestPermissionLauncher.launch(Manifest.permission.CAMERA)
            } else {
                // Denied with "don't ask again": the only retry left is the system page.
                openAppSettings()
            }
        }
        binding.btnOpenAppSettings.setOnClickListener { openAppSettings() }

        if (hasCameraPermission()) {
            showViewfinder()
            startCamera()
        } else {
            requestPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onResume() {
        super.onResume()
        // Came back from the system settings page with the permission granted.
        if (binding.layoutPermissionState.visibility == View.VISIBLE && hasCameraPermission()) {
            showViewfinder()
            startCamera()
        }
    }

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED

    private fun showViewfinder() {
        binding.layoutPermissionState.visibility = View.GONE
        binding.previewView.visibility = View.VISIBLE
        binding.layoutScannerHeader.visibility = View.VISIBLE
        binding.layoutReticle.visibility = View.VISIBLE
        binding.layoutScannerFooter.visibility = View.VISIBLE
    }

    private fun showPermissionState() {
        binding.layoutPermissionState.visibility = View.VISIBLE
        binding.layoutReticle.visibility = View.GONE
        binding.layoutScannerFooter.visibility = View.GONE
    }

    private fun openAppSettings() {
        try {
            openSettingsLauncher.launch(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:$packageName")
                }
            )
        } catch (e: Exception) {
            Toast.makeText(this, R.string.camera_settings_unavailable, Toast.LENGTH_LONG).show()
        }
    }

    /** Ask the caller to show the pairing sheet instead of the camera. */
    private fun handOffToPinEntry() {
        setResult(RESULT_OK, Intent().putExtra(EXTRA_MANUAL_PIN, true))
        finish()
    }

    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(binding.previewView.surfaceProvider)
            }

            val options = com.google.mlkit.vision.barcode.BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build()
            val barcodeScanner = BarcodeScanning.getClient(options)
            val imageAnalysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()

            imageAnalysis.setAnalyzer(cameraExecutor) { imageProxy ->
                val mediaImage = imageProxy.image
                if (mediaImage != null && !isScanned) {
                    val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
                    barcodeScanner.process(image)
                        .addOnSuccessListener { barcodes ->
                            var matched = false
                            for (barcode in barcodes) {
                                val rawValue = barcode.rawValue ?: continue
                                val trimmed = rawValue.trim()
                                if (trimmed.startsWith("safedrop://") || trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("{")) {
                                    triggerHapticFeedback()
                                    handleScannedUri(trimmed)
                                    matched = true
                                    break
                                }
                            }
                            // A frame with a code in it that is not ours is the case where the
                            // user is pointing at the wrong square; say so, at most every few
                            // seconds, instead of leaving the viewfinder silently doing nothing.
                            if (!matched && barcodes.isNotEmpty()) {
                                reportUnrelatedCode()
                            }
                        }
                        .addOnCompleteListener {
                            imageProxy.close()
                        }
                } else {
                    imageProxy.close()
                }
            }

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    this,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageAnalysis
                )
            } catch (e: Exception) {
                Log.e(tag, "Failed to bind CameraX lifecycle: ${e.message}")
                // A camera another app is holding should not leave a black screen behind.
                showPermissionState()
            }

        }, ContextCompat.getMainExecutor(this))
    }

    private var lastUnrelatedToastAt = 0L

    /** Called from the camera analysis thread, so the toast goes back to the main thread. */
    private fun reportUnrelatedCode() {
        val now = System.currentTimeMillis()
        if (now - lastUnrelatedToastAt < 4000) return
        lastUnrelatedToastAt = now
        runOnUiThread {
            if (!isFinishing) {
                Toast.makeText(this, R.string.scan_not_pair_code, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun triggerHapticFeedback() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vm?.defaultVibrator?.vibrate(VibrationEffect.createOneShot(80, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v?.vibrate(VibrationEffect.createOneShot(80, VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    v?.vibrate(80)
                }
            }
        } catch (_: Exception) {}
    }

    private fun handleScannedUri(rawUriString: String) {
        if (isScanned) return
        isScanned = true

        runOnUiThread {
            try {
                var ip = ""
                var port = 8899
                var fp = ""
                var token = ""
                var pin = ""
                var theme = ""

                if (rawUriString.startsWith("{") && rawUriString.endsWith("}")) {
                    // JSON format payload
                    val json = org.json.JSONObject(rawUriString)
                    val parsedHost = json.optString("ip", json.optString("host", ""))
                    ip = if (parsedHost.isNotEmpty() && parsedHost != "127.0.0.1" && parsedHost != "localhost") {
                        parsedHost
                    } else {
                        NetworkHelper.getDefaultGateway(this)
                    }
                    port = json.optInt("port", 8899)
                    fp = json.optString("fp", json.optString("fingerprint", ""))
                    token = json.optString("token", "")
                    pin = json.optString("pin", "")
                    theme = json.optString("theme", "")
                } else {
                    // Standard URI format (safedrop://pair, http://, https://)
                    val uri = Uri.parse(rawUriString)
                    val parsedHost = uri.getQueryParameter("ip") ?: uri.host
                    ip = if (!parsedHost.isNullOrEmpty() && parsedHost != "127.0.0.1" && parsedHost != "localhost") {
                        parsedHost
                    } else {
                        NetworkHelper.getDefaultGateway(this)
                    }
                    port = uri.getQueryParameter("port")?.toIntOrNull() ?: uri.port.takeIf { it != -1 } ?: 8899
                    fp = uri.getQueryParameter("fp") ?: uri.getQueryParameter("fingerprint") ?: ""
                    token = uri.getQueryParameter("token") ?: ""
                    pin = uri.getQueryParameter("pin") ?: ""
                    theme = uri.getQueryParameter("theme") ?: ""
                }

                if (ip.isEmpty() || (pin.isEmpty() && token.isEmpty())) {
                    // Nothing usable on this code: keep scanning instead of pairing against a blank.
                    isScanned = false
                    Toast.makeText(this, R.string.scan_result_incomplete, Toast.LENGTH_LONG).show()
                    return@runOnUiThread
                }

                val resultIntent = Intent().apply {
                    putExtra(EXTRA_IP, ip)
                    putExtra(EXTRA_PORT, port)
                    putExtra(EXTRA_FP, fp)
                    putExtra(EXTRA_TOKEN, token)
                    putExtra(EXTRA_PIN, pin)
                    putExtra(EXTRA_THEME, theme)
                }
                setResult(RESULT_OK, resultIntent)
                finish()
            } catch (e: Exception) {
                Log.e(tag, "Failed to parse QR URI: ${e.message}")
                isScanned = false
                Toast.makeText(this, R.string.scan_result_unreadable, Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
    }

    companion object {
        const val EXTRA_IP = "EXTRA_IP"
        const val EXTRA_PORT = "EXTRA_PORT"
        const val EXTRA_FP = "EXTRA_FP"
        const val EXTRA_TOKEN = "EXTRA_TOKEN"
        const val EXTRA_PIN = "EXTRA_PIN"
        const val EXTRA_THEME = "EXTRA_THEME"
        const val EXTRA_MANUAL_PIN = "EXTRA_MANUAL_PIN"
    }
}
