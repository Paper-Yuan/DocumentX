# SafeDrop 优化路线图 (Optimization Roadmap)

**版本**: v1.1 规划文档  
**日期**: 2026-09-14  
**当前状态**: v1.0.1 已发布（Tauri 桌面端 + Android 移动端）

---

## 📊 执行摘要

SafeDrop 已完成核心功能开发和 Tauri 架构迁移。本路线图基于当前技术栈和用户体验反馈，规划了 **短期优化（1-2 周）** 和 **中期增强（1-2 个月）** 的可行性方案。

**优化目标**：
- ✅ 提升用户体验和易用性
- ✅ 增强系统稳定性和性能
- ✅ 扩展跨平台能力
- ✅ 完善自动化和运维

---

## 🎯 短期优化（1-2 周）

### 优先级：P0（必须完成）

#### 1. Tauri 系统托盘完整实现 ⭐⭐⭐

**现状**: Tauri 配置已包含 `tray-icon` feature，但 Rust 代码中未实现

**目标**: 实现完整的系统托盘交互

**技术方案**:
```rust
// src-tauri/src/main.rs 增强
use tauri::{
    Manager, SystemTray, SystemTrayEvent, 
    SystemTrayMenu, SystemTrayMenuItem, CustomMenuItem
};

fn main() {
    // 系统托盘菜单
    let show = CustomMenuItem::new("show".to_string(), "显示窗口");
    let hide = CustomMenuItem::new("hide".to_string(), "隐藏窗口");
    let quit = CustomMenuItem::new("quit".to_string(), "退出 SafeDrop");
    
    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_item(hide)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);
    
    let tray = SystemTray::new().with_menu(tray_menu);
    
    tauri::Builder::default()
        .system_tray(tray)
        .on_system_tray_event(|app, event| {
            match event {
                SystemTrayEvent::LeftClick { .. } => {
                    let window = app.get_window("main").unwrap();
                    if window.is_visible().unwrap() {
                        window.hide().unwrap();
                    } else {
                        window.show().unwrap();
                        window.set_focus().unwrap();
                    }
                }
                SystemTrayEvent::MenuItemClick { id, .. } => {
                    match id.as_str() {
                        "show" => {
                            app.get_window("main").unwrap().show().unwrap();
                        }
                        "hide" => {
                            app.get_window("main").unwrap().hide().unwrap();
                        }
                        "quit" => {
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        })
        .setup(|_app| {
            start_node_backend();
            // ... 省略其他代码
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SafeDrop");
}
```

**预期效果**:
- 最小化到托盘而非任务栏
- 单击托盘图标显示/隐藏窗口
- 右键菜单提供快捷操作
- 退出前提示确认（防止误操作）

**工作量**: 2-3 小时  
**风险**: 低（Tauri 原生支持）

---

#### 2. 桌面端启动速度优化 ⭐⭐⭐

**现状**: Node.js 后端启动需要等待最多 5 秒

**问题分析**:
```rust
// 当前实现：轮询检测端口
for _ in 0..50 {
    if is_port_listening(8899) {
        break;
    }
    thread::sleep(Duration::from_millis(100));
}
```

**优化方案**:

**方案 A: 预启动策略**（推荐）
```rust
// 1. 并行启动窗口和后端
fn main() {
    // 立即启动后端（不阻塞）
    let backend_handle = start_node_backend_async();
    
    // 立即显示窗口（加载动画页面）
    tauri::Builder::default()
        .setup(|app| {
            // 显示加载界面
            show_loading_screen(app);
            
            // 后台等待后端就绪
            thread::spawn(move || {
                wait_for_backend_ready();
                // 就绪后自动刷新主页面
                app.get_window("main")
                    .unwrap()
                    .eval("location.reload()")
                    .unwrap();
            });
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running SafeDrop");
}
```

**方案 B: 健康检查端点**
```javascript
// desktop_hub/server.js 添加快速响应端点
app.get('/health', (req, res) => {
    res.json({ status: 'ready', port: 8899 });
});
```

```rust
// Rust 端改用 HTTP 健康检查（更可靠）
fn is_backend_ready() -> bool {
    reqwest::blocking::get("http://127.0.0.1:8899/health")
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
```

**预期效果**:
- 启动时间从 2-5 秒 → 0.5-1 秒
- 用户感知延迟降低 80%
- 启动体验更流畅

