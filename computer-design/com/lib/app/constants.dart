/// SafeDrop System Constants & Protocol Definitions
class AppConstants {
  static const String appName = 'SafeDrop Hub';
  static const String appVersion = '1.0.1';

  // Network Protocol
  static const int defaultHttpPort = 8899;
  static const int mdnsPort = 5353;
  static const String mdnsServiceType = '_safedrop._tcp';
  static const String mdnsDomain = 'local';

  // Chunk & Crypto Protocol
  static const int chunkSizeBytes = 1024 * 1024; // 1MB Chunk
  static const int ivSizeBytes = 12;             // 96-bit AES-GCM IV
  static const int authTagSizeBytes = 16;        // 128-bit GCM Tag
  static const int sha256SizeBytes = 32;         // 256-bit SHA256 Hash
  static const int chunkIndexSizeBytes = 4;      // 32-bit uint Big-Endian

  // Timing & KeepAlive
  static const Duration heartbeatInterval = Duration(seconds: 5);
  static const Duration deviceTimeout = Duration(seconds: 15);

  // Scheme
  static const String qrSchemePrefix = 'safedrop://pair';
}
