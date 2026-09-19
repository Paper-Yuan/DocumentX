# 参与 SafeDrop

这份文件只讲三件事：怎么把每一端跑起来、提 PR 之前必须过什么、以及这个项目里几条"违反就会让另一端静默坏掉"的硬规则。产品面与安全边界看 [README.md](./README.md) 和 [SECURITY.md](./SECURITY.md)，历史与破坏性变更看 [CHANGELOG.md](./CHANGELOG.md)。

## 环境

| 目标 | 需要 | 备注 |
|:---|:---|:---|
| 桌面后端 + 界面 + 全部 Node 测试 | Node.js（CI 用 24，README 里的实测数字同版本） | **不需要 `npm install`**，见下方"零依赖"规则 |
| Android 编译与单元测试 | JDK 17、Android SDK（API 34）、Gradle | 工程在 `apps/android/com`；`local.properties` 写 `sdk.dir=...`，该文件已 gitignore |
| Tauri 外壳 | Rust 工具链 + MSVC 构建环境 + `npm install`（只为拿 `@tauri-apps/cli`） | CI 完全不构建它 |
| Windows 安装包 | `.NET Framework 4` 的 `csc.exe`、PowerShell（zip） | 见 `apps/desktop/installer/README.md` |

## 把每一端跑起来

### 桌面 hub（日常开发就用这个）

```bash
node apps/desktop/desktop_hub/server.js
# 打开 http://127.0.0.1:8899
```

界面、二维码、6 位配对码都由这个进程直出，没有构建步骤。常用环境变量：

| 变量 | 作用 |
|:---|:---|
| `PORT` / `TLS_PORT` | 覆盖 `8899` / `8900`（HTTPS 端口默认 = HTTP 端口 + 1，见 `protocol.json` 的 `hubTlsPortDelta`） |
| `SAFEDROP_RELAY_TARGETS` | 逗号分隔的中继目标白名单，跨网段调试时要用 |
| `SAFEDROP_SESSION_MAX_MS` | 调试会话过期时缩短绝对上限 |

端口被占用会直接 `EADDRINUSE` 退出，不会静默换端口。

### Tauri 桌面外壳

```bash
cd apps/desktop/tauri-app
npm install            # 只有这一步需要 npm，装的是 CLI 本身
npx tauri dev          # beforeDevCommand 会自己起上面的 hub
```

`tauri.conf.json` 里 `devUrl` 指 `http://localhost:8899`、`frontendDist` 指 `../../desktop_hub/public`：外壳不打包前端，前端永远由 Node 服务提供。改这两个路径时要一起改 `apps/desktop/desktop_hub/` 的位置。

### Android 端

```bash
cd apps/android/com
./gradlew.bat testDebugUnitTest      # 14 项密码学单测，不需要手机或模拟器
./gradlew.bat assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew.bat installDebug           # 接真机
```

首次构建要联网拉依赖；依赖已在本地缓存时用 `--offline` 可以跑通（本文的数字就是这么来的）。仓库里只有 Windows 的 `gradlew.bat`，Linux/macOS 需自己用 `gradle`（CI 用的就是 `gradle/actions/setup-gradle`，版本对齐 `gradle-wrapper.properties` 里 pin 的 8.5）。

真机联调前记得：手机要和 hub 在同一网段，并且 hub 的 UDP `8890` 没被防火墙吃掉；用扫码就不依赖广播。

### Web 门户

不需要单独跑：`https://<局域网IP>:<TLS_PORT>/portal`，第一次接受自签名证书即可。证书由 `tls_selfsigned.js` 现生成，缓存在 `apps/desktop/desktop_hub/tls/`（已 gitignore，删掉会重新生成）。

### Windows 安装包

```bash
node apps/desktop/installer/build_installer.js   # 产物 set/SafeDrop-Setup.exe
```

**已知问题**：`build_installer.js` 与 `test_installer_extraction.js` 里的 `ROOT_DIR = path.resolve(__dirname, '..', '..')` 还停在重构前的目录深度上，现在会解析成 `apps/`，于是 `HUB_DIR` 指向不存在的 `apps/apps/desktop/desktop_hub`，产物也被算到 `apps/set/`。这类"目录搬家"的账在这里还没结。改它时把两个脚本一起修，然后跑 `node apps/desktop/installer/test_payload_check.js`（它管的是依赖解析规则，不管路径），再手工确认 `set/SafeDrop-Setup.exe` 真的落在仓库根目录下。

## 提 PR 之前必须过的两件事

第一件，契约：

```bash
node scripts/protocol.js check
```

第二件，测试套件——全部从仓库根目录执行，任何一条红就不要提：

```bash
node scripts/gen-vectors.js --check
node --test test/*.test.js                    # 23 项
node test/e2e/encryption_e2e.js               # 60 项
node test/e2e/qr_and_security.js              # 32 项
node test/e2e/multi_device_and_portal.js      # 14 项
node scripts/version-check.js                 # 19 项
cd apps/android/com && ./gradlew.bat testDebugUnitTest   # 14 项
```

