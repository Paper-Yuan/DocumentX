# SafeDrop (DocumentX) - 跨平台极速安全互传系统

<p align="center">
  <img src="./app.ico" alt="SafeDrop Logo" width="96" height="96" />
</p>

<p align="center">
  <strong>基于零配置网络与端到端混合加密的跨平台文件互传与即时会话系统</strong>
</p>

<p align="center">
  <a href="#-核心特性">核心特性</a> •
  <a href="#-工程目录与文件介绍">文件介绍</a> •
  <a href="#-安全审计与纵深防御">安全矩阵</a> •
  <a href="#-快速上手指南">快速上手</a> •
  <a href="#-自动化测试">自动化测试</a> •
  <a href="#-技术架构">技术架构</a>
</p>

---

## 🌟 项目简介 (About SafeDrop)

**SafeDrop**（内部代号 **DocumentX**）是一套针对局域网（LAN）复杂网络拓扑专门打造的**高安全、高吞吐、零配置、跨平台**文件互传与双端通信解决方案。

系统由 **Desktop Hub（桌面端中心节点）** 与 **Android Mobile Client（移动随行端）** 组成，深度结合了现代浏览器技术、Node.js 轻量微服务、Android 原生 Kotlin 与现代密码学体系。在确保毫秒级设备拓扑自发现的同时，通过 X25519 密钥交换与 AES-256-GCM 密码管道实现防中间人攻击（Anti-MITM）的文件加密流式互传，并支持免安装 Web 直连门户。

---

## 💡 核心特性

### 1. 零配置局域网发现与双向拓扑感知
- **主动式网络拓扑探针**：桌面端与移动端基于轻量级组播（Multicast）与 mDNS 协议，在同一 Wi-Fi 或热点下实现毫秒级设备发现，告别手动输入 IP/端口。
- **60fps 动态水波纹雷达**：自适应 Canvas 动画引擎，动态渲染周边在线节点（PC、Android、Web），支持物理悬浮与距离拓扑排布。

### 2. 金融级端到端加密体系 (End-to-End Encryption)
- **非对称密钥协商**：基于现代椭圆曲线密码学 **X25519** 算法进行无信任信道密钥协商。
- **密钥派生与认证加密**：通过 **HKDF-SHA256** 派生独立会话密钥，采用 **AES-256-GCM** 提供 128 位认证标签（Auth Tag），保障传输内容的机密性与防篡改性。
- **带外二维码信任锚点（OOB Pairing）**：利用 Reed-Solomon 矩阵生成的图形码与 6 位动态 PIN 码双因子认证，有效抵御局域网 ARP 欺骗与中间人攻击。

### 3. 1MB 分块流式管道与断点续传
- **背压流式上传（Backpressure Streaming）**：将海量大文件拆分为标准 1MB 内存分块，基于 OkHttp / Fetch API 管道流式传输，杜绝多吉字节文件撑爆系统可用内存。
- **Android 前台保活与动态通知**：集成 Android `FOREGROUND_SERVICE_DATA_SYNC` 与多核通知引擎，防止大文件长时传输被系统低内存杀手（LMK）强行中断。
- **Android 10~14+ 分区存储深度合规**：采用 `MediaStore` API（图片/视频写入相册并即时索引，文档/压缩包归档入 `Download/SafeDrop/` 目录），无需授予高危的全局外部存储管理权限。

### 4. 跨平台交互与独立会话体验
- **独立互传对话框**：移动端基于动态视口监听（`addOnLayoutChangeListener`）自适应全面屏手势条与虚拟底栏，彻底根除输入框与导航选项的重叠问题。
- **自适应滚动条调色板**：桌面端彻底消除突兀的 Windows 原生白条，滑轨与滑块根据所选主题毫秒级同频着色。
- **双端文本长按复制**：
  - **电脑端**：长按右键或点击右键选中文本，弹出毛玻璃悬浮菜单一键快捷复制，支持全局 `Ctrl+C`。
  - **手机端**：长按气泡文本自由调整光标手柄选择文本，支持系统剪贴板服务一键复制全文。
