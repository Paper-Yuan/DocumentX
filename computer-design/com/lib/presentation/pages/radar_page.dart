import 'package:fluent_ui/fluent_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../features/discovery/device_watcher.dart';
import '../../features/discovery/device_model.dart';
import '../widgets/radar_view.dart';
import '../widgets/drop_target_card.dart';

/// 设备动态拓扑雷达与拖拽发现主页
class RadarPage extends ConsumerWidget {
  final Function(DeviceModel device)? onDeviceSelected;

  const RadarPage({super.key, this.onDeviceSelected});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(deviceListProvider);
    final theme = FluentTheme.of(context);

    return ScaffoldPage.scrollable(
      header: PageHeader(
        title: const Text('设备发现中心'),
        commandBar: CommandBar(
          mainAxisAlignment: MainAxisAlignment.end,
          primaryItems: [
            CommandBarButton(
              icon: const Icon(FluentIcons.refresh),
              label: const Text('刷新网络'),
              onPressed: () {},
            ),
          ],
        ),
      ),
      children: [
        // 1. 动态脉冲拓扑罗盘
        Card(
          child: Column(
            children: [
              RadarView(
                devices: devices,
                onDeviceSelected: onDeviceSelected,
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 8.0),
                child: Text(
                  devices.isEmpty
                    ? '正在监听局域网 SafeDrop 节点 (UDP 8890 探针通道)...'
                    : '已发现 ${devices.length} 台在线设备',
                  style: theme.typography.caption?.copyWith(
                    color: theme.resources.textFillColorSecondary,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        // 2. 全局拖拽即发投放区
        DropTargetCard(
          onFilesDropped: (files) {
            displayInfoBar(
              context,
              builder: (context, close) {
                return InfoBar(
                  title: Text('已捕获 ${files.length} 个文件'),
                  content: const Text('请在下方选择目标设备以立即发起加密推流'),
                  severity: InfoBarSeverity.info,
                  onClose: close,
                );
              },
            );
          },
        ),
        const SizedBox(height: 16),

        // 3. 在线设备列表卡片
        Text('局域网在线设备列表', style: theme.typography.subtitle),
        const SizedBox(height: 8),

        if (devices.isEmpty)
          Container(
            padding: const EdgeInsets.all(32),
            alignment: Alignment.center,
            child: Text(
              '当前未发现其他设备，请确保手机与电脑连接至同一 Wi-Fi，或点击右上角二维码进行离线扫码配对。',
              style: theme.typography.body?.copyWith(
                color: theme.resources.textFillColorSecondary,
              ),
              textAlign: TextAlign.center,
            ),
          )
        else
          ...devices.map((d) {
            return Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                leading: Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: const Color(0xFF107C41).withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(FluentIcons.cell_phone, color: Color(0xFF107C41)),
                ),
                title: Text(d.name, style: const TextStyle(fontWeight: FontWeight.bold)),
                subtitle: Text('${d.ip}:${d.port} • 指纹: ${d.fingerprint}'),
                trailing: FilledButton(
                  child: const Text('投送文件'),
                  onPressed: () => onDeviceSelected?.call(d),
                ),
              ),
            );
          }),
      ],
    );
  }
}
