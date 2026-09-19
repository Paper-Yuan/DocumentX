# SafeDrop 全局快捷键实现指南

## 概述

SafeDrop Tauri 桌面端已成功集成全局快捷键支持，提升操作效率。即使应用在后台运行，快捷键也能正常响应。

## 已实现的快捷键

### 系统级快捷键（全局生效）

| 快捷键 | Windows/Linux | macOS | 功能 |
|--------|---------------|-------|------|
| 显示/隐藏窗口 | `Ctrl+Shift+S` | `Cmd+Shift+S` | 切换主窗口显示状态 |
| 快速发送文件 | `Ctrl+Shift+Q` | `Cmd+Shift+Q` | 打开文件选择器快速发送 |
| 刷新设备列表 | `Ctrl+Shift+R` | `Cmd+Shift+R` | 刷新可用设备列表 |

### 应用内快捷键

| 快捷键 | 功能 | 作用范围 |
|--------|------|----------|
| `Escape` | 关闭对话框/模态窗 | 前端实现 |

## 技术实现

### 后端实现 (Rust/Tauri)

#### 依赖配置

在 `src-tauri/Cargo.toml` 中添加：

```toml
[dependencies]
tauri-plugin-global-shortcut = "2.0"
```

#### 核心实现文件

**文件路径**: `apps\desktop\tauri-app\src-tauri\src\main.rs`

主要功能：
- 注册全局快捷键
- 处理快捷键事件
- 跨平台修饰键适配（Command/Ctrl）
- 快捷键冲突检测和降级处理

#### 关键函数

1. **`register_global_shortcuts()`**: 注册所有全局快捷键
   - 自动检测操作系统并适配修饰键
   - 提供错误处理和冲突检测
   - 打印注册状态日志

2. **`handle_shortcut_event()`**: 分发快捷键事件到具体处理函数
   - 解析快捷键组合
   - 调用对应的处理函数

3. **`toggle_main_window()`**: 切换窗口显示状态
   - 检测当前窗口可见性
   - 显示/隐藏窗口
   - 自动聚焦窗口

4. **`trigger_quick_send()`**: 触发快速发送
   - 确保窗口可见并聚焦
   - 发送事件到前端

5. **`trigger_refresh_devices()`**: 触发设备刷新
   - 发送事件到前端处理

### 前端实现 (JavaScript)

#### 核心文件

**文件路径**: `apps\desktop\desktop_hub\public\global-shortcuts.js`

功能：
- 监听 Tauri 发送的快捷键事件
- 处理 Escape 键关闭对话框
- 提供自定义事件机制供应用集成

#### 集成方法

在您的 HTML 文件中引入：

```html
<script src="/global-shortcuts.js"></script>
```

或在主 JavaScript 文件中：

```javascript
import './global-shortcuts.js';
```

#### 自定义事件监听

如果您需要在应用中响应快捷键事件：

```javascript
// 监听快速发送事件
document.addEventListener('quick-send-triggered', (event) => {
    console.log('Quick send triggered from:', event.detail.source);
    // 您的自定义逻辑
});

// 监听设备刷新事件
document.addEventListener('refresh-devices-triggered', (event) => {
    console.log('Refresh devices triggered from:', event.detail.source);
    // 您的自定义逻辑
});

// 监听 Escape 键事件
document.addEventListener('escape-key-pressed', (event) => {
    console.log('Escape pressed at:', event.detail.timestamp);
    // 您的自定义逻辑
});
```

## 构建和测试

### 构建命令

```bash
cd apps\desktop\tauri-app\src-tauri
cargo build --release
```

### 开发模式测试

```bash
cd apps\desktop\tauri-app\src-tauri
cargo tauri dev
```

### 测试清单

- [ ] Windows: 测试所有 `Ctrl+Shift+[S/Q/R]` 快捷键
- [ ] macOS: 测试所有 `Cmd+Shift+[S/Q/R]` 快捷键
- [ ] Linux: 测试所有 `Ctrl+Shift+[S/Q/R]` 快捷键
- [ ] 后台运行时快捷键响应
- [ ] 窗口最小化时快捷键响应
- [ ] Escape 键关闭对话框
- [ ] 快捷键冲突检测（查看控制台日志）

## 跨平台兼容性

### 修饰键映射

| 平台 | 主修饰键 | 实现方式 |
|------|---------|----------|
| Windows | `Ctrl` | `Ctrl+Shift+Key` |
| Linux | `Ctrl` | `Ctrl+Shift+Key` |
| macOS | `Command` | `CommandOrControl+Shift+Key` |

### 快捷键冲突处理

如果快捷键与系统或其他应用冲突：

1. **检查日志**: 应用启动时会在控制台输出注册结果
   ```
   ✓ Global shortcut registered: Ctrl+Shift+S - Show/Hide main window
   ✗ Failed to register Ctrl+Shift+Q: Quick send file - Already registered
   ```

2. **优雅降级**: 失败的快捷键不会影响应用运行，只是该快捷键不可用

3. **替代方案**: 用户可以通过系统托盘菜单或应用内按钮使用相同功能

### 已知限制

- **Wayland on Linux**: 部分 Linux 桌面环境（使用 Wayland）可能不完全支持全局快捷键
- **安全限制**: 某些操作系统在安全模式或特定场景下可能限制全局快捷键
- **快捷键数量**: 建议不超过 5 个全局快捷键，避免冲突

## 故障排查

### 快捷键不响应

1. **检查注册日志**:
   ```bash
   # 运行应用并查看控制台输出
   cargo tauri dev
   ```

2. **检查快捷键冲突**:
   - Windows: 使用 Process Explorer 查看全局热键
   - macOS: 系统偏好设置 > 键盘 > 快捷键
   - Linux: 查看桌面环境快捷键设置

3. **权限问题**:
   - Windows: 以管理员身份运行
   - macOS: 授予辅助功能权限（系统偏好设置 > 安全性与隐私 > 辅助功能）
   - Linux: 检查 X11/Wayland 权限

### 控制台错误信息

```
Failed to register Ctrl+Shift+S: ...
```
表示该快捷键已被系统或其他应用占用，尝试更改快捷键组合。

## 自定义快捷键

如果您需要修改快捷键组合，编辑 `main.rs` 中的 `register_global_shortcuts()` 函数：

```rust
let shortcuts = vec![
    (
        "your_action_id",
        if cfg!(target_os = "macos") {
            "CommandOrControl+Shift+Y"  // 您的快捷键
        } else {
            "Ctrl+Shift+Y"  // 您的快捷键
        },
        "Your action description",
    ),
];
```

然后在 `handle_shortcut_event()` 中添加对应的处理逻辑。

## 性能考虑

- 全局快捷键监听是轻量级的，不会影响系统性能
- 事件处理是异步的，不会阻塞主线程
- 建议快捷键响应函数保持简单，避免耗时操作

## 安全性

- 快捷键仅在应用运行时生效
- 应用退出后自动取消注册
- 不会截获密码输入或敏感操作
- 符合各平台安全最佳实践

## 更新日志

### Version 1.0.1
- ✅ 添加全局快捷键支持
- ✅ 实现跨平台修饰键适配
- ✅ 添加快捷键冲突检测
- ✅ 实现前端事件监听机制
- ✅ 添加 Escape 键关闭对话框

## 许可证

MIT License - 与 SafeDrop 项目保持一致

## 支持

如有问题或建议，请提交 Issue 或 Pull Request。
