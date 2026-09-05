import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'transfer_model.dart';

final transferListProvider = StateNotifierProvider<TransferQueue, List<TransferTask>>((ref) {
  return TransferQueue();
});

/// 传输多任务队列与并发分发器
class TransferQueue extends StateNotifier<List<TransferTask>> {
  TransferQueue() : super([]);

  /// 压入新任务
  void enqueueTask(TransferTask task) {
    state = [task, ...state];
  }

  /// 更新任务进度
  void updateProgress(String taskId, int bytesTransferred, double speed) {
    state = [
      for (final t in state)
        if (t.taskId == taskId)
          TransferTask(
            taskId: t.taskId,
            fileName: t.fileName,
            fileSize: t.fileSize,
            bytesTransferred: bytesTransferred,
            speedBytesPerSec: speed,
            status: TransferStatus.running,
            isSender: t.isSender,
            remoteDeviceName: t.remoteDeviceName,
            startTime: t.startTime,
          )
        else
          t,
    ];
  }

  /// 标记任务完成
  void markCompleted(String taskId) {
    state = [
      for (final t in state)
        if (t.taskId == taskId)
          TransferTask(
            taskId: t.taskId,
            fileName: t.fileName,
            fileSize: t.fileSize,
            bytesTransferred: t.fileSize,
            speedBytesPerSec: 0,
            status: TransferStatus.completed,
            isSender: t.isSender,
            remoteDeviceName: t.remoteDeviceName,
            startTime: t.startTime,
          )
        else
          t,
    ];
  }

  /// 标记任务失败
  void markFailed(String taskId) {
    state = [
      for (final t in state)
        if (t.taskId == taskId)
          TransferTask(
            taskId: t.taskId,
            fileName: t.fileName,
            fileSize: t.fileSize,
            bytesTransferred: t.bytesTransferred,
            speedBytesPerSec: 0,
            status: TransferStatus.failed,
            isSender: t.isSender,
            remoteDeviceName: t.remoteDeviceName,
            startTime: t.startTime,
          )
        else
          t,
    ];
  }
}
