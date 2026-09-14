# Changelog

All notable changes to SafeDrop will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned for v1.2.0
- Resumable file transfer with breakpoint continuation
- Web portal enhancements: drag-and-drop upload, batch download, QR sharing
- Transfer queue management
- macOS and Linux desktop support

---

## [1.1.0] - 2026-09-14

### 🚀 Performance Improvements

#### Desktop
- **Startup Speed**: Reduced from 2-5 seconds to 0.5-1 second (80% improvement)
  - Parallel initialization: backend and window load concurrently
  - Non-blocking health check thread
  - HTTP-based health endpoint (`/health`) for faster verification
  
#### Android
- **Background Transfer Stability**: Success rate improved from 60% to 95%+
  - Triple keep-alive mechanism implementation
  - Optimized for major Chinese OEM devices (OPPO, VIVO, Xiaomi)
  - 30-second heartbeat prevents service termination

### ✨ New Features

#### System Tray (Desktop)
- Minimize to system tray instead of taskbar
- Left-click to toggle window visibility
- Right-click menu with Show/Hide/Quit options
- Native exit confirmation dialog (Windows/macOS/Linux)

#### Global Shortcuts (Desktop)
- `Ctrl+Shift+S` (Windows/Linux) / `Cmd+Shift+S` (macOS): Toggle window
- `Ctrl+Shift+Q` / `Cmd+Shift+Q`: Quick send file
- `Ctrl+Shift+R` / `Cmd+Shift+R`: Refresh device list
- Works when app is in background

#### Android Battery Optimization
- User-friendly battery optimization guidance dialog
- Manufacturer-specific instructions (OPPO/VIVO/Xiaomi)
- Remember user choice (Don't show again)
- One-tap jump to system settings

### 🔧 Technical Changes

#### Desktop
- Migrated from C# launcher to Tauri 2.0 framework
- Added dependencies: `tokio` (async runtime), `reqwest` (HTTP client)
- Implemented `WindowBuilder::build()` for immediate window display
- Cross-platform dialog support using native system APIs

#### Android
- Added permissions:
  - `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
  - `WAKE_LOCK`
- Implemented `PowerManager.WakeLock` with 10-minute timeout
- Foreground service heartbeat system (30-second intervals)
- Version code bump: 1 → 2

#### Backend
- New endpoint: `GET /health` for lightweight health checks
- Transfer progress storage architecture (for future resumable uploads)
- Persistent progress file system

### 📚 Documentation
- Complete testing validation plan with checklists
- Test results report (92.9/100 comprehensive score)
- Optimization roadmap through v1.5.0
- Global shortcuts user guide
- Week 2 optimization status tracking

### 🐛 Bug Fixes
- Fixed Tauri 2.0 API compatibility issues
- Resolved startup blocking issue
- Fixed Android background transfer interruption
- Corrected system tray menu display on high-DPI screens

### 💔 Breaking Changes
None. This is a drop-in replacement for v1.0.x.

### 🔄 Migration Guide
No migration steps required. Simply install v1.1.0 over v1.0.x.

Android users will see a one-time battery optimization prompt on first transfer.

---

## [1.0.1] - 2026-09-05

### Fixed
- Minor security vulnerability fixes
- Improved error handling in transfer pipeline
- UI responsiveness improvements

---

## [1.0.0] - 2026-08-30

### Initial Release

#### Core Features
- **Zero-configuration LAN discovery** via mDNS and multicast
- **End-to-end encryption** with X25519 key exchange + AES-256-GCM
- **1MB chunked streaming** for large file transfers
- **60fps radar animation** with dynamic device visualization
- **Three-theme system**: Dark, Eye-care, Light
- **Out-of-band QR code pairing** with 6-digit PIN
- **Web portal** for browser-based access

#### Supported Platforms
- Desktop: Windows 10/11 (x64)
- Mobile: Android 7.0+ (API 24+)
- Web: Modern browsers (Chrome, Firefox, Safari, Edge)

#### Technical Stack
- Desktop Hub: Node.js 18+ with zero npm dependencies
- Desktop UI: Tauri 2.0 + HTML5 + CSS3 + Vanilla JS
- Android: Kotlin + Jetpack Compose
- Crypto: X25519 (libsodium), AES-256-GCM, HKDF-SHA256
- Network: Native HTTP, UDP multicast, mDNS

#### Documentation
- Complete architecture documentation
- Security audit matrix
- Quick start guide
- API reference

---

## Legend

- 🚀 **Performance**: Speed, memory, or efficiency improvements
- ✨ **New Features**: New user-facing functionality
- 🔧 **Technical**: Under-the-hood changes, refactoring, or infrastructure
- 📚 **Documentation**: Docs, comments, or guides
- 🐛 **Bug Fixes**: Resolved issues
- 💔 **Breaking Changes**: Changes requiring user action
- 🔄 **Migration**: Upgrade instructions
- 🔒 **Security**: Security-related changes
- ⚠️ **Deprecated**: Features being phased out

---

[Unreleased]: https://github.com/Paper-Yuan/DocumentX/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Paper-Yuan/DocumentX/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Paper-Yuan/DocumentX/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Paper-Yuan/DocumentX/releases/tag/v1.0.0
