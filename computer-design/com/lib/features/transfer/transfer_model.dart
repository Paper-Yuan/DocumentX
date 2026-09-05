enum TransferStatus {
  queued,
  running,
  paused,
  completed,
  failed,
}

class TransferTask {
  final String taskId;
  final String fileName;
  final int fileSize;
  int bytesTransferred;
  double speedBytesPerSec;
  TransferStatus status;
  final bool isSender;
  final String remoteDeviceName;
  final DateTime startTime;

  TransferTask({
    required this.taskId,
    required this.fileName,
    required this.fileSize,
    this.bytesTransferred = 0,
    this.speedBytesPerSec = 0.0,
    this.status = TransferStatus.queued,
    required this.isSender,
    required this.remoteDeviceName,
    DateTime? startTime,
  }) : startTime = startTime ?? DateTime.now();

  double get progress => fileSize == 0 ? 0.0 : (bytesTransferred / fileSize).clamp(0.0, 1.0);

  String get formattedSpeed {
    if (speedBytesPerSec < 1024) {
      return '${speedBytesPerSec.toStringAsFixed(1)} B/s';
    } else if (speedBytesPerSec < 1024 * 1024) {
      return '${(speedBytesPerSec / 1024).toStringAsFixed(1)} KB/s';
    } else {
      return '${(speedBytesPerSec / (1024 * 1024)).toStringAsFixed(1)} MB/s';
    }
  }

  String get formattedSize {
    if (fileSize < 1024) {
      return '$fileSize B';
    } else if (fileSize < 1024 * 1024) {
      return '${(fileSize / 1024).toStringAsFixed(1)} KB';
    } else if (fileSize < 1024 * 1024 * 1024) {
      return '${(fileSize / (1024 * 1024)).toStringAsFixed(1)} MB';
    } else {
      return '${(fileSize / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB';
    }
  }
}
