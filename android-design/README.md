# SafeDrop Android 端

Android 客户端，作为桌面端 hub 的接入方：发现电脑、扫码或用 PIN 配对、投送文件、接收文件，并在后台保持传输存活。

---

## 一、 交付产物

1. **安装包**：[`SafeDrop-release.apk`](file:///e:/Workbox/DocumentX/android-design/SafeDrop-release.apk)（Android 8.0 ~ 14+）。注意：该文件是较早的构建产物，**不含最新的传输加密**，需要重新构建后才具备加密能力。
2. **构建脚本**：[`build_apk.bat`](file:///e:/Workbox/DocumentX/android-design/build_apk.bat)。
3. **工程源码**：[`com/`](file:///e:/Workbox/DocumentX/android-design/com/)
   - 表现层：Material 3 布局、水波纹雷达 Canvas、CameraX 扫码
   - 系统适配层：MulticastLock 调度、前台保活服务、系统分享 Intent 接收
   - 密码学层：X25519 密钥协商、HKDF-SHA256、AES-256-GCM 分块加解密
   - 存储层：Android 10+ MediaStore 分区存储适配
4. **联调测试**：[`test_e2e_verification.js`](file:///e:/Workbox/DocumentX/android-design/test_e2e_verification.js)（需先在 8899 端口启动桌面端 hub）。

### 构建

```bash
cd com
gradlew.bat assembleDebug          # 输出 app/build/outputs/apk/debug/app-debug.apk
gradlew.bat testDebugUnitTest      # 运行密码学单元测试
```

---

## 二、 工程目录结构

```text
android-design/
├── build_apk.bat                   # 一键构建 APK
├── test_e2e_verification.js        # 与桌面端的全链路联调测试
├── README.md                       # 本文件
└── com/                            # Android 工程
    ├── build.gradle                # 根构建脚本
    ├── settings.gradle             # 模块拓扑
    ├── gradle.properties           # JVM 内存与 AndroidX 配置
    ├── gradlew.bat                 # Windows Gradle Wrapper
    └── app/
        ├── build.gradle            # 依赖 (Material 3, CameraX, BouncyCastle, OkHttp3)
        ├── proguard-rules.pro      # Release 混淆规则
        └── src/
            ├── main/
            │   ├── AndroidManifest.xml
            │   ├── assets/portal.html          # 内置 Web 门户（与桌面端同源）
            │   ├── java/com/safedrop/mobile/
            │   │   ├── SafeDropApp.kt          # Application (BouncyCastle 注入、通知渠道)
            │   │   ├── core/
            │   │   │   ├── crypto/CryptoEngine.kt      # X25519 / HKDF / AES-256-GCM
            │   │   │   ├── network/                    # 发现与 HTTP 客户端
            │   │   │   ├── cache/DeviceNameCache.kt    # 指纹 → 名称持久化
            │   │   │   └── storage/ScopedStorageHelper.kt
            │   │   ├── service/
            │   │   │   ├── TransferForegroundService.kt # 前台保活 + 进度通知
            │   │   │   └── MobileTransferServer.kt      # 手机端接收服务
            │   │   └── ui/
            │   │       ├── MainActivity.kt
            │   │       ├── radar/RadarView.kt
            │   │       ├── scanner/QrScannerActivity.kt
            │   │       ├── share/ShareReceiverActivity.kt
            │   │       └── transfer/TransferSheetDialog.kt
            │   └── res/                        # 布局、菜单、多语言资源
            └── test/java/com/safedrop/mobile/
                └── CryptoEngineTest.kt         # 密码学单元测试
```

---

## 三、 传输加密

与桌面端 [`crypto_protocol.js`](file:///e:/Workbox/DocumentX/computer-design/desktop_hub/crypto_protocol.js) 逐字段对齐，二者必须保持一致才能互通。

| 环节 | 实现 |
|:---|:---|
| 密钥协商 | 每次连接生成临时 X25519 密钥对（ECDH），具备前向保密 |
| 会话密钥 | HKDF-SHA256；salt = `SHA-256("safedrop-e2e-v1\|salt\|" + sessionId)`，info = `"safedrop-e2e-v1\|key\|" + 配对凭据` |
| 配对凭据 | 6 位 PIN 或二维码 token，**只在本机作为 HKDF 输入**，通过 HMAC 证明双方派生一致，不上网 |
| 分块封装 | `nonce(12) \|\| ciphertext \|\| tag(16)`，nonce 由 `SecureRandom` 每次生成 |
| 完整性 | 以 task id 与分块序号作为 GCM AAD，因此重排或跨文件拼接都会导致验签失败 |
| 手机间传输 | 发送方与目标手机直接协商会话，桌面 hub 仅转发密文，不持有该密钥 |

**关于手机间传输**：目标为另一台手机时，hub 没有该手机的密钥，因此发送方会自行与目标完成握手（复用扫码/PIN 配对得到的凭据），再让 hub 转发已封装的分块。接收端用它与发送方协商出的密钥解密。这样即便中经桌面端，文件内容对 hub 仍不可见。

**关于 nonce**：早期实现由分块序号推导 nonce，同一会话内传第二个文件时会复用 nonce，进而泄露 GCM 密钥流。现已改为随机生成，并由 `testNonceIsRandomPerChunk` 锁定该行为。

---

## 四、 关键实现细节

### 1. MulticastLock 生命周期调度

Android 为省电会在 Wi-Fi 驱动层过滤 UDP 组播/广播，导致手机收不到桌面端的 beacon。`MulticastLockHelper.kt` 封装 `WifiManager.createMulticastLock()`，进入雷达页时加锁、退到后台或息屏时释放，避免持续占用射频导致发热与耗电。

### 2. CameraX 扫码与带外配对

针对禁止设备间广播的网络（公共 WiFi / 校园网 / 企业网），用摄像头扫描桌面端二维码（`safedrop://pair?ip={IP}&port={Port}&fp={FP}&token={Token}&pin={PIN}`），解析出 IP 后直接单播握手，跳过广播环节。

### 3. Android 10+ 分区存储适配

图片与视频经 `MediaStore.Images.Media.EXTERNAL_CONTENT_URI` 写入并即时建立相册索引；文档与压缩包经 `MediaStore.Downloads` 落到公共 `Download/SafeDrop/`。不使用 `MANAGE_EXTERNAL_STORAGE`。

### 4. 前台服务保活

声明 `android:foregroundServiceType="dataSync"`，配合 `PowerManager.WakeLock` 与心跳协程抵御 LMK 与厂商省电策略。通知栏实时显示文件名、进度与速度，并提供"取消传输"。

### 5. 系统分享集成

`AndroidManifest.xml` 注册 `ACTION_SEND` / `ACTION_SEND_MULTIPLE`，在相册或聊天软件中"分享到 SafeDrop"即可直接调起投送。

---

## 五、 跨端联调测试

```bash
# 终端 1：启动桌面端 hub
node computer-design/desktop_hub/server.js

# 终端 2：运行联调
node android-design/test_e2e_verification.js
```

覆盖内容：

| 测试大项 | 验证项目 |
|:---|:---|
| 密码安全层 | X25519 指纹生成、ECDH 共享秘密一致、HKDF 会话密钥一致 |
| | AES-256-GCM 1MB 分块封装（12B Nonce + 密文 + 16B AuthTag）与验签解密 |
| 存储沙箱层 | 路径穿越防御（`../../`、`..\..\Windows\System32\`）、非法字符替换 |
| 扫码解析层 | IP / Port / 指纹 / token / PIN 提取 |
| 真实 HTTP 联调 | `ping` 探活、`info` 探测、加密握手与双向证明、加密分块上传、反向下载校验、篡改分块被拒 |

桌面端侧另有 `test_encryption_e2e.js`（覆盖限流、未认证访问拒绝与 HTTPS 门户）与密码学单测；Android 侧单元测试见 `CryptoEngineTest.kt`。

---

## 六、 编码规范

1. **用户可见文案保留中文**：按钮、Toast、弹窗、通知与 `strings.xml` 使用简体中文。
2. **底层一律英文**：Kotlin / JS / XML 的注释、日志、异常信息全部英文，避免跨平台与跨代码页的字形损坏。
3. **强制 UTF-8**：`gradle.properties` 设 `-Dfile.encoding=UTF-8`，`build.gradle` 的 `compileOptions` 显式指定 `encoding 'UTF-8'`；构建脚本首行 `chcp 65001 >nul`。
4. **文件名编码**：`X-File-Name` 采用 `URLEncoder.encode(name, "UTF-8").replace("+", "%20")`；桌面端解码时先 `decodeURIComponent`，失败再按 latin1→utf8 回退；下载响应使用 RFC 5987/6266 的 `Content-Disposition`。

---

## 七、 网络自感知

1. **不再硬编码 `127.0.0.1`**：`NetworkHelper.kt` 通过 `WifiManager` 与 `NetworkInterface` 动态获取手机在 Wi-Fi 下的真实 IPv4。
2. **顶栏显示本机 IP**：启动或回到前台时展示 `本机: 192.168.10.x | 跨平台快传`。
3. **网段自动发现**：基于当前 IP 的 `/24` 网段并发探测 `8899` 端口，发现运行中的桌面 hub 后自动接入并获取其指纹。
4. **持久化记忆**：配对或发现到的 hub IP 写入 `SharedPreferences`（`connected_host`），下次启动直接沿用。
5. **设备列表交互**：`DeviceAdapter.kt` 将发现的电脑端呈现为卡片，点击连接或直接"投送"调起文件选择器。
