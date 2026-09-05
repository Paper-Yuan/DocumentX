package com.safedrop.mobile.ui.adapter

import android.graphics.Color
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.databinding.ItemPeerChipBinding

class PeerChipAdapter(
    private val onPeerSelected: (DiscoveredDevice) -> Unit
) : RecyclerView.Adapter<PeerChipAdapter.PeerChipViewHolder>() {

    private val peers = mutableListOf<DiscoveredDevice>()
    private var selectedPeerId: String? = null
    private var themeMode: String = "dark"

    fun setPeers(newPeers: List<DiscoveredDevice>, activeId: String?) {
        peers.clear()
        peers.addAll(newPeers)
        selectedPeerId = activeId
        notifyDataSetChanged()
    }

    fun setSelectedPeerId(activeId: String?) {
        selectedPeerId = activeId
        notifyDataSetChanged()
    }

    fun setThemeMode(theme: String) {
        this.themeMode = theme
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): PeerChipViewHolder {
        val binding = ItemPeerChipBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return PeerChipViewHolder(binding)
    }

    override fun onBindViewHolder(holder: PeerChipViewHolder, position: Int) {
        val peer = peers[position]
        holder.bind(peer, peer.id == selectedPeerId, themeMode, onPeerSelected)
    }

    override fun getItemCount(): Int = peers.size

    class PeerChipViewHolder(private val binding: ItemPeerChipBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(
            peer: DiscoveredDevice,
            isSelected: Boolean,
            theme: String,
            onSelect: (DiscoveredDevice) -> Unit
        ) {
            binding.tvChipName.text = peer.name
            val isMobile = peer.deviceType.lowercase().contains("android") ||
                    peer.deviceType.lowercase().contains("ios") ||
                    peer.deviceType.lowercase().contains("mobile")

            binding.ivChipIcon.setImageResource(
                if (isMobile) com.safedrop.mobile.R.drawable.ic_device_mobile
                else com.safedrop.mobile.R.drawable.ic_device_pc
            )

            // Theme adaptation
            when (theme) {
                "eyecare" -> {
                    if (isSelected) {
                        binding.chipCard.setCardBackgroundColor(Color.parseColor("#CDE8D5"))
                        binding.chipCard.strokeColor = Color.parseColor("#2E5C38")
                        binding.chipCard.strokeWidth = 3
                        binding.tvChipName.setTextColor(Color.parseColor("#000000"))
                    } else {
                        binding.chipCard.setCardBackgroundColor(Color.parseColor("#F5EDDC"))
                        binding.chipCard.strokeColor = Color.parseColor("#D5C7AA")
                        binding.chipCard.strokeWidth = 1
                        binding.tvChipName.setTextColor(Color.parseColor("#3D382B"))
                    }
                }
                "light" -> {
                    if (isSelected) {
                        binding.chipCard.setCardBackgroundColor(Color.parseColor("#E0E7FF"))
                        binding.chipCard.strokeColor = Color.parseColor("#4F46E5")
                        binding.chipCard.strokeWidth = 3
                        binding.tvChipName.setTextColor(Color.parseColor("#1E1B4B"))
                    } else {
                        binding.chipCard.setCardBackgroundColor(Color.parseColor("#FFFFFF"))
                        binding.chipCard.strokeColor = Color.parseColor("#E2E8F0")
                        binding.chipCard.strokeWidth = 1
                        binding.tvChipName.setTextColor(Color.parseColor("#64748B"))
                    }
                }
                else -> {
                    if (isSelected) {
                        binding.chipCard.setCardBackgroundColor(Color.parseColor("#312E81"))
                        binding.chipCard.strokeColor = Color.parseColor("#818CF8")
                        binding.chipCard.strokeWidth = 3
                        binding.tvChipName.setTextColor(Color.parseColor("#FFFFFF"))
                    } else {
                        binding.chipCard.setCardBackgroundColor(Color.parseColor("#1F2937"))
                        binding.chipCard.strokeColor = Color.parseColor("#374151")
                        binding.chipCard.strokeWidth = 1
                        binding.tvChipName.setTextColor(Color.parseColor("#9CA3AF"))
                    }
                }
            }

            binding.root.setOnClickListener { onSelect(peer) }
        }
    }
}
