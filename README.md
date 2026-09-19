# SafeDrop

<p align="center">
  <img src="./app.ico" alt="SafeDrop Logo" width="120" height="120" />
</p>

<p align="center">
  <strong>局域网文件互传 · 以桌面端为中心的 hub 模式</strong><br/>
  <sub>A LAN file transfer tool built around a desktop hub</sub>
</p>

<p align="center">
  <a href="https://github.com/Paper-Yuan/DocumentX/releases/tag/v1.3.0">
    <img src="https://img.shields.io/github/v/release/Paper-Yuan/DocumentX?label=version" alt="Latest release: v1.3.0">
  </a>
  <a href="https://github.com/Paper-Yuan/DocumentX/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/Paper-Yuan/DocumentX" alt="License: MIT">
  </a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Android%20%7C%20Web-blue" alt="Platforms">
</p>

---

## 这是什么，给谁用

SafeDrop 是一个局域网文件互传工具，三个端：

- **Windows 桌面端**：hub。它自己就是一个 HTTP 服务（默认 `8899`）+ HTTPS 门户（`8900`）+ UDP 发现（`8890`），界面、二维码、配对码都由这个服务直出；Tauri 只是外壳（托盘、全局快捷键）。
- **Android 端**：接入方，也能自己开一个接收服务，让手机直接收另一台手机的文件。
- **浏览器门户**：桌面端直出的一个页面，任何能开浏览器的设备都能上传 / 下载，不用装东西。

没有账号、没有云端、没有第三方中继。设备之间在局域网里直连，每个分块用 AES-256-GCM 封装后再走线。当前线协议是 `safedrop-e2e-v2`。

**适合**：同一个 Wi-Fi / 有线网段内，自己手机和电脑之间、同事之间传文件；不能或不想让文件经过外网的场合；断网环境。

**不适合**：跨网络或公网传输（做不到，代码里没有中继服务）；需要强身份认证的场合（配对码只有 6 位数字，见「安全边界」）；把 hub 长期开着暴露在你不控制的网络里。

**发布状态**：v1.3.0 是唯一带安装包的 release，而它说的是 `safedrop-e2e-v1`，与当前 `main`（v2）**不互通**——`git show v1.3.0:computer-design/desktop_hub/crypto_protocol.js` 里就是这个常量。要用当前协议的完整行为，请从源码跑。

---

## 30 秒上手

需要 Node.js。CI 的两个 Node job 都固定在 **Node 24**，与本文标"实测"的数字同一版本（2026-09-19 于 Windows / Node 24.19.0 跑出）。更低版本没有验证过，因此这里不承诺能跑；`node --test` 的 glob 参数本身就要求较新的 Node。没跑过的命令会写明。桌面后端不需要 `npm install`——它没有第三方依赖。

```bash
git clone https://github.com/Paper-Yuan/DocumentX.git
cd DocumentX

# 1) 起 hub（端口被占用会直接 EADDRINUSE 报错，先确认 8899 空闲）
node apps/desktop/desktop_hub/server.js
# 打开 http://127.0.0.1:8899 —— 界面、二维码、6 位配对码都在这页
```

```bash
# 2) 验证传输加密真的在工作：它自己起一个 hub，端口按进程号算（17000+），不占 8899
node test/e2e/encryption_e2e.js          # 60 项断言，实测全部通过
```

```bash
# 3) Android（不需要连手机或模拟器就能跑密码学单测）
cd apps/android/com
./gradlew.bat testDebugUnitTest          # 14 项，读的是与 Node 同一份 test/vectors/e2e-v2.json
./gradlew.bat assembleDebug              # 产物 app/build/outputs/apk/debug/app-debug.apk
```

配对：手机端扫码或输 6 位码；浏览器打开 hub 界面上给出的 `https://<局域网IP>:8900/portal` 并接受自签名证书。用 `http://…:8899/portal` 打开时页面会拒绝配对，不会静默走明文。

---

## 现在能用什么

分成三档，差别很大：第一档有会失败的行为测试，第二档只是代码存在且能编译，第三档没有。

### 一 · 已实现，并且有自动化测试盯住

下面每一条都对应上面某个套件里的断言，不是"看代码觉得没问题"。