- **三态高颜值主题系统**：原生支持【科技深黑 (Dark)】、【温润护眼米黄 (Eye-care)】、【清爽明亮 (Light)】三套精调设计系统。

### 5. 零安装 Web 直连门户 (Standalone Web Portal)
- 任何处于同一局域网的第三方设备（iPhone、iPad、Mac、Linux、智能电视）无需安装客户端，扫描二维码或直接在浏览器访问即可唤起现代化投送门户，直连手机或 PC 上传/下载文件。

---

## 📁 工程目录与文件介绍

SafeDrop 采用模块化结构设计，各端代码分工明确：

```text
DocumentX/
├── README.md                                  # 仓库主说明与技术架构文档
├── Launcher.cs                                # Windows 桌面端原生 C# 启动引导器
├── app.ico                                    # Windows 应用标准多尺寸图标资源
├── .gitignore                                 # Git 忽略配置 (过滤 APK、EXE、构建缓存)
├── test_scrollbar_and_copy_features.js        # 滚动条主题自适应与双端长按复制自动化测试
├── test_new_chat_and_layout_features.js       # 会话流式时间线与移动端防重叠布局测试
├── test_qr_and_security.js                    # 二维码矩阵、SSRF 防护与接口安全测试
├── test_multi_device_and_portal.js            # 多设备拓扑感知与 Web 门户直连测试
├── test_theme_and_device_display.js           # 三态主题切换与设备卡片渲染测试
│
├── computer-design/                           # 电脑端工程根目录
│   ├── SafeDrop.exe                           # 编译后的 Windows 原生轻量快捷启动程序
│   ├── app.ico                                # 桌面端应用图标
│   ├── design_plan.md                         # 电脑端设计与架构规范文档
│   │
│   ├── desktop_hub/                           # 【核心】Node.js 极速服务与现代 Web 交互中心
│   │   ├── server.js                          # 原生 HTTP & API 微服务 (含 SSRF/CSRF/DoS/路径遍历纵深防御)
│   │   ├── config.json                        # 端口、临时目录与配对密钥运行时配置
│   │   └── public/                            # 现代化流光毛玻璃前端应用
│   │       ├── index.html                     # 桌面端主 UI 骨架 (雷达、设备卡片、传输队列、互传会话)
│   │       ├── portal.html                    # 移动端/第三方设备浏览器免安装投送门户
│   │       ├── app.js                         # 前端主控制中枢 (雷达渲染、1MB分块传输、会话复制交互)
│   │       ├── style.css                      # 完整现代 CSS 设计系统 (三套主题、毛玻璃、滚动条调色)
│   │       ├── qrcode.js                      # 里德-所罗门高容错矩阵二维码生成模块
│   │       └── favicon.ico                    # 网页应用图标
│   │
│   ├── installer/                             # Windows 单文件静默安装打包工程
│   │   ├── Installer.cs                       # C# 自解压安装包引导程序 (桌面快捷方式、注册表写入)
│   │   ├── Uninstaller.cs                     # C# 纯净卸载清理工具 (注册表及残留文件清理)
│   │   ├── build_installer.js                 # 单文件安装包自动构建脚本
│   │   ├── test_installer_extraction.js       # 安装包自解压与完整性校验脚本
│   │   └── README.md                          # 安装打包技术说明文档
│   │
│   └── com/                                   # Flutter / Dart 跨平台桌面端客户端实现
│       ├── lib/                               # Dart 源码 (雷达画布、加解密引擎、系统托盘、主题)
│       ├── pubspec.yaml                       # Flutter 依赖项配置
│       └── windows/                           # Windows C++ 原生运行环境宿主
│
└── android-design/                            # Android 移动端工程根目录
    ├── SafeDrop-release.apk                   # 移动端正式版发布 APK 安装包 (28.45MB, 支持 AXML 签名)
    ├── SafeDrop-debug.apk                     # 移动端调试版测试包
    ├── build_apk.bat                          # 一键编译打包构建脚本
    ├── pack_apk.js                            # APK 独立打包与合规对齐签名工具
    ├── design_plan.md                         # 移动端架构与 Scoped Storage 设计方案
    ├── README.md                              # 移动端专属技术交付报告
    ├── test_e2e_verification.js               # 移动端与电脑端 E2E 全链路集成测试
    ├── test_mobile_features_verification.js   # 移动端特性合规与 CameraX 接口测试
    │
    └── com/                                   # 【核心】Android 原生工程 (Kotlin + Gradle)
        ├── build.gradle                       # 项目级 Gradle 脚本
        ├── settings.gradle                    # 模块组织定义
        ├── gradle.properties                  # JVM 编译优化与 AndroidX 开关
        ├── gradlew.bat                        # Gradle Wrapper 执行器
        └── app/                               # 移动端主 Application 模块
            ├── build.gradle                   # 模块构建配置 (Material3, CameraX, ML Kit, BouncyCastle)
            ├── proguard-rules.pro             # Release 混淆保护与密码学符号保留规则
            └── src/main/
                ├── AndroidManifest.xml        # 系统权限清单 (前台服务、Camera、allowBackup安全加固)
                │
                ├── java/com/safedrop/mobile/  # Kotlin 核心源码包
                │   ├── SafeDropApp.kt         # 全局 Application (密码学提供商注入 & 通知渠道构建)
                │   │
                │   ├── core/                  # 核心基础能力层
                │   │   ├── crypto/
                │   │   │   └── CryptoEngine.kt        # X25519 密钥协商、HKDF 与 AES-256-GCM 流式加解密
                │   │   ├── network/
                │   │   │   ├── DesktopHubClient.kt    # OkHttp3 客户端 (对端握手与分块流推送)
                │   │   │   ├── MulticastLockHelper.kt # Wi-Fi 组播锁调度器 (保障熄屏广播不丢包)
                │   │   │   └── NetworkHelper.kt       # 本地 Wi-Fi IP 解析与子网掩码计算
                │   │   └── storage/
                │   │       └── ScopedStorageHelper.kt # Android 10+ MediaStore 与路径穿越安全防护沙箱
                │   │
                │   ├── service/               # 后台服务层
                │   │   ├── MobileTransferServer.kt    # 手机内嵌轻量 HTTP 互传微服务 (含 2MB DoS 截断防护)
                │   │   └── TransferForegroundService.kt # 系统前台保活服务 (防杀保活与常驻下载进度条)
                │   │
                │   └── ui/                    # 用户界面与交互层
                │       ├── MainActivity.kt            # 主窗体 (底栏动态高度自适应、三态主题、页面调度)
                │       ├── adapter/                   # 视图适配器
                │       │   ├── ChannelMessageAdapter.kt # 会话气泡适配器 (长按选中文本复制、高亮着色)
                │       │   ├── DeviceAdapter.kt       # 在线设备卡片适配器
                │       │   ├── PeerChipAdapter.kt     # 顶部对话对端水平切换栏适配器
                │       │   ├── TransferTaskAdapter.kt # 传输任务进度条适配器
                │       │   └── VaultAdapter.kt        # 本地已下载文件保险库适配器
                │       ├── radar/
                │       │   └── RadarView.kt           # 自定义 60fps 水波纹扫描雷达自定义视图
                │       ├── scanner/
                │       │   └── QrScannerActivity.kt   # CameraX 极速扫码绑定器
                │       └── share/
                │           └── ShareReceiverActivity.kt # 系统分享菜单意图接收器 ("通过 SafeDrop 发送")
                │
                └── res/                       # 资源清单
                    ├── layout/                # XML 界面布局 (包含自适应 chatInputBarDivider、独立卡片)
                    ├── values/                # 颜色集、多语言中英文字符串、三套 Material 主题定义
                    └── xml/                   # FileProvider 路径定义、系统级数据提取规则
```

