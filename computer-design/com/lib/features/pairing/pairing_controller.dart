import 'dart:math';
import 'package:uuid/uuid.dart';

class PairingController {
  static final PairingController instance = PairingController._();
  PairingController._();

  String? _currentOneTimeToken;
  String? _currentPin;

  String get currentPin => _currentPin ?? _generateNewPin();

  String _generateNewPin() {
    final pin = (Random().nextInt(900000) + 100000).toString();
    _currentPin = pin;
    return pin;
  }

  /// 构建用于穿透 AP 隔离的离线动态配对二维码 URL
  String buildPairingQrUri({
    required String localIp,
    required int port,
    required String fingerprint,
  }) {
    _currentOneTimeToken = const Uuid().v4().replaceAll('-', '').substring(0, 12);
    _generateNewPin();

    final uri = Uri(
      scheme: 'safedrop',
      host: 'pair',
      queryParameters: {
        'ip': localIp,
        'port': port.toString(),
        'fp': fingerprint,
        'token': _currentOneTimeToken,
        'pin': _currentPin,
      },
    );

    return uri.toString();
  }

  /// 校验移动端提交的凭证
  bool verifyCredentials({String? pin, String? token}) {
    if (token != null && token == _currentOneTimeToken) {
      return true;
    }
    if (pin != null && pin == _currentPin) {
      return true;
    }
    return false;
  }
}
