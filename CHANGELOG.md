# Changelog

All notable changes to SafeDrop will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🔐 Added — Encrypted transport

- **Payload encryption is now on the transfer path.** Each chunk is sealed with
  AES-256-GCM (`crypto_protocol.js`) and is verified before anything reaches disk; a
  modified tag or a chunk presented under the wrong index is rejected.
- **Phone-to-phone transfers are encrypted end to end.** The sender negotiates a session
  directly with the destination phone and the hub only forwards the sealed bytes, so the
  hub never holds, unwraps, or can read the file content. The destination session id is
  carried separately (`X-Target-Session-Id`) so the hub's own session with the sender is
  never leaked to the receiving device.
- **Sessions are tracked per peer**, not per app: pairing with one device no longer
  invalidates the session with another, and trust is derived from the live session store
  instead of a set that could claim trust after the session was gone.
- **Pairing secrets never leave the device.** The 6-digit PIN / one-time token is used as
  HKDF input and proven with an HMAC over the derived session key, replacing the previous
  scheme that compared the PIN server-side. Both sides now verify each other's proof.
- **Session enforcement.** Upload, download, vault listing, and device-name endpoints
  require a verified session; only loopback callers are exempt. The Android receiver
  enforces the same rule.
- **Pairing rate limiting** on both the hub and the Android receiver (8 failures from one
  source IP block further attempts).
- **Self-signed HTTPS portal** (`tls_selfsigned.js`). Browsers only expose WebCrypto in a
  secure context, so the portal is served over HTTPS with a certificate generated in pure
  Node (with IP SANs). Without it the portal refuses to pair rather than silently sending
  plaintext.
- **Fixed a real nonce-reuse defect.** The previous nonce was derived deterministically from
  the chunk index, so two files sent in one session would reuse a GCM nonce and leak
  keystream. Nonces are now drawn from `SecureRandom` / `crypto.randomBytes`.
- **Fixed `/health` returning HTML.** It sat outside the `/api/v1` prefix, fell through to
  the static handler, and answered 200 with `index.html`, which also fooled the Tauri
  startup probe.
- **Fixed pairing-secret disclosure.** `/api/v1/info` on both the hub and the Android
  receiver previously returned the PIN and token to any LAN caller, which made the pairing
  step decorative.

### Planned
- Resumable file transfer with breakpoint continuation
- Batch download (TAR.GZ) and QR share links with expiry
- macOS and Linux desktop validation on real hardware

---

## [1.2.0] - 2026-09-14

### ✨ Features

- **Transfer queue with concurrency**: up to 3 files transfer simultaneously, remaining
  tasks queue automatically; queue position is surfaced in the UI and a failure in one
  task does not affect the others
- **Fingerprint-based persistent device naming**: device identity derives from a SHA-256
  fingerprint of the public key, so custom names survive IP changes and reconnections
- **Optional gzip compression**: automatically applied to common compressible file types
  of 1 MB or larger, compressed client-side and decompressed server-side; toggleable in settings
- **Corporate Trust visual system**: Indigo/Violet theme with revised hierarchy

### ⚡ Performance

- **Desktop chunk size raised from 1 MB to 4 MB**, reducing per-chunk protocol overhead
  for large files (the Android client continues to use 1 MB chunks)
- Improved chunk processing and buffering

### 📱 Android

- Material 3 touch-target compliance (all interactive elements ≥ 48dp)
- Layout and theme adaptation improvements, better handling of rotation and varied screen sizes

### 📚 Documentation

- v1.2.0 optimization report and mobile optimization documentation added

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
