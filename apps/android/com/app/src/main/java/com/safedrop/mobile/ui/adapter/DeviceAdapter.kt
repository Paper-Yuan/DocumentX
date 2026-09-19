package com.safedrop.mobile.ui.adapter

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.R
import com.safedrop.mobile.databinding.ItemDeviceBinding
import com.safedrop.mobile.ui.Palette

data class DiscoveredDevice(
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val fingerprint: String,
    val deviceType: String = "pc",
    val isOnline: Boolean = true
)

/**
 * Adapter for displaying discovered online devices (Desktop Hubs & Mobile Peers)
 */
class DeviceAdapter(
    private val onDeviceClick: (DiscoveredDevice) -> Unit,
    private val onSendClick: (DiscoveredDevice) -> Unit,
    private val onChatClick: (DiscoveredDevice) -> Unit = {}
) : RecyclerView.Adapter<DeviceAdapter.DeviceViewHolder>() {

    private val devices = mutableListOf<DiscoveredDevice>()
    private var themeMode: String = "dark"
    private var deviceNameCache: Map<String, String> = emptyMap()

    fun updateDevices(newDevices: List<DiscoveredDevice>) {
        devices.clear()
        devices.addAll(newDevices)
        notifyDataSetChanged()
    }

    fun setThemeMode(theme: String) {
        this.themeMode = theme
        notifyDataSetChanged()
    }

    fun setDeviceNameCache(cache: Map<String, String>) {
        this.deviceNameCache = cache
        notifyDataSetChanged()
    }

    private fun getDisplayName(device: DiscoveredDevice): String {
        // Priority: customName > name > IP fallback
        val customName = deviceNameCache[device.fingerprint]
        return when {
            !customName.isNullOrEmpty() -> customName
            device.name.isNotEmpty() -> device.name
            else -> "未命名设备 ${device.host}"
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): DeviceViewHolder {
        val binding = ItemDeviceBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return DeviceViewHolder(binding)
    }

    override fun onBindViewHolder(holder: DeviceViewHolder, position: Int) {
        val device = devices[position]
        val displayName = getDisplayName(device)
        holder.bind(device, displayName, themeMode, onDeviceClick, onSendClick, onChatClick)
    }

    override fun getItemCount(): Int = devices.size

    class DeviceViewHolder(private val binding: ItemDeviceBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(
            device: DiscoveredDevice,
            displayName: String,
            theme: String,
            onClick: (DiscoveredDevice) -> Unit,
            onSend: (DiscoveredDevice) -> Unit,
            onChat: (DiscoveredDevice) -> Unit
        ) {
            val isMobile = device.deviceType.lowercase().contains("android") ||
                    device.deviceType.lowercase().contains("ios") ||
                    device.deviceType.lowercase().contains("mobile")

            binding.ivDeviceIcon.setImageResource(
                if (isMobile) com.safedrop.mobile.R.drawable.ic_device_mobile
                else com.safedrop.mobile.R.drawable.ic_device_pc
            )
            val ctx = binding.root.context
            binding.tvDevicePlatformTag.text =
                ctx.getString(if (isMobile) R.string.device_phone else R.string.device_pc)

            binding.tvDeviceName.text = displayName
            binding.tvDeviceAddress.text = "${device.host}:${device.port}"
            binding.tvFingerprint.text = ctx.getString(
                R.string.fingerprint_label,
                device.fingerprint.ifEmpty { "…" }
            )

            // Paint comes from res/values/colors.xml through Palette - no hex in this file.
            val p = Palette.of(ctx, theme)
            binding.root.setCardBackgroundColor(p.surface)
            binding.root.strokeColor = p.hairline
            binding.ivDeviceIcon.backgroundTintList = p.states(p.raised)
            binding.ivDeviceIcon.imageTintList = p.states(p.ink)
            binding.tvDeviceName.setTextColor(p.ink)
            binding.tvDeviceAddress.setTextColor(p.inkMuted)
            binding.tvFingerprint.setTextColor(p.inkFaint)
            binding.tvDevicePlatformTag.setTextColor(p.inkMuted)
            binding.tvDevicePlatformTag.backgroundTintList = p.states(p.raised)
            binding.btnOpenChat.setTextColor(p.inkMuted)
            binding.btnOpenChat.iconTint = p.states(p.inkMuted)
            binding.btnConnectDevice.setBackgroundColor(p.ctaBackground)
            binding.btnConnectDevice.setTextColor(p.ctaText)

            binding.root.setOnClickListener { onClick(device) }
            binding.btnConnectDevice.setOnClickListener { onSend(device) }
            binding.btnOpenChat.setOnClickListener { onChat(device) }
        }
    }
}
