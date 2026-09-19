package com.safedrop.mobile.ui.transfer

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import com.safedrop.mobile.databinding.DialogTransferSheetBinding

/**
 * Transfer Progress Modal Bottom Sheet
 */
class TransferSheetDialog : BottomSheetDialogFragment() {

    private var _binding: DialogTransferSheetBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = DialogTransferSheetBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.btnCancelTransfer.setOnClickListener {
            dismiss()
        }
    }

    fun updateProgress(fileName: String, progress: Int, speedMbps: Float) {
        if (_binding == null) return
        binding.tvTransferFileName.text = fileName
        binding.progressBar.progress = progress
        binding.tvTransferPercent.text = "$progress%"
        binding.tvTransferSpeed.text = "%.1f MB/s".format(speedMbps)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        const val TAG = "TransferSheetDialog"
        fun newInstance(): TransferSheetDialog = TransferSheetDialog()
    }
}