**工作量**: 4-6 小时  
**风险**: 低

---

#### 3. Android 后台传输稳定性增强 ⭐⭐

**现状**: 已有前台服务，但某些厂商仍可能杀后台

**问题**: OPPO/VIVO/小米等深度定制系统的激进省电策略

**优化方案**:

**方案 A: 电池优化白名单引导**
```kotlin
// MainActivity.kt 添加白名单引导
private fun requestBatteryOptimizationExemption() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            AlertDialog.Builder(this)
                .setTitle("允许后台运行")
                .setMessage("为确保大文件传输不被中断，建议允许 SafeDrop 在后台运行")
                .setPositiveButton("去设置") { _, _ ->
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    intent.data = Uri.parse("package:$packageName")
                    startActivity(intent)
                }
                .setNegativeButton("暂不设置", null)
                .show()
        }
    }
}
```

**方案 B: 保活心跳机制**
```kotlin
// TransferForegroundService.kt 增强
class TransferForegroundService : Service() {
    private val HEARTBEAT_INTERVAL = 30_000L // 30 秒心跳
    
    private fun startHeartbeat() {
        heartbeatJob = CoroutineScope(Dispatchers.IO).launch {
            while (isActive) {
                // 发送心跳到桌面端
                sendHeartbeatToDesktop()
                
                // 更新前台通知（防止被系统回收）
                updateNotification("传输服务运行中")
                
                delay(HEARTBEAT_INTERVAL)
            }
        }
    }
    
    private fun sendHeartbeatToDesktop() {
        // 向已连接的桌面端发送心跳包
        discoveredDevices.forEach { device ->
            try {
                val url = "http://${device.ip}:8899/api/v1/heartbeat"
                // 发送轻量级心跳请求
            } catch (e: Exception) {
                // 静默失败
            }
        }
    }
}
```

**方案 C: WakeLock 优化**
```kotlin
// 传输期间持有 CPU 唤醒锁
private lateinit var wakeLock: PowerManager.WakeLock

private fun acquireWakeLock() {
    val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = powerManager.newWakeLock(
        PowerManager.PARTIAL_WAKE_LOCK,
        "SafeDrop::TransferWakeLock"
    )
    wakeLock.acquire(10*60*1000L) // 最多 10 分钟
}
```

**预期效果**:
- 后台传输中断率降低 70%
- 大文件传输成功率提升至 95%+
- 用户满意度提升

**工作量**: 6-8 小时  
**风险**: 中（需要测试多种厂商机型）

---

#### 4. 桌面端快捷键支持 ⭐

**现状**: 无全局快捷键，操作依赖鼠标点击

**优化方案**:

```rust
// Cargo.toml 添加依赖
[dependencies]
tauri-plugin-global-shortcut = "2.0"
```

```rust
// src-tauri/src/main.rs
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::init())
        .setup(|app| {
            // Ctrl+Shift+S: 显示/隐藏主窗口
            let shortcut = Shortcut::new("Ctrl+Shift+S");
            app.global_shortcut()
                .register(shortcut.clone(), move || {
                    let window = app.get_window("main").unwrap();
                    if window.is_visible().unwrap() {
                        window.hide().unwrap();
                    } else {
                        window.show().unwrap();
                        window.set_focus().unwrap();
                    }
                })
                .unwrap();
            
            // Ctrl+Shift+Q: 快速发送文件
            let send_shortcut = Shortcut::new("Ctrl+Shift+Q");
            app.global_shortcut()
                .register(send_shortcut, || {
                    // 触发文件选择对话框
                })
                .unwrap();
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running SafeDrop");
}
```

**预期功能**:
- `Ctrl+Shift+S`: 快速唤起/隐藏窗口
- `Ctrl+Shift+Q`: 快速发送文件
- `Ctrl+Shift+R`: 刷新设备列表
- `Escape`: 关闭对话框

**工作量**: 3-4 小时  
**风险**: 低

---

### 优先级：P1（重要但非紧急）

#### 5. 断点续传完整实现 ⭐⭐

**现状**: 已有 1MB 分块传输，但传输中断后需要重新发送

**技术方案**:

