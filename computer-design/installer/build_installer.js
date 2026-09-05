/**
 * SafeDrop Self-Extracting Installer Packager
 * Packages SafeDrop Desktop Hub into a single standalone SafeDrop-Setup.exe
 * with standard Windows software installation wizard logic.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
  fs.copyFileSync(path.join(HUB_DIR, 'server.js'), path.join(TEMP_DIR, 'server.js'));
  if (fs.existsSync(path.join(HUB_DIR, 'config.json'))) {
    fs.copyFileSync(path.join(HUB_DIR, 'config.json'), path.join(TEMP_DIR, 'config.json'));
  } else {
    fs.writeFileSync(path.join(TEMP_DIR, 'config.json'), '{}');
  }

  // Copy public assets
  copyDirRecursive(path.join(HUB_DIR, 'public'), path.join(TEMP_DIR, 'public'));

  // Bundle portable node.exe
  const nodeSource = 'C:\\Program Files\\nodejs\\node.exe';
  if (fs.existsSync(nodeSource)) {
    console.log('  -> 正在捆绑便携式运行时 node.exe...');
    fs.copyFileSync(nodeSource, path.join(TEMP_DIR, 'node.exe'));
  }

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
