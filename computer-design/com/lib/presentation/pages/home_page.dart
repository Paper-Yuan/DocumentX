import 'package:fluent_ui/fluent_ui.dart';
import '../../features/pairing/pairing_controller.dart';
import '../widgets/qr_dialog.dart';
import 'radar_page.dart';
import 'transfers_page.dart';
import 'settings_page.dart';

/// Fluent UI 主框架窗口，集成极简侧边导航栏与离线配对弹窗
class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _currentIndex = 0;

  void _showPairingQrDialog() {
    final qrUri = PairingController.instance.buildPairingQrUri(
      localIp: '192.168.1.100', // 实际运行时从网卡枚举
      port: 8899,
      fingerprint: 'A3F8B9C1',
    );

    showDialog(
      context: context,
      builder: (context) => QrDialog(
        qrData: qrUri,
        pin: PairingController.instance.currentPin,
        ip: '192.168.1.100',
        port: 8899,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return NavigationView(
      titleBar: TitleBar(
        title: const Text('SafeDrop - Windows 桌面中枢端'),
        endHeader: Padding(
          padding: const EdgeInsets.only(right: 12.0),
          child: Tooltip(
            message: 'AP 隔离穿透配对码',
            child: IconButton(
              icon: const Icon(FluentIcons.q_r_code, size: 20),
              onPressed: _showPairingQrDialog,
            ),
          ),
        ),
      ),
      pane: NavigationPane(
        selected: _currentIndex,
        onChanged: (i) => setState(() => _currentIndex = i),
        displayMode: PaneDisplayMode.compact,
        items: [
          PaneItem(
            icon: const Icon(FluentIcons.network_tower),
            title: const Text('设备发现'),
            body: RadarPage(
              onDeviceSelected: (device) {
                // 切换到传输页面
                setState(() => _currentIndex = 1);
              },
            ),
          ),
          PaneItem(
            icon: const Icon(FluentIcons.sync_folder),
            title: const Text('传输任务'),
            body: const TransfersPage(),
          ),
          PaneItem(
            icon: const Icon(FluentIcons.shield),
            title: const Text('安全设置'),
            body: const SettingsPage(),
          ),
        ],
      ),
    );
  }
}