**前端实现**:
```javascript
// desktop_hub/public/app.js
class ResumeableUploader {
    constructor(file, targetDevice) {
        this.file = file;
        this.target = targetDevice;
        this.chunkSize = 1024 * 1024; // 1MB
        this.uploadedChunks = new Set();
        this.transferId = this.generateTransferId();
    }
    
    generateTransferId() {
        return `${Date.now()}-${this.file.name}-${this.file.size}`;
    }
    
    async checkProgress() {
        // 向服务器查询已上传的分块
        const resp = await fetch(
            `http://${this.target.ip}:8899/api/v1/transfer/progress?id=${this.transferId}`
        );
        const data = await resp.json();
        this.uploadedChunks = new Set(data.uploadedChunks || []);
        return this.uploadedChunks.size;
    }
    
    async upload() {
        const totalChunks = Math.ceil(this.file.size / this.chunkSize);
        
        // 先检查已上传进度
        await this.checkProgress();
        
        for (let i = 0; i < totalChunks; i++) {
            // 跳过已上传的分块
            if (this.uploadedChunks.has(i)) {
                continue;
            }
            
            const start = i * this.chunkSize;
            const end = Math.min(start + this.chunkSize, this.file.size);
            const chunk = this.file.slice(start, end);
            
            const formData = new FormData();
            formData.append('file', chunk);
            formData.append('transferId', this.transferId);
            formData.append('chunkIndex', i);
            formData.append('totalChunks', totalChunks);
            formData.append('fileName', this.file.name);
            
            try {
                await fetch(`http://${this.target.ip}:8899/api/v1/upload/chunk`, {
                    method: 'POST',
                    body: formData
                });
                
                this.uploadedChunks.add(i);
                this.onProgress?.(i + 1, totalChunks);
            } catch (error) {
                // 失败时保存进度，等待重试
                this.saveProgressLocally();
                throw error;
            }
        }
        
        // 所有分块上传完成，通知服务器合并
        await this.finalizeUpload();
    }
    
    saveProgressLocally() {
        localStorage.setItem(`transfer_${this.transferId}`, JSON.stringify({
            uploadedChunks: Array.from(this.uploadedChunks),
            fileName: this.file.name,
            fileSize: this.file.size,
            timestamp: Date.now()
        }));
    }
    
    async finalizeUpload() {
        await fetch(`http://${this.target.ip}:8899/api/v1/upload/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transferId: this.transferId,
                fileName: this.file.name
            })
        });
    }
}
```

**后端实现**:
```javascript
// desktop_hub/server.js
const transferProgress = new Map(); // 存储传输进度

// 查询传输进度
app.get('/api/v1/transfer/progress', (req, res) => {
    const transferId = req.query.id;
    const progress = transferProgress.get(transferId) || { uploadedChunks: [] };
    res.json(progress);
});

// 接收分块
app.post('/api/v1/upload/chunk', upload.single('file'), (req, res) => {
    const { transferId, chunkIndex, totalChunks, fileName } = req.body;
    const chunkPath = path.join(TEMP_DIR, `${transferId}_${chunkIndex}`);
    
    // 保存分块
    fs.renameSync(req.file.path, chunkPath);
    
    // 更新进度
    if (!transferProgress.has(transferId)) {
        transferProgress.set(transferId, {
            uploadedChunks: [],
            fileName,
            totalChunks: parseInt(totalChunks)
        });
    }
    
    const progress = transferProgress.get(transferId);
    progress.uploadedChunks.push(parseInt(chunkIndex));
    
    res.json({ success: true, progress: progress.uploadedChunks.length });
});

// 合并分块
app.post('/api/v1/upload/finalize', async (req, res) => {
    const { transferId, fileName } = req.body;
    const progress = transferProgress.get(transferId);
    
    if (!progress) {
        return res.status(404).json({ error: 'Transfer not found' });
    }
    
    const finalPath = path.join(DOWNLOAD_DIR, fileName);
    const writeStream = fs.createWriteStream(finalPath);
    
    // 按顺序合并所有分块
    for (let i = 0; i < progress.totalChunks; i++) {
        const chunkPath = path.join(TEMP_DIR, `${transferId}_${i}`);
        const chunkData = fs.readFileSync(chunkPath);
        writeStream.write(chunkData);
        fs.unlinkSync(chunkPath); // 删除临时分块
    }
    
    writeStream.end();
    transferProgress.delete(transferId);
    
    res.json({ success: true, path: finalPath });
});
```

**预期效果**:
- 传输中断后可从断点继续
- 大文件传输成功率接近 100%
- 节省重传带宽和时间

**工作量**: 8-10 小时  
**风险**: 中（需要测试边界情况）

---

#### 6. Web 门户功能增强 ⭐

**现状**: Web 门户仅支持基本上传/下载

**优化方案**:

**方案 A: 拖拽上传**
```javascript
// portal.html 增强
const dropZone = document.getElementById('uploadArea');

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
        await uploadFile(file);
    }
});
```

**方案 B: 批量下载（ZIP 打包）**
```javascript
// desktop_hub/server.js
const archiver = require('archiver');

app.post('/api/v1/download/batch', (req, res) => {
    const { fileIds } = req.body;
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=SafeDrop-files.zip');
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    
    fileIds.forEach(id => {
        const filePath = getFilePathById(id);
        const fileName = path.basename(filePath);
        archive.file(filePath, { name: fileName });
    });
    
    archive.finalize();
});
```

**方案 C: 二维码分享链接**
```javascript
// 生成临时分享链接（24 小时有效）
app.get('/api/v1/share/create', (req, res) => {
    const { fileId } = req.query;
    const shareToken = crypto.randomBytes(16).toString('hex');
    const shareUrl = `http://${LOCAL_IP}:8899/share/${shareToken}`;
    
    shareLinks.set(shareToken, {
        fileId,
        expires: Date.now() + 24 * 60 * 60 * 1000
    });
    
    res.json({ shareUrl });
});

