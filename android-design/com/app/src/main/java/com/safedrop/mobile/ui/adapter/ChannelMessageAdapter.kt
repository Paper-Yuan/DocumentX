package com.safedrop.mobile.ui.adapter

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.Selection
import android.text.Spannable
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.appcompat.app.AlertDialog
import androidx.recyclerview.widget.RecyclerView
import com.safedrop.mobile.R
import com.safedrop.mobile.databinding.ItemChannelMessageBinding
import com.safedrop.mobile.ui.Palette
import java.text.SimpleDateFormat
import java.util.*

/**
 * The conversation with one peer: text bubbles and transfer rows.
 *
 * Colour means state and nothing else - ready for a file that landed, failure for one that did
 * not, active while bytes are moving. An outgoing bubble is set apart by surface weight rather
 * than by a second brand colour, because there is no second brand colour.
 */
class ChannelMessageAdapter(
    private val onOpenFile: (ChannelMessage) -> Unit = {},
    private val onShareFile: (ChannelMessage) -> Unit = {}
) : RecyclerView.Adapter<ChannelMessageAdapter.ChannelMessageViewHolder>() {

    private val messages = mutableListOf<ChannelMessage>()
    private var themeMode: String = Palette.DARK
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
        return ChannelMessageViewHolder(binding, timeFormat, onOpenFile, onShareFile)
    }

    override fun onBindViewHolder(holder: ChannelMessageViewHolder, position: Int) {
        holder.bind(messages[position], themeMode)
    }

    override fun getItemCount(): Int = messages.size

    class ChannelMessageViewHolder(
        private val binding: ItemChannelMessageBinding,
        private val timeFormat: SimpleDateFormat,
        private val onOpenFile: (ChannelMessage) -> Unit,
        private val onShareFile: (ChannelMessage) -> Unit
    ) : RecyclerView.ViewHolder(binding.root) {

        fun bind(msg: ChannelMessage, theme: String) {
            val ctx = binding.root.context
            val p = Palette.of(ctx, theme)
            val timeStr = timeFormat.format(Date(msg.timestamp))

            if (msg.type == ChannelMessage.Type.TEXT) {
                binding.layoutTextBubble.visibility = View.VISIBLE
                binding.layoutFileCard.visibility = View.GONE

                binding.tvMessageContent.setTextIsSelectable(true)
                binding.tvMessageContent.text = msg.text
                binding.tvMessageTime.text = timeStr

                // Long-press: copy or select. The copy used to announce itself with a toast that
                // echoed the text back; the system clipboard indicator is enough.
                val handleLongPress = View.OnLongClickListener { v ->
                    val text = msg.text
                    if (text.isNotEmpty()) {
                        val context = v.context
                        val items = arrayOf(
                            context.getString(R.string.chat_copy_text),
                            context.getString(R.string.chat_select_text)
                        )
                        AlertDialog.Builder(context)
                            .setTitle(R.string.chat_title)
                            .setItems(items) { _, which ->
                                when (which) {
                                    0 -> {
                                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                        clipboard.setPrimaryClip(ClipData.newPlainText("SafeDrop", text))
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

                binding.cardTextBubble.setCardBackgroundColor(if (msg.isOutgoing) p.raised else p.surface)
                binding.cardTextBubble.strokeColor = p.hairline
                binding.tvMessageContent.setTextColor(p.ink)
                binding.tvMessageContent.highlightColor = p.raised
                binding.tvMessageTime.setTextColor(p.inkFaint)
                return
            }

            // Transfer row
            binding.layoutTextBubble.visibility = View.GONE
            binding.layoutFileCard.visibility = View.VISIBLE

            binding.tvFileName.text = msg.fileName
            val dirText = ctx.getString(
                if (msg.isOutgoing) R.string.transfer_out_short else R.string.transfer_in_short
            )
            binding.tvFileSizeAndDirection.text = "${formatSize(msg.fileSize)} · $dirText"
            binding.tvFileTime.text = timeStr
            binding.pbFileTransfer.progress = msg.progress
            binding.ivFileIcon.setImageResource(
                if (msg.isOutgoing) R.drawable.ic_send else R.drawable.ic_download
            )

            val isDone = msg.status == "completed" || msg.progress >= 100
            val isFailed = msg.status == "failed"

            if (isDone) {
                binding.tvFileStatusBadge.text = ctx.getString(R.string.transfer_done_badge)
                binding.tvFileStatusBadge.setTextColor(p.ready)
                binding.tvFileSpeed.text = ctx.getString(R.string.transfer_saved_here)
                binding.pbFileTransfer.visibility = View.GONE
                // A file that has landed gets the actions that make it findable again.
                binding.layoutFileActions.visibility = View.VISIBLE
                binding.cardFileTransfer.isClickable = true
                binding.cardFileTransfer.setOnClickListener { onOpenFile(msg) }
                binding.btnFileOpenAction.setOnClickListener { onOpenFile(msg) }
                binding.btnFileShareAction.setOnClickListener { onShareFile(msg) }
            } else if (isFailed) {
                binding.tvFileStatusBadge.text = ctx.getString(R.string.transfer_failed)
                binding.tvFileStatusBadge.setTextColor(p.failure)
                binding.tvFileSpeed.text = ctx.getString(R.string.transfer_failed)
                binding.pbFileTransfer.visibility = View.GONE
                clearRowActions()
            } else {
                binding.tvFileStatusBadge.text = "${msg.progress}%"
                binding.tvFileStatusBadge.setTextColor(p.active)
                binding.tvFileSpeed.text =
                    if (msg.speed.isEmpty()) ctx.getString(R.string.transferring) else msg.speed
                binding.pbFileTransfer.visibility = View.VISIBLE
                clearRowActions()
            }

            if (msg.isOutgoing) {
                binding.spacerFileLeft.visibility = View.VISIBLE
                binding.spacerFileRight.visibility = View.GONE
            } else {
                binding.spacerFileLeft.visibility = View.GONE
                binding.spacerFileRight.visibility = View.VISIBLE
            }

            binding.cardFileTransfer.setCardBackgroundColor(p.surface)
            binding.cardFileTransfer.strokeColor = p.hairline
            binding.ivFileIcon.backgroundTintList = p.states(p.raised)
            binding.ivFileIcon.imageTintList = p.states(p.ink)
            binding.tvFileName.setTextColor(p.ink)
            binding.tvFileSizeAndDirection.setTextColor(p.inkFaint)
            binding.tvFileSpeed.setTextColor(p.inkMuted)
            binding.tvFileTime.setTextColor(p.inkFaint)
            binding.tvFileStatusBadge.backgroundTintList = p.states(p.raised)
            binding.btnFileOpenAction.setTextColor(p.inkMuted)
            binding.btnFileShareAction.setTextColor(p.inkMuted)
        }

        private fun clearRowActions() {
            binding.layoutFileActions.visibility = View.GONE
            binding.cardFileTransfer.setOnClickListener(null)
            binding.cardFileTransfer.isClickable = false
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
