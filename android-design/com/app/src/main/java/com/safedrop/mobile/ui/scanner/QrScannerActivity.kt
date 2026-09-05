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
import android.util.Log
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
import com.safedrop.mobile.core.network.NetworkHelper
import com.safedrop.mobile.databinding.ActivityQrScannerBinding

import java.util.concurrent.Executors

/**
 * CameraX + Google ML Kit Barcode Scanner Viewfinder
 * Features:
 * 1. Scans dynamic offline connection QR codes on desktop screen.
 * 2. Parses protocol: safedrop://pair?ip={IP}&port={Port}&fp={FP}&token={Token}&pin={PIN}
 * 3. Extracts target hub parameters to establish direct unicast connection penetrating AP isolation.
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
            startCamera()
        } else {
            Toast.makeText(this, "需开启摄像头权限以扫描电脑端二维码", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityQrScannerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnBack.setOnClickListener { finish() }
        binding.btnManualPin.setOnClickListener {
            val resultIntent = Intent().apply {
                putExtra("EXTRA_MANUAL_PIN", true)
            }
            setResult(RESULT_OK, resultIntent)
            finish()
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            requestPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()

            // 1. Camera preview
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(binding.previewView.surfaceProvider)
            }

            // 2. ML Kit barcode image analyzer optimized for QR Code format
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
                            for (barcode in barcodes) {
                                val rawValue = barcode.rawValue ?: continue
                                val trimmed = rawValue.trim()
                                if (trimmed.startsWith("safedrop://") || trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("{")) {
                                    triggerHapticFeedback()
                                    handleScannedUri(trimmed)
                                    break
                                }
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
            }

        }, ContextCompat.getMainExecutor(this))
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

                val resultIntent = Intent().apply {
                    putExtra("EXTRA_IP", ip)
                    putExtra("EXTRA_PORT", port)
                    putExtra("EXTRA_FP", fp)
                    putExtra("EXTRA_TOKEN", token)
                    putExtra("EXTRA_PIN", pin)
                    putExtra("EXTRA_THEME", theme)
                }
                setResult(RESULT_OK, resultIntent)
                Toast.makeText(this, "配对码解析成功 ($ip:$port)，正在建立信任锚点...", Toast.LENGTH_SHORT).show()
                finish()
            } catch (e: Exception) {
                Log.e(tag, "Failed to parse QR URI: ${e.message}")
                isScanned = false
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
    }
}