// 访问分享链接
app.get('/share/:token', (req, res) => {
    const share = shareLinks.get(req.params.token);
    
    if (!share || Date.now() > share.expires) {
        return res.status(404).send('分享链接已失效');
    }
    
    const filePath = getFilePathById(share.fileId);
    res.download(filePath);
});
```

**预期效果**:
- Web 门户体验接近原生 App
- 支持拖拽、批量操作
- 移动端浏览器更友好

**工作量**: 6-8 小时  
**风险**: 低

---

## 🚀 中期增强（1-2 个月）

### 阶段一：跨平台扩展（2-3 周）

#### 7. macOS 桌面端适配 ⭐⭐⭐

**现状**: Tauri 项目已支持 macOS 构建，但未测试

**技术方案**:

**步骤 1: macOS 构建环境准备**
```bash
# 在 macOS 上安装 Xcode Command Line Tools
xcode-select --install

# 安装 Rust 和 Tauri CLI
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli

# 构建 macOS 应用
cd computer-design/tauri-app
export PATH="$HOME/.cargo/bin:$PATH"
npx tauri build --target universal-apple-darwin
```

**步骤 2: macOS 特定适配**
```rust
// src-tauri/src/main.rs
#[cfg(target_os = "macos")]
fn setup_macos_specifics(app: &App) {
    use tauri::WindowBuilder;
    
    // macOS 窗口样式
    let window = app.get_window("main").unwrap();
    window.set_decorations(true).unwrap();
    
    // macOS 托盘图标（Template 模式）
    // 使用黑白图标自动适配 Light/Dark 模式
}

#[cfg(target_os = "macos")]
fn get_node_command() -> &'static str {
    "node" // macOS 通常通过 PATH 找到 node
}
```

**步骤 3: DMG 安装包**
```json
// tauri.conf.json 添加 DMG 配置
{
  "bundle": {
    "targets": ["dmg", "app"],
    "macOS": {
      "frameworks": [],
      "minimumSystemVersion": "10.15",
      "exceptionDomain": "localhost",
      "signingIdentity": null
    }
  }
}
```

**预期产物**:
- `SafeDrop_1.0.1_universal.dmg` (支持 Intel + Apple Silicon)
- `SafeDrop.app` 应用包

**工作量**: 12-16 小时  
**风险**: 中（需要 macOS 设备测试）

---

#### 8. Linux 桌面端适配 ⭐⭐

**技术方案**:

**步骤 1: Linux 依赖安装**
```bash
# Ubuntu/Debian
sudo apt install libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev

