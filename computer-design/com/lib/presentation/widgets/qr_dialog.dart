import 'package:fluent_ui/fluent_ui.dart';
import 'package:qr_flutter/qr_flutter.dart';

/// 动态离线配对二维码与 PIN 码弹窗（用于穿透 AP 隔离）
class QrDialog extends StatelessWidget {
  final String qrData;
  final String pin;
  final String ip;
  final int port;

  const QrDialog({
    super.key,
    required this.qrData,
    required this.pin,
    required this.ip,
    required this.port,
  });

  @override
  Widget build(BuildContext context) {
    final theme = FluentTheme.of(context);

    return ContentDialog(
      title: const Text('设备离线信任配对 (AP 隔离穿透)'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            '若局域网路由器开启了 AP 隔离导致无法自动搜到电脑，请使用手机 SafeDrop 扫码直接单播配对：',
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(8),
            ),
            child: QrImageView(
              data: qrData,
              version: QrVersions.auto,
              size: 200.0,
            ),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text('动态安全 PIN 码：'),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: theme.accentColor.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  pin,
                  style: theme.typography.subtitle?.copyWith(
                    fontWeight: FontWeight.bold,
                    letterSpacing: 3,
                    color: theme.accentColor,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '监听地址: http://$ip:$port',
            style: theme.typography.caption?.copyWith(
              color: theme.resources.textFillColorSecondary,
            ),
          ),
        ],
      ),
      actions: [
        FilledButton(
          child: const Text('完成'),
          onPressed: () => Navigator.pop(context),
        ),
      ],
    );
  }
}