这两件事就是 CI 的桌面 job 与 Android job 做的事（CI 另外还会对 `desktop_hub/*.js`、`public/*.js`、`scripts/*.js` 逐个跑 `node --check`），本地全绿再推。

**两个例外要知道**：

- `encryption_e2e.js` 的 Section 8（手机↔手机中继）要求机器上存在**第二个 on-link IPv4 地址**。只有一个地址的主机（典型是 GitHub runner）那一条必然失败，这是测试的环境假设，不是你改坏了代码——但也不要为了让它变绿就删断言，要写清楚原因。
- `test/e2e/` 里另外三个界面套件（`theme_and_device_display`、`scrollbar_and_copy_features`、`new_chat_and_layout_features`）**不在 CI 里，并且当前就是红的**（10/13、崩溃、33/36）。它们以源码字符串断言写成，界面一重做就过期。修它们请改成能验证行为的断言，而不是改期望字符串。

红项的标准处理是修代码或修测试，**不是放宽断言**。这个项目有过的每一次安全声明回退，都是"声明先于实现"造成的，见 `git log` 里 `docs: drop 'secure' framing…`、`feat(security): … drop thesis documents` 这类提交。

## `protocol.json`：改一个常量等于改线格式

`protocol.json` 是**两个以上实现必须同意的每一个值**的唯一来源：协议标记、密钥/nonce/tag 宽度、五个模板串、PIN 与 token 规格、宽限期、限流窗口、会话 TTL、分块上限、端口、每一个传输请求头名。

```bash
node scripts/protocol.js gen     # 重写 apps/desktop/desktop_hub/protocol.gen.js 与 ProtocolConst.kt
node scripts/protocol.js check   # 在内存里重算这两份，并断言浏览器侧的手写字面量
```

四份实现分别是：Node hub（`protocol.gen.js`）、Kotlin（`ProtocolConst.kt`）、桌面界面的 `app.js`、门户的 `portal.html`。前两份由 `gen` 生成，后两份**只能断言**——它们是从磁盘直读的普通脚本，塞一个生成的 `import` 进去就意味着多一份要被服务到的文件，而门户根本没有构建步骤。

改 `crypto` 或 `headers` 下的任何东西都会改变线格式，因此必须同时做三件事：

1. **把 `crypto.protocol` 往上 bump**（例如 `safedrop-e2e-v2` → `v3`）。这个标记不是标签：它被哈希进 KDF 的 salt 与 info，也进两个配对证明，所以版本不同的两端会派生出不同的密钥、在 `/handshake/verify` 互相拒绝对方的证明；每个客户端还会比对对端声明的标记，把这件事变成一句"版本不对"的错误而不是一句"配对码错了"。不 bump 的结果是一句谁也看不懂的失败。
2. **四份实现一起改**，跑 `node scripts/protocol.js check`。
3. **不要留双读窗口**。v1 → v2 时故意拒绝了同时接受两种格式：接受两者的那段时间，正是这次要关掉的攻击面。

只有**跨端**的值才进 `protocol.json`。单端调参（Android socket 读超时、hub 的设备过期时间、各家偏好的分块大小）留在原地——写一份没人读的东西不叫契约，叫文档表演。分块步长就是典型的单端调参：桌面 4 MB、Android 1 MB、门户 1 MB，`protocol.json` 记录它但**不**断言三者相等；步长本身已经在 AAD 里，所以不同不会破坏认证。

## `portal.html` 必须自包含，而且两份要逐字节一致

`apps/desktop/desktop_hub/public/portal.html` 与 `apps/android/com/app/src/main/assets/portal.html` 必须是同一份内容，`scripts/protocol.js check` 会直接比对文件字节。

原因：门户的设计前提是"任何设备零安装打开就能用"，所以它不能 import 模块、不能外链字体或 CDN（外链字体会让一个要在无出口网络的局域网上工作的页面被远端主机卡住），并且手机端的接收服务是**原样吐这份 asset**，没有构建期注入这一步。

因此改门户的正确顺序是：

1. 只改 `apps/desktop/desktop_hub/public/portal.html`；
2. 整文件复制到 `apps/android/com/app/src/main/assets/portal.html`（不要手工同步改动，两份差一个空格 check 就红）；
3. 跑 `node scripts/protocol.js check`。

门户里的加密代码（`SafeDropCrypto`）是被测试真跑的：`encryption_e2e.js` Section 10 会把它从 HTML 里抠出来、在 Node 里执行、并用 64 字节步长上传 21 个块。也就是说改这段代码，行为会被验证，不只是被 diff 看一眼。

## 后端零 npm 依赖（硬规则）

`apps/desktop/desktop_hub/*.js` 只允许 Node 标准库和同目录的相对模块。今天的实际情况：`http`、`https`、`dgram`、`crypto`、`zlib`、`os`、`fs`、`path`、`child_process`。这条规则有三个理由，缺一个就没有例外：

- **审计面**：一个 `node_modules` 都没有，读得完。
- **分发**：安装包直接把 `desktop_hub/*.js` 全量拷进载荷，并解析每个 `require()` 的目标是否都在；有第三方包就意味着打包逻辑要重写。
- **启动**：免安装、秒起，是"临时互传一下"这个用途的前提。