| 能力 | 实现位置 | 覆盖它的测试 |
|:---|:---|:---|
| 配对握手（临时 X25519 → HKDF-SHA256 会话密钥，双向 HMAC 证明） | `desktop_hub/crypto_protocol.js` | `encryption_e2e.js` Section 2 |
| 分块封装：`nonce(12) ‖ ciphertext ‖ tag(16)`，AAD 绑 `taskId/序号/总块数/步长` | 同上 + `portal.html` + `CryptoEngine.kt` | `node --test test/*.test.js`、Kotlin 14 项 |
| 收齐**认证过的**完整块集合才改名落盘；块按 `序号 × 步长` 定位写，重排不影响结果 | `server.js`、`MobileTransferServer.kt` | `encryption_e2e.js` Section 3 / 11 |
| 拒绝改写几何参数（改总块数提前定稿、改步长、越界块大小、tag 翻转、换 nonce、跨会话搬运） | 同上 | `encryption_e2e.js` Section 4 + `test/vectors/e2e-v2.json` 的 7 个反例 |
| 未配对不能读写：文件列表、下载、消息、设备名一律 401；带 `X-Encrypted` 却无会话 → 400；明文上传只对本机回环开放 | `server.js` | `encryption_e2e.js` Section 6、`qr_and_security.js` |
| 配对凭据不上网（PIN/token 只作 HKDF 输入），仅向本机回环下发；换码宽限期最多 3 代 / 60 秒 | `server.js` | `encryption_e2e.js` Section 1 / 5 |
| 配对限流：同一来源 8 次失败封 5 分钟 | `server.js` | `encryption_e2e.js` Section 7 |
| 手机↔手机：hub 只转发密文、不持有该会话密钥 | `server.js` + `DesktopHubClient.kt` | `encryption_e2e.js` Section 8、`CryptoEngineTest.kt` |
| 中继目标校验（RFC1918 或本机同网段放行，回环 / 链路本地 / 公网拒绝，只收规范点分十进制） | `desktop_hub/lan_guard.js` | `node --test`（`lan-guard.test.js`）、`qr_and_security.js` |
| 自签名 HTTPS 门户（纯 Node 生成 P-256 证书，带 IP SAN），门户内的浏览器加密代码 | `tls_selfsigned.js`、`public/portal.html` | `encryption_e2e.js` Section 9 / 10（第 10 节真的执行 `portal.html` 里的代码） |
| HTTP `announce` 上报与多设备共存（含 12 秒过期窗口） | `server.js` | `multi_device_and_portal.js` |
| 跨端常量一致：`protocol.json` 单一来源，四份实现 + 两份 portal 副本 | `protocol.json`、`scripts/protocol.js` | `node scripts/protocol.js check` |
| 版本号一致（hub / Tauri 配置 / npm / Cargo.toml / Cargo.lock / Android / 3 个 C# 组件 / CHANGELOG / README，共 11 个文件） | `scripts/version-check.js` | `node scripts/version-check.js` → 19/19 |
| 安装包载荷完整（后端模块自动收集 + `require()` 依赖校验，缺一即构建失败） | `installer/payload_check.js` | `node apps/desktop/installer/test_payload_check.js` → 11 项 |

### 二 · 已实现，但只有编译或人工验证

这些是真的在跑的产品面，但当前没有能失败的自动化测试覆盖其行为。别把它们当成"已验证"。

