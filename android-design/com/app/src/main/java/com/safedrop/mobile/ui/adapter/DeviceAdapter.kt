package com.safedrop.mobile.ui.adapter

import android.graphics.Color
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.databinding.ItemDeviceBinding

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

    fun updateDevices(newDevices: List<DiscoveredDevice>) {
        devices.clear()
        devices.addAll(newDevices)
        notifyDataSetChanged()
    }

    fun setThemeMode(theme: String) {
        this.themeMode = theme
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): DeviceViewHolder {
        val binding = ItemDeviceBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return DeviceViewHolder(binding)
    }

    override fun onBindViewHolder(holder: DeviceViewHolder, position: Int) {
        holder.bind(devices[position], themeMode, onDeviceClick, onSendClick, onChatClick)
    }

    override fun getItemCount(): Int = devices.size

    class DeviceViewHolder(private val binding: ItemDeviceBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(
            device: DiscoveredDevice,
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
            binding.tvDevicePlatformTag.text = if (isMobile) "手机端" else "电脑端"

            binding.tvDeviceName.text = device.name
            binding.tvDeviceAddress.text = "${device.host}:${device.port}"
            binding.tvFingerprint.text = "指纹: ${device.fingerprint.ifEmpty { "待配对" }}"

            // Theme adaptation
            when (theme) {
                "eyecare" -> {
                    binding.root.setCardBackgroundColor(Color.parseColor("#F5EDDC"))
                    binding.root.strokeColor = Color.parseColor("#D5C7AA")
                    binding.tvDeviceName.setTextColor(Color.parseColor("#000000"))
                    binding.tvDeviceAddress.setTextColor(Color.parseColor("#3D382B"))
                    binding.btnConnectDevice.setBackgroundColor(Color.parseColor("#CDE8D5"))
                    binding.btnConnectDevice.setTextColor(Color.parseColor("#000000"))
                    binding.btnOpenChat.setTextColor(Color.parseColor("#2E5C38"))
                    binding.btnOpenChat.iconTint = android.content.res.ColorStateList.valueOf(Color.parseColor("#2E5C38"))
                }
                "light" -> {
                    binding.root.setCardBackgroundColor(Color.parseColor("#FFFFFF"))
                    binding.root.strokeColor = Color.parseColor("#E2E8F0")
                    binding.tvDeviceName.setTextColor(Color.parseColor("#000000"))
                    binding.tvDeviceAddress.setTextColor(Color.parseColor("#64748B"))
                    binding.btnConnectDevice.setBackgroundColor(Color.parseColor("#E2E8F0"))
                    binding.btnConnectDevice.setTextColor(Color.parseColor("#000000"))
                    binding.btnOpenChat.setTextColor(Color.parseColor("#4F46E5"))
                    binding.btnOpenChat.iconTint = android.content.res.ColorStateList.valueOf(Color.parseColor("#4F46E5"))
                }
                else -> {
                    binding.root.setCardBackgroundColor(Color.parseColor("#111827"))
                    binding.root.strokeColor = Color.parseColor("#1F2937")
                    binding.tvDeviceName.setTextColor(Color.parseColor("#F8FAFC"))
                    binding.tvDeviceAddress.setTextColor(Color.parseColor("#94A3B8"))
                    binding.btnConnectDevice.setBackgroundColor(Color.parseColor("#4F46E5"))
                    binding.btnConnectDevice.setTextColor(Color.parseColor("#FFFFFF"))
                    binding.btnOpenChat.setTextColor(Color.parseColor("#818CF8"))
                    binding.btnOpenChat.iconTint = android.content.res.ColorStateList.valueOf(Color.parseColor("#818CF8"))
                }
            }

            binding.root.setOnClickListener { onClick(device) }
            binding.btnConnectDevice.setOnClickListener { onSend(device) }
            binding.btnOpenChat.setOnClickListener { onChat(device) }
        }
    }
}
