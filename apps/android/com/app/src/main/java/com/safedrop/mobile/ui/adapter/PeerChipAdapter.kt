package com.safedrop.mobile.ui.adapter

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.databinding.ItemPeerChipBinding
import com.safedrop.mobile.ui.Palette

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

            // The selected tab is marked with ink weight, not with a hue: hue is spent on state.
            val p = Palette.of(binding.root.context, theme)
            if (isSelected) {
                binding.chipCard.setCardBackgroundColor(p.raised)
                binding.chipCard.strokeColor = p.ink
                binding.chipCard.strokeWidth = dp(binding.root.context, 1.5f)
                binding.tvChipName.setTextColor(p.ink)
                binding.ivChipIcon.imageTintList = p.states(p.ink)
            } else {
                binding.chipCard.setCardBackgroundColor(p.surface)
                binding.chipCard.strokeColor = p.hairline
                binding.chipCard.strokeWidth = dp(binding.root.context, 1f)
                binding.tvChipName.setTextColor(p.inkMuted)
                binding.ivChipIcon.imageTintList = p.states(p.inkFaint)
            }
            binding.vChipStatusDot.backgroundTintList =
                p.states(if (peer.isOnline) p.ready else p.inkFaint)

            binding.root.setOnClickListener { onSelect(peer) }
        }

        private fun dp(context: android.content.Context, value: Float): Int =
            (value * context.resources.displayMetrics.density).toInt()
    }
}