- **桌面 UI**：设备列表、传输队列（同时最多 3 个文件，其余排队）、Canvas 雷达、三套主题（深色 / 护眼 / 浅色）、即时消息、收件目录管理与"打开目录"、gzip 压缩开关、失败任务的原地重试。逻辑在 `desktop_hub/public/app.js`（界面自己发的请求会经过第一档里那些被测端点，但点击流本身没测）。
- **UDP beacon 自发现**（`8890`，每 3 秒定向广播）与手机侧 `MulticastLock` 接收、以及 hub 对 Clash / TAP / TUN / vEthernet 网卡的过滤：代码在（`server.js` 的广播定时器、`getAllLocalIps`，Android 的 `UdpDiscoveryHelper.kt`），但**没有任何一条测试发过或收过一个 beacon**——仓库里连 `dgram` 的测试引用都没有。这条链路只能靠真机看界面确认。
- **Tauri 外壳**：托盘、3 个全局快捷键、注册失败不阻断启动（`apps/desktop/tauri-app/src-tauri/src/main.rs`）。CI 不构建它，本次也没能在这台机器上跑完 `npx tauri build`，所以当前 `main` 的 Tauri 构建**未经验证**。
- **Android 端全部行为**：前台服务保活、WakeLock、扫码配对、系统分享入口、分区存储写入、以及手机接收端的定位写入 / CORS / 限流。CI 的 Android job 没有模拟器，只跑 JVM 单元测试，所以这些只是"编译通过 + 加密实现与契约一致"。
- **Android 的 `RadarView` 是一个没接上的自定义视图**：全项目没有任何 layout 实例化它，`MainActivity` 也从不调用它的 `setThemeMode()` / `setConnectedDevice()`；手机主界面那个"雷达"位上放的是一张静态 `ic_radar` 图标。它已经改成从共享 token 取色（不再有 Tailwind 时代的靛紫），但在被写进布局之前，**它对屏幕没有任何影响**——桌面端才有真正会转的雷达。
- **Windows 安装包构建本身**：`build_installer.js` 的载荷校验逻辑有单测（第一档最后一行）；脚本自身的目录常量已随重构修正，但**没有跑过一次真实构建**（需要 Inno Setup 与 .NET 编译器），所以"安装包能出"这件事仍只有代码审阅级保证。

### 三 · 计划中（现在代码里没有）

- **断点续传**。地基有了（定位写入 + 只认认证过的块），但发送端无从知道对方已经有哪些块；`server.js` 里的 `transferProgress` / `persistProgress()` / `findMissingChunks()` 是死代码——只有启动时 `loadPersistedProgress()` 被调用，传输过程中既不写也不用。
- **批量下载（TAR.GZ）**、**带时效的二维码分享链接**。
- **手机侧 HTTPS 门户**。目前手机只监听 HTTP，所以手机当 hub 时那个网页门户打不开配对。
- **持久信任设备身份**，免掉每次读码。
- **macOS / Linux 实机验证**：Tauri 代码是跨平台的，但没人在这两个系统上跑过。

---

## 安全边界

下面是 `SECURITY.md` 的摘要；冲突时以 `SECURITY.md` 为准，因为它更靠近代码。

**给了什么**：每个分块先用 AES-256-GCM 封装再走线，验签通过才落盘；AAD 覆盖 `taskId / 序号 / 总块数 / 步长`，所以"改写一共几块来提前定稿"和"把块挪到别的文件 / 别的位置"都会被认证拒掉（到达顺序本身不在认证范围内，因此不需要它有序）。会话密钥来自每次连接新生成的 X25519 密钥对，配对码不上网、只作 HKDF 输入，双方各自算 HMAC 证明。数据接口要求已验证会话，中继目标过 `lan_guard` 白名单，JSON 请求体上限 4 MB、单个密封分块上限 64 MB。

**没给什么（不要依赖）**：

- **6 位 PIN 不是 PAKE。** 取值空间 90 万个（`100000`–`999999`，约 20 比特）。它作为 HKDF 输入参与派生，因此能在路径上抓到完整握手的攻击者可以离线穷举那 90 万个候选；在线穷举被限流压制。结论：防得住误连和被动窃听，防不住蹲守同一来源的定向攻击，也防不住已知 PIN 的中间人。
- **拿到同一个 PIN 的 evil-twin hub 检测不出来。** 双向证明只说明"对方知道当前 PIN"，PIN 之外没有身份锚点，指纹要用户自己肉眼比对。
- **桌面端自身到 hub 之间是明文 HTTP。** 本机回环不加密。同一台机器上的不受信进程能看到这段流量。
- **Web 门户只有走 HTTPS 才加密。** 浏览器只在安全上下文里暴露 WebCrypto；`http://` 打开时页面直接拒绝配对（不是降级成明文）。手机只提供 HTTP，所以**手机上的网页门户无法完成配对**，它只是个提示页。
- **限流是抑制，不是阻断。** 每来源 8 次失败封 5 分钟，换地址即可绕过——这是局域网威胁模型下的取舍。
- **没有持久信任。** 每次接入都要重新读码，会话密钥只存内存。
- **自签名证书只提供传输加密，不提供身份认证**（身份靠 PIN + 握手 HMAC），所以首次访问的证书警告是预期行为，但别把它当成"已经确认了对端是谁"。