# Arch Linux
sudo pacman -S webkit2gtk base-devel curl wget file openssl appmenu-gtk-module gtk3 libappindicator-gtk3 librsvg
```

**步骤 2: Linux 构建**
```bash
cd computer-design/tauri-app
npx tauri build --target x86_64-unknown-linux-gnu
```

**步骤 3: 打包格式**
```json
// tauri.conf.json
{
  "bundle": {
    "targets": ["deb", "appimage"],
    "linux": {
      "deb": {
        "depends": ["libwebkit2gtk-4.1-0"]
      }
    }
  }
}
```

**预期产物**:
- `safedrop_1.0.1_amd64.deb` (Debian/Ubuntu)
- `SafeDrop_1.0.1_amd64.AppImage` (通用格式)

**工作量**: 10-12 小时  
**风险**: 中（Linux 发行版差异大）

---

### 阶段二：高级功能（3-4 周）

#### 9. 自动更新系统 ⭐⭐⭐

**现状**: 无自动更新，需要手动下载新版本

**技术方案**:

**步骤 1: 更新服务器搭建**
```javascript
// update-server/server.js (可部署在 Vercel/Netlify)
const express = require('express');
const app = express();

const LATEST_VERSION = {
    version: '1.0.2',
    notes: '修复若干 Bug，提升稳定性',
    pub_date: '2026-09-20T00:00:00Z',
    platforms: {
        'windows-x86_64': {
            url: 'https://releases.safedrop.com/SafeDrop_1.0.2_x64-setup.exe',
            signature: 'dW50cnVzdGVk...' // Tauri 签名
        },
        'darwin-universal': {
            url: 'https://releases.safedrop.com/SafeDrop_1.0.2_universal.dmg',
            signature: 'dW50cnVzdGVk...'
        },
        'linux-x86_64': {
            url: 'https://releases.safedrop.com/safedrop_1.0.2_amd64.deb',
            signature: 'dW50cnVzdGVk...'
        }
    }
};

app.get('/updates/:platform/:version', (req, res) => {
    const { platform, version } = req.params;
    
    if (version < LATEST_VERSION.version) {
        res.json(LATEST_VERSION);
    } else {
        res.status(204).send(); // 无更新
    }
});

app.listen(3000);
```

**步骤 2: Tauri 客户端集成**
```rust
// Cargo.toml
[dependencies]
tauri-plugin-updater = "2.0"
```

```rust
// src-tauri/src/main.rs
use tauri_plugin_updater::UpdaterExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::init())
        .setup(|app| {
            // 启动时检查更新
            let handle = app.handle();
            tauri::async_runtime::spawn(async move {
                match handle.updater().check().await {
                    Ok(Some(update)) => {
                        println!("发现新版本: {}", update.version);
                        
                        // 下载并安装更新
                        update.download_and_install().await.unwrap();
                        
                        // 提示用户重启
                        handle.notification()
                            .builder()
                            .title("SafeDrop 更新")
                            .body("新版本已下载，重启生效")
                            .show()
                            .unwrap();
                    }
                    Ok(None) => {
                        println!("已是最新版本");
                    }
                    Err(e) => {
                        eprintln!("检查更新失败: {}", e);
                    }
                }
            });
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running SafeDrop");
}
```

**步骤 3: 配置更新服务器**
```json
// tauri.conf.json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://releases.safedrop.com/updates/{{target}}/{{current_version}}"
      ],
      "dialog": true,
      "pubkey": "YOUR_PUBLIC_KEY_HERE"
    }
  }
}
```

**预期效果**:
- 启动时自动检查更新
- 后台静默下载
- 一键安装重启
- 用户无感知升级

**工作量**: 16-20 小时  
**风险**: 中（需要稳定的更新服务器）

---

#### 10. 传输历史与统计 ⭐⭐

**目标**: 记录传输历史，提供数据统计和可视化

**技术方案**:

**数据库设计** (SQLite)
```sql
-- desktop_hub/transfer_history.db
CREATE TABLE transfers (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    direction TEXT CHECK(direction IN ('upload', 'download')),
    peer_id TEXT NOT NULL,
    peer_name TEXT,
    status TEXT CHECK(status IN ('pending', 'transferring', 'completed', 'failed')),
    progress INTEGER DEFAULT 0,
    speed_mbps REAL,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,
    error_message TEXT
);

CREATE TABLE statistics (
    date TEXT PRIMARY KEY,
    total_files INTEGER DEFAULT 0,
    total_bytes INTEGER DEFAULT 0,
    upload_count INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    avg_speed_mbps REAL
);
```

**后端实现**
```javascript
// desktop_hub/server.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./transfer_history.db');

