# SafeDrop

<p align="center">
  <img src="./app.ico" alt="SafeDrop Logo" width="120" height="120" />
</p>

<p align="center">
  <strong>局域网文件互传 · 以桌面端为中心的 hub 模式</strong><br/>
  <sub>A LAN file transfer tool built around a desktop hub</sub>
</p>

<p align="center">
  <a href="https://github.com/Paper-Yuan/DocumentX/releases/latest">
    <img src="https://img.shields.io/github/v/release/Paper-Yuan/DocumentX?label=version" alt="Version">
  </a>
  <a href="https://github.com/Paper-Yuan/DocumentX/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/Paper-Yuan/DocumentX" alt="License">
  </a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Android%20%7C%20Web-blue" alt="Platform">
</p>

<p align="center">
  <a href="#-使用逻辑">使用逻辑</a> •
  <a href="#-design-highlights">设计特点</a> •
  <a href="#-quick-start">快速开始</a> •
  <a href="#-what-it-does-and-does-not-protect">安全边界</a> •
  <a href="#-architecture">架构</a> •
  <a href="#-roadmap">路线图</a>
</p>

---

## 🧭 使用逻辑

SafeDrop 不依赖账号、云端或中转服务器。它的运行模型只有一条主线：

**桌面端是 hub，其它设备是接入方。**

1. **启动桌面端** — 本机同时起一个 HTTP 服务（默认 `8899`）和一个 UDP 发现服务（`8890`）。桌面 UI 与 Web 门户由这个服务直接提供。
2. **手机 / 浏览器接入** — 桌面端显示二维码与 6 位配对码。手机扫码（或浏览器打开 `http://<局域网IP>:8899/portal`）后，用配对码完成一次握手。
3. **之后就是直连** — 文件在设备之间通过局域网直接传输，桌面端负责落盘（可自定义保存目录）、展示进度，并在需要时把流量转发给同一网络内的其它设备。

这个模型带来的直接结果是：**没有月费、没有流量上限、断网也照常工作**，代价是它只能在同一个可互通的局域网里使用。

> English: The desktop app is the hub. It serves the UI, the web portal, and the discovery service. A phone or browser joins by scanning a QR code and entering a rotating pairing code; after that, file transfers run over the local network, with the hub handling storage and display.

---

## 🎨 Design Highlights

这些是当前代码里真实存在、且经过验证的设计点：

- **零配置发现** — 桌面端每 3 秒向本网段定向广播地址发送 UDP beacon，手机端通过 `MulticastLock` 接收；同时过滤 Clash / TAP / TUN / vEthernet 等虚拟网卡，避免多网卡环境下出现幻影设备。
- **无需安装的接入端** — Web 门户是服务端直出的一个页面，手机、平板、Mac、Linux、智能电视只要能开浏览器就能收发文件，不需要装任何东西。
- **后端零依赖** — `server.js` 约 1140 行，只用 Node.js 标准库（`http`/`dgram`/`crypto`/`zlib`），没有 `node_modules`，启动快、体积小、审计面窄。
- **分块流式传输** — 上传按分块 + `.part` 临时文件拼接后原子改名，大文件不会整包读进内存；桌面端分块 4 MB，Android 端 1 MB。
- **传输队列与并发** — 最多 3 个文件并发传输，其余进入队列，UI 上显示队列位置，单个任务失败不影响其它任务。
- **可选的 gzip 压缩** — 对文本类、体积 ≥ 1 MB 的常见可压缩格式自动启用（客户端 `CompressionStream`，服务端 `zlib` 解压），可在设置里关闭。
- **桌面端原生化** — 外壳用 Tauri 2.0（Rust + WebView2），带系统托盘（显示 / 隐藏 / 退出带确认）和 3 个全局快捷键，窗口关闭后仍可在后台响应。
- **Android 后台传输** — 前台服务（`foregroundServiceType="dataSync"`）+ WakeLock + 心跳，抵御 LMK 与厂商省电策略；首次传输会引导用户关闭电池优化。
- **设备命名可持久** — 设备身份取自公钥的 SHA-256 指纹，自定义名称按指纹保存并跨网络同步，换 IP 或重连不会丢名字。
- **界面细节** — Canvas 雷达图展示设备拓扑，3 套主题（深色 / 浅色 / 护眼），自适应刘海与手势条，主题化滚动条。

---

## ✨ 功能

### 设备发现
- 桌面端每 3 秒 UDP beacon（`8890`）+ 网段定向广播，Android 端主动监听
- HTTP `announce` 端点补充上报，设备信息含 ID、IP、名称、指纹
- 排除虚拟网卡，避免同一台机器出现多条记录

### 文件传输
- 手机 → 桌面：分块上传至 `/api/v1/transfer/upload`
- 桌面 → 手机：从桌面文件库下载（`files/list`、`files/download`）
- 手机 ↔ 手机：桌面 hub 按目标地址转发（`x-target-ip`），校验目标为私有网段地址
- 上传完成后写入桌面保存目录，文件名做非法字符清洗与重名去重

