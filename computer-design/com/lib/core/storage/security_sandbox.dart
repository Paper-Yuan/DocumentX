import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// 安全沙箱与落盘管理器：严格防御恶意路径穿越 (../) 漏洞与同名覆盖伪装
class SecuritySandbox {
  Directory? _downloadDirectory;

  /// 初始化并获取安全的 SafeDrop 下载目录
  Future<Directory> getDownloadDirectory() async {
    if (_downloadDirectory != null && await _downloadDirectory!.exists()) {
      return _downloadDirectory!;
    }
    final downloads = await getDownloadsDirectory();
    final target = Directory(p.join(downloads?.path ?? Directory.current.path, 'SafeDrop'));
    if (!await target.exists()) {
      await target.create(recursive: true);
    }
    _downloadDirectory = target;
    return target;
  }

  /// 设置自定义下载目录
  void setCustomDownloadDirectory(String path) {
    _downloadDirectory = Directory(path);
  }

  /// 净化文件名：强力剔除相对路径、盘符、特殊控制字符，防止目录遍历攻击 (Path Traversal)
  String sanitizeFileName(String inputName) {
    // 仅保留基础文件名
    String safeName = p.basename(inputName);

    // 剔除 Windows 非法字符: \ / : * ? " < > |
    safeName = safeName.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');

    // 剔除任何试图穿越的符号与前后空格
    safeName = safeName.replaceAll('..', '').trim();

    if (safeName.isEmpty || safeName == '.' || safeName == '..') {
      safeName = 'unnamed_file_${DateTime.now().millisecondsSinceEpoch}';
    }

    return safeName;
  }

  /// 解决同名冲突：生成不重复的目标文件路径 (例如: demo (1).txt)
  Future<File> resolveUniqueDestinationFile(String sanitizedFileName) async {
    final dir = await getDownloadDirectory();
    final nameWithoutExt = p.basenameWithoutExtension(sanitizedFileName);
    final ext = p.extension(sanitizedFileName);

    var candidate = File(p.join(dir.path, sanitizedFileName));
    int counter = 1;

    while (await candidate.exists()) {
      final newName = '$nameWithoutExt ($counter)$ext';
      candidate = File(p.join(dir.path, newName));
      counter++;
    }

    return candidate;
  }

  /// 获取传输中的临时 .part 文件
  Future<File> getTemporaryPartFile(String taskId, String sanitizedFileName) async {
    final dir = await getDownloadDirectory();
    return File(p.join(dir.path, '.${taskId}_$sanitizedFileName.part'));
  }
}