// 记录传输开始
app.post('/api/v1/transfer/start', (req, res) => {
    const { transferId, fileName, fileSize, direction, peerId } = req.body;
    
    db.run(`
        INSERT INTO transfers (id, file_name, file_size, direction, peer_id, status)
        VALUES (?, ?, ?, ?, ?, 'transferring')
    `, [transferId, fileName, fileSize, direction, peerId]);
    
    res.json({ success: true });
});

// 更新传输进度
app.post('/api/v1/transfer/progress', (req, res) => {
    const { transferId, progress, speedMbps } = req.body;
    
    db.run(`
        UPDATE transfers
        SET progress = ?, speed_mbps = ?
        WHERE id = ?
    `, [progress, speedMbps, transferId]);
    
    res.json({ success: true });
});

// 传输完成
app.post('/api/v1/transfer/complete', (req, res) => {
    const { transferId, status, errorMessage } = req.body;
    
    db.run(`
        UPDATE transfers
        SET status = ?, end_time = CURRENT_TIMESTAMP, error_message = ?
        WHERE id = ?
    `, [status, errorMessage, transferId]);
    
    // 更新统计
    updateDailyStatistics();
    
    res.json({ success: true });
});

// 获取传输历史
app.get('/api/v1/transfer/history', (req, res) => {
    const { limit = 50, offset = 0 } = req.query;
    
    db.all(`
        SELECT * FROM transfers
        ORDER BY start_time DESC
        LIMIT ? OFFSET ?
    `, [limit, offset], (err, rows) => {
        res.json({ transfers: rows });
    });
});

// 获取统计数据
app.get('/api/v1/statistics/daily', (req, res) => {
    db.all(`
        SELECT * FROM statistics
        ORDER BY date DESC
        LIMIT 30
    `, (err, rows) => {
        res.json({ statistics: rows });
    });
});
```

**前端可视化**
```javascript
// desktop_hub/public/app.js
async function renderStatistics() {
    const resp = await fetch('/api/v1/statistics/daily');
    const { statistics } = await resp.json();
    
    // 使用 Chart.js 绘制图表
    new Chart(document.getElementById('statsChart'), {
        type: 'line',
        data: {
            labels: statistics.map(s => s.date),
            datasets: [{
                label: '传输文件数',
                data: statistics.map(s => s.total_files),
                borderColor: '#2563eb'
            }, {
                label: '传输流量 (GB)',
                data: statistics.map(s => s.total_bytes / 1024 / 1024 / 1024),
                borderColor: '#10b981'
            }]
        }
    });
}
```

**预期效果**:
- 完整的传输历史记录
- 每日/每周/每月统计
- 可视化图表
- 导出功能

**工作量**: 12-16 小时  
**风险**: 低

---

#### 11. 多语言支持 (i18n) ⭐

**目标**: 支持中文、英文、日文等多语言

**技术方案**:

**桌面端**
```javascript
// desktop_hub/public/i18n.js
const translations = {
    'zh-CN': {
        'app.title': 'SafeDrop - 安全互传',
        'radar.title': '设备雷达',
        'transfer.title': '传输列表',
        'settings.title': '设置'
    },
    'en-US': {
        'app.title': 'SafeDrop - Secure Transfer',
        'radar.title': 'Device Radar',
        'transfer.title': 'Transfers',
        'settings.title': 'Settings'
    },
    'ja-JP': {
        'app.title': 'SafeDrop - 安全転送',
        'radar.title': 'デバイスレーダー',
        'transfer.title': '転送リスト',
        'settings.title': '設定'
    }
};

let currentLanguage = localStorage.getItem('language') || 'zh-CN';

function t(key) {
    return translations[currentLanguage][key] || key;
}

function setLanguage(lang) {
    currentLanguage = lang;
    localStorage.setItem('language', lang);
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        el.textContent = t(key);
    });
}
```

**Android 端**
```xml
<!-- res/values/strings.xml (中文) -->
<resources>
    <string name="app_name">SafeDrop</string>
    <string name="radar_title">设备雷达</string>
    <string name="transfer_title">传输列表</string>
</resources>

<!-- res/values-en/strings.xml (英文) -->
<resources>
    <string name="app_name">SafeDrop</string>
    <string name="radar_title">Device Radar</string>
    <string name="transfer_title">Transfers</string>
</resources>

<!-- res/values-ja/strings.xml (日文) -->
<resources>
    <string name="app_name">SafeDrop</string>
    <string name="radar_title">デバイスレーダー</string>
    <string name="radar_title">転送リスト</string>