---

## 🛡️ 安全审计与纵深防御

本项目已通过系统级的安全渗透测试与漏洞排查，实施了严密的纵深防御机制：

| 安全维度 | 抵御威胁 | 实现机制与关键代码 |
| :--- | :--- | :--- |
| **网络边界防护** | **SSRF (服务端请求伪造)** | 校验目标主机 IP 是否属于 RFC 1918 私有网段（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.1`），过滤广域网恶意反弹与云元数据探测；强制端口限制在 `1024~65535`。 |
| **内存抗耗尽保护** | **DoS 拒绝服务攻击** | 桌面端对 JSON 载荷限制最大 **1MB**；移动端内置服务器在 `readBodyString` 中设置 **2MB** 严格上限截断，杜绝畸形大包引发 OOM 崩溃。 |
| **接口权限隔离** | **CSRF 篡改 / 敏感目录唤起** | 针对修改下载目录与唤起 Windows Explorer 的接口，强制核验调用端为本机回环（`127.0.0.1` / `::1`），局域网内其他节点调用直接阻断并返回 `403 Forbidden`。 |
| **文件系统沙箱** | **路径遍历 / 危险设备名注入** | 剥离文件名中的 `../`、`%2e%2e` 等相对越界字符；阻断 Windows 保留设备名称（`CON`, `PRN`, `AUX`, `NUL`, `COM1~9`, `LPT1~9`）；强制基于沙箱根目录二次解析校验。 |
| **端侧凭据防护** | **离线数据备份与 ADB 泄露** | 在 `AndroidManifest.xml` 中将 `android:allowBackup` 显式设为 `false`，防范通过调试器提取私有密钥与配对凭据。 |
| **前端展现安全** | **DOM XSS (跨站脚本攻击)** | 全局强化 `escapeHtml()` 函数，转义 `&`, `<`, `>`, `"`, `'`（`&#39;`），并在模板渲染中全面转义设备 ID、传输速率、端口等动态参数。 |

