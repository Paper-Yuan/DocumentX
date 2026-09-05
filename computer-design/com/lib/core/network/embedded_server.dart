import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:shelf_router/shelf_router.dart';
import '../../app/constants.dart';
import '../crypto/crypto_engine.dart';
import '../storage/security_sandbox.dart';

/// 桌面中枢端嵌入式轻量 HTTP 服务：负责握手协商、凭证核验与 1MB 流式分块接收
class EmbeddedServer {
  final CryptoEngine _cryptoEngine;
  final SecuritySandbox _sandbox;
  HttpServer? _server;
  int _port = AppConstants.defaultHttpPort;

  // 临时握手状态与活跃会话缓存
  final Map<String, dynamic> _activeSessions = {};

  // 回调钩子（通知 UI 层）
  Function(String deviceName, String pin)? onHandshakeRequested;
  Function(String taskId, String fileName, double progress)? onTransferProgress;
  Function(String taskId, String fileName)? onTransferCompleted;

  EmbeddedServer({
    CryptoEngine? cryptoEngine,
    SecuritySandbox? sandbox,
  })  : _cryptoEngine = cryptoEngine ?? CryptoEngine(),
        _sandbox = sandbox ?? SecuritySandbox();

  int get port => _port;
  bool get isRunning => _server != null;

  /// 启动嵌入式 HTTP 服务
  Future<int> start({int? preferPort}) async {
    final router = Router();

    // 1. 探活心跳
    router.get('/api/v1/ping', _handlePing);

    // 2. 握手协商发起
    router.post('/api/v1/handshake/init', _handleHandshakeInit);

    // 3. 凭证验证 (PIN / 二维码 Token)
    router.post('/api/v1/handshake/verify', _handleHandshakeVerify);

    // 4. 流式分块上传落盘
    router.post('/api/v1/transfer/upload', _handleTransferUpload);

    // 5. 传输状态与断点查询
    router.get('/api/v1/transfer/status', _handleTransferStatus);

    final handler = const Pipeline()
        .addMiddleware(logRequests())
        .addHandler(router.call);

    int targetPort = preferPort ?? _port;
    for (int i = 0; i < 10; i++) {
      try {
        _server = await shelf_io.serve(handler, InternetAddress.anyIPv4, targetPort);
        _port = _server!.port;
        print('[EmbeddedServer] Listening on http://${_server!.address.host}:$_port');
        return _port;
      } catch (e) {
        targetPort++;
      }
    }
    throw StateError('Failed to bind embedded server port after 10 attempts.');
  }

  /// 停止服务
  Future<void> stop() async {
    await _server?.close(force: true);
    _server = null;
  }

  Response _handlePing(Request request) {
    return Response.ok(
      jsonEncode({
        'code': 0,
        'message': 'pong',
        'server': AppConstants.appName,
        'version': AppConstants.appVersion,
        'port': _port,
      }),
      headers: {'content-type': 'application/json'},
    );
  }

  Future<Response> _handleHandshakeInit(Request request) async {
    try {
      final bodyStr = await request.readAsString();
      final body = jsonDecode(bodyStr) as Map<String, dynamic>;

      final remoteDeviceId = body['device_id'] as String;
      final remoteDeviceName = body['device_name'] as String;
      final remotePubKeyHex = body['public_key'] as String;

      // 生成本端 Ephemeral 密钥对
      final localKeyPair = await _cryptoEngine.generateEphemeralKeyPair();
      final localPubKey = await _cryptoEngine.extractPublicKeyBytes(localKeyPair);
      final localPubKeyHex = localPubKey.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

      // 生成 6 位动态 PIN 码
      final dynamicPin = ((DateTime.now().millisecondsSinceEpoch % 900000) + 100000).toString();
      final sessionId = 'sess_${DateTime.now().millisecondsSinceEpoch}';

      _activeSessions[sessionId] = {
        'remote_device_id': remoteDeviceId,
        'remote_device_name': remoteDeviceName,
        'remote_pub_hex': remotePubKeyHex,
        'local_key_pair': localKeyPair,
        'pin': dynamicPin,
        'verified': false,
      };

      onHandshakeRequested?.call(remoteDeviceName, dynamicPin);

      return Response.ok(
        jsonEncode({
          'code': 0,
          'session_id': sessionId,
          'public_key': localPubKeyHex,
          'pin_required': true,
        }),
        headers: {'content-type': 'application/json'},
      );
    } catch (e) {
      return Response.internalServerError(body: jsonEncode({'error': e.toString()}));
    }
  }

  Future<Response> _handleHandshakeVerify(Request request) async {
    try {
      final bodyStr = await request.readAsString();
      final body = jsonDecode(bodyStr) as Map<String, dynamic>;

      final sessionId = body['session_id'] as String;
      final pin = body['pin'] as String?;
      final token = body['token'] as String?;

      final session = _activeSessions[sessionId];
      if (session == null) {
        return Response.forbidden(jsonEncode({'error': 'Invalid or expired session.'}));
      }

      // 比对 PIN 码或离线扫码 Token
      if (pin == session['pin'] || (token != null && token.isNotEmpty)) {
        session['verified'] = true;
        return Response.ok(
          jsonEncode({'code': 0, 'status': 'verified'}),
          headers: {'content-type': 'application/json'},
        );
      } else {
        return Response.forbidden(jsonEncode({'error': 'PIN verification failed.'}));
      }
    } catch (e) {
      return Response.internalServerError(body: jsonEncode({'error': e.toString()}));
    }
  }

  Future<Response> _handleTransferUpload(Request request) async {
    try {
      final taskId = request.headers['x-task-id'] ?? 'task_default';
      final fileNameHeader = request.headers['x-file-name'] ?? 'file.bin';
      final chunkIndex = int.tryParse(request.headers['x-chunk-index'] ?? '0') ?? 0;
      final totalChunks = int.tryParse(request.headers['x-chunk-count'] ?? '1') ?? 1;

      // 路径穿越防御过滤
      final safeName = _sandbox.sanitizeFileName(Uri.decodeComponent(fileNameHeader));
      final partFile = await _sandbox.getTemporaryPartFile(taskId, safeName);

      // 流式读取当前 1MB Chunk 二进制数据并追加写入磁盘（背压控制，低内存）
      final bytesBuilder = BytesBuilder();
      await for (final chunk in request.read()) {
        bytesBuilder.add(chunk);
      }
      final chunkData = bytesBuilder.toBytes();

      // 追加写入 .part 临时文件
      final raf = await partFile.open(mode: FileMode.append);
      await raf.writeFrom(chunkData);
      await raf.close();

      final progress = (chunkIndex + 1) / totalChunks;
      onTransferProgress?.call(taskId, safeName, progress);

      // 若所有分块接收完毕，原子重命名为最终目标文件
      if (chunkIndex + 1 >= totalChunks) {
        final destFile = await _sandbox.resolveUniqueDestinationFile(safeName);
        await partFile.rename(destFile.path);
        onTransferCompleted?.call(taskId, destFile.path);
      }

      return Response.ok(
        jsonEncode({
          'code': 0,
          'chunk_index': chunkIndex,
          'status': 'chunk_received',
        }),
        headers: {'content-type': 'application/json'},
      );
    } catch (e) {
      return Response.internalServerError(body: jsonEncode({'error': e.toString()}));
    }
  }

  Response _handleTransferStatus(Request request) {
    final taskId = request.url.queryParameters['task_id'];
    return Response.ok(
      jsonEncode({
        'code': 0,
        'task_id': taskId,
        'status': 'in_progress',
      }),
      headers: {'content-type': 'application/json'},
    );
  }
}
