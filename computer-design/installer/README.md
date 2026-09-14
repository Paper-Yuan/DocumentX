# SafeDrop 电脑端自解压安装包构建模块 (Installer Packaging Suite)

本目录独立存放用于打包 Windows 电脑端单文件自解压安装包（`SafeDrop-Setup.exe`）的全部源代码、脚本和测试工具。

---

## 📁 目录结构

| 文件 | 类型 | 说明 |
| :--- | :--- | :--- |
| [Installer.cs](file:///e:/Workbox/DocumentX/computer-design/installer/Installer.cs) | C# 源代码 | 基于 WinForms 的 5 步向导式安装程序源码（欢迎页、路径选择、快捷方式配置、进度解压、完成启动） |
| [Uninstaller.cs](file:///e:/Workbox/DocumentX/computer-design/installer/Uninstaller.cs) | C# 源代码 | 干净彻底的系统标准卸载程序源码（关闭运行进程、清理桌面/开始菜单快捷方式、删除文件、注销注册表） |
| [build_installer.js](file:///e:/Workbox/DocumentX/computer-design/installer/build_installer.js) | Node.js 构建脚本 | 自动化打包流水线：编译启动器/卸载器、打包便携式 Node.js + 服务端资源到 `payload.zip`、嵌入资源编译出单文件 `SafeDrop-Setup.exe` |
| [payload_check.js](file:///e:/Workbox/DocumentX/computer-design/installer/payload_check.js) | Node.js 模块 | 载荷完整性校验：发现后端全部模块并解析其 `require()` 依赖，缺一即构建失败 |
| [test_installer_extraction.js](file:///e:/Workbox/DocumentX/computer-design/installer/test_installer_extraction.js) | 测试验证脚本 | 针对安装包 PE 文件头、载荷解压有效性、内嵌 Node.js 版本及向导逻辑的自动化验证测试集 |
| [test_payload_check.js](file:///e:/Workbox/DocumentX/computer-design/installer/test_payload_check.js) | 测试验证脚本 | 载荷依赖解析规则的单元测试（含"缺少模块会被发现"的回归用例） |

---

## 🚀 安装包构建方法

在项目根目录下或本目录执行以下命令即可一键构建安装包：

```bash
node computer-design/installer/build_installer.js
```

### 构建输出：
- 独立分发目录：`e:\Workbox\DocumentX\set\SafeDrop-Setup.exe`
- 大小约为：**34 MB**（内含便携式 Node.js 运行时、启动器、卸载器及全部前端资产，用户电脑无需预装任何运行环境）。

### 打包规则

1. **后端模块按目录自动收集**：打包 `desktop_hub/*.js` 全量，而不是手工维护文件清单。新增模块（如 `crypto_protocol.js`、`lan_guard.js`、`tls_selfsigned.js`）曾因漏列而缺失，安装后启动即 `MODULE_NOT_FOUND`。
2. **构建前校验依赖**：解析每个模块的相对 `require()`，任一目标缺失即中止构建（第 3.5 步）。这类问题只在用户安装后才会暴露，必须在打包阶段拦下。
3. **不携带开发机配置**：安装包内写入空的 `config.json`。仓库中的副本记录着维护者本机的保存路径，不应装到别人机器上；未配置时服务端回退到 `<用户目录>/Downloads/SafeDrop`。
4. **缺少 node.exe 即失败**：自带运行时是"免安装"的前提，取不到就直接报错，不生成残缺安装包。

---

## 🧪 验证与测试

执行自动化测试套件：

```bash
node computer-design/installer/test_installer_extraction.js   # 安装包产物校验
node computer-design/installer/test_payload_check.js          # 载荷依赖规则单测
```

`test_installer_extraction.js` 包含：
1. `SafeDrop-Setup.exe` 文件存在性与体积完整性检查（> 30MB）
2. PE Executable MZ 文件头格式验证
3. 内置 `payload.zip` 提取与内嵌便携式 Node.js 版本检查
4. `Installer.cs` 五步向导逻辑与系统注册表项检查
5. `Uninstaller.cs` 卸载清除逻辑完备性检查

> 建议打包后补一次冒烟验证：把 `payload.zip` 解到临时目录，用其中的 `node.exe` 运行 `server.js`，确认能监听端口并响应 `/health`。这能覆盖"模块齐全但启动仍然失败"的情况。
