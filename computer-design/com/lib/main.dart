import 'dart:io';
import 'package:fluent_ui/fluent_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:window_manager/window_manager.dart';
import 'app/constants.dart';
import 'app/theme.dart';
import 'presentation/pages/home_page.dart';
import 'features/tray/tray_service.dart';
import 'core/storage/database_helper.dart';
import 'core/network/embedded_server.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 初始化 Windows 原生窗口管理器
  if (Platform.isWindows) {
    await windowManager.ensureInitialized();

    const windowOptions = WindowOptions(
      size: Size(960, 680),
      minimumSize: Size(800, 560),
      center: true,
      backgroundColor: Colors.transparent,
      skipTaskbar: false,
      title: AppConstants.appName,
      titleBarStyle: TitleBarStyle.normal,
    );

    windowManager.waitUntilReadyToShow(windowOptions, () async {
      await windowManager.show();
      await windowManager.focus();
    });

    // 初始化系统托盘与原生通知
    await TrayService.instance.init();
  }

  // 初始化本地 SQLite 数据库
  await DatabaseHelper.instance.database;

  // 启动内置轻量 HTTP 监听服务
  final server = EmbeddedServer();
  await server.start();

  runApp(
    const ProviderScope(
      child: SafeDropDesktopApp(),
    ),
  );
}

class SafeDropDesktopApp extends StatelessWidget {
  const SafeDropDesktopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return FluentApp(
      title: AppConstants.appName,
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.system,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      home: const HomePage(),
    );
  }
}
