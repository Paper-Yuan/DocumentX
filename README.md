# SafeDrop - Zero-Config Secure File Transfer 🚀

<p align="center">
  <img src="./app.ico" alt="SafeDrop Logo" width="128" height="128" />
</p>

<p align="center">
  <strong>Cross-platform secure file transfer with end-to-end encryption</strong><br/>
  Zero configuration • Millisecond discovery • 95%+ success rate
</p>

<p align="center">
  <a href="https://github.com/Paper-Yuan/DocumentX/releases/latest">
    <img src="https://img.shields.io/github/v/release/Paper-Yuan/DocumentX?label=version" alt="Version">
  </a>
  <a href="https://github.com/Paper-Yuan/DocumentX/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/Paper-Yuan/DocumentX" alt="License">
  </a>
  <a href="https://github.com/Paper-Yuan/DocumentX/stargazers">
    <img src="https://img.shields.io/github/stars/Paper-Yuan/DocumentX?style=social" alt="Stars">
  </a>
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-download">Download</a> •
  <a href="#-security">Security</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-roadmap">Roadmap</a>
</p>

---

## 🌟 What is SafeDrop?

**SafeDrop** (internal codename: DocumentX) is a modern, secure file transfer system designed for local area networks (LAN). It combines **zero-configuration device discovery**, **end-to-end encryption**, and **cross-platform compatibility** to deliver a seamless file sharing experience.

### Key Highlights

- 🔐 **Bank-grade encryption**: X25519 + AES-256-GCM with forward secrecy
- 🎯 **Zero configuration**: Auto-discovery via mDNS/multicast, no IP/port setup
- ⚡ **Lightning fast**: 80% faster startup (0.5s), 95%+ transfer success rate
- 🌐 **Universal access**: Desktop (Windows/macOS/Linux) + Android + Web Portal
- 🛡️ **Privacy-first**: All data stays in your LAN, never touches the cloud
- 🎨 **Beautiful UI**: 60fps radar animation, 3 themes (Dark/Light/Eye-care)

---

## ✨ Features

### 🔍 Automatic Device Discovery

**Millisecond-level topology detection** powered by mDNS and multicast protocols:
- See all devices on your network instantly (PC, Android, Web clients)
- 60fps animated radar with real-time device positioning
- No manual IP address or port configuration required

### 🔒 End-to-End Encryption

**Military-grade cryptography** protecting every byte:
- **X25519** elliptic curve Diffie-Hellman key exchange
- **AES-256-GCM** authenticated encryption with 128-bit auth tags
- **HKDF-SHA256** key derivation for session isolation
- **QR code + 6-digit PIN** out-of-band pairing prevents MITM attacks

### 📱 Cross-Platform Support

**One solution, all your devices**:
- **Desktop Hub**: Windows 10/11, macOS (coming soon), Linux (coming soon)
  - System tray integration with show/hide toggle
  - 3 global shortcuts (Ctrl+Shift+S/Q/R)
  - Native dialogs and notifications
- **Android**: 7.0+ with deep system integration
  - Triple keep-alive mechanism (95%+ background success)
  - Optimized for OPPO/VIVO/Xiaomi devices
  - Scoped storage compliance (Android 10-14+)
- **Web Portal**: Any modern browser (Chrome, Firefox, Safari, Edge)
  - Zero installation, instant access
  - Drag-and-drop upload support
  - QR code connection

### 🚀 Performance & Reliability

**v1.1.0 brings massive improvements**:
- **80% faster startup**: Desktop app launches in 0.5-1 second
- **95%+ success rate**: Android background transfers with WakeLock + heartbeat
- **1MB chunked streaming**: Handle multi-gigabyte files without memory bloat
- **Foreground service**: Prevents system from killing transfers

### 🎨 Modern User Experience

**Polished interface on every platform**:
- **60fps radar animation**: Smooth, responsive device visualization
- **3 theme system**: Dark, Light, Eye-care modes
- **Adaptive UI**: Auto-adjusts for notches, gesture bars, high-DPI displays
- **Text selection**: Long-press to copy on both desktop and mobile
- **Custom scrollbars**: Theme-aware, never intrusive

---

## 📥 Download

### Latest Release: v1.1.0 (2026-09-14)

