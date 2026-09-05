class DeviceModel {
  final String id;
  final String name;
  final String ip;
  final int port;
  final String fingerprint;
  final String os; // 'android', 'windows', 'macos', 'ios', 'linux'
  DateTime lastSeen;

  DeviceModel({
    required this.id,
    required this.name,
    required this.ip,
    required this.port,
    required this.fingerprint,
    required this.os,
    DateTime? lastSeen,
  }) : lastSeen = lastSeen ?? DateTime.now();

  bool get isOnline {
    return DateTime.now().difference(lastSeen).inSeconds < 75;
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'ip': ip,
    'port': port,
    'fingerprint': fingerprint,
    'os': os,
    'lastSeen': lastSeen.toIso8601String(),
  };

  factory DeviceModel.fromJson(Map<String, dynamic> json) => DeviceModel(
    id: json['id'] as String,
    name: json['name'] as String,
    ip: json['ip'] as String,
    port: json['port'] as int,
    fingerprint: json['fingerprint'] as String,
    os: json['os'] as String? ?? 'unknown',
    lastSeen: json['lastSeen'] != null ? DateTime.parse(json['lastSeen'] as String) : null,
  );
}
