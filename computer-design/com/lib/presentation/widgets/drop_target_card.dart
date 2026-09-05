import 'dart:io';
import 'package:fluent_ui/fluent_ui.dart';
import 'package:desktop_drop/desktop_drop.dart';

/// 全局文件与深层目录拖拽投放卡片（Win32 Drag & Drop）
class DropTargetCard extends StatefulWidget {
  final Function(List<File> files)? onFilesDropped;

  const DropTargetCard({super.key, this.onFilesDropped});

  @override
  State<DropTargetCard> createState() => _DropTargetCardState();
}

class _DropTargetCardState extends State<DropTargetCard> {
  bool _isDragging = false;

  @override
  Widget build(BuildContext context) {
    final theme = FluentTheme.of(context);

    return DropTarget(
      onDragEntered: (details) => setState(() => _isDragging = true),
      onDragExited: (details) => setState(() => _isDragging = false),
      onDragDone: (details) async {
        setState(() => _isDragging = false);
        final droppedFiles = <File>[];
        for (final item in details.files) {
          final file = File(item.path);
          if (await file.exists()) {
            droppedFiles.add(file);
          } else {
            // 若拖入的是文件夹，递归检索其下文件
            final dir = Directory(item.path);
            if (await dir.exists()) {
              await for (final entity in dir.list(recursive: true)) {
                if (entity is File) {
                  droppedFiles.add(entity);
                }
              }
            }
          }
        }
        if (droppedFiles.isNotEmpty) {
          widget.onFilesDropped?.call(droppedFiles);
        }
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        width: double.infinity,
        height: 120,
        decoration: BoxDecoration(
          color: _isDragging
              ? theme.accentColor.withValues(alpha: 0.12)
              : theme.cardColor,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: _isDragging
                ? theme.accentColor
                : theme.resources.dividerStrokeColorDefault,
            width: _isDragging ? 2 : 1,
          ),
        ),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                FluentIcons.cloud_upload,
                size: 32,
                color: _isDragging ? theme.accentColor : theme.resources.textFillColorSecondary,
              ),
              const SizedBox(height: 8),
              Text(
                _isDragging ? '释放以立即压入发送队列' : '拖拽单个文件、多个文件或整个文件夹至此处发送',
                style: theme.typography.body?.copyWith(
                  color: _isDragging ? theme.accentColor : theme.resources.textFillColorPrimary,
                  fontWeight: _isDragging ? FontWeight.bold : FontWeight.normal,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
