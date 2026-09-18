package com.safedrop.mobile.ui

import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.util.Log
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.safedrop.mobile.R
import com.safedrop.mobile.core.crypto.CryptoEngine
import com.safedrop.mobile.core.crypto.ProtocolConst
import com.safedrop.mobile.core.network.DesktopHubClient
import com.safedrop.mobile.core.network.MulticastLockHelper
import com.safedrop.mobile.core.network.NetworkHelper
import com.safedrop.mobile.core.network.UdpDiscoveryHelper
import com.safedrop.mobile.core.storage.ScopedStorageHelper
import com.safedrop.mobile.databinding.ActivityMainBinding
import com.safedrop.mobile.service.MobileTransferServer
import com.safedrop.mobile.service.TransferForegroundService
import com.safedrop.mobile.ui.adapter.DeviceAdapter
import com.safedrop.mobile.ui.adapter.DiscoveredDevice
import com.safedrop.mobile.ui.adapter.TransferTaskAdapter
import com.safedrop.mobile.ui.adapter.VaultFileAdapter
import com.safedrop.mobile.ui.adapter.ChannelMessage
import com.safedrop.mobile.ui.adapter.ChannelMessageAdapter
import com.safedrop.mobile.ui.adapter.PeerChipAdapter
import com.safedrop.mobile.ui.scanner.QrScannerActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.InputStream

