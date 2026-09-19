package com.safedrop.mobile.ui.adapter

data class ChannelMessage(
    val id: String,
    val type: Type,
    val isOutgoing: Boolean,
    val text: String = "",
    val fileName: String = "",
    val fileSize: Long = 0L,
    var progress: Int = 0,
    var speed: String = "",
    var status: String = "completed",
    val timestamp: Long = System.currentTimeMillis()
) {
    enum class Type { TEXT, FILE }
}
