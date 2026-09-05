import 'dart:async';
import 'package:multicast_dns/multicast_dns.dart';
import '../../app/constants.dart';
import '../../features/discovery/device_model.dart';

/// mDNS 局域网组播自发现服务 (UDP 5353)
class MdnsService {
  MDnsClient? _client;
  Timer? _broadcastTimer;
  final Function(DeviceModel device)? onDeviceDiscovered;

  MdnsService({this.onDeviceDiscovered});

  /// 启动监听局域网中的 SafeDrop 服务
  Future<void> startDiscovery() async {
    _client = MDnsClient();
    await _client!.start();

    // 周期性查询局域网设备
    _broadcastTimer = Timer.periodic(AppConstants.heartbeatInterval, (_) async {
      await _queryServices();
    });

    await _queryServices();
  }

  Future<void> _queryServices() async {
    if (_client == null) return;
    try {
      await for (final PtrResourceRecord ptr in _client!.lookup<PtrResourceRecord>(
        ResourceRecordQuery.serverPointer(
          '${AppConstants.mdnsServiceType}.${AppConstants.mdnsDomain}',
        ),
      )) {
        await for (final SrvResourceRecord srv in _client!.lookup<SrvResourceRecord>(
          ResourceRecordQuery.service(ptr.domainName),
        )) {
          await for (final IPAddressResourceRecord ip in _client!.lookup<IPAddressResourceRecord>(
            ResourceRecordQuery.addressIPv4(srv.target),
          )) {
            final device = DeviceModel(
              id: srv.target.replaceAll('.${AppConstants.mdnsDomain}', ''),
              name: srv.target,
              ip: ip.address.address,
              port: srv.port,
              fingerprint: 'UNKNOWN',
              os: 'android',
            );
            onDeviceDiscovered?.call(device);
          }
        }
      }
    } catch (e) {
      print('[MdnsService] Discovery query error: $e');
    }
  }

  /// 停止 mDNS 服务
  void stop() {
    _broadcastTimer?.cancel();
    _client?.stop();
    _client = null;
  }
}