/**
 * Mobile Main Window Activity (Material 3 Responsive UI)
 * Architecture:
 * 1. 4 Independent Full Pages (Discovery, Transfer Tasks, Safe Vault, Settings)
 * 2. Embedded MobileTransferServer (Receives 1MB streaming chunks directly from PC)
 * 3. UDP 8890 instant dual-channel broadcast LAN discovery
 * 4. Scoped Storage vault inspection and system file viewer intent launcher
 * 5. Three-state dynamic live theme switching (Dark / EyeCare / Light)
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var multicastLockHelper: MulticastLockHelper
    private val hubClient = DesktopHubClient()
    private val cryptoEngine = CryptoEngine()
    private lateinit var storageHelper: ScopedStorageHelper
    private lateinit var prefs: SharedPreferences
    private lateinit var deviceNameCache: com.safedrop.mobile.core.cache.DeviceNameCache

    // Embedded HTTP receiver server on mobile
    private var mobileTransferServer: MobileTransferServer? = null
    // UDP 8890 discovery helper
    private var udpDiscoveryHelper: UdpDiscoveryHelper? = null

    // Target desktop hub connection parameters
    private var connectedHost = ""
    private var connectedPort = 8899
    private var targetFingerprint = ""
    private var isHubConnected = false
    private var currentThemeMode = "dark"
    private var hasBatteryOptimizationPrompted = false

    // Adapters for the 4 pages
    private lateinit var deviceAdapter: DeviceAdapter
    private val discoveredDevices = mutableListOf<DiscoveredDevice>()
    private var selectedTargetDevice: DiscoveredDevice? = null

    /**
     * Pairing secrets (PIN or QR token) learned from a scan or manual entry, keyed by
     * "host:port". Needed to negotiate a direct session with a phone-to-phone target later,
     * since the desktop hub holds no key for that peer.
     */
    private val pairingSecrets = mutableMapOf<String, String>()

    private lateinit var transferTaskAdapter: TransferTaskAdapter
    private lateinit var vaultFileAdapter: VaultFileAdapter
    private lateinit var peerChipAdapter: PeerChipAdapter
    private lateinit var channelMessageAdapter: ChannelMessageAdapter
    private val peerMessages = mutableMapOf<String, MutableList<ChannelMessage>>()
    private var activePeerId: String? = null

    // QR scanner activity launcher
    private val scanQrLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val data = result.data!!
            val isManualPin = data.getBooleanExtra("EXTRA_MANUAL_PIN", false)
            if (isManualPin) {
                showPinPairingDialog(connectedHost, connectedPort)
                return@registerForActivityResult
            }

            val ip = data.getStringExtra("EXTRA_IP") ?: connectedHost
            val port = data.getIntExtra("EXTRA_PORT", connectedPort)
            val fp = data.getStringExtra("EXTRA_FP") ?: ""
            val token = data.getStringExtra("EXTRA_TOKEN") ?: ""
            val pin = data.getStringExtra("EXTRA_PIN") ?: ""
            val theme = data.getStringExtra("EXTRA_THEME") ?: ""

            if (theme == "eyecare" || theme == "light" || theme == "dark") {
                applyThemeMode(theme)
            }

            handlePairingResult(ip, port, fp, token, pin)
        }
    }

    // Media file picker launcher (Images / Videos)
    private val pickMediaLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) {
            startStreamingUpload(uri)
        }
    }

    // Document file picker launcher (PDF / ZIP / Documents)
    private val pickFileLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) {
            startStreamingUpload(uri)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = getSharedPreferences("safedrop_prefs", MODE_PRIVATE)
        currentThemeMode = prefs.getString("theme_mode", "dark") ?: "dark"
        hasBatteryOptimizationPrompted = prefs.getBoolean("battery_optimization_prompted", false)

        // Initialize target connection host from preferences or LAN gateway
        val savedHost = prefs.getString("connected_host", null)
        val localIp = NetworkHelper.getLocalWifiIpv4(this)
        connectedHost = when {
            !savedHost.isNullOrEmpty() && savedHost != "127.0.0.1" -> savedHost
            localIp != "127.0.0.1" -> NetworkHelper.getDefaultGateway(this)
            else -> localIp
        }

        multicastLockHelper = MulticastLockHelper(this)
        storageHelper = ScopedStorageHelper(this)
        deviceNameCache = com.safedrop.mobile.core.cache.DeviceNameCache(this)

        initViews()
        initServices()
        applyThemeMode(currentThemeMode)
        handleIncomingSharedUris(intent)
    }

    private fun initViews() {
        // 0. Standalone Web Portal & Pairing QR Code button
        binding.btnShowMyQr.setOnClickListener {
            showMyPairingQrDialog()
        }

        // 1. QR code scanner
        binding.btnScanQr.setOnClickListener {
            val intent = Intent(this, QrScannerActivity::class.java)
            scanQrLauncher.launch(intent)
        }

        // 2. Manual PIN pairing dialog
        binding.btnInputPin.setOnClickListener {
            showPinPairingDialog(connectedHost, connectedPort)
        }

        // 3. Three-state theme switcher in Settings page
        binding.btnThemeDark.setOnClickListener {
            applyThemeMode("dark")
        }
        binding.btnThemeEyecare.setOnClickListener {
            applyThemeMode("eyecare")
        }
        binding.btnThemeLight.setOnClickListener {
            applyThemeMode("light")
        }

        // 4. Send media gallery items
        binding.cardSendMedia.setOnClickListener {
            prepareTargetAndLaunch {
                pickMediaLauncher.launch("image/*")
            }
        }

        // 5. Send general documents
        binding.cardSendFiles.setOnClickListener {
            prepareTargetAndLaunch {
                pickFileLauncher.launch("*/*")
            }
        }

        // 6. Scoped Storage folder management and opening
        binding.tvCurrentStoragePath.text = storageHelper.getStorageDisplayPath()
        binding.btnOpenStorageFolder.setOnClickListener {
            try {
                val intent = storageHelper.createOpenFolderIntent()
                startActivity(intent)
            } catch (e: Exception) {
                Toast.makeText(this, "打开系统下载目录: Download/SafeDrop", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnChangeStoragePath.setOnClickListener {
            showStorageChoiceDialog()
        }

        // 7. Setup device list RecyclerView (Page 1) - Displays both PC Hubs and Android Phones
        deviceAdapter = DeviceAdapter(
            onDeviceClick = { dev ->
                openPeerChatWindow(dev)
            },
            onSendClick = { dev ->
                selectedTargetDevice = dev
                connectedHost = dev.host
                connectedPort = dev.port
                prefs.edit().putString("connected_host", dev.host).apply()

                if (hubClient.hasSession(dev.host, dev.port)) {
                    pickFileLauncher.launch("*/*")
                } else {
                    showPinPairingDialog(dev.host, dev.port, onPaired = {
                        pickFileLauncher.launch("*/*")
                    })
                }
            },
            onChatClick = { dev ->
                openPeerChatWindow(dev)
            }
        )
        binding.rvDevices.layoutManager = LinearLayoutManager(this)
        binding.rvDevices.adapter = deviceAdapter

        // 8. Setup Per-Device Chat & Transfer Window (Page 2)
        peerChipAdapter = PeerChipAdapter { peer ->
            openPeerChatWindow(peer)
        }
        binding.rvPeerChips.layoutManager = LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
        binding.rvPeerChips.adapter = peerChipAdapter

        channelMessageAdapter = ChannelMessageAdapter()
        binding.rvChannelMessages.layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = true
        }
        binding.rvChannelMessages.adapter = channelMessageAdapter

        transferTaskAdapter = TransferTaskAdapter()
        binding.rvTransferTasks.layoutManager = LinearLayoutManager(this)
        binding.rvTransferTasks.adapter = transferTaskAdapter

        binding.btnActivePeerQuickSend.setOnClickListener {
            val target = getActivePeer()
            if (target != null) {
                selectedTargetDevice = target
                connectedHost = target.host
                connectedPort = target.port
                pickFileLauncher.launch("*/*")
            } else {
                Toast.makeText(this, "请先选择对端设备", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnChannelPickFile.setOnClickListener {
            val target = getActivePeer()
            if (target != null) {
                selectedTargetDevice = target
                connectedHost = target.host
                connectedPort = target.port
                pickFileLauncher.launch("*/*")
            } else {
                Toast.makeText(this, "请先选择对端设备", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnChannelSendMessage.setOnClickListener {
            sendCurrentChatMessage()
        }

        binding.etChannelMessage.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEND) {
                sendCurrentChatMessage()
                true
            } else false
        }

        binding.btnClearCompletedTasks.setOnClickListener {
            val activeId = activePeerId
            if (activeId != null) {
                peerMessages[activeId]?.clear()
                updatePeerChatUI()
                Toast.makeText(this, "已清空当前会话记录", Toast.LENGTH_SHORT).show()
            }
        }

        // 9. Setup Safe Sandbox Files RecyclerView (Page 3)
        vaultFileAdapter = VaultFileAdapter { item ->
            storageHelper.openFile(item)
        }
        binding.rvVaultFiles.layoutManager = LinearLayoutManager(this)
        binding.rvVaultFiles.adapter = vaultFileAdapter
        binding.btnRefreshVault.setOnClickListener {
            refreshVaultFiles()
        }

        // Pull-to-refresh for device list (refresh device names)
        binding.rvDevices.setOnScrollChangeListener { _, _, scrollY, _, oldScrollY ->
            if (scrollY < oldScrollY && scrollY < -100) {
                refreshDeviceNames()
            }
        }

        // 10. Bottom navigation bar listener - Switches between 4 independent full pages!
        binding.bottomNavigation.setOnItemSelectedListener { item ->
            switchPage(item.itemId)
            true
        }

        // Dynamically measure bottom navigation bar height (including system navigation insets)
        // and adjust pagesContainer bottom margin so chat input box is completely independent and never overlapped
        binding.bottomNavigation.addOnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom ->
            val navHeight = bottom - top
            if (navHeight > 0) {
                val lp = binding.pagesContainer.layoutParams as? ViewGroup.MarginLayoutParams
                if (lp != null && lp.bottomMargin != navHeight) {
                    lp.bottomMargin = navHeight
                    binding.pagesContainer.layoutParams = lp
                }
            }
        }

        updateDeviceListUI()
        updateTransferEmptyState()
        refreshVaultFiles()
    }

    /**
     * Switch between the 4 independent full pages (No popups, no dialogs)
     */
    private fun switchPage(pageId: Int) {
        binding.layoutDiscoveryPage.visibility = if (pageId == R.id.nav_radar) View.VISIBLE else View.GONE
        binding.layoutTransferPage.visibility = if (pageId == R.id.nav_transfer) View.VISIBLE else View.GONE
        binding.layoutVaultPage.visibility = if (pageId == R.id.nav_vault) View.VISIBLE else View.GONE
        binding.layoutSettingsPage.visibility = if (pageId == R.id.nav_settings) View.VISIBLE else View.GONE

        if (pageId == R.id.nav_vault) {
            refreshVaultFiles()
        } else if (pageId == R.id.nav_settings) {
            updateSettingsUI()
        }
    }

    /**
     * Initialize background MobileTransferServer and UdpDiscoveryHelper
     */
    private fun initServices() {
        // Start mobile HTTP transfer receiver on port 8899 (or 8898)
        mobileTransferServer = MobileTransferServer(
            context = this,
            storageHelper = storageHelper,
            onProgress = { taskId, fileName, progress, speedMbps ->
                runOnUiThread {
                    TransferForegroundService.updateProgress(this@MainActivity, fileName, progress, speedMbps)
                    transferTaskAdapter.updateProgress(taskId, fileName, progress, speedMbps, isDownload = true)
                    updateTransferEmptyState()

                    val targetDev = getActivePeer()
                    if (targetDev != null) {
                        val list = peerMessages.getOrPut(targetDev.id) { mutableListOf() }
                        val existing = list.find { it.id == taskId }
                        if (existing != null) {
                            existing.progress = progress
                            existing.speed = if (speedMbps > 0) String.format(java.util.Locale.US, "%.1f MB/s", speedMbps) else ""
                            existing.status = if (progress >= 100) "completed" else "transferring"
                            channelMessageAdapter.notifyDataSetChanged()
                        } else {
                            val msg = ChannelMessage(
                                id = taskId,
                                type = ChannelMessage.Type.FILE,
                                isOutgoing = false,
                                fileName = fileName,
                                progress = progress,
                                speed = if (speedMbps > 0) String.format(java.util.Locale.US, "%.1f MB/s", speedMbps) else "",
                                status = "transferring"
                            )
                            list.add(msg)
                            updatePeerChatUI()
                        }
                    }
                }
            },
            onCompleted = { taskId, fileName, uri ->
                runOnUiThread {
                    TransferForegroundService.finishTransfer(this@MainActivity, fileName)
                    transferTaskAdapter.updateProgress(taskId, fileName, 100, 0f, isDownload = true)
                    updateTransferEmptyState()
                    refreshVaultFiles()

                    val targetDev = getActivePeer()
                    if (targetDev != null) {
                        val list = peerMessages.getOrPut(targetDev.id) { mutableListOf() }
                        val existing = list.find { it.id == taskId }
                        if (existing != null) {
                            existing.progress = 100
                            existing.status = "completed"
                            channelMessageAdapter.notifyDataSetChanged()
                        }
                    }

                    Toast.makeText(this@MainActivity, "接收完成：文件 \"$fileName\" 已成功存入系统沙箱！", Toast.LENGTH_LONG).show()
                }
            },
            onMessageReceived = { senderId, senderName, text, timestamp ->
                runOnUiThread {
                    val matchingPeer = discoveredDevices.find { it.id == senderId || it.host == senderId } ?: getActivePeer()
                    val targetId = matchingPeer?.id ?: senderId
                    val list = peerMessages.getOrPut(targetId) { mutableListOf() }
                    list.add(
                        ChannelMessage(
                            id = "msg_$timestamp",
                            type = ChannelMessage.Type.TEXT,
                            isOutgoing = false,
                            text = text,
                            timestamp = timestamp
                        )
                    )
                    if (activePeerId == targetId || activePeerId == null) {
                        activePeerId = targetId
                        updatePeerChatUI()
                    }
                    Toast.makeText(this@MainActivity, "收到来自 $senderName 的消息: $text", Toast.LENGTH_SHORT).show()
                }
            }
        )
        val serverPort = mobileTransferServer?.start(8899) ?: 8899

        // Start UDP 8890 broadcast discovery helper
        udpDiscoveryHelper = UdpDiscoveryHelper(this) { ip, port, name, fp, devType, devId ->
            runOnUiThread {
                val existingIdx = discoveredDevices.indexOfFirst {
                    it.host == ip || (fp.isNotEmpty() && it.fingerprint.isNotEmpty() && it.fingerprint == fp)
                }
                val isPc = devType.lowercase() == "pc" || devType.lowercase() == "windows"
                val formattedName = if (name.isNotEmpty()) name else (if (isPc) "Desktop Hub ($ip)" else "Android 手机 ($ip)")
                val standardDevType = if (isPc) "pc" else "android"

                if (existingIdx >= 0) {
                    val existing = discoveredDevices[existingIdx]
                    discoveredDevices[existingIdx] = existing.copy(
                        name = formattedName,
                        port = port,
                        fingerprint = if (fp.isNotEmpty()) fp else existing.fingerprint,
                        deviceType = standardDevType
                    )
                    updateDeviceListUI()
                } else {
                    val dev = DiscoveredDevice(
                        id = devId.ifEmpty { if (isPc) "pc-$ip" else "android-$ip" },
                        name = formattedName,
                        host = ip,
                        port = port,
                        fingerprint = fp,
                        deviceType = standardDevType
                    )
                    discoveredDevices.add(0, dev)
                    updateDeviceListUI()
                    if (connectedHost.isEmpty() || connectedHost == "127.0.0.1") {
                        connectedHost = ip
                        connectedPort = port
                        prefs.edit().putString("connected_host", ip).apply()
                    }
                    // Announce mobile presence to discovered device (PC or Android)
                    val localIp = NetworkHelper.getLocalWifiIpv4(this@MainActivity)
                    val sPort = mobileTransferServer?.port ?: 8899
                    val myFp = mobileTransferServer?.fingerprint ?: ""
                    lifecycleScope.launch {
                        hubClient.announceDevice(ip, port, "Android ($localIp)", myFp, sPort)
                    }
                }
            }
        }
        val devId = mobileTransferServer?.deviceId ?: ""
        val myFp = mobileTransferServer?.fingerprint ?: ""
        udpDiscoveryHelper?.start(serverPort, devId, myFp)
    }

    private fun refreshVaultFiles() {
        val files = storageHelper.getVaultFiles()
        vaultFileAdapter.updateFiles(files)
        binding.tvEmptyVaultFiles.visibility = if (files.isEmpty()) View.VISIBLE else View.GONE
        binding.rvVaultFiles.visibility = if (files.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun updateTransferEmptyState() {
        val hasTasks = transferTaskAdapter.itemCount > 0
        binding.tvEmptyTransferTasks.visibility = if (hasTasks) View.GONE else View.VISIBLE
        binding.rvTransferTasks.visibility = if (hasTasks) View.VISIBLE else View.GONE
    }

    private fun updateSettingsUI() {
        val localIp = NetworkHelper.getLocalWifiIpv4(this)
        val serverPort = mobileTransferServer?.port ?: 8899
        binding.tvSettingsLocalIp.text = "本机局域网 IP: $localIp:$serverPort"
        binding.tvSettingsTargetPc.text = if (connectedHost.isNotEmpty()) "绑定电脑中枢: $connectedHost:$connectedPort" else "未连接电脑端 (等待扫码或局域网发现)"
    }

    private fun updateDeviceListUI() {
        if (discoveredDevices.isEmpty()) {
            binding.rvDevices.visibility = View.GONE
            binding.tvEmptyDevices.visibility = View.VISIBLE
            val localIp = NetworkHelper.getLocalWifiIpv4(this)
            val subnet = NetworkHelper.getSubnetPrefix(localIp)
            binding.tvEmptyDevices.text = "正在全向扫描局域网设备 (${subnet}*)... 也可点击右上角扫码连接"
        } else {
            binding.rvDevices.visibility = View.VISIBLE
            binding.tvEmptyDevices.visibility = View.GONE
            deviceAdapter.setDeviceNameCache(deviceNameCache.getDeviceNames())
            deviceAdapter.updateDevices(discoveredDevices)
        }
        updatePeerChatUI()
    }

    private fun getActivePeer(): DiscoveredDevice? {
        val id = activePeerId ?: return discoveredDevices.firstOrNull()
        return discoveredDevices.find { it.id == id } ?: discoveredDevices.firstOrNull()
    }

    private fun openPeerChatWindow(dev: DiscoveredDevice) {
        activePeerId = dev.id
        selectedTargetDevice = dev
        connectedHost = dev.host
        connectedPort = dev.port
        prefs.edit().putString("connected_host", dev.host).apply()

        // Switch bottom nav to Page 2 (Transfers & Chat)
        binding.bottomNavigation.selectedItemId = R.id.nav_transfer
        updatePeerChatUI()
    }

    private fun updatePeerChatUI() {
        if (discoveredDevices.isEmpty()) {
            binding.layoutNoPeerState.visibility = View.VISIBLE
            binding.layoutActivePeerContent.visibility = View.GONE
            peerChipAdapter.setPeers(emptyList(), null)
            binding.tvOnlineCountTag.text = "0 台在线"
            return
        }

        binding.layoutNoPeerState.visibility = View.GONE
        binding.layoutActivePeerContent.visibility = View.VISIBLE
        binding.tvOnlineCountTag.text = "${discoveredDevices.size} 台在线"

        var activeDev = discoveredDevices.find { it.id == activePeerId }
        if (activeDev == null) {
            activeDev = discoveredDevices[0]
            activePeerId = activeDev.id
        }

        peerChipAdapter.setPeers(discoveredDevices, activePeerId)

        // Hide active peer banner per user request (redundant since peer chip is present above)
        binding.cardActivePeerInfo.visibility = View.GONE

        val msgs = peerMessages.getOrPut(activeDev.id) { mutableListOf() }
        channelMessageAdapter.setMessages(msgs)
        binding.tvEmptyChannelMessages.visibility = if (msgs.isEmpty()) View.VISIBLE else View.GONE
        if (msgs.isNotEmpty()) {
            binding.rvChannelMessages.scrollToPosition(msgs.size - 1)
        }
    }

    private fun sendCurrentChatMessage() {
        val text = binding.etChannelMessage.text.toString().trim()
        if (text.isEmpty()) return

        val activeDev = getActivePeer()
        if (activeDev == null) {
            Toast.makeText(this, "暂无对端设备连接", Toast.LENGTH_SHORT).show()
            return
        }

        val msgId = "msg_${System.currentTimeMillis()}"
        val msg = ChannelMessage(
            id = msgId,
            type = ChannelMessage.Type.TEXT,
            isOutgoing = true,
            text = text,
            timestamp = System.currentTimeMillis()
        )

        val list = peerMessages.getOrPut(activeDev.id) { mutableListOf() }
        list.add(msg)
        binding.etChannelMessage.setText("")
        updatePeerChatUI()

        val myDevId = mobileTransferServer?.deviceId ?: "android-mobile"
        val myName = mobileTransferServer?.deviceName ?: "SafeDrop 手机端"
        val localIp = NetworkHelper.getLocalWifiIpv4(this)

        lifecycleScope.launch(Dispatchers.IO) {
            val sent = hubClient.sendInstantMessage(
                host = activeDev.host,
                port = activeDev.port,
                text = text,
                senderId = myDevId,
                senderName = myName,
                targetId = activeDev.id,
                senderIp = localIp
            )
            // The bubble was added optimistically; the hub only accepts messages from a paired
            // session, so a rejection has to take it back rather than leave a phantom delivery.
            if (!sent) {
                runOnUiThread {
                    list.remove(msg)
                    updatePeerChatUI()
                    Toast.makeText(this@MainActivity, "消息未送达：与对端的加密会话不可用（未配对或已过期）", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun getNavColorStateList(selectedColor: Int, unselectedColor: Int): ColorStateList {
        val states = arrayOf(
            intArrayOf(android.R.attr.state_checked),
            intArrayOf(-android.R.attr.state_checked)
        )
        val colors = intArrayOf(selectedColor, unselectedColor)
        return ColorStateList(states, colors)
    }

    /**
     * Apply active theme palette (Dark / EyeCare / Light) across all 4 independent pages
     */
    private fun applyThemeMode(theme: String) {
        currentThemeMode = theme
        prefs.edit().putString("theme_mode", theme).apply()

        deviceAdapter.setThemeMode(theme)
        transferTaskAdapter.setThemeMode(theme)
        vaultFileAdapter.setThemeMode(theme)
        peerChipAdapter.setThemeMode(theme)
        channelMessageAdapter.setThemeMode(theme)

        when (theme) {
            "eyecare" -> {
                // 优化护眼模式：更深润的米黄色背景 (#EDE4D0) + 温润浅绿点缀 (#CDE8D5)
                binding.mainCoordinatorLayout.setBackgroundColor(Color.parseColor("#EDE4D0"))
                binding.mainAppBarLayout.setBackgroundColor(Color.parseColor("#DFD5BE"))
                binding.topAppBar.setTitleTextColor(Color.parseColor("#000000"))
                binding.topAppBar.setSubtitleTextColor(Color.parseColor("#3D382B"))

                val eyecareCardBg = Color.parseColor("#F5EDDC")
                val eyecareStroke = Color.parseColor("#D5C7AA")
                val eyecareTextBlack = Color.parseColor("#000000")
                val eyecareSubText = Color.parseColor("#3D382B")
                val eyecareLightGreen = Color.parseColor("#CDE8D5") // 浅绿点缀色

                binding.cardRadar.setCardBackgroundColor(eyecareCardBg)
                binding.cardRadar.strokeColor = eyecareStroke
                binding.cardSendMedia.setCardBackgroundColor(eyecareCardBg)
                binding.cardSendMedia.strokeColor = eyecareStroke
                binding.cardSendFiles.setCardBackgroundColor(eyecareCardBg)
                binding.cardSendFiles.strokeColor = eyecareStroke
                binding.cardStorageSettings.setCardBackgroundColor(eyecareCardBg)
                binding.cardStorageSettings.strokeColor = eyecareStroke
                binding.cardSettingsTheme.setCardBackgroundColor(eyecareCardBg)
                binding.cardSettingsTheme.strokeColor = eyecareStroke
                binding.cardSettingsNetwork.setCardBackgroundColor(eyecareCardBg)
                binding.cardSettingsNetwork.strokeColor = eyecareStroke
                binding.cardSettingsSecurity.setCardBackgroundColor(eyecareCardBg)
                binding.cardSettingsSecurity.strokeColor = eyecareStroke

                // 文字颜色统一为黑色
                binding.tvBeaconTitle.setTextColor(eyecareTextBlack)
                binding.tvDeviceSectionTitle.setTextColor(eyecareTextBlack)
                binding.tvTransferSectionTitle.setTextColor(eyecareTextBlack)
                binding.tvTransferPageTitle.setTextColor(eyecareTextBlack)
                binding.tvVaultSectionTitle.setTextColor(eyecareTextBlack)
                binding.tvThemeTitle.setTextColor(eyecareTextBlack)
                binding.tvSettingsNetTitle.setTextColor(eyecareTextBlack)
                binding.tvSettingsSecurityTitle.setTextColor(eyecareTextBlack)
                binding.tvStorageTitle.setTextColor(eyecareTextBlack)
                binding.tvCurrentStoragePath.setTextColor(eyecareSubText)
                binding.tvSendMedia.setTextColor(eyecareTextBlack)
                binding.tvSendFiles.setTextColor(eyecareTextBlack)

                // 选项与操作按钮：文字为黑色，背景采用浅绿点缀
                binding.btnShowMyQr.setBackgroundColor(Color.parseColor("#E5D9C0"))
                binding.btnShowMyQr.setTextColor(eyecareTextBlack)
                binding.btnShowMyQr.iconTint = ColorStateList.valueOf(eyecareTextBlack)
                binding.btnScanQr.setBackgroundColor(eyecareLightGreen)
                binding.btnScanQr.setTextColor(eyecareTextBlack)
                binding.btnInputPin.setBackgroundColor(Color.parseColor("#E5D9C0"))
                binding.btnInputPin.setTextColor(eyecareTextBlack)
                binding.btnClearCompletedTasks.setTextColor(eyecareTextBlack)
                binding.btnRefreshVault.setTextColor(eyecareTextBlack)
                binding.btnChangeStoragePath.setTextColor(eyecareTextBlack)
                binding.btnOpenStorageFolder.setBackgroundColor(eyecareLightGreen)
                binding.btnOpenStorageFolder.setTextColor(eyecareTextBlack)

                // 广播雷达核心元素浅绿点缀
                binding.beaconOuterRing.backgroundTintList = ColorStateList.valueOf(eyecareLightGreen)
                binding.beaconInnerIcon.backgroundTintList = ColorStateList.valueOf(eyecareLightGreen)
                binding.beaconInnerIcon.imageTintList = ColorStateList.valueOf(eyecareTextBlack)
                binding.tvOnlineCountTag.backgroundTintList = ColorStateList.valueOf(eyecareLightGreen)
                binding.tvOnlineCountTag.setTextColor(Color.parseColor("#1B6B40"))

                // Page 2 互传会话窗口元素
                binding.cardActivePeerInfo.setCardBackgroundColor(eyecareCardBg)
                binding.cardActivePeerInfo.strokeColor = eyecareStroke
                binding.tvActivePeerName.setTextColor(eyecareTextBlack)
                binding.tvActivePeerMeta.setTextColor(eyecareSubText)
                binding.tvActivePeerTag.setTextColor(Color.parseColor("#1B6B40"))
                binding.tvActivePeerTag.backgroundTintList = ColorStateList.valueOf(eyecareLightGreen)
                binding.ivActivePeerAvatar.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#DFD5BE"))
                binding.ivActivePeerAvatar.imageTintList = ColorStateList.valueOf(eyecareTextBlack)
                binding.btnActivePeerQuickSend.setBackgroundColor(eyecareLightGreen)
                binding.btnActivePeerQuickSend.setTextColor(eyecareTextBlack)
                binding.btnActivePeerQuickSend.iconTint = ColorStateList.valueOf(eyecareTextBlack)

                binding.layoutChatInputBar.setBackgroundColor(Color.parseColor("#DFD5BE"))
                binding.chatInputBarDivider.setBackgroundColor(Color.parseColor("#D5C7AA"))
                binding.btnChannelPickFile.setBackgroundColor(Color.parseColor("#E5D9C0"))
                binding.btnChannelPickFile.iconTint = ColorStateList.valueOf(eyecareTextBlack)
                binding.etChannelMessage.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#F5EDDC"))
                binding.etChannelMessage.setTextColor(eyecareTextBlack)
                binding.etChannelMessage.setHintTextColor(Color.parseColor("#7A7160"))
                binding.btnChannelSendMessage.setBackgroundColor(eyecareLightGreen)
                binding.btnChannelSendMessage.iconTint = ColorStateList.valueOf(eyecareTextBlack)
                binding.tvEmptyChannelMessages.setTextColor(eyecareSubText)

                // 主题切换按钮选项：背景色与所代表/选择主题保持严格一致
                applyThemeOptionStyles("eyecare")

                binding.tvSettingsLocalIp.setTextColor(eyecareSubText)
                binding.tvSettingsTargetPc.setTextColor(eyecareSubText)
                binding.tvSettingsMulticast.setTextColor(Color.parseColor("#1B6B40"))
                binding.tvSettingsSecurityDesc.setTextColor(eyecareSubText)

                // 底栏导航：背景米黄，四个页面选项选中后的背景色（指示胶囊）改为与主题一致的浅绿点缀 (#CDE8D5)，文字/图标纯黑
                binding.bottomNavigation.setBackgroundColor(Color.parseColor("#DFD5BE"))
                binding.bottomNavigation.itemActiveIndicatorColor = ColorStateList.valueOf(eyecareLightGreen)
                binding.bottomNavigation.isItemActiveIndicatorEnabled = true
                val eyecareNavColors = getNavColorStateList(eyecareTextBlack, Color.parseColor("#6B614D"))
                binding.bottomNavigation.itemTextColor = eyecareNavColors
                binding.bottomNavigation.itemIconTintList = eyecareNavColors
            }
            "light" -> {
                binding.mainCoordinatorLayout.setBackgroundColor(Color.parseColor("#F1F4F9"))
                binding.mainAppBarLayout.setBackgroundColor(Color.parseColor("#FFFFFF"))
                binding.topAppBar.setTitleTextColor(Color.parseColor("#000000"))
                binding.topAppBar.setSubtitleTextColor(Color.parseColor("#64748B"))

                val lightCardBg = Color.parseColor("#FFFFFF")
                val lightStroke = Color.parseColor("#E2E8F0")
                val lightTextBlack = Color.parseColor("#000000")
                val lightSubText = Color.parseColor("#64748B")
                val lightBtnBg = Color.parseColor("#E2E8F0")

                binding.cardRadar.setCardBackgroundColor(lightCardBg)
                binding.cardRadar.strokeColor = lightStroke
                binding.cardSendMedia.setCardBackgroundColor(lightCardBg)
                binding.cardSendMedia.strokeColor = lightStroke
                binding.cardSendFiles.setCardBackgroundColor(lightCardBg)
                binding.cardSendFiles.strokeColor = lightStroke
                binding.cardStorageSettings.setCardBackgroundColor(lightCardBg)
                binding.cardStorageSettings.strokeColor = lightStroke
                binding.cardSettingsTheme.setCardBackgroundColor(lightCardBg)
                binding.cardSettingsTheme.strokeColor = lightStroke
                binding.cardSettingsNetwork.setCardBackgroundColor(lightCardBg)
                binding.cardSettingsNetwork.strokeColor = lightStroke
                binding.cardSettingsSecurity.setCardBackgroundColor(lightCardBg)
                binding.cardSettingsSecurity.strokeColor = lightStroke

                binding.tvBeaconTitle.setTextColor(lightTextBlack)
                binding.tvDeviceSectionTitle.setTextColor(lightTextBlack)
                binding.tvTransferSectionTitle.setTextColor(lightTextBlack)
                binding.tvTransferPageTitle.setTextColor(lightTextBlack)
                binding.tvVaultSectionTitle.setTextColor(lightTextBlack)
                binding.tvThemeTitle.setTextColor(lightTextBlack)
                binding.tvSettingsNetTitle.setTextColor(lightTextBlack)
                binding.tvSettingsSecurityTitle.setTextColor(lightTextBlack)
                binding.tvStorageTitle.setTextColor(lightTextBlack)
                binding.tvCurrentStoragePath.setTextColor(lightSubText)
                binding.tvSendMedia.setTextColor(lightTextBlack)
                binding.tvSendFiles.setTextColor(lightTextBlack)

                // 选项与操作按钮：文字为黑色
                binding.btnShowMyQr.setBackgroundColor(Color.parseColor("#F1F5F9"))
                binding.btnShowMyQr.setTextColor(lightTextBlack)
                binding.btnShowMyQr.iconTint = ColorStateList.valueOf(lightTextBlack)
                binding.btnScanQr.setBackgroundColor(lightBtnBg)
                binding.btnScanQr.setTextColor(lightTextBlack)
                binding.btnInputPin.setBackgroundColor(Color.parseColor("#F1F5F9"))
                binding.btnInputPin.setTextColor(lightTextBlack)
                binding.btnClearCompletedTasks.setTextColor(lightTextBlack)
                binding.btnRefreshVault.setTextColor(lightTextBlack)
                binding.btnChangeStoragePath.setTextColor(lightTextBlack)
                binding.btnOpenStorageFolder.setBackgroundColor(Color.parseColor("#E2E8F0"))
                binding.btnOpenStorageFolder.setTextColor(lightTextBlack)

                binding.beaconOuterRing.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#2563EB"))
                binding.beaconInnerIcon.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#2563EB"))
                binding.beaconInnerIcon.imageTintList = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
                binding.tvOnlineCountTag.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#DBEAFE"))
                binding.tvOnlineCountTag.setTextColor(Color.parseColor("#1E40AF"))

                // Page 2 互传会话窗口元素
                binding.cardActivePeerInfo.setCardBackgroundColor(lightCardBg)
                binding.cardActivePeerInfo.strokeColor = lightStroke
                binding.tvActivePeerName.setTextColor(lightTextBlack)
                binding.tvActivePeerMeta.setTextColor(lightSubText)
                binding.tvActivePeerTag.setTextColor(Color.parseColor("#2563EB"))
                binding.tvActivePeerTag.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#DBEAFE"))
                binding.ivActivePeerAvatar.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#F1F5F9"))
                binding.ivActivePeerAvatar.imageTintList = ColorStateList.valueOf(Color.parseColor("#2563EB"))
                binding.btnActivePeerQuickSend.setBackgroundColor(Color.parseColor("#2563EB"))
                binding.btnActivePeerQuickSend.setTextColor(Color.parseColor("#FFFFFF"))
                binding.btnActivePeerQuickSend.iconTint = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))

                binding.layoutChatInputBar.setBackgroundColor(Color.parseColor("#FFFFFF"))
                binding.chatInputBarDivider.setBackgroundColor(Color.parseColor("#E2E8F0"))
                binding.btnChannelPickFile.setBackgroundColor(Color.parseColor("#F1F5F9"))
                binding.btnChannelPickFile.iconTint = ColorStateList.valueOf(lightTextBlack)
                binding.etChannelMessage.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#F1F5F9"))
                binding.etChannelMessage.setTextColor(lightTextBlack)
                binding.etChannelMessage.setHintTextColor(lightSubText)
                binding.btnChannelSendMessage.setBackgroundColor(Color.parseColor("#2563EB"))
                binding.btnChannelSendMessage.iconTint = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
                binding.tvEmptyChannelMessages.setTextColor(lightSubText)

                // 主题切换按钮选项：背景色与所代表/选择主题保持严格一致
                applyThemeOptionStyles("light")

                binding.tvSettingsLocalIp.setTextColor(lightSubText)
                binding.tvSettingsTargetPc.setTextColor(lightSubText)
                binding.tvSettingsMulticast.setTextColor(Color.parseColor("#166534"))
                binding.tvSettingsSecurityDesc.setTextColor(lightSubText)

                // 底栏导航：背景纯白，四个页面选项选中后的背景色（指示胶囊）改为明亮一致的清爽浅灰 (#E2E8F0)，文字/图标纯黑
                binding.bottomNavigation.setBackgroundColor(Color.parseColor("#FFFFFF"))
                binding.bottomNavigation.itemActiveIndicatorColor = ColorStateList.valueOf(Color.parseColor("#E2E8F0"))
                binding.bottomNavigation.isItemActiveIndicatorEnabled = true
                val lightNavColors = getNavColorStateList(lightTextBlack, Color.parseColor("#64748B"))
                binding.bottomNavigation.itemTextColor = lightNavColors
                binding.bottomNavigation.itemIconTintList = lightNavColors
            }
            else -> { // dark
                binding.mainCoordinatorLayout.setBackgroundColor(Color.parseColor("#0B0F19"))
                binding.mainAppBarLayout.setBackgroundColor(Color.parseColor("#111827"))
                binding.topAppBar.setTitleTextColor(Color.parseColor("#F8FAFC"))
                binding.topAppBar.setSubtitleTextColor(Color.parseColor("#94A3B8"))

                val darkCardBg = Color.parseColor("#111827")
                val darkStroke = Color.parseColor("#334155")
                val darkTextWhite = Color.parseColor("#F8FAFC")
                val darkSubText = Color.parseColor("#94A3B8")

                binding.cardRadar.setCardBackgroundColor(darkCardBg)
                binding.cardRadar.strokeColor = darkStroke
                binding.cardSendMedia.setCardBackgroundColor(darkCardBg)
                binding.cardSendMedia.strokeColor = darkStroke
                binding.cardSendFiles.setCardBackgroundColor(darkCardBg)
                binding.cardSendFiles.strokeColor = darkStroke
                binding.cardStorageSettings.setCardBackgroundColor(darkCardBg)
                binding.cardStorageSettings.strokeColor = darkStroke
                binding.cardSettingsTheme.setCardBackgroundColor(darkCardBg)
                binding.cardSettingsTheme.strokeColor = darkStroke
                binding.cardSettingsNetwork.setCardBackgroundColor(darkCardBg)
                binding.cardSettingsNetwork.strokeColor = darkStroke
                binding.cardSettingsSecurity.setCardBackgroundColor(darkCardBg)
                binding.cardSettingsSecurity.strokeColor = darkStroke

                binding.tvBeaconTitle.setTextColor(darkTextWhite)
                binding.tvDeviceSectionTitle.setTextColor(darkTextWhite)
                binding.tvTransferSectionTitle.setTextColor(darkTextWhite)
                binding.tvTransferPageTitle.setTextColor(darkTextWhite)
                binding.tvVaultSectionTitle.setTextColor(darkTextWhite)
                binding.tvThemeTitle.setTextColor(darkTextWhite)
                binding.tvSettingsNetTitle.setTextColor(darkTextWhite)
                binding.tvSettingsSecurityTitle.setTextColor(darkTextWhite)
                binding.tvStorageTitle.setTextColor(darkTextWhite)
                binding.tvCurrentStoragePath.setTextColor(darkSubText)
                binding.tvSendMedia.setTextColor(darkTextWhite)
                binding.tvSendFiles.setTextColor(darkTextWhite)

                binding.btnShowMyQr.setBackgroundColor(Color.parseColor("#1F2937"))
                binding.btnShowMyQr.setTextColor(Color.parseColor("#06B6D4"))
                binding.btnShowMyQr.iconTint = ColorStateList.valueOf(Color.parseColor("#06B6D4"))
                binding.btnScanQr.setBackgroundColor(Color.parseColor("#4F46E5"))
                binding.btnScanQr.setTextColor(Color.parseColor("#FFFFFF"))
                binding.btnInputPin.setBackgroundColor(Color.parseColor("#1F2937"))
                binding.btnInputPin.setTextColor(Color.parseColor("#06B6D4"))
                binding.btnClearCompletedTasks.setTextColor(Color.parseColor("#818CF8"))
                binding.btnRefreshVault.setTextColor(Color.parseColor("#818CF8"))
                binding.btnChangeStoragePath.setTextColor(Color.parseColor("#818CF8"))
                binding.btnOpenStorageFolder.setBackgroundColor(Color.parseColor("#1F2937"))
                binding.btnOpenStorageFolder.setTextColor(Color.parseColor("#F8FAFC"))

                binding.beaconOuterRing.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#4F46E5"))
                binding.beaconInnerIcon.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#4F46E5"))
                binding.beaconInnerIcon.imageTintList = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
                binding.tvOnlineCountTag.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#1E293B"))
                binding.tvOnlineCountTag.setTextColor(Color.parseColor("#34D399"))

                // Page 2 互传会话窗口元素
                binding.cardActivePeerInfo.setCardBackgroundColor(darkCardBg)
                binding.cardActivePeerInfo.strokeColor = darkStroke
                binding.tvActivePeerName.setTextColor(darkTextWhite)
                binding.tvActivePeerMeta.setTextColor(darkSubText)
                binding.tvActivePeerTag.setTextColor(Color.parseColor("#38BDF8"))
                binding.tvActivePeerTag.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#1E293B"))
                binding.ivActivePeerAvatar.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#1E293B"))
                binding.ivActivePeerAvatar.imageTintList = ColorStateList.valueOf(Color.parseColor("#38BDF8"))
                binding.btnActivePeerQuickSend.setBackgroundColor(Color.parseColor("#4F46E5"))
                binding.btnActivePeerQuickSend.setTextColor(Color.parseColor("#FFFFFF"))
                binding.btnActivePeerQuickSend.iconTint = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))

                binding.layoutChatInputBar.setBackgroundColor(Color.parseColor("#111827"))
                binding.chatInputBarDivider.setBackgroundColor(Color.parseColor("#1F2937"))
                binding.btnChannelPickFile.setBackgroundColor(Color.parseColor("#1F2937"))
                binding.btnChannelPickFile.iconTint = ColorStateList.valueOf(Color.parseColor("#06B6D4"))
                binding.etChannelMessage.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#1F2937"))
                binding.etChannelMessage.setTextColor(darkTextWhite)
                binding.etChannelMessage.setHintTextColor(darkSubText)
                binding.btnChannelSendMessage.setBackgroundColor(Color.parseColor("#4F46E5"))
                binding.btnChannelSendMessage.iconTint = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
                binding.tvEmptyChannelMessages.setTextColor(darkSubText)

                // 主题切换按钮选项：背景色与所代表/选择主题保持严格一致
                applyThemeOptionStyles("dark")

                binding.tvSettingsLocalIp.setTextColor(darkSubText)
                binding.tvSettingsTargetPc.setTextColor(darkSubText)
                binding.tvSettingsMulticast.setTextColor(Color.parseColor("#10B981"))
                binding.tvSettingsSecurityDesc.setTextColor(darkSubText)

                // 底栏导航：背景深蓝黑，四个页面选项选中后的背景色（指示胶囊）改为暗黑一致的深邃蓝黑 (#1F2937)，文字/图标高亮
                binding.bottomNavigation.setBackgroundColor(Color.parseColor("#111827"))
                binding.bottomNavigation.itemActiveIndicatorColor = ColorStateList.valueOf(Color.parseColor("#1F2937"))
                binding.bottomNavigation.isItemActiveIndicatorEnabled = true
                val darkNavColors = getNavColorStateList(Color.parseColor("#818CF8"), Color.parseColor("#94A3B8"))
                binding.bottomNavigation.itemTextColor = darkNavColors
                binding.bottomNavigation.itemIconTintList = darkNavColors
            }
        }
    }

    /**
     * 外观与色彩主题选项背景色和选择主题改为一致：
     * 无论当前处于何种全局模式，各个主题选项卡片的背景色与其自身代表的主题色调完全一致：
     * 1. 🌙 暗黑选项：沉稳深邃蓝黑 (#111827)，文字为纯白 (#FFFFFF)
     * 2. 🌿 护眼选项：醇润深米黄色 (#EDE4D0)，文字为纯黑 (#000000)，选中有机深绿描边 (#2E7D56)
     * 3. ☀️ 明亮选项：纯净雅致白色 (#FFFFFF)，文字为纯黑 (#000000)
     *
     * 选中的主题选项：
     * - 背景保持所选主题的高保真原色
     * - 拥有高对比度高亮描边 (2.5dp) 与 选中对勾状态标识 (✓)
     * - 护眼与明亮模式下选中文字均为纯黑 (#000000)
     * - 带有 4dp 浮起阴影高亮指示
     * 未选中的主题选项：
     * - 维持代表色背景与细腻 1dp 轮廓，提供所见即所得的直观色彩预览
     */
    private fun applyThemeOptionStyles(activeTheme: String) {
        val density = resources.displayMetrics.density
        val activeStrokeWidth = (2.5f * density).toInt()
        val normalStrokeWidth = (1.0f * density).toInt()

        // 1. 🌙 暗黑选项 (背景色恒为暗黑主题色 #111827，文字为纯白 #FFFFFF)
        val darkBg = Color.parseColor("#111827")
        binding.btnThemeDark.backgroundTintList = ColorStateList.valueOf(darkBg)
        if (activeTheme == "dark") {
            binding.btnThemeDark.strokeWidth = activeStrokeWidth
            binding.btnThemeDark.strokeColor = ColorStateList.valueOf(Color.parseColor("#6366F1"))
            binding.btnThemeDark.setTextColor(Color.parseColor("#FFFFFF"))
            binding.btnThemeDark.text = "✓ 🌙 暗黑"
            binding.btnThemeDark.elevation = 4f * density
        } else {
            binding.btnThemeDark.strokeWidth = normalStrokeWidth
            binding.btnThemeDark.strokeColor = ColorStateList.valueOf(Color.parseColor("#334155"))
            binding.btnThemeDark.setTextColor(Color.parseColor("#94A3B8"))
            binding.btnThemeDark.text = "🌙 暗黑"
            binding.btnThemeDark.elevation = 0f
        }

        // 2. 🌿 护眼选项 (背景色恒为深润米黄色 #EDE4D0，文字为纯黑 #000000，选中时呈现典雅深绿边框 #2E7D56)
        val eyecareBg = Color.parseColor("#EDE4D0")
        binding.btnThemeEyecare.backgroundTintList = ColorStateList.valueOf(eyecareBg)
        if (activeTheme == "eyecare") {
            binding.btnThemeEyecare.strokeWidth = activeStrokeWidth
            binding.btnThemeEyecare.strokeColor = ColorStateList.valueOf(Color.parseColor("#2E7D56"))
            binding.btnThemeEyecare.setTextColor(Color.parseColor("#000000"))
            binding.btnThemeEyecare.text = "✓ 🌿 护眼"
            binding.btnThemeEyecare.elevation = 4f * density
        } else {
            binding.btnThemeEyecare.strokeWidth = normalStrokeWidth
            binding.btnThemeEyecare.strokeColor = ColorStateList.valueOf(Color.parseColor("#D5C7AA"))
            binding.btnThemeEyecare.setTextColor(Color.parseColor("#5A5243"))
            binding.btnThemeEyecare.text = "🌿 护眼"
            binding.btnThemeEyecare.elevation = 0f
        }

        // 3. ☀️ 明亮选项 (背景色恒为明亮纯白色 #FFFFFF，文字为纯黑 #000000)
        val lightBg = Color.parseColor("#FFFFFF")
        binding.btnThemeLight.backgroundTintList = ColorStateList.valueOf(lightBg)
        if (activeTheme == "light") {
            binding.btnThemeLight.strokeWidth = activeStrokeWidth
            // 明亮模式下选中文字与高亮边框均为纯黑
            binding.btnThemeLight.strokeColor = ColorStateList.valueOf(Color.parseColor("#000000"))
            binding.btnThemeLight.setTextColor(Color.parseColor("#000000"))
            binding.btnThemeLight.text = "✓ ☀️ 明亮"
            binding.btnThemeLight.elevation = 4f * density
        } else {
            binding.btnThemeLight.strokeWidth = normalStrokeWidth
            binding.btnThemeLight.strokeColor = ColorStateList.valueOf(Color.parseColor("#CBD5E1"))
            binding.btnThemeLight.setTextColor(Color.parseColor("#64748B"))
            binding.btnThemeLight.text = "☀️ 明亮"
            binding.btnThemeLight.elevation = 0f
        }
    }

    override fun onResume() {
        super.onResume()
        multicastLockHelper.acquire()

        val localIp = NetworkHelper.getLocalWifiIpv4(this)
        val serverPort = mobileTransferServer?.port ?: 8899
        binding.topAppBar.subtitle = "本机: $localIp:$serverPort | 跨平台快传"

        scanAndRefreshLanTopology()
        refreshVaultFiles()
        refreshDeviceNames()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleIncomingSharedUris(intent)
    }

    private fun handleIncomingSharedUris(intent: Intent?) {
        val uris = intent?.getParcelableArrayListExtra<Uri>("EXTRA_SHARED_URIS")
        if (!uris.isNullOrEmpty()) {
            for (u in uris) {
                startStreamingUpload(u)
            }
        }
    }

    override fun onStop() {
        super.onStop()
        multicastLockHelper.release()
    }

    override fun onDestroy() {
        super.onDestroy()
        mobileTransferServer?.stop()
        udpDiscoveryHelper?.stop()
    }

    /**
     * Concurrent LAN scan discovering all online devices (PC Desktop Hubs & Android peers)
     * All devices appear in topology without forcing immediate connection!
     */
    private fun scanAndRefreshLanTopology() {
        lifecycleScope.launch {
            val localIp = NetworkHelper.getLocalWifiIpv4(this@MainActivity)
            if (localIp == "127.0.0.1") {
                updateDeviceListUI()
                return@launch
            }

            val subnet = NetworkHelper.getSubnetPrefix(localIp)
            binding.tvRadarStatus.text = "正在全向发现局域网设备 (${subnet}*)..."

            val activeIps = withContext(Dispatchers.IO) {
                NetworkHelper.probeAllLanNodes(this@MainActivity, 8899)
            }

            val sPort = mobileTransferServer?.port ?: 8899
            val myFp = mobileTransferServer?.fingerprint ?: ""

            for (ip in activeIps) {
                if (ip == localIp) continue
                val info = withContext(Dispatchers.IO) {
                    hubClient.fetchHubInfo(ip, 8899)
                }
                val devType = info?.get("device_type")?.asString
                    ?: info?.get("os")?.asString
                    ?: "pc"
                val isPc = devType != "android"
                val devName = if (info != null && info.has("name")) {
                    info.get("name").asString
                } else if (info != null && info.has("host")) {
                    info.getAsJsonObject("host").get("name")?.asString ?: (if (isPc) "Desktop Hub ($ip)" else "Android ($ip)")
                } else {
                    if (isPc) "Desktop Hub ($ip)" else "Android 手机 ($ip)"
                }
                val devFp = if (info != null && info.has("fingerprint")) {
                    info.get("fingerprint").asString
                } else ""

                val dev = DiscoveredDevice(
                    id = if (isPc) "pc-$ip" else "android-$ip",
                    name = devName,
                    host = ip,
                    port = 8899,
                    fingerprint = devFp,
                    deviceType = if (isPc) "pc" else "android"
                )

                val existingIdx = discoveredDevices.indexOfFirst { it.host == ip }
                if (existingIdx >= 0) {
                    discoveredDevices[existingIdx] = dev
                } else {
                    discoveredDevices.add(dev)
                }

                // Announce our presence to discovered node
                withContext(Dispatchers.IO) {
                    hubClient.announceDevice(ip, 8899, "Android ($localIp)", myFp, sPort)
                }
            }

            updateDeviceListUI()
            if (discoveredDevices.isNotEmpty()) {
                binding.tvRadarStatus.text = "📡 局域网全向拓扑已就绪，发现 ${discoveredDevices.size} 台在线设备（待命可投送）"
            } else {
                binding.tvRadarStatus.text = "局域网监听中 (UDP 8890 通道)... 可点击右上角扫码连接"
            }
        }
    }

    /**
     * Show manual 6-digit dynamic PIN pairing dialog
     */
    private fun showPinPairingDialog(
        defaultHost: String,
        defaultPort: Int,
        onPaired: (() -> Unit)? = null
    ) {
        val localIp = NetworkHelper.getLocalWifiIpv4(this)
        val savedHost = prefs.getString("connected_host", null)

        val initialHost = when {
            defaultHost.isNotEmpty() && defaultHost != "127.0.0.1" -> defaultHost
            !savedHost.isNullOrEmpty() && savedHost != "127.0.0.1" -> savedHost
            localIp != "127.0.0.1" -> NetworkHelper.getDefaultGateway(this)
            else -> localIp
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(60, 40, 60, 20)
        }

        val tvLocalIp = TextView(this).apply {
            text = "📱 本机局域网 IP: $localIp\n💻 请输入目标设备展示的局域网 IP 与 6 位 PIN 码"
            setTextColor(Color.parseColor("#10B981"))
            textSize = 12f
            setPadding(0, 0, 0, 16)
        }

        val etHost = EditText(this).apply {
            hint = "目标设备 IP 地址 (如 192.168.10.42)"
            setText(initialHost)
        }
        val etPin = EditText(this).apply {
            hint = "目标端屏幕显示的 6 位动态 PIN 码"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
        }

        layout.addView(tvLocalIp)
        layout.addView(etHost)
        layout.addView(etPin)

        AlertDialog.Builder(this)
            .setTitle("🔑 动态 PIN 码安全配对")
            .setView(layout)
            .setPositiveButton("立即配对") { _, _ ->
                val inputHost = etHost.text.toString().trim()
                val inputPin = etPin.text.toString().trim()
                if (inputHost.isNotEmpty() && inputPin.isNotEmpty()) {
                    prefs.edit().putString("connected_host", inputHost).apply()
                    handlePairingResult(inputHost, defaultPort, "", "", inputPin, onPaired)
                } else {
                    Toast.makeText(this, "请输入完整的 IP 与 6 位 PIN 码", Toast.LENGTH_SHORT).show()
                }
            }
            .setNeutralButton("目标端换一组") { _, _ ->
                val hostToUse = etHost.text.toString().trim().ifEmpty { initialHost }
                lifecycleScope.launch {
                    val res = hubClient.refreshPin(hostToUse, defaultPort)
                    if (res != null && res.has("pin")) {
                        val newPin = res.get("pin").asString
                        Toast.makeText(this@MainActivity, "目标端已刷新 PIN: $newPin", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(this@MainActivity, "请在目标端主界面点击“换一组”按钮刷新 PIN", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * Show storage folder selection dialog
     */
    private fun showStorageChoiceDialog() {
        val options = arrayOf(
            "系统公共下载目录 (Download/SafeDrop - 推荐)",
            "相册自适应目录 (Pictures/SafeDrop - 媒体秒刷新)",
            "应用私有沙箱目录 (Android/data/com.safedrop.mobile)"
        )
        AlertDialog.Builder(this)
            .setTitle("📁 选择 SafeDrop 文件接收目录")
            .setItems(options) { _, which ->
                val chosenPath = when (which) {
                    1 -> storageHelper.setCustomStorageType("pictures")
                    2 -> storageHelper.setCustomStorageType("private")
                    else -> storageHelper.setCustomStorageType("download")
                }
                binding.tvCurrentStoragePath.text = chosenPath
                Toast.makeText(this, "文件接收目录已切换: $chosenPath", Toast.LENGTH_SHORT).show()
                refreshVaultFiles()
            }
            .setPositiveButton("在文件管理器中打开") { _, _ ->
                try {
                    startActivity(storageHelper.createOpenFolderIntent())
                } catch (e: Exception) {
                    Toast.makeText(this, "已进入目录 Download/SafeDrop", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("关闭", null)
            .show()
    }

    /**
     * Negotiate an encrypted session directly with a peer device, reusing the pairing secret
     * from the most recent QR scan or PIN entry for that host.
     *
     * A phone-to-phone transfer needs a key shared with the destination, and the desktop hub
     * has no session with that phone, so the sender must pair with the peer itself.
     *
     * @return true when the peer proved the same session key.
     */
    private suspend fun pairWithTargetDirectly(host: String, port: Int): Boolean {
        val secret = pairingSecrets["$host:$port"]
            ?: pairingSecrets[connectedHost.let { "$it:$connectedPort" }]
            ?: prefs.getString("pairing_secret", null)
            ?: return false

        val pingOk = hubClient.ping(host, port)
        if (!pingOk) return false

        val keyPair = cryptoEngine.generateEphemeralKeyPair()
        val rawPubKeyHex = cryptoEngine.bytesToHex(cryptoEngine.extractRawPublicKey(keyPair))
        val handshake = hubClient.initHandshake(host, port, rawPubKeyHex) ?: return false

        val sessionId = handshake.get("session_id")?.asString ?: return false
        val serverPubKeyHex = handshake.get("server_public_key")?.asString ?: return false

        val sessionKey = try {
            cryptoEngine.deriveSessionKey(
                localKeyPair = keyPair,
                remoteRawPublicKey = cryptoEngine.hexToBytes(serverPubKeyHex),
                sessionId = sessionId,
                pairingSecret = secret
            )
        } catch (e: Exception) {
            Log.w("MainActivity", "Session key derivation failed for $host:$port: ${e.message}")
            return false
        }

        val proofHex = cryptoEngine.bytesToHex(cryptoEngine.clientProof(sessionKey, sessionId))
        val verifyResp = hubClient.verifyHandshake(host, port, sessionId, proofHex) ?: return false
        val serverProofHex = verifyResp.get("server_proof")?.asString ?: return false
        if (!cryptoEngine.verifyServerProof(sessionKey, sessionId, serverProofHex)) return false

        hubClient.setSession(host, port, sessionId, sessionKey)
        Log.i("MainActivity", "Direct encrypted session established with $host:$port")
        return true
    }

    /**
     * Handle pairing result and perform handshake
     */
    private fun handlePairingResult(
        ip: String,
        port: Int,
        fp: String,
        token: String,
        pin: String,
        onPaired: (() -> Unit)? = null
    ) {
        connectedHost = ip
        connectedPort = port
        targetFingerprint = fp
        prefs.edit().putString("connected_host", ip).apply()

        lifecycleScope.launch {
            binding.tvRadarStatus.text = "正在穿透连接 $ip:$port..."

            // 1. Ping connection channel
            val pingOk = hubClient.ping(ip, port)
            if (!pingOk) {
                Toast.makeText(this@MainActivity, "无法连接到目标设备 ($ip:$port)，请确认在同一局域网", Toast.LENGTH_LONG).show()
                binding.tvRadarStatus.text = "连接设备超时，请核对局域网 Wi-Fi"
                return@launch
            }

            // 2. Ephemeral ECDH key agreement
            val keyPair = cryptoEngine.generateEphemeralKeyPair()
            val rawPubKey = cryptoEngine.extractRawPublicKey(keyPair)
            val rawPubKeyHex = cryptoEngine.bytesToHex(rawPubKey)

            val handshakeResp = hubClient.initHandshake(ip, port, rawPubKeyHex)
            if (handshakeResp == null) {
                Toast.makeText(this@MainActivity, "密钥协商握手失败", Toast.LENGTH_SHORT).show()
                return@launch
            }

            val sessionId = handshakeResp.get("session_id")?.asString
            val serverPubKeyHex = handshakeResp.get("server_public_key")?.asString
            if (sessionId.isNullOrEmpty() || serverPubKeyHex.isNullOrEmpty()) {
                Toast.makeText(this@MainActivity, "握手响应缺少会话参数", Toast.LENGTH_SHORT).show()
                return@launch
            }

            // 3. Derive the session key locally. The pairing secret (PIN or QR token) stays on
            //    this device: it is used as HKDF input and proven via HMAC, never transmitted.
            val pairingSecret = when {
                pin.isNotEmpty() -> pin
                token.isNotEmpty() -> token
                else -> {
                    Toast.makeText(this@MainActivity, "缺少配对信息，请重新扫码", Toast.LENGTH_SHORT).show()
                    return@launch
                }
            }

            val sessionKey = try {
                cryptoEngine.deriveSessionKey(
                    localKeyPair = keyPair,
                    remoteRawPublicKey = cryptoEngine.hexToBytes(serverPubKeyHex),
                    sessionId = sessionId,
                    pairingSecret = pairingSecret
                )
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "会话密钥派生失败: ${e.message}", Toast.LENGTH_SHORT).show()
                return@launch
            }

            val clientProofHex = cryptoEngine.bytesToHex(cryptoEngine.clientProof(sessionKey, sessionId))
            val verifyResp = hubClient.verifyHandshake(ip, port, sessionId, clientProofHex)
            val serverProofHex = verifyResp?.get("server_proof")?.asString

            if (verifyResp != null && !serverProofHex.isNullOrEmpty() &&
                cryptoEngine.verifyServerProof(sessionKey, sessionId, serverProofHex)) {
                // Both sides proved the same key: the session is mutually authenticated.
                hubClient.setSession(ip, port, sessionId, sessionKey)
                // Remember the secret so a later phone-to-phone transfer to this peer can be
                // encrypted without asking the user to re-enter it.
                pairingSecrets["$ip:$port"] = pairingSecret
                prefs.edit().putString("pairing_secret", pairingSecret).apply()
                isHubConnected = true
                binding.tvRadarStatus.text = "🟢 加密会话已建立：$ip (PIN 核验通过)"
                Toast.makeText(this@MainActivity, "配对成功！已建立端到端加密会话", Toast.LENGTH_LONG).show()

                val info = hubClient.fetchHubInfo(ip, port)
                val devType = info?.get("device_type")?.asString
                    ?: info?.get("os")?.asString
                    ?: "pc"
                val isPc = devType != "android"
                val devName = if (info != null && info.has("name")) {
                    info.get("name").asString
                } else if (info != null && info.has("host")) {
                    info.getAsJsonObject("host").get("name")?.asString ?: (if (isPc) "Desktop Hub ($ip)" else "Android ($ip)")
                } else {
                    if (isPc) "Desktop Hub ($ip)" else "Android 手机 ($ip)"
                }
                val devFp = if (info != null && info.has("fingerprint")) {
                    info.get("fingerprint").asString
                } else fp

                val dev = DiscoveredDevice(
                    id = if (isPc) "pc-$ip" else "android-$ip",
                    name = devName,
                    host = ip,
                    port = port,
                    fingerprint = devFp,
                    deviceType = if (isPc) "pc" else "android"
                )
                discoveredDevices.removeAll { it.host == ip }
                discoveredDevices.add(0, dev)
                selectedTargetDevice = dev
                updateDeviceListUI()

                val localIp = NetworkHelper.getLocalWifiIpv4(this@MainActivity)
                val sPort = mobileTransferServer?.port ?: 8899
                val myFp = mobileTransferServer?.fingerprint ?: ""
                hubClient.announceDevice(ip, port, "Android ($localIp)", myFp, sPort)

                onPaired?.invoke()
            } else {
                binding.tvRadarStatus.text = "❌ 动态 PIN 码核验未通过"
                Toast.makeText(this@MainActivity, "PIN 码已失效或不匹配，请在目标端点击“换一组”刷新重试", Toast.LENGTH_LONG).show()
                showPinPairingDialog(ip, port, onPaired)
            }
        }
    }

    /**
     * Show Local Device Pairing QR Code Dialog
     *
     * This device serves its portal over plain HTTP, where a browser has no WebCrypto and
     * therefore refuses to pair, so the code here is a SafeDrop device pairing code: it carries
     * the fingerprint too, which the old http link dropped, and no longer hands the PIN to
     * whatever camera or browser happens to scan it.
     */
    private fun showMyPairingQrDialog() {
        val localIp = NetworkHelper.getLocalWifiIpv4(this)
        val port = mobileTransferServer?.port ?: 8899
        val fingerprint = mobileTransferServer?.fingerprint ?: ""
        val currentPin = mobileTransferServer?.currentPin ?: "123456"
        val currentToken = mobileTransferServer?.currentToken ?: ""
        val pairingUri = "safedrop://pair?ip=$localIp&port=$port&fp=$fingerprint&token=$currentToken&pin=$currentPin"

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 32, 48, 24)
            gravity = Gravity.CENTER_HORIZONTAL
        }

        val tvDesc = TextView(this).apply {
            text = "📷 请用另一台 SafeDrop 设备的「扫码配对」扫描此码，两端会直接建立加密会话。\n" +
                "浏览器免安装传送门只在 HTTPS 下才能加密，本机目前只提供 http，因此网页端可打开页面但无法配对。"
            textSize = 13f
            setTextColor(if (currentThemeMode == "light" || currentThemeMode == "eyecare") Color.parseColor("#334155") else Color.parseColor("#94A3B8"))
            setPadding(0, 0, 0, 24)
            gravity = Gravity.CENTER_HORIZONTAL
        }

        val ivQr = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                (240 * resources.displayMetrics.density).toInt(),
                (240 * resources.displayMetrics.density).toInt()
            ).apply {
                gravity = Gravity.CENTER_HORIZONTAL
            }
            setPadding(8, 8, 8, 8)
            setBackgroundColor(Color.WHITE)
        }

        val tvPin = TextView(this).apply {
            text = "🔑 本机动态 PIN: $currentPin"
            textSize = 18f
            setTextColor(Color.parseColor("#10B981"))
            setPadding(0, 24, 0, 8)
            gravity = Gravity.CENTER_HORIZONTAL
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }

        val tvUrl = TextView(this).apply {
            text = "🌐 本机地址: $localIp:$port（网页配对需 HTTPS，当前不可用）"
            textSize = 12f
            setTextColor(if (currentThemeMode == "light" || currentThemeMode == "eyecare") Color.parseColor("#475569") else Color.parseColor("#94A3B8"))
            setPadding(0, 0, 0, 16)
            gravity = Gravity.CENTER_HORIZONTAL
        }

        fun updateQrImage(url: String) {
            try {
                val bitmap = generateQrBitmap(url, 512)
                ivQr.setImageBitmap(bitmap)
            } catch (e: Exception) {
                Toast.makeText(this, "生成二维码失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }

        updateQrImage(pairingUri)

        layout.addView(tvDesc)
        layout.addView(ivQr)
        layout.addView(tvPin)
        layout.addView(tvUrl)

        val dialog = AlertDialog.Builder(this)
            .setTitle("📱 本机配对码")
            .setView(layout)
            .setNeutralButton("🔄 换一组") { _, _ -> }
            .setPositiveButton("完成", null)
            .create()

        dialog.show()

        dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener {
            val (newPin, newToken) = mobileTransferServer?.refreshPairingPin() ?: Pair("123456", "")
            tvPin.text = "🔑 本机动态 PIN: $newPin"
            updateQrImage("safedrop://pair?ip=$localIp&port=$port&fp=$fingerprint&token=$newToken&pin=$newPin")
            Toast.makeText(this, "动态 PIN 与二维码已刷新: $newPin", Toast.LENGTH_SHORT).show()
        }
    }

    private fun generateQrBitmap(content: String, size: Int = 512): Bitmap {
        val writer = QRCodeWriter()
        val bitMatrix = writer.encode(content, BarcodeFormat.QR_CODE, size, size)
        val width = bitMatrix.width
        val height = bitMatrix.height
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
        for (x in 0 until width) {
            for (y in 0 until height) {
                bitmap.setPixel(x, y, if (bitMatrix.get(x, y)) Color.BLACK else Color.WHITE)
            }
        }
        return bitmap
    }

    /**
     * Ensure a target device is selected and verified before launching file picker
     */
    private fun prepareTargetAndLaunch(action: () -> Unit) {
        val target = selectedTargetDevice ?: discoveredDevices.firstOrNull { it.host == connectedHost }
        if (target != null) {
            selectedTargetDevice = target
            connectedHost = target.host
            connectedPort = target.port
            prefs.edit().putString("connected_host", target.host).apply()

            if (hubClient.hasSession(target.host, target.port)) {
                action()
            } else {
                showPinPairingDialog(target.host, target.port, onPaired = {
                    action()
                })
            }
        } else if (discoveredDevices.isNotEmpty()) {
            if (discoveredDevices.size == 1) {
                val dev = discoveredDevices[0]
                selectedTargetDevice = dev
                connectedHost = dev.host
                connectedPort = dev.port
                prefs.edit().putString("connected_host", dev.host).apply()

                if (hubClient.hasSession(dev.host, dev.port)) {
                    action()
                } else {
                    showPinPairingDialog(dev.host, dev.port, onPaired = {
                        action()
                    })
                }
            } else {
                val deviceNames = discoveredDevices.map { "${if (it.deviceType == "pc") "💻" else "📱"} ${it.name}" }.toTypedArray()
                AlertDialog.Builder(this)
                    .setTitle("🎯 选择接收设备")
                    .setItems(deviceNames) { _, index ->
                        val dev = discoveredDevices[index]
                        selectedTargetDevice = dev
                        connectedHost = dev.host
                        connectedPort = dev.port
                        prefs.edit().putString("connected_host", dev.host).apply()

                        if (hubClient.hasSession(dev.host, dev.port)) {
                            action()
                        } else {
                            showPinPairingDialog(dev.host, dev.port, onPaired = {
                                action()
                            })
                        }
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
        } else if (connectedHost.isNotEmpty() && connectedHost != "127.0.0.1") {
            showPinPairingDialog(connectedHost, connectedPort, onPaired = {
                action()
            })
        } else {
            Toast.makeText(this, "未发现可投送设备，请等待局域网发现或点击右上角扫码连接", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * Read up to [want] bytes into [buffer], returning how many were actually filled.
     *
     * One read() on a ContentResolver stream is free to return less than was asked for, and since
     * protocol v2 every non-final chunk has to carry exactly the stride the sender committed to -
     * so a short read would abort a transfer that is not in the slightest bit broken. A short
     * result here therefore means end of stream, not a partial read.
     */
    private fun readChunkInto(stream: InputStream, buffer: ByteArray, want: Int): Int {
        var filled = 0
        while (filled < want) {
            val read = stream.read(buffer, filled, want - filled)
            if (read == -1) break
            filled += read
        }
        return filled
    }

    /**
     * Stream chunked upload from Android to target peer (PC Desktop Hub or another Android phone).
     * Every chunk is sealed by [DesktopHubClient.uploadChunk] with the session key negotiated for
     * that peer; an unpaired target is rejected before any byte leaves the device.
     */
    private fun startStreamingUpload(uri: Uri) {
        val fileName = resolveFileName(uri)
        val fileSize = resolveFileSize(uri)

        val target = selectedTargetDevice ?: discoveredDevices.firstOrNull { it.host == connectedHost }
        val targetHost = target?.host ?: connectedHost
        val targetPort = target?.port ?: connectedPort
        val targetName = target?.name ?: "目标设备 ($targetHost)"
        val targetDevId = target?.id ?: (if (targetHost.isNotEmpty()) "peer-$targetHost" else "unknown")

        if (targetHost.isEmpty() || targetHost == "127.0.0.1") {
            Toast.makeText(this, "未指定目标设备，请先在雷达列表中选择或配对", Toast.LENGTH_SHORT).show()
            return
        }

        activePeerId = targetDevId
        // Automatically switch to Transfer & Chat page to show progress
        binding.bottomNavigation.selectedItemId = R.id.nav_transfer

        // Ensure battery optimization exemption for stable transfers
        ensureBatteryOptimizationForTransfer()

        // Start foreground service
        TransferForegroundService.startTransfer(this, fileName)
        val taskId = "task_${System.currentTimeMillis()}"
        transferTaskAdapter.updateProgress(taskId, fileName, 0, 0f, isDownload = false)
        updateTransferEmptyState()

        val list = peerMessages.getOrPut(targetDevId) { mutableListOf() }
        val transferMsg = ChannelMessage(
            id = taskId,
            type = ChannelMessage.Type.FILE,
            isOutgoing = true,
            fileName = fileName,
            fileSize = fileSize,
            progress = 0,
            speed = "0.0 MB/s",
            status = "transferring",
            timestamp = System.currentTimeMillis()
        )
        list.add(transferMsg)
        updatePeerChatUI()

        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val inputStream: InputStream? = contentResolver.openInputStream(uri)
                if (inputStream == null) {
                    withContext(Dispatchers.Main) {
                        transferMsg.status = "failed"
                        channelMessageAdapter.notifyDataSetChanged()
                        Toast.makeText(this@MainActivity, "读取文件失败", Toast.LENGTH_SHORT).show()
                    }
                    return@launch
                }

                // The chunk must be sealed with a key the destination itself holds. When the
                // destination is another phone the hub cannot help: it has no session with that
                // phone, so we negotiate one directly and let the hub forward the sealed bytes.
                if (!hubClient.hasSession(targetHost, targetPort)) {
                    val paired = try {
                        pairWithTargetDirectly(targetHost, targetPort)
                    } catch (e: Exception) {
                        Log.w("MainActivity", "Direct pairing with $targetHost:$targetPort failed: ${e.message}")
                        false
                    }
                    if (!paired) {
                        withContext(Dispatchers.Main) {
                            transferMsg.status = "failed"
                            channelMessageAdapter.notifyDataSetChanged()
                            TransferForegroundService.finishTransfer(this@MainActivity, fileName)
                            Toast.makeText(
                                this@MainActivity,
                                "无法与目标设备建立加密会话，请确认已扫码配对 $targetName",
                                Toast.LENGTH_LONG
                            ).show()
                        }
                        return@launch
                    }
                }

                val chunkSize = ProtocolConst.Chunking.PREFERRED_CHUNK_SIZE_BYTES
                val totalChunks = ((fileSize + chunkSize - 1) / chunkSize).coerceAtLeast(1).toInt()
                val buffer = ByteArray(chunkSize)

                var chunkIndex = 0
                var uploadedBytes = 0L
                val startTime = System.currentTimeMillis()

                inputStream.use { stream ->
                    while (chunkIndex < totalChunks) {
                        val bytesRead = readChunkInto(stream, buffer, chunkSize)
                        val chunkData = if (bytesRead == chunkSize) buffer else buffer.copyOfRange(0, bytesRead)

                        val ok = hubClient.uploadChunk(
                            host = targetHost,
                            port = targetPort,
                            taskId = taskId,
                            fileName = fileName,
                            fileSize = fileSize,
                            chunkIndex = chunkIndex,
                            chunkCount = totalChunks,
                            chunkSize = chunkSize,
                            chunkData = chunkData
                        )

                        if (!ok) {
                            throw Exception("Chunk upload failed for index $chunkIndex")
                        }

                        uploadedBytes += bytesRead
                        chunkIndex++

                        val progress = ((uploadedBytes * 100) / fileSize.coerceAtLeast(1)).toInt().coerceIn(0, 100)
                        val elapsedSeconds = (System.currentTimeMillis() - startTime) / 1000f
                        val speedMbps = if (elapsedSeconds > 0) (uploadedBytes / (1024f * 1024f)) / elapsedSeconds else 0f
                        val speedStr = if (speedMbps > 0) String.format(java.util.Locale.US, "%.1f MB/s", speedMbps) else ""

                        TransferForegroundService.updateProgress(this@MainActivity, fileName, progress, speedMbps)
                        withContext(Dispatchers.Main) {
                            transferTaskAdapter.updateProgress(taskId, fileName, progress, speedMbps, isDownload = false)
                            transferMsg.progress = progress
                            transferMsg.speed = speedStr
                            channelMessageAdapter.notifyDataSetChanged()
                        }
                    }
                }

                TransferForegroundService.finishTransfer(this@MainActivity, fileName)
                withContext(Dispatchers.Main) {
                    transferTaskAdapter.updateProgress(taskId, fileName, 100, 0f, isDownload = false)
                    transferMsg.progress = 100
                    transferMsg.speed = ""
                    transferMsg.status = "completed"
                    channelMessageAdapter.notifyDataSetChanged()
                    Toast.makeText(this@MainActivity, "投送成功：已发送至 $targetName！", Toast.LENGTH_LONG).show()
                }

            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    transferMsg.status = "failed"
                    channelMessageAdapter.notifyDataSetChanged()
                    Toast.makeText(this@MainActivity, "传输中断: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun resolveFileName(uri: Uri): String {
        var name = "safedrop_upload.bin"
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (nameIndex != -1 && cursor.moveToFirst()) {
                name = cursor.getString(nameIndex)
            }
        }
        return name
    }

    private fun resolveFileSize(uri: Uri): Long {
        var size = 0L
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (sizeIndex != -1 && cursor.moveToFirst()) {
                size = cursor.getLong(sizeIndex)
            }
        }
        return size
    }

    /**
     * Request battery optimization exemption to ensure stable background transfers
     * This is crucial for OPPO/VIVO/Xiaomi devices with aggressive battery management
     */
    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return

        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        val packageName = packageName

        if (powerManager.isIgnoringBatteryOptimizations(packageName)) {
            return
        }

        if (hasBatteryOptimizationPrompted) {
            return
        }

        AlertDialog.Builder(this)
            .setTitle("提升传输稳定性")
            .setMessage("为确保大文件传输稳定完成（特别是 OPPO/VIVO/小米设备），建议允许 SafeDrop 在后台运行。\n\n这将防止系统在传输过程中强制关闭应用。")
            .setPositiveButton("前往设置") { _, _ ->
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                    prefs.edit().putBoolean("battery_optimization_prompted", true).apply()
                    hasBatteryOptimizationPrompted = true
                } catch (e: Exception) {
                    Toast.makeText(this, "请在系统设置中手动允许 SafeDrop 后台运行", Toast.LENGTH_LONG).show()
                }
            }
            .setNegativeButton("稍后提醒") { _, _ ->
                // Do not mark as prompted, will ask again next time
            }
            .setNeutralButton("不再提示") { _, _ ->
                prefs.edit().putBoolean("battery_optimization_prompted", true).apply()
                hasBatteryOptimizationPrompted = true
            }
            .setCancelable(false)
            .show()
    }

    /**
     * Check if battery optimization exemption is needed before starting transfer
     */
    private fun ensureBatteryOptimizationForTransfer() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return

        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        if (!powerManager.isIgnoringBatteryOptimizations(packageName) && !hasBatteryOptimizationPrompted) {
            requestBatteryOptimizationExemption()
        }
    }

    /**
     * Fetch device custom names from desktop hub and update cache
     */
    private fun refreshDeviceNames() {
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                // Try to fetch from all discovered PC devices
                val pcDevices = discoveredDevices.filter { it.deviceType == "pc" }
                
                for (device in pcDevices) {
                    val names = hubClient.fetchDeviceNames(device.host, device.port)
                    if (names != null && names.isNotEmpty()) {
                        deviceNameCache.saveDeviceNames(names)
                        withContext(Dispatchers.Main) {
                            updateDeviceListUI()
                        }
                        break // Successfully fetched from one hub
                    }
                }
                
                // Fallback: try connectedHost if no PC devices available
                if (pcDevices.isEmpty() && connectedHost.isNotEmpty() && connectedHost != "127.0.0.1") {
                    val names = hubClient.fetchDeviceNames(connectedHost, connectedPort)
                    if (names != null && names.isNotEmpty()) {
                        deviceNameCache.saveDeviceNames(names)
                        withContext(Dispatchers.Main) {
                            updateDeviceListUI()
                        }
                    }
                }
            } catch (e: Exception) {
                // Silently handle fetch errors, use cached names
            }
        }
    }
}