**因此**：不要在公共 Wi-Fi 或你不控制的网络上用；要跨不可信链路就自己叠 VPN，或者等中继 / 持久信任落地。

上报漏洞走 GitHub 的 Private security vulnerability reporting，不要开公开 Issue。

---

## 仓库结构

```
DocumentX/
├── protocol.json                     # 跨端常量的唯一来源（协议标记、模板、宽度、限额、端口、请求头名）
├── apps/
│   ├── desktop/
│   │   ├── desktop_hub/
│   │   │   ├── server.js             # HTTP/HTTPS + UDP + 全部 API（仅 Node 标准库）
│   │   │   ├── crypto_protocol.js    # ECDH / HKDF / AES-256-GCM / HMAC 证明
│   │   │   ├── lan_guard.js          # 中继目标校验（SSRF 面）
│   │   │   ├── tls_selfsigned.js     # 纯 Node 自签名证书（含 DER 编码）
│   │   │   ├── protocol.gen.js       # 由 protocol.json 生成，别手改
│   │   │   ├── tls/                  # 自动生成的证书与私钥（gitignore）
│   │   │   ├── temp_transfers/       # 传输中的 .part（gitignore）
│   │   │   └── public/
│   │   │       ├── index.html        # 桌面 UI
│   │   │       ├── app.js            # 队列、分块、压缩、配对弹窗
│   │   │       ├── portal.html       # Web 门户（自包含，含浏览器加密代码）
│   │   │       └── style.css         # 三套主题
│   │   ├── tauri-app/                # Tauri 2 外壳：托盘 + 3 个全局快捷键
│   │   └── installer/                # Windows 自解压安装包构建（C# 向导 + Node 打包脚本）
│   └── android/
│       ├── com/                      # Android 工程（Kotlin + ViewBinding，minSdk 26 / targetSdk 34）
│       │   ├── app/src/main/assets/portal.html   # 必须与桌面端那份逐字节一致
│       │   └── app/src/main/java/com/safedrop/mobile/
│       │       ├── core/crypto/      # CryptoEngine.kt + 生成的 ProtocolConst.kt
│       │       ├── core/network/     # 发现、HTTP 客户端、组播锁
│       │       ├── service/          # 前台保活服务、手机侧接收服务
│       │       └── ui/               # 雷达、扫码、分享入口、传输面板
│       └── README.md                 # Android 端专文
├── scripts/
│   ├── protocol.js                   # gen / check：把 protocol.json 灌进 Node 与 Kotlin 两份实现
│   ├── gen-vectors.js                # 生成 / 校验 test/vectors/e2e-v2.json
│   └── version-check.js              # 版本号一致性
├── test/
│   ├── crypto-protocol.test.js       # node:test
│   ├── lan-guard.test.js             # node:test
│   ├── vectors/e2e-v2.json           # 跨端金标向量（Node 与 Kotlin 共读一份）
│   └── e2e/                          # 起真实 hub 进程的端到端套件 + 三个界面回归套件
├── docs/                             # 快捷键说明；archive/ 是历史优化报告，不代表现状
├── SECURITY.md
├── CONTRIBUTING.md
└── CHANGELOG.md
```

`.gitignore` 排掉了 `*.exe` / `*.apk` / `*.msi` / `*.dll`，安装包只挂在 Release 附件上；仓库里唯一入库的二进制是 Gradle wrapper jar 和图标。

**技术栈**：桌面后端 Node.js 标准库（`http`/`https`/`dgram`/`crypto`/`zlib`/`os`/`fs`/`path`/`child_process`，无 `node_modules`）；界面无框架、无外链字体（离线也能正常显示），前端唯一的外来代码是入库的 `public/qrcode.js`（Kazuhiko Arase 的 QR Code Generator，MIT，只有桌面 UI 引用它）；外壳 Tauri 2 + `tauri-plugin-global-shortcut`；Android 为 Kotlin + ViewBinding（**不是** Jetpack Compose）、OkHttp3、CameraX、BouncyCastle、MediaStore 分区存储。发现协议是自定义 UDP beacon，不是 mDNS。

