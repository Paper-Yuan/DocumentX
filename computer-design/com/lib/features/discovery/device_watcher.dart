import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../app/constants.dart';
import 'device_model.dart';

/// 设备列表全局状态 Provider
final deviceListProvider = StateNotifierProvider<DeviceWatcher, List<DeviceModel>>((ref) {
  return DeviceWatcher();
});

/// 设备自发现与存活监视器：维护在线拓扑并定时老化离线设备
class DeviceWatcher extends StateNotifier<List<DeviceModel>> {
  Timer? _decayTimer;

  DeviceWatcher() : super([]) {
    _startDecayTimer();
  }

  void _startDecayTimer() {
    _decayTimer = Timer.periodic(const Duration(seconds: 4), (_) {
      _evictTimedOutDevices();
    });
  }

  /// 收到设备心跳或广播包：如果之前连接过同一台设备，直接合并信息；不重复添加
  void upsertDevice(DeviceModel device) {
    final existingIndex = state.indexWhere((d) =>
      d.id == device.id ||
      d.ip == device.ip ||
      (d.fingerprint.isNotEmpty && device.fingerprint.isNotEmpty && d.fingerprint == device.fingerprint)
    );

    if (existingIndex >= 0) {
      final updated = List<DeviceModel>.from(state);
      final prev = updated[existingIndex];
      // 直接合并信息
      prev.name = device.name.isNotEmpty && !device.name.startsWith('Device (') ? device.name : prev.name;
      prev.ip = device.ip;
      prev.port = device.port;
      if (device.fingerprint.isNotEmpty) prev.fingerprint = device.fingerprint;
      prev.lastSeen = DateTime.now();
      state = updated;
    } else {
      state = [...state, device];
    }
  }

  /// 老化并移除超过 15 秒无响应的离线设备，不保留失效记录
  void _evictTimedOutDevices() {
    final now = DateTime.now();
    final activeDevices = state.where((d) {
      return now.difference(d.lastSeen) < AppConstants.deviceTimeout;
    }).toList();

    if (activeDevices.length != state.length) {
      state = activeDevices;
    }
  }

  @override
  void dispose() {
    _decayTimer?.cancel();
    super.dispose();
  }
}
