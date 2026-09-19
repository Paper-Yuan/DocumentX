package com.safedrop.mobile.ui.adapter

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.R
import com.safedrop.mobile.core.storage.VaultFileItem
import com.safedrop.mobile.databinding.ItemVaultFileBinding
import com.safedrop.mobile.ui.Palette
import java.text.SimpleDateFormat
import java.util.*

/**
 * Received files. A row is a finding, not a label: tapping it opens the file, and the row carries
 * the share action too, so a file that arrived is a file the user can actually get at.
 */
class VaultFileAdapter(
    private val files: MutableList<VaultFileItem> = mutableListOf(),
    private val onFileClick: (VaultFileItem) -> Unit,
    private val onFileShare: (VaultFileItem) -> Unit = {}
) : RecyclerView.Adapter<VaultFileAdapter.ViewHolder>() {

    private var currentTheme = Palette.DARK
    private val dateFormat = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())

    fun setThemeMode(theme: String) {
        currentTheme = theme
        notifyDataSetChanged()
    }

    fun updateFiles(newFiles: List<VaultFileItem>) {
        files.clear()
        files.addAll(newFiles)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemVaultFileBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(files[position])
    }

    override fun getItemCount(): Int = files.size

    inner class ViewHolder(private val binding: ItemVaultFileBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(item: VaultFileItem) {
            val ctx = binding.root.context
            binding.tvFileName.text = item.name
            val dateStr = if (item.lastModified > 0) dateFormat.format(Date(item.lastModified)) else
                ctx.getString(R.string.transfer_complete)
            // "·" reads as one machine value: size then time, both monospace
            binding.tvFileMeta.text = "${item.formattedSize} · $dateStr"

            binding.root.contentDescription = item.name
            binding.root.setOnClickListener { onFileClick(item) }
            binding.btnOpenFile.setOnClickListener { onFileClick(item) }
            binding.btnShareFile.setOnClickListener { onFileShare(item) }

            // Icon by file type
            val lower = item.name.lowercase()
            val iconRes = when {
                item.isMedia -> R.drawable.ic_download
                lower.endsWith(".zip") || lower.endsWith(".rar") -> R.drawable.ic_vault
                else -> R.drawable.ic_download
            }
            binding.ivFileIcon.setImageResource(iconRes)

            val p = Palette.of(ctx, currentTheme)
            binding.cardVaultFile.setCardBackgroundColor(p.surface)
            binding.cardVaultFile.strokeColor = p.hairline
            binding.tvFileName.setTextColor(p.ink)
            binding.tvFileMeta.setTextColor(p.inkFaint)
            binding.ivFileIcon.backgroundTintList = p.states(p.raised)
            binding.ivFileIcon.imageTintList = p.states(p.ink)
            binding.btnOpenFile.setTextColor(p.inkMuted)
            binding.btnShareFile.setTextColor(p.inkMuted)
        }
    }
}
