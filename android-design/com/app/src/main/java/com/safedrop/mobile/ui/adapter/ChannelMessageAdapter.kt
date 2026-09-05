package com.safedrop.mobile.ui.adapter

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.text.Selection
import android.text.Spannable
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.databinding.ItemChannelMessageBinding
import java.text.SimpleDateFormat
import java.util.*

class ChannelMessageAdapter : RecyclerView.Adapter<ChannelMessageAdapter.ChannelMessageViewHolder>() {

    private val messages = mutableListOf<ChannelMessage>()
    private var themeMode: String = "dark"
    private val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())

    fun setMessages(newMessages: List<ChannelMessage>) {
        messages.clear()
        messages.addAll(newMessages)
        notifyDataSetChanged()
    }

    fun addOrUpdateMessage(message: ChannelMessage) {
        val idx = messages.indexOfFirst { it.id == message.id }
        if (idx != -1) {
            messages[idx] = message
            notifyItemChanged(idx)
        } else {
            messages.add(message)
            notifyItemInserted(messages.size - 1)
        }
    }

    fun setThemeMode(theme: String) {
        this.themeMode = theme
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ChannelMessageViewHolder {
        val binding = ItemChannelMessageBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ChannelMessageViewHolder(binding, timeFormat)
    }

    override fun onBindViewHolder(holder: ChannelMessageViewHolder, position: Int) {
        holder.bind(messages[position], themeMode)
    }

    override fun getItemCount(): Int = messages.size

    class ChannelMessageViewHolder(
        private val binding: ItemChannelMessageBinding,
        private val timeFormat: SimpleDateFormat
    ) : RecyclerView.ViewHolder(binding.root) {

        fun bind(msg: ChannelMessage, theme: String) {
            val timeStr = timeFormat.format(Date(msg.timestamp))

            if (msg.type == ChannelMessage.Type.TEXT) {
                binding.layoutTextBubble.visibility = View.VISIBLE
                binding.layoutFileCard.visibility = View.GONE

                binding.tvMessageContent.setTextIsSelectable(true)
                binding.tvMessageContent.text = msg.text
                binding.tvMessageTime.text = timeStr

                // Long-press handler to copy or select text
                val handleLongPress = View.OnLongClickListener { v ->
                    val text = msg.text
                    if (text.isNotEmpty()) {
                        val context = v.context
                        val items = arrayOf("复制全文", "选中文本")
                        AlertDialog.Builder(context)
                            .setTitle("会话文本")
                            .setItems(items) { _, which ->
                                when (which) {
                                    0 -> {
                                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                        val clip = ClipData.newPlainText("SafeDrop Message", text)
                                        clipboard.setPrimaryClip(clip)
                                        val preview = if (text.length > 20) text.take(20) + "..." else text
                                        Toast.makeText(context, "已复制文本: \"$preview\"", Toast.LENGTH_SHORT).show()
                                    }
                                    1 -> {
                                        binding.tvMessageContent.requestFocus()
                                        val spannable = binding.tvMessageContent.text as? Spannable
                                        if (spannable != null) {
                                            Selection.selectAll(spannable)
                                        }
                                    }
                                }
                            }
                            .show()
                    }
                    true
                }

                binding.cardTextBubble.setOnLongClickListener(handleLongPress)

                if (msg.isOutgoing) {
                    binding.spacerTextLeft.visibility = View.VISIBLE
                    binding.spacerTextRight.visibility = View.GONE
                } else {
                    binding.spacerTextLeft.visibility = View.GONE
                    binding.spacerTextRight.visibility = View.VISIBLE
                }

                // Theme for text bubble & highlight color
                when (theme) {
                    "eyecare" -> {
                        binding.tvMessageContent.highlightColor = Color.parseColor("#B4DFC4")
                        if (msg.isOutgoing) {
                            binding.cardTextBubble.setCardBackgroundColor(Color.parseColor("#CDE8D5"))
                            binding.cardTextBubble.strokeColor = Color.parseColor("#A8D5B5")
                            binding.tvMessageContent.setTextColor(Color.parseColor("#000000"))
                        } else {
                            binding.cardTextBubble.setCardBackgroundColor(Color.parseColor("#F5EDDC"))
                            binding.cardTextBubble.strokeColor = Color.parseColor("#D5C7AA")
                            binding.tvMessageContent.setTextColor(Color.parseColor("#000000"))
                        }
                        binding.tvMessageTime.setTextColor(Color.parseColor("#5C5243"))
                    }
                    "light" -> {
                        binding.tvMessageContent.highlightColor = Color.parseColor("#BFDBFE")
                        if (msg.isOutgoing) {
                            binding.cardTextBubble.setCardBackgroundColor(Color.parseColor("#E0E7FF"))
                            binding.cardTextBubble.strokeColor = Color.parseColor("#C7D2FE")
                            binding.tvMessageContent.setTextColor(Color.parseColor("#1E1B4B"))
                        } else {
                            binding.cardTextBubble.setCardBackgroundColor(Color.parseColor("#FFFFFF"))
                            binding.cardTextBubble.strokeColor = Color.parseColor("#E2E8F0")
                            binding.tvMessageContent.setTextColor(Color.parseColor("#0F172A"))
                        }
                        binding.tvMessageTime.setTextColor(Color.parseColor("#64748B"))
                    }
                    else -> {
                        binding.tvMessageContent.highlightColor = Color.parseColor("#4338CA")
                        if (msg.isOutgoing) {
                            binding.cardTextBubble.setCardBackgroundColor(Color.parseColor("#3730A3"))
                            binding.cardTextBubble.strokeColor = Color.parseColor("#4F46E5")
                            binding.tvMessageContent.setTextColor(Color.parseColor("#EEF2FF"))
                        } else {
                            binding.cardTextBubble.setCardBackgroundColor(Color.parseColor("#1F2937"))
                            binding.cardTextBubble.strokeColor = Color.parseColor("#374151")
                            binding.tvMessageContent.setTextColor(Color.parseColor("#F9FAFB"))
                        }
                        binding.tvMessageTime.setTextColor(Color.parseColor("#9CA3AF"))
                    }
                }
            } else {
                // File Transfer Card
                binding.layoutTextBubble.visibility = View.GONE
                binding.layoutFileCard.visibility = View.VISIBLE

                binding.tvFileName.text = msg.fileName
                val dirText = if (msg.isOutgoing) "投送至对端" else "来自对端"
                binding.tvFileSizeAndDirection.text = "${formatSize(msg.fileSize)} • $dirText"
                binding.tvFileTime.text = timeStr
                binding.pbFileTransfer.progress = msg.progress

                val isDone = msg.status == "completed" || msg.progress >= 100
                val isFailed = msg.status == "failed"

                if (isDone) {
                    binding.tvFileStatusBadge.text = "已完成"
                    binding.tvFileStatusBadge.setTextColor(Color.parseColor("#10B981"))
                    binding.tvFileSpeed.text = "已落盘至沙箱"
                    binding.pbFileTransfer.visibility = View.GONE
                } else if (isFailed) {
                    binding.tvFileStatusBadge.text = "中断"
                    binding.tvFileStatusBadge.setTextColor(Color.parseColor("#EF4444"))
                    binding.tvFileSpeed.text = "传输中断"
                    binding.pbFileTransfer.visibility = View.GONE
                } else {
                    binding.tvFileStatusBadge.text = "${msg.progress}%"
                    binding.tvFileStatusBadge.setTextColor(Color.parseColor("#6366F1"))
                    binding.tvFileSpeed.text = msg.speed.ifEmpty { "传输中..." }
                    binding.pbFileTransfer.visibility = View.VISIBLE
                }

                if (msg.isOutgoing) {
                    binding.spacerFileLeft.visibility = View.VISIBLE
                    binding.spacerFileRight.visibility = View.GONE
                } else {
                    binding.spacerFileLeft.visibility = View.GONE
                    binding.spacerFileRight.visibility = View.VISIBLE
                }

                // Theme for file card
                when (theme) {
                    "eyecare" -> {
                        binding.cardFileTransfer.setCardBackgroundColor(Color.parseColor("#F5EDDC"))
                        binding.cardFileTransfer.strokeColor = Color.parseColor("#D5C7AA")
                        binding.tvFileName.setTextColor(Color.parseColor("#000000"))
                        binding.tvFileSizeAndDirection.setTextColor(Color.parseColor("#5C5243"))
                        binding.tvFileSpeed.setTextColor(Color.parseColor("#5C5243"))
                        binding.tvFileTime.setTextColor(Color.parseColor("#5C5243"))
                    }
                    "light" -> {
                        binding.cardFileTransfer.setCardBackgroundColor(Color.parseColor("#FFFFFF"))
                        binding.cardFileTransfer.strokeColor = Color.parseColor("#E2E8F0")
                        binding.tvFileName.setTextColor(Color.parseColor("#0F172A"))
                        binding.tvFileSizeAndDirection.setTextColor(Color.parseColor("#64748B"))
                        binding.tvFileSpeed.setTextColor(Color.parseColor("#64748B"))
                        binding.tvFileTime.setTextColor(Color.parseColor("#64748B"))
                    }
                    else -> {
                        binding.cardFileTransfer.setCardBackgroundColor(Color.parseColor("#111827"))
                        binding.cardFileTransfer.strokeColor = Color.parseColor("#1F2937")
                        binding.tvFileName.setTextColor(Color.parseColor("#F8FAFC"))
                        binding.tvFileSizeAndDirection.setTextColor(Color.parseColor("#94A3B8"))
                        binding.tvFileSpeed.setTextColor(Color.parseColor("#94A3B8"))
                        binding.tvFileTime.setTextColor(Color.parseColor("#94A3B8"))
                    }
                }
            }
        }

        private fun formatSize(bytes: Long): String {
            if (bytes <= 0) return "0 B"
            val kb = bytes / 1024.0
            val mb = kb / 1024.0
            val gb = mb / 1024.0
            return when {
                gb >= 1.0 -> String.format(Locale.US, "%.1f GB", gb)
                mb >= 1.0 -> String.format(Locale.US, "%.1f MB", mb)
                kb >= 1.0 -> String.format(Locale.US, "%.1f KB", kb)
                else -> "$bytes B"
            }
        }
    }
}
