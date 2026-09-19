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
  <a href="#-安全模型与边界">安全边界</a> •
  <a href="#-architecture">架构</a> •
  <a href="#-roadmap">路线图</a>
</p>

---

## 🧭 使用逻辑

SafeDrop 不依赖账号、云端或中转服务器。它的运行模型只有一条主线：

**桌面端是 hub，其它设备是接入方。**

1. **启动桌面端** — 本机同时起一个 HTTP 服务（默认 `8899`）、一个 HTTPS 门户（默认 `8900`）和一个 UDP 发现服务（`8890`）。桌面 UI 与 Web 门户由这些服务直接提供。
2. **手机 / 浏览器接入** — 桌面端显示二维码与 6 位配对码。手机扫码，或用浏览器打开界面给出的 `https://<局域网IP>:8900/portal`，再用配对码完成一次握手。
3. **之后就是直连** — 文件在设备之间通过局域网直接传输（每个分块都经 AES-256-GCM 加密），桌面端负责验签与落盘（可自定义保存目录）、展示进度，并在需要时把流量转发给同一网络内的其它设备。

这个模型带来的直接结果是：**没有月费、没有流量上限、断网也照常工作**，代价是它只能在同一个可互通的局域网里使用。

> English: The desktop app is the hub. It serves the UI, the HTTPS web portal, and the discovery service. A phone or browser joins by scanning a QR code and entering a rotating pairing code; transfers are then sealed per chunk with AES-256-GCM over the local network.

---

## 🎨 Design Highlights

这些是当前代码里真实存在、且经过验证的设计点：

- **零配置发现** — 桌面端每 3 秒向本网段定向广播地址发送 UDP beacon，手机端通过 `MulticastLock` 接收；同时过滤 Clash / TAP / TUN / vEthernet 等虚拟网卡，避免多网卡环境下出现幻影设备。
- **无需安装的接入端** — Web 门户是服务端直出的一个页面，手机、平板、Mac、Linux、智能电视只要能开浏览器就能收发文件，不需要装任何东西（前提是走 `https://` 并接受自签名证书，见「安全边界」）。
- **后端零依赖** — 只用 Node.js 标准库（`http`/`https`/`dgram`/`crypto`/`zlib`），没有 `node_modules`，启动快、体积小、审计面窄。
- **端到端载荷加密** — 每个分块以 AES-256-GCM 封装，随机 96 位 nonce，并把 task id、分块序号、总块数与发送端步长一起作为 AAD 绑定：跨文件拼接、改动内容、改动序号、以及改写"这份文件一共几块"来提前定稿都会被认证拒掉。
- **手机直连手机** — 手机之间由发送方直接与目标协商会话，hub 只转发密文，因此即便经过桌面端中转，内容对 hub 也不可见。
- **配对凭据不上网** — PIN / token 只在本机作为 HKDF 输入，通过 HMAC 双向证明密钥一致，被动抓包者拿不到密钥（但 6 位 PIN 的熵有限，边界见下节）。
- **分块传输与重组** — 每个分块按 `序号 × 步长` 定位写入 `.part`，收齐认证过的全部块才改名落盘；整个文件不会一次性读进内存，但每个分块是在内存里解密的，峰值内存与分块大小和并发数成正比。桌面端步长 4 MB，Android 端与 Web 门户 1 MB（这个不一致是已知待办，步长本身已进 AAD，所以两端不同不会破坏认证）。
- **传输队列与并发** — 最多 3 个文件并发传输，其余进入队列，UI 上显示队列位置，单个任务失败不影响其它任务。
- **可选的 gzip 压缩** — 对文本类、体积 ≥ 1 MB 的常见可压缩格式自动启用（客户端 `CompressionStream`，服务端 `zlib` 解压），可在设置里关闭。
- **自签名 HTTPS 门户** — 纯 Node 生成并缓存 P-256 自签名证书（含 IP SAN），让浏览器进入安全上下文，从而能使用 WebCrypto 加密上传。
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
- 手机 ↔ 手机：发送方先与目标手机直接协商会话并加密，再由桌面 hub 按目标地址转发密文（`x-target-ip`）；hub 只校验中继目标合法性，不持有该会话密钥
- 上传完成后写入桌面保存目录，文件名做非法字符清洗与重名去重

### 即时消息
- 设备之间可直接发文本消息，与文件记录一起呈现在同一会话流里

### 设置项
- 自动接收开关、压缩开关、PIN 手动刷新、保存目录自定义并从界面直接打开
- 设备名称管理器（指纹 → 自定义名称）

---

## 📥 Download

