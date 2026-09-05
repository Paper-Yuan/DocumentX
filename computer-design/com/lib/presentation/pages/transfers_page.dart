import 'package:fluent_ui/fluent_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../features/transfer/transfer_queue.dart';
import '../../features/transfer/transfer_model.dart';

/// 传输队列与并发任务监控页
class TransfersPage extends ConsumerWidget {
  const TransfersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tasks = ref.watch(transferListProvider);
    final theme = FluentTheme.of(context);

    return ScaffoldPage.scrollable(
      header: const PageHeader(
        title: Text('传输任务队列'),
      ),
      children: [
        if (tasks.isEmpty)
          Container(
            padding: const EdgeInsets.all(48),
            alignment: Alignment.center,
            child: Column(
              children: [
                Icon(FluentIcons.sync_folder, size: 48, color: theme.resources.textFillColorSecondary),
                const SizedBox(height: 16),
                Text(
                  '暂无进行中或已完成的传输任务',
                  style: theme.typography.body?.copyWith(color: theme.resources.textFillColorSecondary),
                ),
              ],
            ),
          )
        else
          ...tasks.map((task) {
            return Card(
              margin: const EdgeInsets.only(bottom: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          Icon(
                            task.isSender ? FluentIcons.upload : FluentIcons.download,
                            color: theme.accentColor,
                          ),
                          const SizedBox(width: 8),
                          Text(task.fileName, style: const TextStyle(fontWeight: FontWeight.bold)),
                        ],
                      ),
                      _buildStatusBadge(task.status),
                    ],
                  ),
                  const SizedBox(height: 8),
                  ProgressBar(value: task.progress * 100),
                  const SizedBox(height: 6),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        '${(task.progress * 100).toStringAsFixed(1)}% • ${task.formattedSize}',
                        style: theme.typography.caption,
                      ),
                      Text(
                        task.formattedSpeed,
                        style: theme.typography.caption?.copyWith(fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                ],
              ),
            );
          }),
      ],
    );
  }

  Widget _buildStatusBadge(TransferStatus status) {
    switch (status) {
      case TransferStatus.running:
        return const Text('传输中', style: TextStyle(color: Color(0xFF0078D4)));
      case TransferStatus.completed:
        return const Text('已完成', style: TextStyle(color: Color(0xFF107C41)));
      case TransferStatus.failed:
        return const Text('失败', style: TextStyle(color: Color(0xFFD13438)));
      case TransferStatus.paused:
        return const Text('已暂停', style: TextStyle(color: Color(0xFFCA5010)));
      case TransferStatus.queued:
        return const Text('排队中', style: TextStyle(color: Color(0xFF8A8886)));
    }
  }
}
