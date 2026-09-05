import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';
import '../../app/constants.dart';

/// 密码学核心引擎：负责 X25519 密钥协商、HKDF 会话密钥派生、AES-256-GCM 流式分块加解密与 SHA-256 完整性校验
class CryptoEngine {
  final X25519 _x25519 = X25519();
  final AesGcm _aesGcm = AesGcm.with256bits();
  final Sha256 _sha256 = Sha256();
  final Hkdf _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);

  /// 生成临时的 Ephemeral X25519 密钥对（完全前向保密 PFS）
  Future<SimpleKeyPair> generateEphemeralKeyPair() async {
    return await _x25519.newKeyPair();
  }

  /// 提取公钥原始字节
  Future<Uint8List> extractPublicKeyBytes(SimpleKeyPair keyPair) async {
    final pubKey = await keyPair.extractPublicKey();
    return Uint8List.fromList(pubKey.bytes);
  }

  /// 计算公钥 SHA-256 指纹（用于展示与比对）
  Future<String> calculateFingerprint(List<int> publicKeyBytes) async {
    final hash = await _sha256.hash(publicKeyBytes);
    final hex = hash.bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return hex.substring(0, 16).toUpperCase();
  }

  /// 执行 ECDH 协商计算 SharedSecret，并通过 HKDF 派生出 256 位 SessionKey
  Future<SecretKey> deriveSessionKey({
    required SimpleKeyPair localKeyPair,
    required List<int> remotePublicKeyBytes,
    required List<int> salt,
    required List<int> info,
  }) async {
    final remotePublicKey = SimplePublicKey(
      remotePublicKeyBytes,
      type: KeyPairType.x25519,
    );

    // 计算 ECDH 共享密钥
    final sharedSecret = await _x25519.sharedSecretKey(
      keyPair: localKeyPair,
      remotePublicKey: remotePublicKey,
    );

    // HKDF 派生会话密钥
    return await _hkdf.deriveKey(
      secretKey: sharedSecret,
      nonce: salt,
      info: info,
    );
  }

  /// AES-256-GCM 加密 1MB 分块数据
  /// 返回格式：[Nonce 12B] + [Ciphertext N Bytes] + [AuthTag 16B]
  Future<Uint8List> encryptChunk({
    required List<int> plaintextChunk,
    required SecretKey sessionKey,
    required int chunkIndex,
  }) async {
    // 派生唯一的 12 字节 Nonce（根据分块序号防重放）
    final nonceBytes = Uint8List(AppConstants.ivSizeBytes);
    final bdata = ByteData.sublistView(nonceBytes);
    bdata.setUint32(0, chunkIndex, Endian.big);
    // 填充后续字节作为随机混淆
    for (int i = 4; i < AppConstants.ivSizeBytes; i++) {
      nonceBytes[i] = (chunkIndex * 31 + i) & 0xFF;
    }

    final secretBox = await _aesGcm.encrypt(
      plaintextChunk,
      secretKey: sessionKey,
      nonce: nonceBytes,
    );

    final result = BytesBuilder();
    result.add(secretBox.nonce);
    result.add(secretBox.cipherText);
    result.add(secretBox.mac.bytes);
    return result.toBytes();
  }

  /// AES-256-GCM 解密分块数据
  /// 校验 16 字节 AuthTag，若篡改立即抛出 SecretBoxAuthenticationError 异常
  Future<Uint8List> decryptChunk({
    required List<int> encryptedData,
    required SecretKey sessionKey,
  }) async {
    if (encryptedData.length < AppConstants.ivSizeBytes + AppConstants.authTagSizeBytes) {
      throw ArgumentError('Encrypted chunk length is too short.');
    }

    final nonce = encryptedData.sublist(0, AppConstants.ivSizeBytes);
    final ciphertext = encryptedData.sublist(
      AppConstants.ivSizeBytes,
      encryptedData.length - AppConstants.authTagSizeBytes,
    );
    final macBytes = encryptedData.sublist(
      encryptedData.length - AppConstants.authTagSizeBytes,
    );

    final secretBox = SecretBox(
      ciphertext,
      nonce: nonce,
      mac: Mac(macBytes),
    );

    final clearText = await _aesGcm.decrypt(
      secretBox,
      secretKey: sessionKey,
    );

    return Uint8List.fromList(clearText);
  }

  /// 计算数据的 SHA-256 哈希
  Future<Uint8List> hashSha256(List<int> data) async {
    final hash = await _sha256.hash(data);
    return Uint8List.fromList(hash.bytes);
  }
}