### 即时消息
- 设备之间可直接发文本消息，与文件记录一起呈现在同一会话流里

### 设置项
- 自动接收开关、压缩开关、PIN 手动刷新、保存目录自定义并从界面直接打开
- 设备名称管理器（指纹 → 自定义名称）

---

## 📥 Download

> ⚠️ 构建产物尚未上传到 Release（仓库 `main` 分支不含二进制文件，二进制已在 `.gitignore` 中排除）。当前 Release 页面只有说明、没有附件。

现阶段推荐从源码构建，命令见 [快速开始](#-quick-start)。若需要直接分发包，欢迎在 [Issues](https://github.com/Paper-Yuan/DocumentX/issues) 里说明需求。

**运行要求**

| 平台 | 要求 |
|:---|:---|
| Windows | Windows 10 1809+ / 11，64 位 |
| Android | Android 8.0（API 26）及以上，需与桌面端处于同一局域网 |
| Web 门户 | Chrome / Firefox / Safari / Edge 等现代浏览器 |
| macOS / Linux | Tauri 代码本身跨平台，但**尚未实机验证**，不保证可用 |

---

## 🚀 Quick Start

### 桌面端（Windows）

```bash
cd computer-design/tauri-app
npm install
npx tauri dev        # 开发模式
npx tauri build      # 打包
```

若只想运行后端与 UI，不经过 Tauri 外壳：

```bash
node computer-design/desktop_hub/server.js
# 打开 http://127.0.0.1:8899
```

**全局快捷键**

| 快捷键 | 作用 |
|:---|:---|
| `Ctrl/Cmd + Shift + S` | 显示 / 隐藏主窗口 |
| `Ctrl/Cmd + Shift + Q` | 快速发送文件 |
| `Ctrl/Cmd + Shift + R` | 刷新设备列表 |

快捷键注册失败不会阻断启动（例如与其它软件冲突时），日志会给出提示。

### Android 端

```bash
cd android-design/com
./gradlew assembleDebug
```

安装后需授予相机（扫码）、通知权限，并按引导关闭电池优化。接收到的文件保存在 `Download/SafeDrop/`。

### Web 门户

在桌面端界面找到当前局域网地址，然后在任意设备的浏览器打开：

```
http://<局域网IP>:8899/portal
```

输入界面上的 6 位配对码即可。

---

## 🔐 What it does and does not protect

这一节刻意写清楚边界，避免误用。

### 已经做到的

| 机制 | 说明 |
|:---|:---|
| 数据不出局域网 | 传输路径完全在本地网络内，不经过任何云端或第三方服务器 |
| 配对门禁 | 握手需通过 6 位 PIN 或一次性 token 校验，两者都会在每次成功配对后轮换 |
| 短暂宽限期 | 上一组凭据在轮换后保留 60 秒，避免多设备连续连接时反复输入 |
| 设备身份标识 | 设备身份为公钥的 SHA-256 指纹，用于展示与命名，换 IP 后仍可识别 |
| 转发目标校验 | hub 转发前校验目标是否为私有网段地址，且端口在 1024–65535 范围内 |
| 输入处理 | 文件名做非法字符清洗；JSON 请求体上限 4 MB |

### 尚未做到的（重要）

- **传输内容当前没有加密。** `CryptoEngine.kt` 中实现了完整的 X25519 + AES-256-GCM + HKDF 并配有单元测试，但**尚未接入实际传输链路**：客户端按明文分块上传，服务端解压后直接落盘。X25519 密钥目前仅用于生成设备指纹与握手标识。因此文件内容在局域网上是明文传输的——本项目现阶段的定位是"可信局域网内的便捷传输"，不是抗窃听的加密通道。
- **没有 TLS。** 服务以明文 HTTP 提供，同一局域网内具备抓包能力的设备可以看到传输内容。
- **没有速率限制。** 仅有 4 MB 请求体上限，不含请求频率控制。

因此使用建议是：**只在你自己可控的网络里使用**，不要在公共 Wi-Fi、共享办公网或任何你不信任的链路上传敏感文件。加密链路接通后，本节会更新。

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Desktop Hub (PC)                    │
│  ┌──────────────────┐      ┌────────────────────┐   │
│  │  Tauri 2.0 Shell │      │ Node.js Backend    │   │
│  │  (Rust + WebView)│◄────►│ (stdlib only)      │   │
│  │  • System Tray   │      │ • HTTP :8899       │   │
│  │  • Shortcuts     │      │ • UDP Beacon :8890 │   │
│  └──────────────────┘      └────────────────────┘   │
│           │                          │               │
│           │    HTML5 / CSS3 / JS     │               │
│           └──────────┬───────────────┘               │
│                      │                               │
└──────────────────────┼───────────────────────────────┘
                       │ LAN (Wi-Fi / Ethernet)
         ┌─────────────┼─────────────┬────────────────┐
         │             │             │                │
┌────────▼──────┐ ┌────▼─────┐ ┌─────▼───────┐ ┌──────▼──────┐
│ Android Client│ │ Browser  │ │ Another     │ │ macOS/Linux │
│ (Kotlin +     │ │ Portal   │ │ Android     │ │ (unverified)│
│  Compose)     │ │          │ │ (via relay) │ │             │
│ • Foreground  │ │ • Drag & │ │             │ │             │
│   Service     │ │   drop   │ │             │ │             │
│ • WakeLock    │ │ • QR/PIN │ │             │ │             │
└───────────────┘ └──────────┘ └─────────────┘ └─────────────┘
```

### Tech Stack

**Desktop**
- Shell: Tauri 2.0（Rust + WebView2 / WebKit），`tauri-plugin-global-shortcut`
- Backend: Node.js 18+，仅标准库，无 npm 依赖
- UI: 原生 HTML5 + CSS3 + Vanilla JS，Canvas 绘制雷达图

**Android**
- Kotlin + Jetpack Compose (Material3)，minSdk 26 / targetSdk 34
- OkHttp3 负责分块上传，CameraX 负责扫码
- MediaStore 适配分区存储（Android 10+）
- 前台服务 `dataSync` + `PowerManager.WakeLock` + 心跳协程

**协议**
- HTTP/1.1 + JSON 控制面，分块上传走 `application/octet-stream`
- UDP beacon 发现（`8890`），非 mDNS

---

## 📁 Project Structure

```
DocumentX/
├── computer-design/
│   ├── tauri-app/              # Tauri 2.0 外壳（托盘、全局快捷键）
│   ├── desktop_hub/
│   │   ├── server.js           # HTTP + UDP 后端（~1140 行，零依赖）
│   │   └── public/
│   │       ├── index.html      # 桌面端 UI
│   │       ├── portal.html     # Web 门户
│   │       ├── app.js          # 前端逻辑（队列、分块、压缩）
│   │       └── style.css       # 主题系统
│   └── installer/              # Windows 安装包构建脚本
├── android-design/com/app/src/main/java/com/safedrop/mobile/
│   ├── core/
│   │   ├── crypto/CryptoEngine.kt        # 加解密实现（暂未接入传输链路）
│   │   ├── network/                      # 发现、HTTP 客户端
│   │   ├── cache/DeviceNameCache.kt      # 指纹 → 名称持久化
│   │   └── storage/ScopedStorageHelper.kt
│   ├── service/TransferForegroundService.kt
│   └── ui/                               # Compose UI、雷达图、扫码
├── CHANGELOG.md
└── LICENSE (MIT)
```

---

## 🗺️ Roadmap

### ✅ v1.0.0 — Foundation
零配置发现、分块传输、桌面端 + Android + Web 门户三端打通。

### ✅ v1.1.0 — Performance & Stability
启动速度优化（并行初始化 + 非阻塞健康检查）、Android 后台稳定性（前台服务 + WakeLock + 心跳）、系统托盘、全局快捷键。

### ✅ v1.2.0 — Throughput & UX（当前最新）
并发传输队列（最多 3 个）、文本文件 gzip 压缩、指纹持久化设备命名、Android Material 3 触摸目标合规。

### 🔜 Next
- **接通加密链路** — 让已有的 X25519 + AES-256-GCM 模块真正作用于传输内容
- **断点续传** — 传输进度已持久化到 `temp_transfers/progress.json`，具备继续实现的基础
- **批量下载**（TAR.GZ 打包）与 **二维码分享链接**（带时效）
- macOS / Linux 实机验证

### 🔮 Later
- 可选的自建中继服务（跨网络传输，保持端到端加密）
- 访问控制与审计日志

---

## 🧪 Testing

```bash
# 后端与安全相关
node test_qr_and_security.js
node test_multi_device_and_portal.js

# UI / 交互
node test_theme_and_device_display.js
node test_scrollbar_and_copy_features.js
node test_new_chat_and_layout_features.js
```

Android 侧包含加密模块单元测试：`android-design/com/app/src/test/java/com/safedrop/mobile/CryptoEngineTest.kt`。

---

## 🤝 Contributing

本项目以 MIT 许可开源，欢迎提交 Issue 与 PR。

1. Fork 仓库并创建分支：`git checkout -b feature/your-feature`
2. 提交时遵循 [Conventional Commits](https://www.conventionalcommits.org/)
3. 发起 Pull Request

**代码风格**：桌面端遵循 Rust / 现代 JS 惯例，Android 端遵循 Kotlin 官方风格与 Material3 规范。

---

## 📄 License

MIT License，详见 [LICENSE](./LICENSE)。

---

## 📌 关于命名

- **SafeDrop** — 对外品牌名
- **DocumentX** — 仓库名与内部代号

两者指同一个项目。

---

<p align="center">
  <sub>为局域网内的文件互传而做</sub>
</p>