</resources>
```

**预期效果**:
- 支持 3+ 种语言
- 自动检测系统语言
- 用户可手动切换
- 国际化友好

**工作量**: 8-12 小时  
**风险**: 低

---

### 阶段三：性能与体验优化（2-3 周）

#### 12. 传输速度优化 ⭐⭐⭐

**目标**: 提升传输速度 20-50%

**优化方案**:

**方案 A: 并发分块传输**
```javascript
// 当前：串行传输
for (let i = 0; i < totalChunks; i++) {
    await uploadChunk(i);
}

// 优化：并发传输（4 个并发）
const CONCURRENT_CHUNKS = 4;
const chunks = Array.from({ length: totalChunks }, (_, i) => i);

for (let i = 0; i < chunks.length; i += CONCURRENT_CHUNKS) {
    const batch = chunks.slice(i, i + CONCURRENT_CHUNKS);
    await Promise.all(batch.map(chunkIndex => uploadChunk(chunkIndex)));
}
```

**方案 B: 压缩传输**
```javascript
// desktop_hub/server.js
const zlib = require('zlib');

// 启用 gzip 压缩
app.use(compression({
    level: 6, // 平衡压缩率和速度
    threshold: 1024 // 大于 1KB 才压缩
}));
```

**方案 C: WebSocket 长连接**
```javascript
// 替代 HTTP 短连接，减少握手开销
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8900 });

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        // 接收文件分块
        handleChunk(data);
    });
});
```

**预期效果**:
- 千兆局域网下达到 100+ MB/s
- 百兆网络下达到 10+ MB/s
- 传输效率提升 30-50%

**工作量**: 16-20 小时  
**风险**: 中（需要大量测试）

---

#### 13. 移动端原生分享优化 ⭐⭐

**目标**: 从系统相册/文件管理器直接分享到 SafeDrop

**技术方案**:

```kotlin
// AndroidManifest.xml
<activity
    android:name=".ui.share.ShareReceiverActivity"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.SEND" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="*/*" />
    </intent-filter>
    <intent-filter>
        <action android:name="android.intent.action.SEND_MULTIPLE" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="*/*" />
    </intent-filter>
</activity>

