import 'dart:math';
import 'package:fluent_ui/fluent_ui.dart';
import '../../features/discovery/device_model.dart';

/// 动态拓扑雷达与水波纹渲染组件
class RadarView extends StatefulWidget {
  final List<DeviceModel> devices;
  final Function(DeviceModel device)? onDeviceSelected;

  const RadarView({
    super.key,
    required this.devices,
    this.onDeviceSelected,
  });

  @override
  State<RadarView> createState() => _RadarViewState();
}

class _RadarViewState extends State<RadarView> with SingleTickerProviderStateMixin {
  late AnimationController _animController;

  @override
  void initState() {
    super.initState();
    _animController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 3),
    )..repeat();
  }

  @override
  void dispose() {
    _animController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = FluentTheme.of(context);

    return AnimatedBuilder(
      animation: _animController,
      builder: (context, child) {
        return Container(
          width: double.infinity,
          height: 220,
          alignment: Alignment.center,
          child: Stack(
            alignment: Alignment.center,
            children: [
              // 1. 动态双环脉冲
              for (int i = 0; i < 2; i++) ...[
                Transform.scale(
                  scale: 0.7 + ((_animController.value + i * 0.5) % 1.0) * 0.9,
                  child: Container(
                    width: 140,
                    height: 140,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: theme.accentColor.withValues(
                          alpha: (1.0 - ((_animController.value + i * 0.5) % 1.0)) * 0.4,
                        ),
                        width: 1.5,
                      ),
                    ),
                  ),
                ),
              ],
              // 2. 本机中枢徽章
              Container(
                width: 68,
                height: 68,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: theme.accentColor,
                  boxShadow: [
                    BoxShadow(
                      color: theme.accentColor.withValues(alpha: 0.35),
                      blurRadius: 16,
                      spreadRadius: 2,
                    ),
                  ],
                  border: Border.all(color: const Color(0xFFFFFFFF), width: 2.5),
                ),
                child: const Icon(
                  FluentIcons.devices_3,
                  size: 30,
                  color: Color(0xFFFFFFFF),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

