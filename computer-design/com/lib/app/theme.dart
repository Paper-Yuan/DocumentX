import 'package:fluent_ui/fluent_ui.dart';

class AppTheme {
  static FluentThemeData lightTheme = FluentThemeData(
    brightness: Brightness.light,
    accentColor: Colors.blue,
    scaffoldBackgroundColor: const Color(0xFFF9F9FB),
    cardColor: const Color(0xFFFFFFFF),
    micaBackgroundColor: const Color(0xFFF3F3F3),
    visualDensity: VisualDensity.adaptivePlatformDensity,
  );

  static FluentThemeData darkTheme = FluentThemeData(
    brightness: Brightness.dark,
    accentColor: Colors.blue,
    scaffoldBackgroundColor: const Color(0xFF1E1E1E),
    cardColor: const Color(0xFF2B2B2B),
    micaBackgroundColor: const Color(0xFF202020),
    visualDensity: VisualDensity.adaptivePlatformDensity,
  );

  static FluentThemeData eyecareTheme = FluentThemeData(
    brightness: Brightness.light,
    accentColor: Colors.black,
    scaffoldBackgroundColor: const Color(0xFFEDE4D0),
    cardColor: const Color(0xFFF5EDDC),
    micaBackgroundColor: const Color(0xFFDFD5BE),
    visualDensity: VisualDensity.adaptivePlatformDensity,
  );
}