---

## 测试

以下数字都是在 2026-09-19 于 Windows / Node 24.19.0 上跑出来的，不是从旧文档抄的。全部命令从仓库根目录执行。

### CI 会跑的（失败即红）

| 命令 | 覆盖 | 实测 |
|:---|:---|:---|
| `node scripts/protocol.js check` | 四端实现、两份 portal 副本、README 里的协议标记是否还是同一份协议 | 通过：`safedrop-e2e-v2`，5 个模板，8 个文件一致 |
| `node scripts/gen-vectors.js --check` | 金标向量能被当前代码逐字节复现 | 通过 |
| `node --test test/*.test.js` | 加密层 + 中继目标校验（单元，无端口无设备） | **23** 项通过 / 0 失败 |
| `node test/e2e/encryption_e2e.js` | 起真实 hub：配对、加解密、丢块 / 重放 / 提前定稿 / 篡改拒绝、凭据泄漏、限流、手机↔手机中继、HTTPS 门户、直接执行 `portal.html` 里的浏览器加密代码（11 个小节） | **60** 项通过 / 0 失败 |
| `node test/e2e/qr_and_security.js` | 二维码载荷格式、PIN 宽限、SSRF 目标拒绝、路径处理 | **32** 项通过 / 0 失败 |
| `node test/e2e/multi_device_and_portal.js` | 多设备共存、门户页面与上传下载闭环 | **14** 项通过 / 0 失败 |
| `node scripts/version-check.js` | 11 个文件里的版本字符串是否都等于 hub 的 `APP_VERSION` | **19/19** |
| `gradle testDebugUnitTest`（Android job） | Kotlin 加密实现读同一份向量，含 5 个正例分块与 7 个必须被拒的反例 | **14** 项通过 / 0 失败 |
| `node test/e2e/{theme_and_device_display,new_chat_and_layout_features,scrollbar_and_copy_features}.js` | 界面设计契约：主题 token 对称、禁止远程字体、禁止渐变与发光、色值债务棘轮、滚动条可读性 | **27 / 20 / 17** 项通过，2 项按原因跳过 |

合计：Node 侧 193 项断言 + 契约 / 版本两条检查，Kotlin 侧 14 项。

**CI 覆盖不到的部分**：Android job 没有模拟器，所以手机**接收端**的定位写入与完成判定、CORS 逐源回显、配对限流只有"能编译"和"加密实现一致"两层保证，运行时行为完全未测；同理，前台服务、扫码、分区存储写入也只能靠手工验证。想测这些需要接真机跑 `connectedAndroidTest`，仓库里目前没有 `androidTest` 源码目录。

**中继一节需要一个"不是 hub 自己"的地址**：Section 8 把密封块中继到一个与 hub 本机地址不同的目标上，单网卡机器上没有这样的地址。CI 因此在跑该套件前给 runner 加一个 `192.168.250.1/lo`（`ip -4 addr add`），让中继路径真的被执行；本地若只有一个地址，这条会打印 `[skip]` 并计入 Skipped——**跳过不是通过**，汇总行会显式显示跳了几条。

### 界面契约套件（现已纳入 CI）

`theme_and_device_display`（27 项）、`new_chat_and_layout_features`（20 项 + 1 skip）、`scrollbar_and_copy_features`（17 项 + 1 skip）。它们原先是对着旧样式钉死十六进制字面量的快照，界面重做后全部失效；现在改成断言**设计契约本身**：

- 三套主题必须定义同一组 token，任何一套缺项即红；UI 能选的主题必须与 CSS 里真的画出来的主题一一对应。
- **任何界面文件都不许通过网络取字体或其它资源**（重做前 `index.html` 拉 Plus Jakarta Sans、`portal.html` 拉 Outfit，纯局域网环境下字体根本加载不出来，还让一个免安装页面为渲染文字去连外网）。
- 主按钮不许有渐变或彩色发光；token 块之外出现色值即红（色值债务清单只能变小不能变大：清单内容发生变化本身就会让检查失败，无论变多还是变少）。
- 滚动条滑块必须与自己的轨道看得见差异、悬停必须有反馈；文本可选中而界面外壳不可选中。

