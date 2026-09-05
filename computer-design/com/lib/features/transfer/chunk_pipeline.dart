import 'dart:async';
import 'dart:io';
import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;
import '../../app/constants.dart';
import '../../core/crypto/crypto_engine.dart';

/// 1MB 分块流式加密传输管道（支持背压与大文件低内存常驻）
class ChunkPipeline {
  final CryptoEngine _cryptoEngine;

  ChunkPipeline({CryptoEngine? cryptoEngine})
      : _cryptoEngine = cryptoEngine ?? CryptoEngine();

  /// 将本地文件分块（1MB）流式读取、加密并发送至目标对端
  Future<void> sendFileStream({
    required File file,
    required String targetIp,
    required int targetPort,
    required String taskId,
    required SecretKey sessionKey,
    required Function(int bytesSent, int totalBytes) onProgress,
  }) async {
    final fileSize = await file.length();
    final totalChunks = (fileSize / AppConstants.chunkSizeBytes).ceil();
    final raf = await file.open(mode: FileMode.read);

    int chunkIndex = 0;
    int totalBytesSent = 0;

    try {
      while (totalBytesSent < fileSize) {
        final toRead = (fileSize - totalBytesSent > AppConstants.chunkSizeBytes)
            ? AppConstants.chunkSizeBytes
            : fileSize - totalBytesSent;

        final rawChunk = await raf.read(toRead);

        // 1. AES-256-GCM 1MB 加密
        final encryptedChunk = await _cryptoEngine.encryptChunk(
          plaintextChunk: rawChunk,
          sessionKey: sessionKey,
          chunkIndex: chunkIndex,
        );

        // 2. HTTP POST 推流上传（背压等待对端 Chunk Ack）
        final url = Uri.parse('http://$targetIp:$targetPort/api/v1/transfer/upload');
        final request = http.Request('POST', url)
          ..headers['x-task-id'] = taskId
          ..headers['x-file-name'] = Uri.encodeComponent(file.uri.pathSegments.last)
          ..headers['x-chunk-index'] = chunkIndex.toString()
          ..headers['x-chunk-count'] = totalChunks.toString()
          ..headers['x-file-size'] = fileSize.toString()
          ..bodyBytes = encryptedChunk;

        final streamedResponse = await request.send();
        if (streamedResponse.statusCode != 200) {
          throw HttpException('Upload chunk $chunkIndex failed with status ${streamedResponse.statusCode}');
        }

        totalBytesSent += rawChunk.length;
        chunkIndex++;
        onProgress(totalBytesSent, fileSize);
      }
    } finally {
      await raf.close();
    }
  }
}
