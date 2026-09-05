package com.safedrop.mobile.ui.adapter

import android.graphics.Color
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.R
import com.safedrop.mobile.databinding.ItemTransferTaskBinding

data class TransferTaskItem(
    val taskId: String,
    val fileName: String,
    var progress: Int = 0,
    var speedMbps: Float = 0f,
    var isDownload: Boolean = true,
    var status: String = "传输中", // 传输中, 已完成, 失败
    var remoteDevice: String = "Desktop Hub",
    val timestamp: Long = System.currentTimeMillis()
)

class TransferTaskAdapter(
    private val tasks: MutableList<TransferTaskItem> = mutableListOf()
) : RecyclerView.Adapter<TransferTaskAdapter.ViewHolder>() {

    private var currentTheme = "dark"

    fun setThemeMode(theme: String) {
        currentTheme = theme
        notifyDataSetChanged()
    }

    fun updateTasks(newTasks: List<TransferTaskItem>) {
        tasks.clear()
        tasks.addAll(newTasks)
        notifyDataSetChanged()
    }

    fun updateProgress(taskId: String, fileName: String, progress: Int, speedMbps: Float, isDownload: Boolean = true) {
        val index = tasks.indexOfFirst { it.taskId == taskId }
        if (index != -1) {
            val task = tasks[index]
            task.progress = progress
            task.speedMbps = speedMbps
            task.status = if (progress >= 100) "已完成" else "传输中"
            notifyItemChanged(index)
        } else {
            val newTask = TransferTaskItem(
                taskId = taskId,
                fileName = fileName,
                progress = progress,
                speedMbps = speedMbps,
                isDownload = isDownload,
                status = if (progress >= 100) "已完成" else "传输中"
            )
            tasks.add(0, newTask)
            notifyItemInserted(0)
        }
    }

    fun clearCompleted() {
        val removed = tasks.removeAll { it.status == "已完成" }
        if (removed) notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemTransferTaskBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(tasks[position])
    }

    override fun getItemCount(): Int = tasks.size

    inner class ViewHolder(private val binding: ItemTransferTaskBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(item: TransferTaskItem) {
            binding.tvTaskFileName.text = item.fileName
            binding.tvTaskDevice.text = if (item.isDownload) "来自: ${item.remoteDevice}" else "投送至: ${item.remoteDevice}"
            binding.pbTaskProgress.progress = item.progress
            binding.tvTaskProgressPercent.text = "${item.progress}%"
            binding.tvTaskSpeed.text = if (item.status == "已完成") "已存入沙箱" else String.format(java.util.Locale.US, "%.1f MB/s", item.speedMbps)

            binding.ivTaskDirection.setImageResource(if (item.isDownload) R.drawable.ic_download else R.drawable.ic_send)

            binding.tvTaskStatusBadge.text = item.status
            when (item.status) {
                "已完成" -> binding.tvTaskStatusBadge.setTextColor(Color.parseColor("#10B981"))
                "失败" -> binding.tvTaskStatusBadge.setTextColor(Color.parseColor("#EF4444"))
                else -> binding.tvTaskStatusBadge.setTextColor(Color.parseColor("#06B6D4"))
            }

            // Theme styling
            when (currentTheme) {
                "eyecare" -> {
                    binding.cardTransferTask.setCardBackgroundColor(Color.parseColor("#F5EDDC"))
                    binding.cardTransferTask.strokeColor = Color.parseColor("#D5C7AA")
                    binding.tvTaskFileName.setTextColor(Color.parseColor("#000000"))
                    binding.tvTaskDevice.setTextColor(Color.parseColor("#3D382B"))
                    binding.tvTaskProgressPercent.setTextColor(Color.parseColor("#000000"))
                }
                "light" -> {
                    binding.cardTransferTask.setCardBackgroundColor(Color.parseColor("#FFFFFF"))
                    binding.cardTransferTask.strokeColor = Color.parseColor("#E2E8F0")
                    binding.tvTaskFileName.setTextColor(Color.parseColor("#000000"))
                    binding.tvTaskDevice.setTextColor(Color.parseColor("#64748B"))
                    binding.tvTaskProgressPercent.setTextColor(Color.parseColor("#000000"))
                }
                else -> {
                    binding.cardTransferTask.setCardBackgroundColor(Color.parseColor("#111827"))
                    binding.cardTransferTask.strokeColor = Color.parseColor("#334155")
                    binding.tvTaskFileName.setTextColor(Color.parseColor("#F8FAFC"))
                    binding.tvTaskDevice.setTextColor(Color.parseColor("#94A3B8"))
                    binding.tvTaskProgressPercent.setTextColor(Color.parseColor("#F8FAFC"))
                }
            }
        }
    }
}
