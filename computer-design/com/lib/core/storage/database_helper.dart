import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqlite3/sqlite3.dart';

/// 本地轻量化 SQLite 存储：白名单设备表与传输历史表
class DatabaseHelper {
  static final DatabaseHelper instance = DatabaseHelper._init();
  static Database? _database;

  DatabaseHelper._init();

  Future<Database> get database async {
    if (_database != null) return _database!;
    _database = await _initDB('safedrop.db');
    return _database!;
  }

  Future<Database> _initDB(String filePath) async {
    final docsDir = await getApplicationDocumentsDirectory();
    final dbDir = Directory(p.join(docsDir.path, 'SafeDrop'));
    if (!await dbDir.exists()) {
      await dbDir.create(recursive: true);
    }
    final path = p.join(dbDir.path, filePath);
    final db = sqlite3.open(path);

    _createTables(db);
    return db;
  }

  void _createTables(Database db) {
    db.execute('''
      CREATE TABLE IF NOT EXISTS tb_devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key_fingerprint TEXT NOT NULL,
        is_auto_accept INTEGER DEFAULT 0,
        last_seen INTEGER NOT NULL
      );
    ''');

    db.execute('''
      CREATE TABLE IF NOT EXISTS tb_history (
        task_id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sender TEXT NOT NULL,
        duration INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    ''');
  }

  /// 插入或更新信任设备
  Future<void> upsertDevice({
    required String deviceId,
    required String name,
    required String fingerprint,
    bool isAutoAccept = false,
  }) async {
    final db = await database;
    final now = DateTime.now().millisecondsSinceEpoch;
    final stmt = db.prepare('''
      INSERT INTO tb_devices (device_id, name, public_key_fingerprint, is_auto_accept, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        name=excluded.name,
        public_key_fingerprint=excluded.public_key_fingerprint,
        last_seen=excluded.last_seen;
    ''');
    stmt.execute([deviceId, name, fingerprint, isAutoAccept ? 1 : 0, now]);
    stmt.dispose();
  }

  /// 添加传输记录
  Future<void> addHistoryRecord({
    required String taskId,
    required String fileName,
    required int fileSize,
    required String sender,
    required int durationMs,
    required String status,
  }) async {
    final db = await database;
    final now = DateTime.now().millisecondsSinceEpoch;
    final stmt = db.prepare('''
      INSERT INTO tb_history (task_id, file_name, file_size, sender, duration, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    ''');
    stmt.execute([taskId, fileName, fileSize, sender, durationMs, status, now]);
    stmt.dispose();
  }

  /// 获取历史记录列表
  Future<List<Map<String, dynamic>>> getHistoryRecords({int limit = 50}) async {
    final db = await database;
    final ResultSet results = db.select(
      'SELECT * FROM tb_history ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
    return results.map((row) => Map<String, dynamic>.from(row)).toList();
  }
}
