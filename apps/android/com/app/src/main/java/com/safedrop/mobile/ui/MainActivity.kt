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
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.addTextChangedListener
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
import com.safedrop.mobile.core.storage.VaultFileItem
import com.safedrop.mobile.databinding.ActivityMainBinding
import com.safedrop.mobile.databinding.DialogMyPairingBinding
import com.safedrop.mobile.databinding.DialogPairingBinding
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.InputStream

/**
 * Mobile main window.
 *
 * Layout: four pages behind a bottom bar (devices, conversation with one peer, received files,
 * settings), an embedded [MobileTransferServer] that receives the peer's sealed chunks, and UDP
 * discovery. Appearance is one of three modes persisted in prefs; every colour they use comes from
 * [Palette], i.e. from res/values/colors.xml, which is the same token contract the desktop uses.
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

    // Media picker: several photos/videos at once, the same as sending from the desktop
    private val pickMediaLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        queueUploads(uris)
    }

    // Document picker: several files at once
    private val pickFileLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        queueUploads(uris)
    }

    /**
     * Files waiting to be sent. One transfer runs at a time: the chunk pipeline holds a full
     * chunk buffer in memory per run, and a peer that is busy receiving three streams at once is
     * slower than a queue that finishes them one after another.
     */
    private val pendingUploads = ArrayDeque<Uri>()
    private var uploadInFlight = false

    /** Pairing sheet state, so a rotated code or a late handshake answer updates it in place. */
    private var pairingDialog: AlertDialog? = null
    private var pairingBinding: DialogPairingBinding? = null
    private var pairingPeerJob: Job? = null
    private var pairingInFlight = false

    /** Pollers that only run while the screen is up. */
    private var vaultRefreshJob: Job? = null
    private var myPairingRefreshJob: Job? = null
    private var cryptoExpanded = false

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
        // 0. This device's own pairing code
        binding.btnShowMyQr.setOnClickListener {
            showMyPairingQrDialog()
        }
        binding.btnShowMyQrFromSettings.setOnClickListener {
            showMyPairingQrDialog()
        }

        // 1. QR code scanner
        binding.btnScanQr.setOnClickListener {
            val intent = Intent(this, QrScannerActivity::class.java)
            scanQrLauncher.launch(intent)
        }

        // 2. Pairing sheet
        binding.btnInputPin.setOnClickListener {
            showPinPairingDialog(connectedHost, connectedPort)
        }

        // 3. Three-state theme switcher in Settings page
        binding.btnThemeDark.setOnClickListener {
            applyThemeMode(Palette.DARK)
        }
        binding.btnThemeEyecare.setOnClickListener {
            applyThemeMode(Palette.EYECARE)
        }
        binding.btnThemeLight.setOnClickListener {
            applyThemeMode(Palette.LIGHT)
        }

        // "About the encryption" is a disclosure, not the headline of the settings page.
        binding.btnCryptoToggle.setOnClickListener {
            cryptoExpanded = !cryptoExpanded
            binding.tvSettingsSecurityDesc.visibility = if (cryptoExpanded) View.VISIBLE else View.GONE
            binding.btnCryptoToggle.setText(
                if (cryptoExpanded) R.string.settings_crypto_collapse else R.string.settings_crypto_expand
            )
        }

        // 4/5. Send photos or documents - either way, several at once
        binding.cardSendMedia.setOnClickListener {
            prepareTargetAndLaunch {
                pickMediaLauncher.launch(arrayOf("image/*", "video/*"))
            }
        }

        binding.cardSendFiles.setOnClickListener {
            prepareTargetAndLaunch {
                pickFileLauncher.launch(arrayOf("*/*"))
            }
        }

        // 6. Where received files land
        binding.tvCurrentStoragePath.text = storageHelper.getStorageDisplayPath()
        binding.btnOpenStorageFolder.setOnClickListener {
            try {
                startActivity(storageHelper.createOpenFolderIntent())
            } catch (e: Exception) {
                Toast.makeText(
                    this,
                    getString(R.string.storage_open_failed, storageHelper.getStorageDisplayPath()),
                    Toast.LENGTH_LONG
                ).show()
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
                    pickFileLauncher.launch(arrayOf("*/*"))
                } else {
                    showPinPairingDialog(dev.host, dev.port, onPaired = {
                        pickFileLauncher.launch(arrayOf("*/*"))
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

        channelMessageAdapter = ChannelMessageAdapter(
            onOpenFile = { msg -> openReceivedFileByName(msg.fileName) },
            onShareFile = { msg -> shareReceivedFileByName(msg.fileName) }
        )
        binding.rvChannelMessages.layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = true
        }
        binding.rvChannelMessages.adapter = channelMessageAdapter

        transferTaskAdapter = TransferTaskAdapter()
        binding.rvTransferTasks.layoutManager = LinearLayoutManager(this)
        binding.rvTransferTasks.adapter = transferTaskAdapter

        binding.btnActivePeerQuickSend.setOnClickListener {
            sendToActivePeer()
        }

        binding.btnChannelPickFile.setOnClickListener {
            sendToActivePeer()
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
                Toast.makeText(this, R.string.chat_cleared, Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, R.string.chat_no_peer, Toast.LENGTH_SHORT).show()
            }
        }

        // 9. Received files (Page 3). Tapping a row opens the file; the row also shares it.
        vaultFileAdapter = VaultFileAdapter(
            onFileClick = { item -> openReceivedFile(item) },
            onFileShare = { item -> shareReceivedFile(item) }
        )
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

                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.transfer_received, fileName),
                        Toast.LENGTH_LONG
                    ).show()
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
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.chat_received, senderName, text),
                        Toast.LENGTH_SHORT
                    ).show()
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
                val formattedName = if (name.isNotEmpty()) name else {
                    deviceNameFrom(null, isPc, ip)
                }
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
        val serverPort = mobileTransferServer?.port ?: DEFAULT_HUB_PORT
        binding.tvSettingsLocalIp.text = getString(R.string.settings_local_ip, localIp, serverPort)
        binding.tvSettingsTargetPc.text = if (connectedHost.isNotEmpty()) {
            getString(R.string.settings_target_pc, connectedHost, connectedPort)
        } else {
            getString(R.string.settings_target_none)
        }
        binding.tvSettingsMulticast.text =
            getString(R.string.settings_channel, ProtocolConst.Discovery.UDP_PORT)
    }

    private fun updateDeviceListUI() {
        if (discoveredDevices.isEmpty()) {
            binding.rvDevices.visibility = View.GONE
            binding.tvEmptyDevices.visibility = View.VISIBLE
            binding.tvEmptyDevices.text = getString(R.string.no_devices)
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

    /**
     * Point the radar's one beacon at the peer this device actually holds a session with.
     *
     * The beacon is the only chromatic mark on the dial, so under the ink-first contract it means
     * "paired", not "seen": discovery can list several online peers - the count badge on the same
     * card says so - while RadarView.setConnectedDevice() takes one, and the one it gets is the
     * active peer when that peer is the paired one. With no session the dial scans an empty field,
     * which is the truth on a fresh launch: sessions live in memory only, so a restart has nothing
     * paired until a code is read again.
     */
    private fun updateRadarPeer() {
        val paired = sequenceOf(getActivePeer(), selectedTargetDevice)
            .filterNotNull()
            .firstOrNull { hubClient.hasSession(it.host, it.port) }
            ?: discoveredDevices.firstOrNull { hubClient.hasSession(it.host, it.port) }

        if (paired == null) {
            binding.radarDial.setConnectedDevice(null)
        } else {
            binding.radarDial.setConnectedDevice(paired.host, paired.name)
        }
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
        // Every change to the peer set or the selected peer lands here, which makes it the one
        // place that knows what "connected" currently means. The dial asks it on each pass.
        updateRadarPeer()

        if (discoveredDevices.isEmpty()) {
            binding.layoutNoPeerState.visibility = View.VISIBLE
            binding.layoutActivePeerContent.visibility = View.GONE
            peerChipAdapter.setPeers(emptyList(), null)
            binding.tvOnlineCountTag.text = getString(R.string.device_online_count, 0)
            return
        }

        binding.layoutNoPeerState.visibility = View.GONE
        binding.layoutActivePeerContent.visibility = View.VISIBLE
        binding.tvOnlineCountTag.text = getString(R.string.device_online_count, discoveredDevices.size)

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
            Toast.makeText(this, R.string.chat_no_peer, Toast.LENGTH_SHORT).show()
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
                    Toast.makeText(this@MainActivity, R.string.chat_send_failed, Toast.LENGTH_SHORT).show()
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

        // The radar dial is a View, not an adapter, and it takes the same treatment: it pulls every
        // paint from Palette itself, so all it is told here is which mode is on. applyChrome() has
        // nothing to say about it - see the ink plates that used to sit under the dial.
        binding.radarDial.setThemeMode(theme)

        applyChrome(Palette.of(this, theme))
    }

    /**
     * Paints the whole chrome of the activity for one mode.
     *
     * Previously each mode repeated ~100 `Color.parseColor("#…")` calls in its own branch, and the
     * three of them disagreed with `colors.xml` (indigo here, blue/cyan there). All of it now comes
     * from [Palette], so `res/values/colors.xml` is the only place a hex lives.
     *
     * Tints are applied through `backgroundTintList` rather than `setBackgroundColor`, which used
     * to replace the button's drawable and drop its ripple and radius along with it.
     */
    private fun applyChrome(p: Palette) {
        val b = binding

        b.mainCoordinatorLayout.setBackgroundColor(p.page)
        b.mainAppBarLayout.setBackgroundColor(p.surface)
        b.topAppBar.setTitleTextColor(p.ink)
        b.topAppBar.setSubtitleTextColor(p.inkFaint)

        val cards = listOf(
            b.cardRadar, b.cardSendMedia, b.cardSendFiles, b.cardStorageSettings,
            b.cardSettingsTheme, b.cardSettingsNetwork, b.cardSettingsSecurity,
            b.cardActivePeerInfo
        )
        for (card in cards) {
            card.setCardBackgroundColor(p.surface)
            card.strokeColor = p.hairline
            card.cardElevation = 0f
        }

        // Titles are ink; eyebrows are the faintest ink - the difference is weight, not hue.
        b.tvBeaconTitle.setTextColor(p.ink)
        b.tvRadarStatus.setTextColor(p.inkFaint)
        b.tvSendMedia.setTextColor(p.ink)
        b.tvSendFiles.setTextColor(p.ink)
        b.tvTransferPageTitle.setTextColor(p.ink)
        for (eyebrow in listOf(
            b.tvDeviceSectionTitle, b.tvTransferSectionTitle, b.tvVaultSectionTitle,
            b.tvThemeTitle, b.tvSettingsNetTitle, b.tvSettingsSecurityTitle, b.tvStorageTitle
        )) {
            eyebrow.setTextColor(p.inkFaint)
        }
        b.tvCurrentStoragePath.setTextColor(p.ink)

        // Neutral tonal controls: raised plate, ink glyph. No brand colour on any of them.
        for (btn in listOf(b.btnShowMyQr, b.btnScanQr, b.btnInputPin)) {
            btn.backgroundTintList = p.states(p.raised)
            btn.setTextColor(p.ink)
            btn.iconTint = p.states(p.ink)
        }
        b.btnClearCompletedTasks.setTextColor(p.inkMuted)
        b.btnRefreshVault.setTextColor(p.inkMuted)
        b.btnChangeStoragePath.setTextColor(p.inkMuted)
        b.btnOpenStorageFolder.setTextColor(p.ink)
        b.btnOpenStorageFolder.strokeColor = p.states(p.hairline)
        b.btnCryptoToggle.setTextColor(p.inkMuted)
        b.btnShowMyQrFromSettings.setTextColor(p.inkMuted)

        // The ink-plate beacon that used to sit here is gone: the dial at the head of this card now
        // carries that state itself, painting its own rings from Palette and its one ready-hue
        // beacon from updateRadarPeer(). Nothing is tinted here because nothing is left to tint.
        b.tvOnlineCountTag.backgroundTintList = p.states(p.raised)
        b.tvOnlineCountTag.setTextColor(p.inkMuted)

        // Peer banner (kept in sync even though the chip row replaced it on screen)
        b.tvActivePeerName.setTextColor(p.ink)
        b.tvActivePeerMeta.setTextColor(p.inkFaint)
        b.tvActivePeerTag.setTextColor(p.inkMuted)
        b.tvActivePeerTag.backgroundTintList = p.states(p.raised)
        b.ivActivePeerAvatar.backgroundTintList = p.states(p.raised)
        b.ivActivePeerAvatar.imageTintList = p.states(p.ink)
        b.btnActivePeerQuickSend.backgroundTintList = p.states(p.ctaBackground)
        b.btnActivePeerQuickSend.setTextColor(p.ctaText)
        b.btnActivePeerQuickSend.iconTint = p.states(p.ctaText)

        b.layoutChatInputBar.setBackgroundColor(p.surface)
        b.chatInputBarDivider.setBackgroundColor(p.hairline)
        b.btnChannelPickFile.setTextColor(p.inkMuted)
        b.btnChannelPickFile.iconTint = p.states(p.inkMuted)
        b.etChannelMessage.backgroundTintList = p.states(p.raised)
        b.etChannelMessage.setTextColor(p.ink)
        b.etChannelMessage.setHintTextColor(p.inkFaint)
        b.btnChannelSendMessage.backgroundTintList = p.states(p.ctaBackground)
        b.btnChannelSendMessage.setTextColor(p.ctaText)
        b.btnChannelSendMessage.iconTint = p.states(p.ctaText)
        b.tvEmptyChannelMessages.setTextColor(p.inkFaint)
        b.tvEmptyDevices.setTextColor(p.inkFaint)
        b.tvEmptyVaultFiles.setTextColor(p.inkFaint)
        b.tvEmptyTransferTasks.setTextColor(p.inkFaint)

        b.tvSettingsLocalIp.setTextColor(p.inkMuted)
        b.tvSettingsTargetPc.setTextColor(p.inkMuted)
        b.tvSettingsMulticast.setTextColor(p.inkFaint)
        b.tvSettingsSecurityDesc.setTextColor(p.inkMuted)

        applyThemeOptionStyles(currentThemeMode)

        b.bottomNavigation.setBackgroundColor(p.surface)
        b.bottomNavigation.itemActiveIndicatorColor = p.states(p.raised)
        b.bottomNavigation.isItemActiveIndicatorEnabled = true
        val navColors = getNavColorStateList(p.ink, p.inkFaint)
        b.bottomNavigation.itemTextColor = navColors
        b.bottomNavigation.itemIconTintList = navColors
    }

    /**
     * The three theme buttons are swatches: each one is painted in the mode it stands for, so the
     * choice is seen rather than read. The active one carries a 1dp ink border; no emoji, and no
     * elevation on a control that is not floating.
     */
    private fun applyThemeOptionStyles(activeTheme: String) {
        val density = resources.displayMetrics.density
        val activeStroke = (1f * density).toInt().coerceAtLeast(1)

        fun style(button: com.google.android.material.button.MaterialButton, mode: String) {
            val p = Palette.of(this, mode)
            val active = activeTheme == mode
            button.setBackgroundColor(p.page)
            button.setTextColor(p.ink)
            // Selection is the border, never a glyph in front of the label: a prefix widens the
            // active swatch and shoves its two neighbours sideways on every theme change.
            button.strokeWidth = if (active) activeStroke else 0
            button.strokeColor = p.states(if (active) p.ink else p.hairline)
            button.elevation = 0f
            button.text = labelFor(mode)
            button.isSelected = active
            button.contentDescription = if (active) {
                getString(R.string.settings_theme_selected_description, labelFor(mode))
            } else {
                labelFor(mode)
            }
        }

        style(binding.btnThemeDark, Palette.DARK)
        style(binding.btnThemeEyecare, Palette.EYECARE)
        style(binding.btnThemeLight, Palette.LIGHT)
    }

    private fun labelFor(mode: String): String = getString(
        when (mode) {
            Palette.EYECARE -> R.string.settings_theme_eyecare
            Palette.LIGHT -> R.string.settings_theme_light
            else -> R.string.settings_theme_dark
        }
    )

    override fun onResume() {
        super.onResume()
        multicastLockHelper.acquire()

        val localIp = NetworkHelper.getLocalWifiIpv4(this)
        val serverPort = mobileTransferServer?.port ?: DEFAULT_HUB_PORT
        binding.topAppBar.subtitle = getString(R.string.settings_local_ip, localIp, serverPort)

        scanAndRefreshLanTopology()
        refreshVaultFiles()
        refreshDeviceNames()

        // The desktop's file list refreshes itself; the phone now does the same while it is up, so
        // a file that arrives while you are looking at this page shows up without a "刷新" press.
        vaultRefreshJob?.cancel()
        vaultRefreshJob = lifecycleScope.launch {
            while (true) {
                refreshVaultFiles()
                delay(VAULT_POLL_MS)
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingSharedUris(intent)
    }

    private fun handleIncomingSharedUris(intent: Intent?) {
        val uris = intent?.getParcelableArrayListExtra<Uri>("EXTRA_SHARED_URIS")
        if (!uris.isNullOrEmpty()) {
            queueUploads(uris)
        }
    }

    /**
     * Queue picked / shared files. The picker and the system share sheet both hand over a list,
     * so sending several files at once is the same gesture as sending one.
     */
    private fun queueUploads(uris: List<Uri>?) {
        if (uris.isNullOrEmpty()) return
        pendingUploads.addAll(uris)
        if (uris.size > 1) {
            Toast.makeText(this, getString(R.string.transfer_queued, uris.size), Toast.LENGTH_SHORT).show()
        }
        pumpUploadQueue()
    }

    private fun pumpUploadQueue() {
        if (uploadInFlight) return
        val next = pendingUploads.removeFirstOrNull() ?: return
        uploadInFlight = true
        startStreamingUpload(next)
    }

    /** Called by every terminal path of a transfer so the next queued file can go out. */
    private fun finishUploadSlot() {
        uploadInFlight = false
        pumpUploadQueue()
    }

    private fun sendToActivePeer() {
        val target = getActivePeer()
        if (target == null) {
            Toast.makeText(this, R.string.need_peer_first, Toast.LENGTH_SHORT).show()
            return
        }
        selectedTargetDevice = target
        connectedHost = target.host
        connectedPort = target.port
        prepareTargetAndLaunch { pickFileLauncher.launch(arrayOf("*/*")) }
    }

    /** A received file must be reachable: open it, or hand it to another app. */
    private fun openReceivedFile(item: VaultFileItem) {
        if (!storageHelper.openFile(item)) {
            Toast.makeText(this, getString(R.string.transfer_no_app), Toast.LENGTH_SHORT).show()
        }
    }

    private fun shareReceivedFile(item: VaultFileItem) {
        if (!storageHelper.shareFile(item)) {
            Toast.makeText(this, getString(R.string.transfer_file_missing), Toast.LENGTH_SHORT).show()
        }
    }

    private fun openReceivedFileByName(fileName: String) {
        val item = storageHelper.findVaultFile(fileName)
        if (item == null) {
            refreshVaultFiles()
            Toast.makeText(this, getString(R.string.transfer_file_missing), Toast.LENGTH_SHORT).show()
        } else {
            openReceivedFile(item)
        }
    }

    private fun shareReceivedFileByName(fileName: String) {
        val item = storageHelper.findVaultFile(fileName)
        if (item == null) {
            Toast.makeText(this, getString(R.string.transfer_file_missing), Toast.LENGTH_SHORT).show()
        } else {
            shareReceivedFile(item)
        }
    }

    override fun onPause() {
        super.onPause()
        vaultRefreshJob?.cancel()
        vaultRefreshJob = null
        stopPairingPeerPolling()
    }

    override fun onStop() {
        super.onStop()
        multicastLockHelper.release()
    }

    override fun onDestroy() {
        super.onDestroy()
        myPairingRefreshJob?.cancel()
        pairingDialog?.dismiss()
        pairingDialog = null
        pairingBinding = null
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
                binding.tvRadarStatus.setText(R.string.radar_no_network)
                updateDeviceListUI()
                return@launch
            }

            val subnet = NetworkHelper.getSubnetPrefix(localIp)
            binding.tvRadarStatus.text = getString(R.string.radar_scanning_subnet, subnet)

            val activeIps = withContext(Dispatchers.IO) {
                NetworkHelper.probeAllLanNodes(this@MainActivity, DEFAULT_HUB_PORT)
            }

            val sPort = mobileTransferServer?.port ?: DEFAULT_HUB_PORT
            val myFp = mobileTransferServer?.fingerprint ?: ""

            for (ip in activeIps) {
                if (ip == localIp) continue
                val info = withContext(Dispatchers.IO) {
                    hubClient.fetchHubInfo(ip, DEFAULT_HUB_PORT)
                }
                val devType = info?.get("device_type")?.asString
                    ?: info?.get("os")?.asString
                    ?: "pc"
                val isPc = devType != "android"
                val devName = deviceNameFrom(info, isPc, ip)
                val devFp = if (info != null && info.has("fingerprint")) {
                    info.get("fingerprint").asString
                } else ""

                val dev = DiscoveredDevice(
                    id = if (isPc) "pc-$ip" else "android-$ip",
                    name = devName,
                    host = ip,
                    port = DEFAULT_HUB_PORT,
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
                    hubClient.announceDevice(ip, DEFAULT_HUB_PORT, "Android ($localIp)", myFp, sPort)
                }
            }

            updateDeviceListUI()
            binding.tvRadarStatus.text = if (discoveredDevices.isNotEmpty()) {
                getString(R.string.radar_ready, discoveredDevices.size)
            } else {
                getString(R.string.radar_listening, ProtocolConst.Discovery.UDP_PORT)
            }
        }
    }

    /**
     * The name a peer answers with, falling back to what the device is plus its address instead of
     * echoing a hostname the user does not recognise.
     */
    private fun deviceNameFrom(info: com.google.gson.JsonObject?, isPc: Boolean, ip: String): String {
        val kind = getString(if (isPc) R.string.device_pc_kind else R.string.device_phone_kind)
        if (info != null) {
            info.get("name")?.asString?.takeIf { it.isNotEmpty() }?.let { return it }
            info.getAsJsonObject("host")?.get("name")?.asString?.takeIf { it.isNotEmpty() }?.let { return it }
        }
        return "$kind ($ip)"
    }

    /**
     * Show the pairing sheet.
     *
     * The pairing code is the shared secret for this session. It is deliberately **not** written
     * to SharedPreferences, and neither is the session key derived from it: after a restart the
     * user reads a fresh code off the other screen, which is what the out-of-band exchange is for.
     * [pairingSecrets] lives in memory only, for the same reason.
     */
    private fun showPinPairingDialog(
        defaultHost: String,
        defaultPort: Int,
        onPaired: (() -> Unit)? = null
    ) {
        openPairingDialog(defaultHost, defaultPort, initialError = null, onPaired = onPaired)
    }

    private fun openPairingDialog(
        initialHost: String,
        initialPort: Int,
        initialError: String?,
        onPaired: (() -> Unit)?
    ) {
        // A sheet is already up: update it in place instead of stacking a second one on top.
        if (pairingDialog?.isShowing == true && pairingBinding != null) {
            updatePairingTarget(initialHost, initialPort)
            setPairingError(initialError)
            return
        }

        val b = DialogPairingBinding.inflate(layoutInflater)
        pairingBinding = b

        val localIp = NetworkHelper.getLocalWifiIpv4(this)
        val savedHost = prefs.getString("connected_host", null)
        val host = when {
            initialHost.isNotEmpty() && initialHost != "127.0.0.1" -> initialHost
            !savedHost.isNullOrEmpty() && savedHost != "127.0.0.1" -> savedHost
            localIp != "127.0.0.1" -> NetworkHelper.getDefaultGateway(this)
            else -> localIp
        }
        var port = initialPort

        b.tvPairSubtitle.text = getString(R.string.pairing_subtitle, host)
        b.etPairHost.setText(host)
        b.layoutPairAdvanced.visibility = if (host.isEmpty()) View.VISIBLE else View.GONE
        b.btnPairAdvanced.setText(
            if (b.layoutPairAdvanced.visibility == View.VISIBLE) R.string.pairing_advanced_hide
            else R.string.pairing_advanced
        )

        val dialog = AlertDialog.Builder(ContextThemeWrapper(this, Palette.themeRes(currentThemeMode)))
            .setTitle(R.string.pairing_title)
            .setView(b.root)
            .setPositiveButton(R.string.pairing_action_pair, null)
            .setNegativeButton(R.string.pairing_action_cancel, null)
            .setOnDismissListener {
                stopPairingPeerPolling()
                pairingDialog = null
                pairingBinding = null
            }
            .create()
        pairingDialog = dialog

        // Paint the error line with the mode's failure colour rather than the dark default from XML.
        val p = Palette.of(this, currentThemeMode)
        b.tvPairError.setTextColor(p.failure)
        b.etPairPin.setTextColor(p.ink)

        var submitted = false

        fun submit() {
            if (submitted) return
            val digits = b.etPairPin.text.toString().trim()
            val targetHost = b.etPairHost.text.toString().trim().ifEmpty { host }
            when {
                digits.length != ProtocolConst.Pairing.PIN_DIGITS -> {
                    setPairingError(
                        if (digits.isEmpty()) getString(R.string.pairing_pin_error_empty)
                        else getString(R.string.pairing_pin_error_short)
                    )
                    return
                }
                targetHost.isEmpty() || targetHost == "127.0.0.1" -> {
                    setPairingError(getString(R.string.pairing_host_error))
                    return
                }
            }
            submitted = true
            b.tvPairError.visibility = View.GONE
            dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = false
            b.tvPairPeerStatus.text = getString(R.string.pairing_action_pairing)
            prefs.edit().putString("connected_host", targetHost).apply()
            handlePairingResult(targetHost, port, "", "", digits) { ok ->
                submitted = false
                dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = true
                if (ok) {
                    dialog.dismiss()
                    onPaired?.invoke()
                } else {
                    // Stay open, say why, and put the caret back in the field: the user only has
                    // to read the new code, not re-open anything.
                    setPairingError(getString(R.string.pairing_pin_error_wrong))
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setText(R.string.pairing_action_retry)
                    b.etPairPin.selectAll()
                    b.etPairPin.requestFocus()
                }
            }
        }

        fun acceptPasteOrDigits(text: String) {
            if (text.contains("://") || text.startsWith("safedrop:")) {
                val parsed = parsePairingUri(text)
                if (parsed != null) {
                    if (parsed.host.isNotEmpty()) b.etPairHost.setText(parsed.host)
                    if (parsed.port > 0) {
                        port = parsed.port
                        b.tvPairPeerStatus.text = pairingPeerLine(parsed.host, parsed.port, null)
                    }
                    b.etPairPin.setText(parsed.pin)
                    setPairingError(null)
                    return
                }
                setPairingError(getString(R.string.scan_result_unreadable))
                b.etPairPin.setText("")
                return
            }
            setPairingError(null)
            if (text.length >= ProtocolConst.Pairing.PIN_DIGITS) {
                b.etPairPin.setText(text.take(ProtocolConst.Pairing.PIN_DIGITS))
                b.etPairPin.setSelection(ProtocolConst.Pairing.PIN_DIGITS)
                submit()
            }
        }

        // A guard, because setText() re-enters the watcher when a paste is normalised.
        var editing = false
        b.etPairPin.addTextChangedListener { editable ->
            if (editing) return@addTextChangedListener
            editing = true
            acceptPasteOrDigits(editable?.toString()?.trim() ?: "")
            editing = false
        }

        b.btnPairAdvanced.setOnClickListener {
            val show = b.layoutPairAdvanced.visibility != View.VISIBLE
            b.layoutPairAdvanced.visibility = if (show) View.VISIBLE else View.GONE
            b.btnPairAdvanced.setText(
                if (show) R.string.pairing_advanced_hide else R.string.pairing_advanced
            )
            if (show) b.etPairHost.requestFocus()
        }

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { submit() }
            b.etPairPin.requestFocus()
            if (initialError != null) setPairingError(initialError)
        }
        dialog.show()

        startPairingPeerPolling(host) { reachable ->
            b.tvPairPeerStatus.text = pairingPeerLine(b.etPairHost.text.toString().trim(), port, reachable)
        }
    }

    /** Swap the peer a visible sheet is pointed at, without re-creating it. */
    private fun updatePairingTarget(host: String, port: Int) {
        val b = pairingBinding ?: return
        b.etPairHost.setText(host)
        b.tvPairSubtitle.text = getString(R.string.pairing_subtitle, host)
        startPairingPeerPolling(host) { reachable ->
            b.tvPairPeerStatus.text = pairingPeerLine(host, port, reachable)
        }
    }

    private fun setPairingError(message: String?) {
        val b = pairingBinding ?: return
        b.tvPairError.text = message ?: ""
        b.tvPairError.visibility = if (message.isNullOrEmpty()) View.GONE else View.VISIBLE
    }

    private fun pairingPeerLine(host: String, port: Int, reachable: Boolean?): String {
        val state = when (reachable) {
            true -> getString(R.string.pairing_peer_online)
            false -> getString(R.string.pairing_peer_offline)
            null -> getString(R.string.pairing_peer_checking)
        }
        return "$host:$port · $state"
    }

    /**
     * Ask the peer whether it is there while the sheet is open, so "the other device is not on
     * this network" is visible before the user types anything rather than after a timeout.
     *
     * Deliberately not a code reader: both ends hide the pairing code from remote callers on
     * purpose ([MobileTransferServer] and the desktop hub only disclose it over loopback), so the
     * sheet can observe reachability, never the secret.
     */
    private fun startPairingPeerPolling(host: String, onResult: (Boolean?) -> Unit) {
        pairingPeerJob?.cancel()
        if (host.isEmpty()) {
            onResult(null)
            return
        }
        pairingPeerJob = lifecycleScope.launch {
            onResult(null)
            while (true) {
                val reachable = withContext(Dispatchers.IO) { hubClient.ping(host, connectedPort) }
                onResult(reachable)
                delay(PAIR_PEER_POLL_MS)
            }
        }
    }

    private fun stopPairingPeerPolling() {
        pairingPeerJob?.cancel()
        pairingPeerJob = null
    }

    /** One scanned or pasted pairing link, already split into what the handshake needs. */
    private data class PairingTarget(val host: String, val port: Int, val fp: String, val token: String, val pin: String)

    private fun parsePairingUri(raw: String): PairingTarget? {
        return try {
            val uri = Uri.parse(raw.trim())
            val host = uri.getQueryParameter("ip") ?: uri.host ?: return null
            PairingTarget(
                host = host,
                port = uri.getQueryParameter("port")?.toIntOrNull() ?: uri.port.takeIf { it != -1 } ?: DEFAULT_HUB_PORT,
                fp = uri.getQueryParameter("fp") ?: uri.getQueryParameter("fingerprint") ?: "",
                token = uri.getQueryParameter("token") ?: "",
                pin = uri.getQueryParameter("pin") ?: ""
            )
        } catch (e: Exception) {
            Log.w(TAG, "Unreadable pairing link: ${e.message}")
            null
        }
    }

    /**
     * Where received files land. Two ways to get out: choose a folder, or open the current one.
     */
    private fun showStorageChoiceDialog() {
        val options = arrayOf(
            getString(R.string.storage_choice_download),
            getString(R.string.storage_choice_pictures),
            getString(R.string.storage_choice_private)
        )
        AlertDialog.Builder(ContextThemeWrapper(this, Palette.themeRes(currentThemeMode)))
            .setTitle(R.string.storage_choice_title)
            .setItems(options) { _, which ->
                val chosenPath = when (which) {
                    1 -> storageHelper.setCustomStorageType("pictures")
                    2 -> storageHelper.setCustomStorageType("private")
                    else -> storageHelper.setCustomStorageType("download")
                }
                binding.tvCurrentStoragePath.text = chosenPath
                Toast.makeText(this, getString(R.string.storage_changed, chosenPath), Toast.LENGTH_SHORT).show()
                refreshVaultFiles()
            }
            .setNeutralButton(R.string.storage_open) { _, _ ->
                try {
                    startActivity(storageHelper.createOpenFolderIntent())
                } catch (e: Exception) {
                    Toast.makeText(
                        this,
                        getString(R.string.storage_open_failed, storageHelper.getStorageDisplayPath()),
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
            .setNegativeButton(R.string.pairing_action_cancel, null)
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
        // In-memory only. There is no persisted fallback on purpose: the pairing code is the
        // secret, and a code kept across boots would let anything with the device skip the
        // out-of-band step entirely.
        val secret = pairingSecrets["$host:$port"]
            ?: pairingSecrets[connectedHost.let { "$it:$connectedPort" }]
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
            Log.w(TAG, "Session key derivation failed for $host:$port: ${e.message}")
            return false
        }

        val proofHex = cryptoEngine.bytesToHex(cryptoEngine.clientProof(sessionKey, sessionId))
        val verifyResp = hubClient.verifyHandshake(host, port, sessionId, proofHex) ?: return false
        val serverProofHex = verifyResp.get("server_proof")?.asString ?: return false
        if (!cryptoEngine.verifyServerProof(sessionKey, sessionId, serverProofHex)) return false

        hubClient.setSession(host, port, sessionId, sessionKey)
        Log.i(TAG, "Direct encrypted session established with $host:$port")
        return true
    }

    /**
     * Run the handshake against [ip] and report the outcome.
     *
     * [onResult] lets the pairing sheet react in place. No failure path here shows a raw
     * exception message: the user is told which of the three things that can go wrong went wrong.
     */
    private fun handlePairingResult(
        ip: String,
        port: Int,
        fp: String,
        token: String,
        pin: String,
        onPaired: (() -> Unit)? = null,
        onResult: ((Boolean) -> Unit)? = null
    ) {
        connectedHost = ip
        connectedPort = port
        targetFingerprint = fp
        prefs.edit().putString("connected_host", ip).apply()

        fun fail(reason: String) {
            binding.tvRadarStatus.text = reason
            onResult?.invoke(false)
        }

        lifecycleScope.launch {
            binding.tvRadarStatus.text = getString(R.string.pairing_connecting, ip)

            // 1. Is the peer there at all?
            val pingOk = hubClient.ping(ip, port)
            if (!pingOk) {
                fail(getString(R.string.pairing_peer_unreachable))
                Toast.makeText(this@MainActivity, R.string.pairing_peer_unreachable, Toast.LENGTH_LONG).show()
                return@launch
            }

            // 2. Ephemeral ECDH key agreement
            val keyPair = cryptoEngine.generateEphemeralKeyPair()
            val rawPubKey = cryptoEngine.extractRawPublicKey(keyPair)
            val rawPubKeyHex = cryptoEngine.bytesToHex(rawPubKey)

            val handshakeResp = hubClient.initHandshake(ip, port, rawPubKeyHex)
            if (handshakeResp == null) {
                fail(getString(R.string.pairing_handshake_failed))
                return@launch
            }

            val sessionId = handshakeResp.get("session_id")?.asString
            val serverPubKeyHex = handshakeResp.get("server_public_key")?.asString
            if (sessionId.isNullOrEmpty() || serverPubKeyHex.isNullOrEmpty()) {
                fail(getString(R.string.pairing_handshake_failed))
                return@launch
            }

            // 3. Derive the session key locally. The pairing secret (code or QR token) stays on
            //    this device: it is used as HKDF input and proven via HMAC, never transmitted.
            val pairingSecret = when {
                pin.isNotEmpty() -> pin
                token.isNotEmpty() -> token
                else -> {
                    fail(getString(R.string.pairing_pin_error_no_pair_info))
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
                // The exception text is for logcat only; it names crypto primitives.
                Log.w(TAG, "Session key derivation failed: ${e.message}")
                fail(getString(R.string.pairing_error_generic))
                return@launch
            }

            val clientProofHex = cryptoEngine.bytesToHex(cryptoEngine.clientProof(sessionKey, sessionId))
            val verifyResp = hubClient.verifyHandshake(ip, port, sessionId, clientProofHex)
            val serverProofHex = verifyResp?.get("server_proof")?.asString

            if (verifyResp != null && !serverProofHex.isNullOrEmpty() &&
                cryptoEngine.verifyServerProof(sessionKey, sessionId, serverProofHex)) {
                // Both sides proved the same key: the session is mutually authenticated.
                hubClient.setSession(ip, port, sessionId, sessionKey)
                // Remember the secret for the lifetime of this process only, so a later
                // phone-to-phone transfer to this peer does not ask for it again. It is NOT put in
                // SharedPreferences: a stored pairing code is a stored key.
                pairingSecrets["$ip:$port"] = pairingSecret
                isHubConnected = true
                binding.tvRadarStatus.text = getString(R.string.pairing_success, ip)

                val info = hubClient.fetchHubInfo(ip, port)
                val devType = info?.get("device_type")?.asString
                    ?: info?.get("os")?.asString
                    ?: "pc"
                val isPc = devType != "android"
                val devName = deviceNameFrom(info, isPc, ip)
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
                val sPort = mobileTransferServer?.port ?: DEFAULT_HUB_PORT
                val myFp = mobileTransferServer?.fingerprint ?: ""
                hubClient.announceDevice(ip, port, "Android ($localIp)", myFp, sPort)

                onResult?.invoke(true)
                onPaired?.invoke()
            } else {
                // A wrong or spent code is the common case, and the sheet is the place to say it.
                fail(getString(R.string.pairing_pin_error_wrong))
            }
        }
    }

    /**
     * This device's pairing code: the QR a peer scans, plus the same six digits to type.
     *
     * The sheet repaints itself on a timer, so if the code rotates underneath it (a peer paired
     * successfully, which retires the old code) the QR and the digits on screen are the live ones.
     * The timer deliberately does NOT rotate the code itself: rotating on a clock would invalidate
     * a code a peer is in the middle of scanning, and a six-digit code that nobody has paired with
     * yet is not stale. Changing it early stays an explicit action - "现在换一组".
     */
    private fun showMyPairingQrDialog() {
        val localIp = NetworkHelper.getLocalWifiIpv4(this)
        val port = mobileTransferServer?.port ?: DEFAULT_HUB_PORT
        val fingerprint = mobileTransferServer?.fingerprint ?: ""

        val b = DialogMyPairingBinding.inflate(layoutInflater)
        var shownCode: String? = null

        fun render(pin: String, token: String) {
            if (pin == shownCode) return
            shownCode = pin
            b.tvMyPairPin.text = pin
            val pairingUri =
                "safedrop://pair?ip=$localIp&port=$port&fp=$fingerprint&token=$token&pin=$pin"
            try {
                b.ivMyPairQr.setImageBitmap(generateQrBitmap(pairingUri, 512))
            } catch (e: Exception) {
                Log.w(TAG, "QR render failed: ${e.message}")
                b.ivMyPairQr.setImageDrawable(null)
                b.tvMyPairHint.setText(R.string.my_pairing_qr_failed)
            }
        }

        render(mobileTransferServer?.currentPin ?: "", mobileTransferServer?.currentToken ?: "")
        b.tvMyPairAddress.text = getString(R.string.settings_local_ip, localIp, port)

        val dialog = AlertDialog.Builder(ContextThemeWrapper(this, Palette.themeRes(currentThemeMode)))
            .setTitle(R.string.my_pairing_title)
            .setView(b.root)
            .setNeutralButton(R.string.my_pairing_refresh, null)
            .setPositiveButton(R.string.my_pairing_done, null)
            .setOnDismissListener {
                myPairingRefreshJob?.cancel()
                myPairingRefreshJob = null
            }
            .create()
        dialog.show()

        // "现在换一组" is the only thing that retires a code; the click listener replaces the
        // default dismiss behaviour so the sheet stays open and shows the new code.
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener {
            val (newPin, newToken) = mobileTransferServer?.refreshPairingPin() ?: Pair("", "")
            render(newPin, newToken)
            Toast.makeText(this, R.string.my_pairing_refreshed, Toast.LENGTH_SHORT).show()
        }

        myPairingRefreshJob?.cancel()
        myPairingRefreshJob = lifecycleScope.launch {
            while (true) {
                render(mobileTransferServer?.currentPin ?: "", mobileTransferServer?.currentToken ?: "")
                delay(MY_CODE_POLL_MS)
            }
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
     * Make sure there is a paired target before the picker opens, so the picker is the only thing
     * between the user and a sent file.
     */
    private fun prepareTargetAndLaunch(action: () -> Unit) {
        val target = selectedTargetDevice
            ?: discoveredDevices.firstOrNull { it.host == connectedHost }
        if (target != null) {
            pairThen(target, action)
        } else if (discoveredDevices.isNotEmpty()) {
            if (discoveredDevices.size == 1) {
                pairThen(discoveredDevices[0], action)
            } else {
                val names = discoveredDevices.map { it.name }.toTypedArray()
                AlertDialog.Builder(ContextThemeWrapper(this, Palette.themeRes(currentThemeMode)))
                    .setTitle(R.string.select_target_title)
                    .setItems(names) { _, index ->
                        pairThen(discoveredDevices[index], action)
                    }
                    .setNegativeButton(R.string.pairing_action_cancel, null)
                    .show()
            }
        } else if (connectedHost.isNotEmpty() && connectedHost != "127.0.0.1") {
            showPinPairingDialog(connectedHost, connectedPort, onPaired = action)
        } else {
            Toast.makeText(this, R.string.select_target_none, Toast.LENGTH_SHORT).show()
        }
    }

    /** Pair with [dev] if needed, then run [action] (which is always "open the picker"). */
    private fun pairThen(dev: DiscoveredDevice, action: () -> Unit) {
        selectedTargetDevice = dev
        connectedHost = dev.host
        connectedPort = dev.port
        prefs.edit().putString("connected_host", dev.host).apply()

        if (hubClient.hasSession(dev.host, dev.port)) {
            action()
        } else {
            showPinPairingDialog(dev.host, dev.port, onPaired = action)
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
     * Stream one chunked upload to the peer (a desktop hub or another phone).
     *
     * Every chunk is sealed by [DesktopHubClient.uploadChunk] with the session key negotiated for
     * that peer; an unpaired target is rejected before any byte leaves the device.
     *
     * Started from [pumpUploadQueue] only, one file at a time.
     */
    private fun startStreamingUpload(uri: Uri) {
        val fileName = resolveFileName(uri)
        val fileSize = resolveFileSize(uri)

        val target = selectedTargetDevice ?: discoveredDevices.firstOrNull { it.host == connectedHost }
        val targetHost = target?.host ?: connectedHost
        val targetPort = target?.port ?: connectedPort
        val targetName = target?.name ?: getString(R.string.device_target_fallback, targetHost)
        val targetDevId = target?.id ?: (if (targetHost.isNotEmpty()) "peer-$targetHost" else "unknown")

        if (targetHost.isEmpty() || targetHost == "127.0.0.1") {
            Toast.makeText(this, R.string.transfer_no_target, Toast.LENGTH_SHORT).show()
            finishUploadSlot()
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
                        Toast.makeText(this@MainActivity, R.string.transfer_read_failed, Toast.LENGTH_SHORT).show()
                        finishUploadSlot()
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
                        Log.w(TAG, "Direct pairing with $targetHost:$targetPort failed: ${e.message}")
                        false
                    }
                    if (!paired) {
                        withContext(Dispatchers.Main) {
                            transferMsg.status = "failed"
                            channelMessageAdapter.notifyDataSetChanged()
                            TransferForegroundService.finishTransfer(this@MainActivity, fileName)
                            Toast.makeText(
                                this@MainActivity,
                                getString(R.string.transfer_session_failed, targetName),
                                Toast.LENGTH_LONG
                            ).show()
                            finishUploadSlot()
                        }
                        return@launch
                    }
                    // A session made here is invisible to the pairing sheet's paths, so the dial is
                    // told about it directly rather than waiting for the next peer-list change.
                    withContext(Dispatchers.Main) { updateRadarPeer() }
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
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.transfer_sent, targetName),
                        Toast.LENGTH_LONG
                    ).show()
                    finishUploadSlot()
                }

            } catch (e: Exception) {
                Log.w(TAG, "Upload of $fileName to $targetHost:$targetPort aborted: ${e.message}")
                withContext(Dispatchers.Main) {
                    transferMsg.status = "failed"
                    channelMessageAdapter.notifyDataSetChanged()
                    TransferForegroundService.finishTransfer(this@MainActivity, fileName)
                    Toast.makeText(this@MainActivity, R.string.transfer_failed, Toast.LENGTH_LONG).show()
                    finishUploadSlot()
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

        AlertDialog.Builder(ContextThemeWrapper(this, Palette.themeRes(currentThemeMode)))
            .setTitle(R.string.battery_title)
            .setMessage(R.string.battery_body)
            .setPositiveButton(R.string.battery_go) { _, _ ->
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                    prefs.edit().putBoolean("battery_optimization_prompted", true).apply()
                    hasBatteryOptimizationPrompted = true
                } catch (e: Exception) {
                    Log.w(TAG, "Battery exemption screen unavailable: ${e.message}")
                    Toast.makeText(this, R.string.battery_manual, Toast.LENGTH_LONG).show()
                }
            }
            .setNegativeButton(R.string.battery_later) { _, _ ->
                // Do not mark as prompted, will ask again next time
            }
            .setNeutralButton(R.string.battery_never) { _, _ ->
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
                Log.d(TAG, "Device name refresh skipped: ${e.message}")
            }
        }
    }

    companion object {
        private const val TAG = "MainActivity"

        /** Default port both ends listen on; not in protocol.json because it is not negotiated. */
        private const val DEFAULT_HUB_PORT = 8899

        /** Received-file list refresh while the screen is visible. */
        private const val VAULT_POLL_MS = 4000L

        /** Peer reachability probe while the pairing sheet is open. */
        private const val PAIR_PEER_POLL_MS = 3000L

        /** Repaint of this device's own pairing code sheet. */
        private const val MY_CODE_POLL_MS = 2000L
    }
}
