/**
 * SafeDrop Self-Extracting Installer Packager
 * Packages SafeDrop Desktop Hub into a single standalone SafeDrop-Setup.exe
 * with standard Windows software installation wizard logic.
 *
 * The backend is bundled by copying every JavaScript module in desktop_hub rather than a
 * fixed list, and the staged copy is then checked for unresolved require() targets. Listing
 * files by hand previously meant a newly added module (crypto_protocol.js, lan_guard.js,
 * tls_selfsigned.js) was silently absent from the installer, producing a build that crashed
 * on first launch with MODULE_NOT_FOUND.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const payloadCheck = require('./payload_check');

console.log('========================================================');
console.log('📦 SafeDrop 电脑端自解压安装包构建 (SafeDrop-Setup.exe)');
console.log('========================================================\n');

const INSTALLER_DIR = __dirname;
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const HUB_DIR = path.join(ROOT_DIR, 'computer-design', 'desktop_hub');
const TEMP_DIR = path.join(INSTALLER_DIR, 'build_staging');
const PAYLOAD_ZIP = path.join(INSTALLER_DIR, 'payload.zip');
const SET_DIR = path.join(ROOT_DIR, 'set');
const SET_SETUP_EXE = path.join(SET_DIR, 'SafeDrop-Setup.exe');
const ROOT_SETUP_EXE = path.join(ROOT_DIR, 'SafeDrop-Setup.exe');
const CSC_PATH = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

try {
  // Step 1: Compile SafeDrop.exe (Launcher)
  console.log('[1/6] 正在编译原生桌面启动器 (SafeDrop.exe)...');
  const launcherCs = path.join(ROOT_DIR, 'Launcher.cs');
  const launcherOut = path.join(INSTALLER_DIR, 'SafeDrop.exe');
  execSync(`"${CSC_PATH}" /target:winexe /win32icon:"${path.join(ROOT_DIR, 'app.ico')}" /out:"${launcherOut}" "${launcherCs}"`, { stdio: 'inherit' });
  // Also keep launcher in root for direct portable execution
  fs.copyFileSync(launcherOut, path.join(ROOT_DIR, 'SafeDrop.exe'));
  console.log('  -> SafeDrop.exe 编译成功');

  // Step 2: Compile uninstall.exe (Uninstaller)
  console.log('\n[2/6] 正在编译系统标准卸载程序 (uninstall.exe)...');
  const uninstallerCs = path.join(INSTALLER_DIR, 'Uninstaller.cs');
  const uninstallerOut = path.join(INSTALLER_DIR, 'uninstall.exe');
  execSync(`"${CSC_PATH}" /target:winexe /win32icon:"${path.join(ROOT_DIR, 'app.ico')}" /out:"${uninstallerOut}" "${uninstallerCs}"`, { stdio: 'inherit' });
  console.log('  -> uninstall.exe 编译成功');

  // Step 3: Stage all files for distribution
  console.log('\n[3/6] 正在准备分发文件与便携式 Node.js 核心运行时...');
  cleanDir(TEMP_DIR);
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  fs.copyFileSync(launcherOut, path.join(TEMP_DIR, 'SafeDrop.exe'));
  fs.copyFileSync(uninstallerOut, path.join(TEMP_DIR, 'uninstall.exe'));
  fs.copyFileSync(path.join(ROOT_DIR, 'app.ico'), path.join(TEMP_DIR, 'app.ico'));

  // Every backend module, discovered rather than listed, so a new one cannot be forgotten.
  const backendModules = payloadCheck.backendModulesOf(HUB_DIR);
  for (const moduleName of backendModules) {
    fs.copyFileSync(path.join(HUB_DIR, moduleName), path.join(TEMP_DIR, moduleName));
  }
  console.log(`  -> 已打包后端模块 (${backendModules.length}): ${backendModules.join(', ')}`);

  // Ship an empty config. The repository copy records the maintainer's own Downloads path,
  // which must never land on someone else's machine; the server falls back to
  // <user>/Downloads/SafeDrop when no downloadDir is configured.
  fs.writeFileSync(path.join(TEMP_DIR, 'config.json'), '{}\n', 'utf8');

  // Copy public assets
  copyDirRecursive(path.join(HUB_DIR, 'public'), path.join(TEMP_DIR, 'public'));

  // Bundle portable node.exe
  const nodeSource = 'C:\\Program Files\\nodejs\\node.exe';
  if (fs.existsSync(nodeSource)) {
    console.log('  -> 正在捆绑便携式运行时 node.exe...');
    fs.copyFileSync(nodeSource, path.join(TEMP_DIR, 'node.exe'));
  } else {
    throw new Error('未找到 node.exe（C:\\Program Files\\nodejs\\node.exe），无法生成自带运行时的安装包');
  }

  // Step 3.5: Refuse to package a payload that cannot boot.
  console.log('\n[3.5/6] 正在校验载荷完整性（依赖解析）...');
  const verification = payloadCheck.verifyStagedPayload(TEMP_DIR);
  if (verification.missing.length > 0) {
    throw new Error(
      `载荷缺少被依赖的模块，安装后将无法启动:\n  - ${verification.missing.join('\n  - ')}`
    );
  }
  console.log(`  -> 依赖校验通过（${verification.jsFiles.length} 个模块，无缺失引用）`);

  // Step 4: Compress into payload.zip
  console.log('\n[4/6] 正在将分发程序包压缩为自解压载荷 (payload.zip)...');
  if (fs.existsSync(PAYLOAD_ZIP)) fs.unlinkSync(PAYLOAD_ZIP);

  const zipCmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${TEMP_DIR}', '${PAYLOAD_ZIP}', [System.IO.Compression.CompressionLevel]::Optimal, $false)"`;
  execSync(zipCmd, { stdio: 'inherit' });
  const payloadStats = fs.statSync(PAYLOAD_ZIP);
  console.log(`  -> 载荷压缩完成，大小: ${(payloadStats.size / (1024 * 1024)).toFixed(2)} MB`);

  // Step 5: Compile Installer.cs with embedded payload.zip
  console.log('\n[5/6] 正在编译自解压安装包主程序 (SafeDrop-Setup.exe)...');
  const installerCs = path.join(INSTALLER_DIR, 'Installer.cs');
  if (!fs.existsSync(SET_DIR)) fs.mkdirSync(SET_DIR, { recursive: true });

  const compileInstallerCmd = `"${CSC_PATH}" /target:winexe /win32icon:"${path.join(ROOT_DIR, 'app.ico')}" /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /resource:"${PAYLOAD_ZIP}",payload.zip /resource:"${path.join(ROOT_DIR, 'app.ico')}",app.ico /out:"${SET_SETUP_EXE}" "${installerCs}"`;
  execSync(compileInstallerCmd, { stdio: 'inherit' });

  // Step 6: Cleanup and mirror to root
  console.log('\n[6/6] 正在清理临时构建中间文件并同步输出...');
  cleanDir(TEMP_DIR);
  if (fs.existsSync(PAYLOAD_ZIP)) fs.unlinkSync(PAYLOAD_ZIP);
  if (fs.existsSync(launcherOut)) fs.unlinkSync(launcherOut);
  if (fs.existsSync(uninstallerOut)) fs.unlinkSync(uninstallerOut);

  // Sync copy to root for convenience
  fs.copyFileSync(SET_SETUP_EXE, ROOT_SETUP_EXE);

  const setupStats = fs.statSync(SET_SETUP_EXE);
  console.log('\n========================================================');
  console.log('🎉 SafeDrop 自解压安装包打包成功！');
  console.log(`📁 独立 set 目录产物: ${SET_SETUP_EXE}`);
  console.log(`📊 产物大小: ${(setupStats.size / (1024 * 1024)).toFixed(2)} MB (${setupStats.size.toLocaleString()} 字节)`);
  console.log('========================================================\n');
} catch (err) {
  console.error('\n❌ 打包失败:', err.message);
  process.exit(1);
}