这两套的 skip 是诚实的：APK 那条要求一个不入库的本地产物，消息中继那条要求 8899 上有 hub 在应答——都打印原因，绝不记为通过。

上一轮重构遗留的同类路径问题（`build_installer.js` / `test_installer_extraction.js` 的 `ROOT_DIR` 少一层、`apps/android/test_e2e_verification.js` 的 `require` 少一层）也已修正。

上面这些是本仓库当前已知的账，列在这里而不是藏起来。修它们请直接改代码，不要放宽断言。

---

## 下载

[Releases](https://github.com/Paper-Yuan/DocumentX/releases/tag/v1.3.0) 上的 v1.3.0 附件：

| 产物 | 说明 |
|:---|:---|
| `SafeDrop-Setup-1.3.0.exe` | Windows 单文件自解压安装包，内置便携 Node 运行时（35,717,632 字节，约 34 MB） |
| `SafeDrop-Android-1.3.0.apk` | Android 接收端，需允许"安装未知来源应用"（29,861,728 字节，约 28 MB） |

**已知限制，请逐条当作事实看待**：

1. **这两个包说的是 `safedrop-e2e-v1`，连不上当前 `main`。** 桌面端会拒未握手的上传（401）和"已配对但不加密"的上传（400），明文上传只对本机回环开放；两端同规则，宁可失败也不静默退回明文或旧帧格式。要用当前协议，从源码跑。
2. **校验值不可靠。** Release 页上确实挂着一份 184 字节的 `SHA256SUMS.txt`，但仓库里没有任何发布流水线（`.github/workflows/` 只有 `ci.yml`），也没有一行脚本生成它；它的时间戳早于两个安装包上传 / 替换的时间。所以：**不要把它当成这两个包的可信摘要**，自动生成 + 自动上传是待办项。
3. **APK 用调试密钥签名**（`CN=Android Debug`）。自用和内部分发够了，不是上架签名；同一台机器上后续版本必须用同一把钥匙签才能覆盖安装。release 构建会读 `apps/android/com/keystore.properties`（已 gitignore）或 `SAFEDROP_KEYSTORE_*` 环境变量，没配就回退 debug 签名并明确不可分发。仓库不含任何签名密钥。

**运行要求**

| 平台 | 要求 |
|:---|:---|
| Windows | Windows 10 1809+ / 11，64 位 |
| Android | Android 8.0（API 26）及以上，与桌面端同一局域网 |
| Web 门户 | 支持 WebCrypto 的现代浏览器，且必须以 `https://` 打开 |
| macOS / Linux | Tauri 代码跨平台，但未实机验证，不保证可用 |

---

## 打包

```bash
# Android
cd apps/android/com
./gradlew.bat assembleDebug          # 已实测：--offline 也能跑通
./gradlew.bat assembleRelease        # app/build/outputs/apk/release/app-release.apk
cd .. && node pack_apk.js            # 归档为 apps/android/SafeDrop-release.apk

# Windows 安装包（当前布局下有路径 bug，见「测试」一节）
node apps/desktop/installer/build_installer.js

# Tauri 外壳（需要 Rust + MSVC；CI 不构建，本次未验证）
cd apps/desktop/tauri-app && npm install && npx tauri build
```

安装包流程是"发现模块 → 校验依赖 → 压缩载荷 → 编译安装器"，缺模块会让**构建**失败而不是让用户装完启动即 `MODULE_NOT_FOUND`；细节见 [installer/README.md](./apps/desktop/installer/README.md)。

从 Tauri 外壳启动时前端由后端服务提供，`connect-src http:` 已在 CSP 里放行；自行收紧 `csp` 时记得留 `/api/...`，否则界面会停在加载态。

---

## 参与

环境怎么跑、提 PR 前必须过的两件事（契约检查 + 测试套件）、改 `protocol.json` 为什么等于改线格式、以及那份"门户必须自包含且逐字节一致"的规则，都写在 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可与命名

MIT，见 [LICENSE](./LICENSE)。

- **SafeDrop** — 对外品牌名
- **DocumentX** — 仓库名与 GitHub 地址里的代号

两者指同一个项目。
