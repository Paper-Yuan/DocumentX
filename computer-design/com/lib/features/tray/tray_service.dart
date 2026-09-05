import 'dart:io';
import 'package:system_tray/system_tray.dart';
import 'package:local_notifier/local_notifier.dart';
import 'package:window_manager/window_manager.dart';
import '../../app/constants.dart';

/// Windows 系统托盘驻留与 Action Center 原生通知服务
class TrayService {
  static final TrayService instance = TrayService._();
  TrayService._();

  final SystemTray _systemTray = SystemTray();
  final Menu _menu = Menu();

  Future<void> init() async {
    if (!Platform.isWindows) return;

    // 初始化本地通知
    await localNotifier.setup(
      appName: AppConstants.appName,
      shortcutPolicy: ShortcutPolicy.requireCreate,
    );

    // 初始化系统托盘
    await _systemTray.initSystemTray(
      title: AppConstants.appName,
      iconPath: 'assets/icons/tray.ico',
    );

    await _menu.buildFrom([
      MenuItemLabel(
        label: '显示主视窗',
        onClicked: (menuItem) async {
          await windowManager.show();
          await windowManager.focus();
        },
      ),
      MenuItemLabel(
        label: '退出 SafeDrop',
        onClicked: (menuItem) async {
          await _systemTray.destroy();
          exit(0);
        },
      ),
    ]);

    await _systemTray.setContextMenu(_menu);

    _systemTray.registerSystemTrayEventHandler((eventName) {
      if (eventName == kSystemTrayEventClick) {
        windowManager.show();
      } else if (eventName == kSystemTrayEventRightClick) {
        _systemTray.popUpContextMenu();
      }
    });
  }

  /// 发送 Windows Action Center 原生气泡通知
  Future<void> showNotification({
    required String title,
    required String body,
  }) async {
    final notification = LocalNotification(
      title: title,
      body: body,
    );
    await notification.show();
  }
}
