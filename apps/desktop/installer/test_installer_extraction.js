const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

console.log('=== SafeDrop Self-Extracting Installer Verification Suite ===\n');

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`[PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

const INSTALLER_DIR = __dirname;
// The installer lives three levels below the repository root: apps/desktop/installer.
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');
const setupExePath = path.join(ROOT_DIR, 'Safedrop_able', 'set', 'SafeDrop-Setup.exe');

// 1. Physical existence & size in set folder
it('SafeDrop-Setup.exe in Safedrop_able/set exists and has valid size (> 30MB)', () => {
  assert(fs.existsSync(setupExePath), 'Safedrop_able/set/SafeDrop-Setup.exe does not exist - run build_installer.js first');
  const stats = fs.statSync(setupExePath);
  assert(stats.size > 30 * 1024 * 1024, `Size too small: ${stats.size}`);
  console.log(`       set/SafeDrop-Setup.exe Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB (${stats.size} bytes)`);
});

// 2. PE Header & Windows Executable signature
it('SafeDrop-Setup.exe is a valid Win32/x64 PE Executable (MZ header)', () => {
  const fd = fs.openSync(setupExePath, 'r');
  const buf = Buffer.alloc(2);
  fs.readSync(fd, buf, 0, 2, 0);
  fs.closeSync(fd);
  assert(buf[0] === 0x4D && buf[1] === 0x5A, 'Invalid PE magic number (expected MZ)');
});

// 3. Test extraction of embedded payload.zip resource
it('SafeDrop-Setup.exe contains valid embedded payload.zip with complete runtime and assets', () => {
  const testExtractDir = path.join(INSTALLER_DIR, 'test_extraction_verify');
  if (fs.existsSync(testExtractDir)) fs.rmSync(testExtractDir, { recursive: true, force: true });
  fs.mkdirSync(testExtractDir, { recursive: true });

  const testCs = `
using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;

class ExtractorTest
{
    static int Main(string[] args)
    {
        try
        {
            Assembly asm = Assembly.LoadFile(Path.GetFullPath(args[0]));
            using (Stream s = asm.GetManifestResourceStream("payload.zip"))
            {
                if (s == null) return 1;
                using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
                {
                    foreach (var entry in zip.Entries)
                    {
                        string outPath = Path.Combine(args[1], entry.FullName);
                        if (string.IsNullOrEmpty(entry.Name)) Directory.CreateDirectory(outPath);
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(outPath));
                            entry.ExtractToFile(outPath, true);
                        }
                    }
                }
            }
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 2;
        }
    }
}
`;
  const testCsPath = path.join(INSTALLER_DIR, 'ExtractorTest.cs');
  const testExePath = path.join(INSTALLER_DIR, 'ExtractorTest.exe');
  fs.writeFileSync(testCsPath, testCs);

  execSync(`C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe /nologo /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /out:"${testExePath}" "${testCsPath}"`);
  execSync(`"${testExePath}" "${setupExePath}" "${testExtractDir}"`);

  // Verify extracted files
  const requiredFiles = [
    'SafeDrop.exe',
    'uninstall.exe',
    'app.ico',
    'server.js',
    'config.json',
    'node.exe',
    'public/index.html',
    'public/style.css',
    'public/app.js',
    'public/qrcode.js',
    'public/favicon.ico'
  ];

  for (const rel of requiredFiles) {
    const full = path.join(testExtractDir, rel);
    assert(fs.existsSync(full), `Missing extracted file in payload: ${rel}`);
    assert(fs.statSync(full).size > 0, `Extracted file is empty: ${rel}`);
  }

  // Verify embedded node.exe is functional
  const nodeOutput = execSync(`"${path.join(testExtractDir, 'node.exe')}" -v`).toString().trim();
  assert(nodeOutput.startsWith('v'), `Embedded node version invalid: ${nodeOutput}`);
  console.log(`       Embedded Node.js: ${nodeOutput}`);

  // Clean up
  fs.rmSync(testExtractDir, { recursive: true, force: true });
  fs.unlinkSync(testCsPath);
  fs.unlinkSync(testExePath);
});

// 4. Installer & Uninstaller Source Code Consistency
it('Installer.cs implements standard 5-step wizard logic with shortcut and registry support', () => {
  const code = fs.readFileSync(path.join(INSTALLER_DIR, 'Installer.cs'), 'utf8');
  assert(code.includes('BuildWelcomePage'), 'Missing Welcome page');
  assert(code.includes('BuildDirectoryPage'), 'Missing Directory selection page');
  assert(code.includes('BuildTasksPage'), 'Missing Additional tasks page');
  assert(code.includes('BuildProgressPage'), 'Missing Progress page');
  assert(code.includes('BuildFinishPage'), 'Missing Finish page');
  assert(code.includes('FolderBrowserDialog'), 'Missing folder browser dialog');
  assert(code.includes('WScript.Shell'), 'Missing shortcut creation logic');
  assert(code.includes('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'), 'Missing registry uninstaller registration');
  assert(code.includes('SafeDrop.exe'), 'Missing target executable reference');
});

it('Uninstaller.cs implements clean uninstallation with file, shortcut, and registry cleanup', () => {
  const code = fs.readFileSync(path.join(INSTALLER_DIR, 'Uninstaller.cs'), 'utf8');
  assert(code.includes('MessageBox.Show'), 'Missing confirmation dialog');
  assert(code.includes('KillProcessOnPort'), 'Missing port process cleanup');
  assert(code.includes('DesktopDirectory'), 'Missing desktop shortcut cleanup');
  assert(code.includes('SpecialFolder.Programs'), 'Missing start menu shortcut cleanup');
  assert(code.includes('DeleteSubKeyTree'), 'Missing registry cleanup');
  assert(code.includes('rmdir /s /q'), 'Missing directory self-removal');
});

console.log(`\n========================================`);
console.log(`Results: ${passed} Passed, ${failed} Failed`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
