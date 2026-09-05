package com.safedrop.mobile.ui.adapter

import android.graphics.Color
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.R
import com.safedrop.mobile.core.storage.VaultFileItem
import com.safedrop.mobile.databinding.ItemVaultFileBinding
import java.text.SimpleDateFormat
import java.util.*

class VaultFileAdapter(
    private val files: MutableList<VaultFileItem> = mutableListOf(),
    private val onFileClick: (VaultFileItem) -> Unit
) : RecyclerView.Adapter<VaultFileAdapter.ViewHolder>() {

    private var currentTheme = "dark"
    private val dateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())

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
            binding.tvFileName.text = item.name
            val dateStr = if (item.lastModified > 0) dateFormat.format(Date(item.lastModified)) else "最近"
            binding.tvFileMeta.text = "${item.formattedSize} • $dateStr"

            binding.root.setOnClickListener { onFileClick(item) }
            binding.btnOpenFile.setOnClickListener { onFileClick(item) }

            // Icon by file type
            val lower = item.name.lowercase()
            val iconRes = when {
                item.isMedia -> R.drawable.ic_send
                lower.endsWith(".zip") || lower.endsWith(".rar") -> R.drawable.ic_launcher
                else -> R.drawable.ic_download
            }
            binding.ivFileIcon.setImageResource(iconRes)

            // Theme styling
            when (currentTheme) {
                "eyecare" -> {
                    binding.cardVaultFile.setCardBackgroundColor(Color.parseColor("#F5EDDC"))
                    binding.cardVaultFile.strokeColor = Color.parseColor("#D5C7AA")
                    binding.tvFileName.setTextColor(Color.parseColor("#000000"))
                    binding.tvFileMeta.setTextColor(Color.parseColor("#3D382B"))
                    binding.btnOpenFile.setBackgroundColor(Color.parseColor("#CDE8D5"))
                    binding.btnOpenFile.setTextColor(Color.parseColor("#000000"))
                }
                "light" -> {
                    binding.cardVaultFile.setCardBackgroundColor(Color.parseColor("#FFFFFF"))
                    binding.cardVaultFile.strokeColor = Color.parseColor("#E2E8F0")
                    binding.tvFileName.setTextColor(Color.parseColor("#000000"))
                    binding.tvFileMeta.setTextColor(Color.parseColor("#64748B"))
                    binding.btnOpenFile.setBackgroundColor(Color.parseColor("#E2E8F0"))
                    binding.btnOpenFile.setTextColor(Color.parseColor("#000000"))
                }
                else -> {
                    binding.cardVaultFile.setCardBackgroundColor(Color.parseColor("#111827"))
                    binding.cardVaultFile.strokeColor = Color.parseColor("#334155")
                    binding.tvFileName.setTextColor(Color.parseColor("#F8FAFC"))
                    binding.tvFileMeta.setTextColor(Color.parseColor("#94A3B8"))
                    binding.btnOpenFile.setBackgroundColor(Color.parseColor("#1F2937"))
                    binding.btnOpenFile.setTextColor(Color.parseColor("#06B6D4"))
                }
            }
        }
    }
}
