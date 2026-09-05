import 'package:fluent_ui/fluent_ui.dart';

/// 系统设置与安全保险箱页面
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  bool _autoAcceptKnownDevices = true;
  bool _minimizeToTray = true;
  final int _listenPort = 8899;

  @override
  Widget build(BuildContext context) {
    return ScaffoldPage.scrollable(
      header: const PageHeader(
        title: Text('安全保险箱与设置'),
      ),
      children: [
        Text('传输与安全设置', style: FluentTheme.of(context).typography.subtitle),
        const SizedBox(height: 12),
        Card(
          child: Column(
            children: [
              ToggleSwitch(
                checked: _autoAcceptKnownDevices,
                onChanged: (v) => setState(() => _autoAcceptKnownDevices = v),
                content: const Text('自动接收白名单受信任设备的传输请求（免每次手动确认）'),
              ),
              const SizedBox(height: 12),
              ToggleSwitch(
                checked: _minimizeToTray,
                onChanged: (v) => setState(() => _minimizeToTray = v),
                content: const Text('关闭主窗口时自动最小化至 Windows 系统托盘后台驻留'),
              ),
              const SizedBox(height: 12),
              ListTile(
                title: const Text('本地嵌入式服务端口'),
                subtitle: Text('HTTP 监听端口: $_listenPort (支持自动端口碰撞递增)'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        Text('关于 SafeDrop', style: FluentTheme.of(context).typography.subtitle),
        const SizedBox(height: 12),
        const Card(
          child: ListTile(
            title: Text('基于混合加密与零配置协议的跨平台安全快传系统 (PC 端)'),
            subtitle: Text('版本 1.0.1 • Clean Architecture • X25519 + AES-256-GCM + mDNS'),
          ),
        ),
      ],
    );
  }
}