// ShareReceiverActivity.kt 增强
class ShareReceiverActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        when (intent.action) {
            Intent.ACTION_SEND -> {
                handleSingleFile(intent)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                handleMultipleFiles(intent)
            }
        }
        
        // 显示设备选择对话框
        showDevicePickerDialog()
    }
    
    private fun showDevicePickerDialog() {
        val devices = discoveredDevices.value ?: emptyList()
        
        MaterialAlertDialogBuilder(this)
            .setTitle("选择接收设备")
            .setItems(devices.map { it.name }.toTypedArray()) { _, which ->
                val selectedDevice = devices[which]
                sendFilesToDevice(selectedDevice)
            }
            .setNegativeButton("取消") { _, _ ->
                finish()
            }
            .show()
    }
    
    private fun sendFilesToDevice(device: Device) {
        // 直接调用传输服务
        val intent = Intent(this, TransferForegroundService::class.java)
        intent.putExtra("device", device)
        intent.putExtra("files", selectedFiles)
        startService(intent)
        
        Toast.makeText(this, "正在发送到 ${device.name}", Toast.LENGTH_SHORT).show()
        finish()
    }
}
```

**预期效果**:
- 系统分享菜单中显示 "SafeDrop"
- 一键发送照片、文件到电脑
- 支持批量分享
- 无需打开 App 主界面

**工作量**: 4-6 小时  
**风险**: 低

---

## 📊 优化优先级矩阵

| 优化项 | 优先级 | 工作量 | 用户价值 | 技术风险 | 建议时间 |
|:---|:---:|:---:|:---:|:---:|:---:|
| **系统托盘** | P0 | 2-3h | ⭐⭐⭐ | 低 | 第 1 周 |
| **启动速度优化** | P0 | 4-6h | ⭐⭐⭐ | 低 | 第 1 周 |
| **后台稳定性** | P0 | 6-8h | ⭐⭐⭐ | 中 | 第 1-2 周 |
| **快捷键支持** | P0 | 3-4h | ⭐⭐ | 低 | 第 1 周 |
| **断点续传** | P1 | 8-10h | ⭐⭐⭐ | 中 | 第 2 周 |
| **Web 门户增强** | P1 | 6-8h | ⭐⭐ | 低 | 第 2 周 |
| **macOS 适配** | P1 | 12-16h | ⭐⭐⭐ | 中 | 第 3-4 周 |
| **Linux 适配** | P1 | 10-12h | ⭐⭐ | 中 | 第 4-5 周 |
| **自动更新** | P1 | 16-20h | ⭐⭐⭐ | 中 | 第 5-6 周 |
| **传输历史统计** | P2 | 12-16h | ⭐⭐ | 低 | 第 6-7 周 |
| **多语言支持** | P2 | 8-12h | ⭐⭐ | 低 | 第 7 周 |
| **传输速度优化** | P2 | 16-20h | ⭐⭐⭐ | 中 | 第 8-9 周 |
| **原生分享优化** | P2 | 4-6h | ⭐⭐ | 低 | 第 9 周 |

---

## 🎯 推荐实施路径

### 短期冲刺（2 周）

**第 1 周: 核心体验优化**
- Day 1-2: 系统托盘实现
- Day 3-4: 启动速度优化
- Day 5-7: Android 后台稳定性增强 + 快捷键支持

**第 2 周: 功能完善**
- Day 8-10: 断点续传实现
- Day 11-12: Web 门户功能增强
- Day 13-14: 测试与 Bug 修复

**产出**:
- SafeDrop v1.1.0 发布
- 核心体验显著提升
- 用户反馈收集

---

### 中期规划（2 个月）

**第 3-4 周: macOS 平台**
- macOS 应用构建和测试
- DMG 安装包制作
- macOS 特有功能适配

**第 5-6 周: Linux 平台 + 自动更新**
- Linux 应用构建和测试
- 多发行版支持
- 自动更新系统上线

**第 7-8 周: 高级功能**
- 传输历史与统计
- 多语言支持
- 传输速度优化

**第 9 周: 移动端优化**
- 原生分享增强
- 性能调优
- 用户体验打磨

**产出**:
- SafeDrop v1.2.0 发布
- 三大平台全覆盖（Win/Mac/Linux）
- 自动更新体系完善
- 用户留存率提升

---

## 📝 技术债务清单

在实施优化的同时，需要关注以下技术债务：

1. **测试覆盖率不足** - 当前仅有集成测试，缺少单元测试
2. **错误处理不完善** - 部分异常场景未处理
3. **日志系统缺失** - 调试和排查问题困难
4. **文档需要更新** - 随着功能增加，文档需要同步
5. **代码重复** - 部分逻辑在多处重复，需要重构

**建议**: 在每个迭代中分配 20% 时间处理技术债务

---

## 🔍 风险评估

| 风险项 | 影响 | 概率 | 缓解措施 |
|:---|:---:|:---:|:---|
| **跨平台兼容性问题** | 高 | 中 | 提前在多平台测试，使用虚拟机 |
| **后台进程被杀** | 高 | 中 | 多重保活策略，用户教育 |
| **传输性能瓶颈** | 中 | 中 | 性能基准测试，逐步优化 |
| **自动更新失败** | 中 | 低 | 回滚机制，手动更新备用 |
| **资源消耗过高** | 中 | 低 | 性能监控，内存泄漏检测 |

---

## 📈 成功指标 (KPI)

**短期目标（2 周后）**:
- 启动速度 < 1 秒
- 后台传输成功率 > 95%
- 用户活跃度提升 20%

**中期目标（2 个月后）**:
- 三大平台（Win/Mac/Linux）全覆盖
- 传输速度提升 30%+
- 用户留存率 > 80%
- GitHub Star 数量增长 50%

---

## 🚀 后续展望

**长期愿景（6-12 个月）**:
1. iOS 客户端开发
2. 企业版功能（审计日志、权限管理）
3. 云同步集成（可选）
4. WebRTC 点对点传输（突破 NAT）
5. 插件系统（社区扩展）

---

## 📞 反馈与迭代

欢迎通过以下方式提供反馈：
- GitHub Issues: [提交 Bug 或建议](https://github.com/safedrop/safedrop/issues)
- 讨论区: [功能讨论](https://github.com/safedrop/safedrop/discussions)
- Email: feedback@safedrop.com

---

**文档维护者**: SafeDrop Team  
**最后更新**: 2026-09-14  
**版本**: v1.0
