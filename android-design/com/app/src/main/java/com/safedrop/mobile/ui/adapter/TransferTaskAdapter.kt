package com.safedrop.mobile.ui.adapter

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.R
import com.safedrop.mobile.databinding.ItemTransferTaskBinding
import com.safedrop.mobile.ui.Palette

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

    private var currentTheme = Palette.DARK

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
            val ctx = binding.root.context
            val p = Palette.of(ctx, currentTheme)
            binding.tvTaskFileName.text = item.fileName
            binding.tvTaskDevice.text = ctx.getString(
                if (item.isDownload) R.string.transfer_from else R.string.transfer_to,
                item.remoteDevice
            )
            binding.pbTaskProgress.progress = item.progress
            // Percent and speed are machine values: monospace keeps the column still as they run.
            binding.tvTaskProgressPercent.typeface = android.graphics.Typeface.MONOSPACE
            binding.tvTaskSpeed.typeface = android.graphics.Typeface.MONOSPACE
            binding.tvTaskProgressPercent.text = "${item.progress}%"
            binding.tvTaskSpeed.text = if (item.status == "已完成")
                ctx.getString(R.string.transfer_saved_here)
            else String.format(java.util.Locale.US, "%.1f MB/s", item.speedMbps)

            binding.ivTaskDirection.setImageResource(if (item.isDownload) R.drawable.ic_download else R.drawable.ic_send)

            binding.tvTaskStatusBadge.text = item.status
            when (item.status) {
                "已完成" -> binding.tvTaskStatusBadge.setTextColor(p.ready)
                "失败" -> binding.tvTaskStatusBadge.setTextColor(p.failure)
                else -> binding.tvTaskStatusBadge.setTextColor(p.active)
            }

            binding.cardTransferTask.setCardBackgroundColor(p.surface)
            binding.cardTransferTask.strokeColor = p.hairline
            binding.ivTaskDirection.backgroundTintList = p.states(p.raised)
            binding.ivTaskDirection.imageTintList = p.states(p.ink)
            binding.tvTaskFileName.setTextColor(p.ink)
            binding.tvTaskDevice.setTextColor(p.inkFaint)
            binding.tvTaskProgressPercent.setTextColor(p.inkMuted)
            binding.tvTaskSpeed.setTextColor(p.inkMuted)
            binding.pbTaskProgress.setIndicatorColor(p.active)
            binding.pbTaskProgress.setTrackColor(p.raised)
        }
    }
}