| Platform | Download | Size | Notes |
|:---|:---:|:---:|:---|
| **Windows 10/11** | [MSI Installer](https://github.com/Paper-Yuan/DocumentX/releases/latest) | ~5 MB | Recommended |
| **Windows Portable** | [EXE](https://github.com/Paper-Yuan/DocumentX/releases/latest) | ~5 MB | No installation |
| **Android 7.0+** | [APK](https://github.com/Paper-Yuan/DocumentX/releases/latest) | ~28 MB | Sideload required |
| **macOS** | Coming soon | - | Code ready, testing needed |
| **Linux** | Coming soon | - | Code ready, testing needed |

**System Requirements**:
- Windows: 64-bit, 100 MB disk space
- Android: API 24+, 50 MB storage, Wi-Fi network

---

## 🚀 Quick Start

### Desktop Setup (Windows)

1. **Download** and install SafeDrop MSI
2. **Launch** the app (icon appears in system tray)
3. **Scan QR code** displayed on screen with your phone

**Global shortcuts** (works even when window is hidden):
- `Ctrl+Shift+S` - Show/hide window
- `Ctrl+Shift+Q` - Quick send file
- `Ctrl+Shift+R` - Refresh devices

### Android Setup

1. **Install** SafeDrop APK
2. **Grant permissions**: Camera, Notifications, Battery optimization
3. **Scan QR code** from desktop app or enter connection code
4. **Start transferring** - files auto-save to `Download/SafeDrop/`

### Web Portal (Any Device)

1. **Open desktop app** and note the displayed URL (e.g., `http://192.168.1.100:8899/portal`)
2. **Open browser** on any device (iPhone, iPad, Mac, Linux, Smart TV)
3. **Enter PIN code** shown on desktop
4. **Upload/download** files directly

---

## 🔐 Security

SafeDrop implements **defense-in-depth** security:

### Cryptographic Stack

```
Layer 1: X25519 Key Exchange (Curve25519 ECDH)
         ↓
Layer 2: HKDF-SHA256 Key Derivation (RFC 5869)
         ↓
Layer 3: AES-256-GCM Authenticated Encryption (AEAD)
         ↓
Layer 4: 1MB Chunked Streaming (memory-safe)
```

### Authentication Flow

1. **QR Code Pairing**: Desktop generates ephemeral QR with connection info
2. **PIN Verification**: 6-digit code rotates every connection
3. **Fingerprint Validation**: Both sides verify device identity
4. **Session Keys**: Unique per transfer, forward secrecy guaranteed

### Attack Mitigation

| Attack Vector | Protection |
|:---|:---|
| Man-in-the-Middle | Out-of-band QR + PIN verification |
| ARP Spoofing | Device fingerprint validation |
| Replay Attacks | Timestamp + nonce in every message |
| SSRF / CSRF | Origin validation, CORS headers |
| Path Traversal | Sandboxed file paths, allowlist |
| DoS | 2MB request size limit, rate limiting |

**See [Security Audit Matrix](./README.md#-security-audit-matrix) for full details.**

---

## 🏗️ Architecture

### System Overview

```
┌─────────────────────────────────────────────────────┐
│                  Desktop Hub (PC)                   │
│  ┌──────────────────┐      ┌────────────────────┐  │
│  │  Tauri 2.0 Shell │      │ Node.js Backend    │  │
│  │  (Rust + WebView)│◄────►│ (Zero Dependencies)│  │
│  │  • System Tray   │      │ • HTTP API         │  │
│  │  • Shortcuts     │      │ • mDNS Discovery   │  │
│  └──────────────────┘      └────────────────────┘  │
│           │                          │              │
│           │    HTML5/CSS3/JS        │              │
│           └──────────┬───────────────┘              │
│                      │                              │
└──────────────────────┼──────────────────────────────┘
                       │ LAN (Wi-Fi/Ethernet)
         ┌─────────────┼─────────────┬────────────────┐
         │             │             │                │
┌────────▼──────┐ ┌───▼──────┐ ┌───▼─────────┐ ┌────▼─────┐
│ Android Client│ │  Browser │ │ Future iOS  │ │  Future  │
│ (Kotlin/Jetpack│ │ (Portal) │ │   Client    │ │ Desktop  │
│  Compose)     │ │          │ │             │ │ (macOS/  │
│ • Foreground  │ │• Drag-drop│ │             │ │  Linux)  │
│   Service     │ │• QR Scan │ │             │ │          │
│ • WakeLock    │ │          │ │             │ │          │
└───────────────┘ └──────────┘ └─────────────┘ └──────────┘
```

### Tech Stack

**Desktop**:
- **Frontend**: Tauri 2.0 (Rust + WebView2/WebKit)
- **Backend**: Node.js 18+ (100% native, zero npm dependencies)
- **UI**: HTML5 Canvas (radar), CSS3 (glassmorphism), Vanilla JS

**Android**:
- **Language**: Kotlin 1.9+
- **UI**: Jetpack Compose + Material3
- **Network**: OkHttp3 for chunked streaming
- **Crypto**: BouncyCastle for X25519/AES-GCM
- **Storage**: MediaStore API (Android 10+ compliance)

**Crypto**:
- X25519: libsodium (desktop) / BouncyCastle (Android)
- AES-GCM: Node.js crypto (desktop) / BouncyCastle (Android)
- HKDF: RFC 5869 compliant implementation

---

## 📁 Project Structure

```
DocumentX/
├── computer-design/
│   ├── tauri-app/           # Tauri 2.0 desktop shell (NEW in v1.1.0)
│   ├── desktop_hub/         # Node.js backend + web frontend
│   │   ├── server.js        # Core HTTP API (970 lines)
│   │   └── public/
│   │       ├── index.html   # Desktop UI
│   │       ├── portal.html  # Web portal
│   │       ├── app.js       # Frontend logic
│   │       └── style.css    # Theme system
│   └── installer/           # Windows installer builder
│
├── android-design/
│   └── com/app/src/main/
│       ├── AndroidManifest.xml
│       └── java/com/safedrop/mobile/
│           ├── core/
│           │   ├── crypto/CryptoEngine.kt
│           │   ├── network/DesktopHubClient.kt
│           │   └── storage/ScopedStorageHelper.kt
│           ├── service/TransferForegroundService.kt
│           └── ui/MainActivity.kt
│
├── LICENSE                  # MIT License
├── CHANGELOG.md            # Version history
└── README.md               # This file
```

---

## 🗺️ Roadmap

### ✅ v1.0.0 (2026-08-30) - Foundation
- Zero-config mDNS discovery
- X25519 + AES-256-GCM encryption
- 1MB chunked streaming
- Desktop + Android + Web portal

### ✅ v1.1.0 (2026-09-14) - Performance & Stability
- 80% faster desktop startup
- 95%+ Android background success
- System tray integration
- Global shortcuts (Ctrl+Shift+S/Q/R)
- Triple keep-alive mechanism

### 🔄 v1.2.0 (Est. Early October 2026) - Advanced Features
- **Resumable transfers** with breakpoint continuation
- **Batch download** with TAR.GZ compression
- **QR share links** with 24-hour expiration
- **Transfer queue** management

### 🔮 v1.3.0 - Multi-Platform Expansion
- macOS desktop client
- Linux desktop client (.deb, .rpm, AppImage)
- Enhanced web portal with PWA support

### 🔮 v1.4.0 - Cloud Bridge (Optional)
- Optional relay server for internet transfers
- End-to-end encryption maintained
- Self-hostable bridge server

### 🔮 v1.5.0 - Enterprise Features
- User authentication system
- Access control lists
- Audit logging
- Corporate network support

---

## 🧪 Testing

SafeDrop includes comprehensive test suites:

### Automated Tests

```bash
# Desktop backend tests
node test_qr_and_security.js
node test_multi_device_and_portal.js

# UI/UX tests
node test_theme_and_device_display.js
node test_scrollbar_and_copy_features.js

# Integration tests
node test_new_chat_and_layout_features.js
```

### Manual Testing Checklist

See [TEST_VALIDATION_V1.1.0.md](./TEST_VALIDATION_V1.1.0.md) for:
- Startup speed verification
- System tray functionality
- Global shortcuts testing
- Android background stability
- Cross-platform compatibility

**Test Results**: v1.1.0 scored 92.9/100 (A grade)

---

## 🤝 Contributing

We welcome contributions! SafeDrop is open source under the MIT License.

### How to Contribute

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/AmazingFeature`)
3. **Commit** your changes (`git commit -m 'Add some AmazingFeature'`)
4. **Push** to the branch (`git push origin feature/AmazingFeature`)
5. **Open** a Pull Request

### Development Setup

**Desktop**:
```bash
cd computer-design/tauri-app
npm install
npx tauri dev
```

**Android**:
```bash
cd android-design/com
./gradlew assembleDebug
```

### Code Style

- **Desktop**: Follow Rust conventions for Tauri, modern JS for frontend
- **Android**: Kotlin style guide, Material3 design patterns
- **Commits**: Use [Conventional Commits](https://www.conventionalcommits.org/)

---

## 📄 License

SafeDrop is licensed under the **MIT License** - see [LICENSE](./LICENSE) for details.

```
Copyright (c) 2026 SafeDrop Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, subject to the following conditions:
...
```

---

## 🙏 Acknowledgments

- **Tauri Team** - For the amazing desktop framework
- **Rust Community** - For security-first systems programming
- **Android Developers** - For comprehensive documentation
- **Open Source Contributors** - For making this possible

---

## 📞 Support & Community

- **Issues**: [GitHub Issues](https://github.com/Paper-Yuan/DocumentX/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Paper-Yuan/DocumentX/discussions)
- **Changelog**: [CHANGELOG.md](./CHANGELOG.md)
- **Security**: [SECURITY.md](./SECURITY.md) (coming soon)

---

## 🌐 Alternative Names & Credits

This project is also known as:
- **SafeDrop** (public brand name)
- **DocumentX** (internal codename, repository name)

Both names refer to the same software.

---

<p align="center">
  Made with ❤️ by the SafeDrop Team<br/>
  <sub>Zero-config secure file transfer for everyone</sub>
</p>

<p align="center">
  <a href="#safedrop---zero-config-secure-file-transfer-">⬆ Back to Top</a>
</p>
