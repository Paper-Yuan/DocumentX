import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:safedrop_desktop/core/crypto/crypto_engine.dart';
import 'package:safedrop_desktop/core/storage/security_sandbox.dart';

void main() {
  group('SafeDrop Core Crypto & Security Tests', () {
    final crypto = CryptoEngine();
    final sandbox = SecuritySandbox();

    test('X25519 ECDH Key Agreement & HKDF SessionKey Derivation', () async {
      // 1. 生成 Alice (桌面端) 与 Bob (移动端) 密钥对
      final alicePair = await crypto.generateEphemeralKeyPair();
      final bobPair = await crypto.generateEphemeralKeyPair();

      final alicePubBytes = await crypto.extractPublicKeyBytes(alicePair);
      final bobPubBytes = await crypto.extractPublicKeyBytes(bobPair);

      // 计算指纹
      final aliceFp = await crypto.calculateFingerprint(alicePubBytes);
      final bobFp = await crypto.calculateFingerprint(bobPubBytes);
      expect(aliceFp.length, equals(16));
      expect(bobFp.length, equals(16));

      // 双端各自独立派生 SessionKey
      final salt = [1, 2, 3, 4, 5, 6, 7, 8];
      final info = [9, 10, 11, 12];

      final aliceSessionKey = await crypto.deriveSessionKey(
        localKeyPair: alicePair,
        remotePublicKeyBytes: bobPubBytes,
        salt: salt,
        info: info,
      );

      final bobSessionKey = await crypto.deriveSessionKey(
        localKeyPair: bobPair,
        remotePublicKeyBytes: alicePubBytes,
        salt: salt,
        info: info,
      );

      final aliceKeyBytes = await aliceSessionKey.extractBytes();
      final bobKeyBytes = await bobSessionKey.extractBytes();
      expect(aliceKeyBytes, equals(bobKeyBytes));
    });

    test('AES-256-GCM 1MB Chunk Encryption & Decryption Pipeline', () async {
      final keyPair = await crypto.generateEphemeralKeyPair();
      final pubBytes = await crypto.extractPublicKeyBytes(keyPair);
      final sessionKey = await crypto.deriveSessionKey(
        localKeyPair: keyPair,
        remotePublicKeyBytes: pubBytes,
        salt: [0, 0, 0, 0],
        info: [1, 1, 1, 1],
      );

      // 构造 1MB 测试数据
      final testData = Uint8List(1024 * 1024);
      for (int i = 0; i < testData.length; i++) {
        testData[i] = i % 256;
      }

      // 加密 1MB
      final encrypted = await crypto.encryptChunk(
        plaintextChunk: testData,
        sessionKey: sessionKey,
        chunkIndex: 0,
      );

      // 解密 1MB
      final decrypted = await crypto.decryptChunk(
        encryptedData: encrypted,
        sessionKey: sessionKey,
      );

      expect(decrypted, equals(testData));
    });

    test('Security Sandbox Path Traversal Defense', () {
      expect(sandbox.sanitizeFileName('../../etc/passwd'), equals('passwd'));
      expect(sandbox.sanitizeFileName('..\\..\\Windows\\System32\\cmd.exe'), equals('cmd.exe'));
      expect(sandbox.sanitizeFileName('C:\\secret\\trojan:bad.exe'), equals('trojan_bad.exe'));
    });
  });
}