前往 [Releases](https://github.com/Paper-Yuan/DocumentX/releases/latest) 下载：

| 产物 | 说明 |
|:---|:---|
| `SafeDrop-Setup-1.3.0.exe` | Windows 单文件自解压安装包，内置便携 Node 运行时，双击即可安装，无需另外装 Node.js |
| `SafeDrop-Android-1.3.0.apk` | Android 接收端，需允许"安装未知来源应用" |

> 校验值：Release 流程目前**还不产出** `SHA256SUMS.txt`，所以别去下载它；补齐自动生成是发布流水线的待办项。

> ⚠️ **两端必须实现同一版传输协议：`safedrop-e2e-v2`。** 这个标记由 `protocol.json` 单一来源规定，握手不匹配会被直接拒绝；已发布的 1.3.0 客户端说的是 `safedrop-e2e-v1`，连不上当前代码。桌面端还会拒绝未建立加密握手会话的上传（HTTP 401），也拒绝"已配对但不加密"的上传（HTTP 400）——明文上传只对本机回环开放，两端同规则。旧版 APK（1.0.2 等）没有握手逻辑，同样直接失败。这是有意为之：宁可失败也不静默退化成明文或旧帧格式。
>
> ⚠️ Android 包使用调试密钥签名（`CN=Android Debug`）。它足够用于自用与内部分发，但**不是**发布到应用商店的签名；同一设备上后续版本必须用同一密钥签名才能覆盖安装。
>
> 仓库 `main` 分支不含二进制文件（已在 `.gitignore` 中排除），二进制只挂在 Release 附件上。

也可以从源码构建，命令见 [快速开始](#-quick-start) 与 [打包](#-打包)。

**运行要求**

| 平台 | 要求 |
|:---|:---|
| Windows | Windows 10 1809+ / 11，64 位 |
| Android | Android 8.0（API 26）及以上，需与桌面端处于同一局域网 |
| Web 门户 | Chrome / Firefox / Safari / Edge 等现代浏览器 |
| macOS / Linux | Tauri 代码本身跨平台，但**尚未实机验证**，不保证可用 |

---

## 📦 打包

### Windows 单文件安装包

```bash
node apps/desktop/installer/build_installer.js
```

产物：`set/SafeDrop-Setup.exe`（约 34 MB，自带 Node 运行时，目标机无需预装环境）。

构建流程为"发现模块 → 校验依赖 → 压缩载荷 → 编译安装器"，其中**依赖校验会让缺失模块的构建直接失败**——因为这类问题只会在用户安装后才暴露（表现为启动即 `MODULE_NOT_FOUND`）。打包细节见 [installer/README.md](./apps/desktop/installer/README.md)。

### Android APK

```bash
cd apps/android/com
gradlew.bat assembleRelease     # 输出 app/build/outputs/apk/release/app-release.apk
cd .. && node pack_apk.js       # 归档为 SafeDrop-release.apk
```

**发布签名**：release 构建会读取 `apps/android/com/keystore.properties`（已在 `.gitignore` 中），或 `SAFEDROP_KEYSTORE_FILE` / `SAFEDROP_KEYSTORE_PASSWORD` / `SAFEDROP_KEY_ALIAS` / `SAFEDROP_KEY_PASSWORD` 环境变量：

```properties
storeFile=C:/path/to/release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

未配置时回退到 debug 签名，构建仍可成功，但**该 APK 不可用于分发**（会被应用商店与部分系统拒绝）。仓库不包含任何签名密钥。

### Tauri 桌面外壳（MSI / NSIS）

```bash
cd apps/desktop/tauri-app
npx tauri build
```

需要本机具备 Rust 工具链与 MSVC 构建环境；当前环境未安装，因此该产物未经验证。

---

## 🚀 Quick Start

### 桌面端（Windows）

```bash
cd apps/desktop/tauri-app
npm install
npx tauri dev        # 开发模式
npx tauri build      # 打包
```

若只想运行后端与 UI，不经过 Tauri 外壳：

```bash
node apps/desktop/desktop_hub/server.js
# 打开 http://127.0.0.1:8899
```

**全局快捷键**

| 快捷键 | 作用 |
|:---|:---|
| `Ctrl/Cmd + Shift + S` | 显示 / 隐藏主窗口 |
| `Ctrl/Cmd + Shift + Q` | 快速发送文件 |
| `Ctrl/Cmd + Shift + R` | 刷新设备列表 |

快捷键注册失败不会阻断启动（例如与其它软件冲突时），日志会给出提示。

> 从 Tauri 外壳启动时，前端由后端服务提供。Tauri 的 CSP 已放行 `connect-src http:` 与 Google Fonts，因此界面能正常访问本机后端；若你自行收紧 `csp`，注意 `/api/...` 请求必须被允许，否则界面会停在加载态。

### Android 端

```bash
cd apps/android/com
./gradlew assembleDebug
```

安装后需授予相机（扫码）、通知权限，并按引导关闭电池优化。接收到的文件保存在 `Download/SafeDrop/`。

### Web 门户

在桌面端界面（或二维码弹窗里的"直连网址"）找到门户地址，在任意设备的浏览器打开：

```
https://<局域网IP>:8900/portal
```

首次访问会出现自签名证书警告，选择继续访问即可（该证书只用于传输加密，身份由配对码保证）。然后输入界面上的 6 位配对码。

> 若用 `http://<局域网IP>:8899/portal` 打开，浏览器不会提供 WebCrypto，门户会直接提示"当前地址不支持加密"并拒绝配对——这是有意为之，避免在不知情的情况下走明文。

---

## 🔐 安全模型与边界

SafeDrop 的定位是**局域网内的加密传输**：载荷已加密，但配套机制仍偏"便捷优先"。把边界写清楚，是为了让你知道什么时候不该用它。

### 已提供

| 机制 | 说明 |
|:---|:---|
| 载荷加密 | 每个分块以 AES-256-GCM 封装后传输，服务端验签通过才落盘。AAD 绑定 `taskId / 序号 / 总块数 / 步长`，所以被改动、被搬到别的任务或别的位置、以及改写头部里"一共几块"来提前定稿的块都会被拒 |
| 完整性判定 | 接收端把每块按 `序号 × 步长` 定位写入 `.part`，只有收齐 0..count-1 全部块、且落盘字节数与块流推导出的大小一致时才改名落盘（改名前把 `.part` 截到该大小，避免上一次中断留下的更长 `.part` 把尾巴混进新文件）；同一块重复到达且字节相同是幂等的，内容不同则拒绝——序号在写盘之前就被占用，所以"重发的那一块"和原请求同时在飞时也一样成立。缺块的文件永远不会有"完成"状态，也不会出现在仓库列表里 |
| 手机 → 手机 | 发送方直接与目标手机协商独立会话，hub 只转发密文、不参与解密，因此端到端加密成立 |
| 会话密钥协商 | 每次连接生成临时 X25519 密钥对，经 HKDF-SHA256 派生会话密钥，具备前向保密 |
| 配对凭据不入网 | 6 位 PIN / 一次性 token 不发送给服务端，只作为 HKDF 输入，并用 HMAC 证明双方派生出同一密钥 |
| 双向身份确认 | 服务端返回自身证明，客户端校验通过后才认为配对成功。它证明的是"对方知道当前 PIN"，因此能发现不知道 PIN 的冒充者；拿到同一 PIN 的 evil-twin hub 无法被区分（PIN 之外没有身份锚点，见「未提供」） |
| 配对尝试限流 | 同一来源 IP 连续 8 次配对失败后封禁 5 分钟，抑制在线穷举 |
| 接口鉴权 | 文件列表、下载、消息收发与设备名增删改等接口都要求已验证会话，未配对一律返回 401（含 `/api/v1/message/send`、`/api/v1/messages/list`、`DELETE /api/v1/devices/names/:fp`）；`/api/v1/settings/*` 只接受本机回环；跨源响应只回显本机与私网来源，不再对任意网页开放 `*`；配对 PIN 仅对本机回环请求下发，不广播给局域网 |
| 转发目标校验 | 仅允许中继到 RFC1918 私网地址，或与本机同一网段的对端（因此非标准网段也能开箱即用）；回环、链路本地（含云元数据 `169.254.169.254`）与公网地址一律拒绝；地址只接受规范点分十进制，`010.x` 这类前导零写法直接拒（此处按十进制解释、解析器按八进制解释会造成"放行一个地址、连到另一个地址"）。跨网段可用 `SAFEDROP_RELAY_TARGETS` 显式放行 |
| 输入处理 | 文件名做非法字符清洗；JSON 请求体上限 4 MB；单个密封分块上限 64 MB（两者都写进 `protocol.json`） |

### 未提供（请勿依赖）

- **桌面端自身与 hub 之间是明文 HTTP。** 本机回环通信不加密，这是速度与复杂度的取舍；如果你在同一台机器上运行不受信任的进程，它可以看到这些流量。
- **服务端强制的是"已配对"，不是"是谁"。** 文件与消息接口都要求已验证会话，但会话只证明对方知道当前 PIN，不绑定设备身份。PIN 只有 6 位（约 20 比特）且不是 PAKE——它作为 HKDF 输入参与派生，所以能在路径上抓到完整握手的攻击者可以离线穷举 10⁶ 个候选；在线穷举则被"每 IP 8 次 / 5 分钟"限流压制。结论：它防得住误连与被动窃听，防不住蹲守同一来源地址的定向攻击，也防不住已知 PIN 的中间人。
- **手机自己开的网页传送门只能打开、不能配对。** Android 端只监听 `http`，而同一份门户页面在非安全上下文里会拒绝配对，所以手机当 hub 时网页端只是入口提示；要配对请用另一台 SafeDrop 设备扫本机的配对码（桌面 hub 有自签名 HTTPS，不受此限）。给手机侧补 TLS 是待办。
- **无身份持久化信任。** 每次连接都重新配对，不保存"已信任设备"凭据，因此每次接入都需要读取当前 PIN。
- **Web 门户需要 HTTPS 才加密。** 浏览器只在安全上下文中暴露 WebCrypto，所以门户必须通过 `https://` 打开（见下节）。若你用 `http://` 打开门户，加密不可用，页面会直接拒绝配对而不是静默降级为明文。

### 关于自签名证书

hub 会为门户自动生成一张自签名证书（保存在 `apps/desktop/desktop_hub/tls/`），因此浏览器首次访问会提示证书不受信任。这是预期行为：**该证书只提供传输加密，不提供身份认证**；对端的真实身份由配对 PIN 与握手 HMAC 保证，所以即便有人做了中间人替换证书，拿不到 PIN 也无法解出会话密钥。

**使用建议**：避免在公共 Wi-Fi 或不受信任的网络上使用；如需跨不可信链路传输，请等待中继/持久信任功能，或自行叠加 VPN。

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Desktop Hub (PC)                    │
│  ┌──────────────────┐      ┌────────────────────┐   │
│  │  Tauri 2.0 Shell │      │ Node.js Backend    │   │
│  │  (Rust + WebView)│◄────►│ (stdlib only)      │   │
│  │  • System Tray   │      │ • HTTP :8899       │   │
│  │  • Shortcuts     │      │ • HTTPS :8900      │   │
│  │                  │      │ • UDP Beacon :8890 │   │
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
│  Views)       │ │          │ │ (via relay) │ │             │
│ • Foreground  │ │ • Drag & │ │             │ │             │
│   Service     │ │   drop   │ │             │ │             │
│ • WakeLock    │ │ • QR/PIN │ │             │ │             │
└───────────────┘ └──────────┘ └─────────────┘ └─────────────┘
```

### Tech Stack

**桌面**
- Shell: Tauri 2.0（Rust + WebView2 / WebKit），`tauri-plugin-global-shortcut`
- Backend: Node.js 18+，仅标准库，无 npm 依赖
- UI: 原生 HTML5 + CSS3 + Vanilla JS，Canvas 绘制雷达图

**Android**
- Kotlin + ViewBinding（Material 3 主题与组件，非 Jetpack Compose），minSdk 26 / targetSdk 34
- OkHttp3 负责分块上传，CameraX 负责扫码
- BouncyCastle 提供 X25519 与 AES-GCM
- MediaStore 适配分区存储（Android 10+）
- 前台服务 `dataSync` + `PowerManager.WakeLock` + 心跳协程

**协议**
- HTTP/1.1 + JSON 控制面，分块上传走 `application/octet-stream`，另开 HTTPS 监听供浏览器加密
- AES-256-GCM 分块封装：`nonce(12) || ciphertext || tag(16)`，AAD = `safedrop-e2e-v2|chunk|<taskId>|<index>|<count>|<chunkSize>`
- 会话密钥：ECDH 共享密钥经 HKDF-SHA256（salt 绑定会话 id，info 携带配对凭据）派生
- UDP beacon 发现（`8890`），非 mDNS
- **`protocol.json` 是所有跨端常量的唯一来源**（协议标记、模板、密钥/nonce/tag 宽度、PIN 与 token、宽限期、限流窗口、会话 TTL、端口与请求头名）。`node scripts/protocol.js gen` 据此生成 Node 与 Kotlin 两侧的实现，`node scripts/protocol.js check` 在校验里同时盯住两处浏览器内联副本和 APK 里的 portal.html 副本

---

## 📁 Project Structure

```
DocumentX/
├── apps/desktop/
│   ├── tauri-app/              # Tauri 2.0 外壳（托盘、全局快捷键）
│   ├── desktop_hub/
│   │   ├── server.js           # HTTP/HTTPS + UDP 后端（仅标准库）
│   │   ├── crypto_protocol.js  # 传输加密协议（ECDH/HKDF/AES-GCM/HMAC）
│   │   ├── lan_guard.js        # 中继目标校验（防 SSRF）
│   │   ├── tls_selfsigned.js   # 纯 Node 自签名证书生成（含 DER 编码）
│   │   ├── tls/                # 自动生成的证书与私钥（已 gitignore）
│   │   └── public/
│   │       ├── index.html      # 桌面端 UI
│   │       ├── portal.html     # Web 门户（含 WebCrypto 客户端加密）
│   │       ├── app.js          # 前端逻辑（队列、分块、压缩）
│   │       └── style.css       # 主题系统
│   └── installer/              # Windows 安装包构建脚本
├── apps/android/com/app/src/main/java/com/safedrop/mobile/
│   ├── core/
│   │   ├── crypto/CryptoEngine.kt        # 加解密实现（已接入传输链路）
│   │   ├── network/                      # 发现、HTTP 客户端
│   │   ├── cache/DeviceNameCache.kt      # 指纹 → 名称持久化
│   │   └── storage/ScopedStorageHelper.kt
│   ├── service/TransferForegroundService.kt
│   └── ui/                               # ViewBinding 视图、雷达图、扫码
├── CHANGELOG.md
└── LICENSE (MIT)
```

---

## 🗺️ Roadmap

### ✅ v1.0.0 — Foundation
零配置发现、分块传输、桌面端 + Android + Web 门户三端打通。

### ✅ v1.1.0 — Performance & Stability
启动速度优化（并行初始化 + 非阻塞健康检查）、Android 后台稳定性（前台服务 + WakeLock + 心跳）、系统托盘、全局快捷键。

### ✅ v1.2.0 — Throughput & UX
并发传输队列（最多 3 个）、文本文件 gzip 压缩、指纹持久化设备命名、Android Material 3 触摸目标合规。

### ✅ v1.3.0 — Encrypted Transport（当前最新）
接通 X25519 + AES-256-GCM 载荷加密，配对凭据改为 HMAC 证明而不上网，新增配对限流、服务端会话强制校验、自签名 HTTPS 门户，并修复了原先确定性 nonce 的缺陷。打包侧补齐了此前缺失的后端模块与发布签名配置。

### 🔜 Next
- **断点续传**（仍未实现）— 前置条件已经具备：分块现在按 `序号 × 步长` 定位写、且只认认证过的块集合，所以"从中间继续"不再要求重传整文件。剩下的缺口是发送端无从知道接收端已经有哪些块（需要一个查询已收块列表的接口），以及 `temp_transfers/progress.json` 目前只在启动时读取、运行期不写入
- **批量下载**（TAR.GZ 打包）与 **二维码分享链接**（带时效）
- macOS / Linux 实机验证

### 🔮 Later
- 持久化信任设备身份，避免每次重新配对
- 可选的自建中继服务（跨网络传输）
- 访问控制与审计日志

---

## 🧪 Testing

```bash
# 契约与单元测试（无需端口、无需设备）
node scripts/protocol.js check          # 四端实现与 protocol.json 是否还是同一份协议
node scripts/gen-vectors.js --check     # 金标向量能否被当前代码逐字节复现
node --test "test/*.test.js"            # 加密层与 SSRF 防护的单元测试

# 传输加密端到端（起真实 hub 进程：配对、加解密、丢块/重放/提前定稿拒绝、
# 限流、手机→手机中继、HTTPS 门户、以及直接执行 portal.html 里的浏览器加密代码）
node test/e2e/encryption_e2e.js

# 中继目标与路径处理
node test/e2e/qr_and_security.js
node test/e2e/multi_device_and_portal.js

# UI / 交互（以源码字符串断言为主，不能证明行为，只算回归提示）
node test/e2e/theme_and_device_display.js
node test/e2e/scrollbar_and_copy_features.js
node test/e2e/new_chat_and_layout_features.js
```

Android 侧加密单元测试：`apps/android/com/app/src/test/java/com/safedrop/mobile/CryptoEngineTest.kt`。它读取与 Node 同一份 `test/vectors/e2e-v2.json`，逐项核对模板拼接结果、AAD 字节、双向证明与每个密封分块的解密，因此任何一端单方面改动协议都会在一侧红掉。运行：`cd apps/android/com && ./gradlew.bat testDebugUnitTest --offline`。

CI 两侧都跑：`test-desktop` 执行上面前三条契约/单元测试加三个起真实 hub 的端到端套件，`test-android` 执行上面那条 Gradle 单元测试并上传报告。

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