确实需要第三方能力时，先开 Issue 讨论，别直接在 PR 里加依赖。前端同理：`public/` 下不引入构建工具或外部资源。目前前端唯一入库的外来代码是 `public/qrcode.js`（Kazuhiko Arase 的 QR Code Generator，MIT，只在 `index.html` 里引用）；要再加一份这样的文件，得在 PR 里单独说明来源与许可，并且**不能**是网络请求。

## 代码风格与提交

- **注释、日志、异常信息一律英文**；用户可见文案（界面、Toast、通知、`strings.xml`）保留简体中文。底层英文是为了避免跨平台与跨代码页的字形损坏。
- **强制 UTF-8**：Android 侧 `gradle.properties` 有 `-Dfile.encoding=UTF-8`，`compileOptions` 显式 `encoding 'UTF-8'`。
- 桌面遵循现代 JS 惯例（后端是 CommonJS + 标准库），Android 遵循 Kotlin 官方风格与 Material 3 规范（注意是 **ViewBinding，不是 Jetpack Compose**）。
- Commit 遵循 [Conventional Commits](https://www.conventionalcommits.org/)；分支 `git checkout -b feature/your-feature`。
- 不提交二进制：`*.exe` / `*.apk` / `*.msi` / `*.dll` 已在 `.gitignore` 里，安装包只挂在 Release 附件。
- 文件名与网络编码：`X-File-Name` 用 `URLEncoder.encode(name, "UTF-8")` 并把 `+` 换成 `%20`；下载响应使用 RFC 5987/6266 的 `Content-Disposition`。

## 改动安全相关代码时

- 每个"防住了 X"的说法都要有一条能失败的断言，并写进 `test/`。断言的名字应当说出被攻击的那个动作（"改写总块数来提前定稿被拒"，而不是"完整性测试"）。
- 加新端点时必须明确它属于哪一类：需要已验证会话、只允许本机回环，还是公开。忘了加 `ensureAuthorized` 是这个项目真实发生过的事故（消息读写与 `DELETE /api/v1/devices/names/:fp` 都是这么漏的）。
- **不要顺手往 `SECURITY.md` 或 README 里加代码没有实现的保证。** 边界（PIN 不是 PAKE、同 PIN 的 evil-twin 不可检测、桌面到 hub 是明文回环 HTTP、门户只在 HTTPS 下加密、限流是抑制不是阻断）只有在你**真的**修掉了底层问题之后才能改措辞。
- 跨版本改动会同时影响已发布的 1.3.0（`safedrop-e2e-v1`）：任何兼容性描述都要在 README 与 `apps/android/README.md` 里说清楚，`protocol.js check` 会盯住这两份文档有没有提到当前生效的协议标记。

## 加测试

- 新行为要有能失败的断言。单元放 `test/*.test.js`（`node --test` 自动收集），要起真实进程的放 `test/e2e/`。
- 涉及跨端字节一致的东西放金标向量：`node scripts/gen-vectors.js` 从 Node 实现写出 `test/vectors/e2e-v2.json`（含 5 个正例分块与 7 个必须被拒的反例），Kotlin 侧 `CryptoEngineTest.kt` 读同一份文件。任何一端单方面改协议，另一侧一定红。
- 想在 Android 上测运行时行为需要真机（`connectedAndroidTest`）；仓库目前**没有** `androidTest` 源码目录，CI 也没有模拟器，所以手机接收端的定位写入、CORS、限流只有编译与加密单测两层保证。补这一层是欢迎的，但请说明它在你机器上真的跑过。

## 版本与发布

版本号的单一来源是 `apps/desktop/desktop_hub/server.js` 里的 `APP_VERSION`，`scripts/version-check.js` 会比对 11 个文件里的 19 处字符串（Tauri 配置、npm 清单、`Cargo.toml` / `Cargo.lock`、Android `versionName`/`versionCode`、三个 C# 组件与注册表显示版本、CHANGELOG 段落、README 下载物名称）。改版本时要一起动这些地方，否则 CI 直接红——这条规则就是为抓住曾经 `Cargo.toml` 停在 1.2.0、`Cargo.lock` 停在 1.0.1 而写的。

Android `versionCode` 每次发布必须递增（当前 5）。release 构建会读 `apps/android/com/keystore.properties`（gitignore）或 `SAFEDROP_KEYSTORE_*` 环境变量，没配就回退调试签名——调试签名的 APK 不可分发，README 与 `apps/android/README.md` 都这么写着，别改软。

仓库里目前**没有发布流水线**（`.github/workflows/` 只有 `ci.yml`），安装包与校验值都是手工挂上去的。想把这一步自动化，是个好 PR；在它存在之前，请不要在任何文档里说校验值由构建产出。

## 上报漏洞

不要用公开 Issue，走 GitHub 的 **Private security vulnerability reporting**（仓库页 Security → Report a vulnerability），细节见 [SECURITY.md](./SECURITY.md)。