---

## 🚀 快速上手指南

### 1. 桌面端 (Desktop Hub)
- **直接运行**：双击根目录下 `SafeDrop.exe` 即可自动检查环境、拉起后台服务并以原生独立窗体模式唤起界面。
- **命令行启动**：
  ```bash
  cd computer-design/desktop_hub
  node server.js
  ```
  在任意浏览器打开 `http://localhost:8899` 即可访问操作中枢。

### 2. 移动端 (Android Client)
- **直接安装**：将 `android-design/SafeDrop-release.apk` 传输至 Android 手机直接点击安装。
- **源码编译**：
  ```cmd
  cd android-design/com
  gradlew.bat assembleRelease --no-daemon
  ```
  产物自动输出于 `android-design/com/app/build/outputs/apk/release/app-release.apk`。

### 3. 免安装浏览器投送
- 在手机或第三方设备上直接打开浏览器，访问 `http://<电脑IP>:8899/portal`，即可免安装无线存取文件。

---

## 🧪 自动化测试与质量保证

项目配备了完善的端到端与特性回归自动化测试套件：

```bash
# 1. 验证滚动条主题着色、长按复制逻辑与手机布局防重叠
node test_scrollbar_and_copy_features.js

# 2. 验证多设备拓扑发现与直连 Web 门户
node test_multi_device_and_portal.js

# 3. 验证二维码 Reed-Solomon 矩阵、SSRF 与 DoS 安全防御
node test_qr_and_security.js

# 4. 验证三态色彩主题与设备卡片高质渲染
node test_theme_and_device_display.js

# 5. 验证会话流式时间线与动态事件
node test_new_chat_and_layout_features.js
```

所有测试项均维持 **100% 通过率**。

---

## ⚙️ 技术架构与选型

- **桌面运行时**：Node.js 原生 API（零重型框架依赖，秒级冷启动与极低资源开销）
- **桌面前端**：Vanilla HTML5 / Modern CSS Custom Properties（GPU 加速毛玻璃与微动效）
- **移动端**：Android Kotlin, Material Components 3, Jetpack CameraX, ML Kit Barcode Scanning
- **网络通信**：HTTP/1.1 Persistent Connections, 1MB Streaming Chunking, Wi-Fi Multicast Lock
- **密码协议**：Curve25519 (X25519), HKDF-HMAC-SHA256, AES-GCM-256 (BouncyCastle & WebCrypto)

---

## 📄 隐私与版权说明

- 本仓库由作者独家开发，仓库属性为 **Private（私有）**。
- 所有通信数据仅在用户自有的局域网物理信道内直连加密交换，**绝不经过任何第三方公网服务器中转**，彻底杜绝数据泄露风险。
