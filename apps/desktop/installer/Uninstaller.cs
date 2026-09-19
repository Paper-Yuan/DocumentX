using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("SafeDrop Uninstaller")]
[assembly: AssemblyDescription("SafeDrop Desktop Hub Uninstaller")]
[assembly: AssemblyConfiguration("")]
[assembly: AssemblyCompany("SafeDrop")]
[assembly: AssemblyProduct("SafeDrop")]
[assembly: AssemblyCopyright("Copyright © 2026 SafeDrop")]
[assembly: AssemblyTrademark("")]
[assembly: AssemblyCulture("")]
[assembly: AssemblyVersion("1.3.0.0")]
[assembly: AssemblyFileVersion("1.3.0.0")]
[assembly: AssemblyInformationalVersion("1.3.0")]

namespace SafeDrop
{
    static class Uninstaller
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                DialogResult dr = MessageBox.Show(
                    "您确定要从这台计算机上完全移除 SafeDrop 局域网互传及其所有组件吗？",
                    "SafeDrop 卸载向导",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                );

                if (dr != DialogResult.Yes)
                {
                    return;
                }

                string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

                // 1. 关闭正在运行的 SafeDrop.exe 进程
                try
                {
                    Process currentProc = Process.GetCurrentProcess();
                    foreach (var p in Process.GetProcessesByName("SafeDrop"))
                    {
                        if (p.Id != currentProc.Id)
                        {
                            try { p.Kill(); p.WaitForExit(1000); } catch { }
                        }
                    }
                }
                catch { }

                // 2. 终止运行在 8899 端口的 Node 服务
                KillProcessOnPort(8899);

                // 3. 删除桌面快捷方式
                try
                {
                    string userDesktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    string userLnk = Path.Combine(userDesktop, "SafeDrop.lnk");
                    if (File.Exists(userLnk)) File.Delete(userLnk);

                    string commonDesktop = Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
                    string commonLnk = Path.Combine(commonDesktop, "SafeDrop.lnk");
                    if (File.Exists(commonLnk)) File.Delete(commonLnk);
                }
                catch { }

                // 4. 删除开始菜单快捷方式
                try
                {
                    string userPrograms = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                    string userStartLnk = Path.Combine(userPrograms, "SafeDrop.lnk");
                    if (File.Exists(userStartLnk)) File.Delete(userStartLnk);

                    string userStartDir = Path.Combine(userPrograms, "SafeDrop");
                    if (Directory.Exists(userStartDir)) Directory.Delete(userStartDir, true);

                    string commonPrograms = Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms);
                    string commonStartLnk = Path.Combine(commonPrograms, "SafeDrop.lnk");
                    if (File.Exists(commonStartLnk)) File.Delete(commonStartLnk);

                    string commonStartDir = Path.Combine(commonPrograms, "SafeDrop");
                    if (Directory.Exists(commonStartDir)) Directory.Delete(commonStartDir, true);
                }
                catch { }

                // 5. 移除控制面板注册表项与自启动项
                try
                {
                    using (RegistryKey hkcu = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall", true))
                    {
                        if (hkcu != null) hkcu.DeleteSubKeyTree("SafeDrop", false);
                    }
                }
                catch { }

                try
                {
                    using (RegistryKey hklm = Registry.LocalMachine.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall", true))
                    {
                        if (hklm != null) hklm.DeleteSubKeyTree("SafeDrop", false);
                    }
                }
                catch { }

                try
                {
                    using (RegistryKey runKey = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                    {
                        if (runKey != null) runKey.DeleteValue("SafeDrop", false);
                    }
                }
                catch { }

                // 6. 清理除卸载程序自身的其它安装目录文件
                try
                {
                    string[] files = Directory.GetFiles(baseDir);
                    string currentExe = Process.GetCurrentProcess().MainModule.FileName;
                    foreach (var f in files)
                    {
                        if (!string.Equals(f, currentExe, StringComparison.OrdinalIgnoreCase))
                        {
                            try { File.Delete(f); } catch { }
                        }
                    }

                    string[] dirs = Directory.GetDirectories(baseDir);
                    foreach (var d in dirs)
                    {
                        try { Directory.Delete(d, true); } catch { }
                    }
                }
                catch { }

                // 7. 启动延迟命令删除 uninstall.exe 及其父目录
                try
                {
                    ProcessStartInfo cleanupPsi = new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = "/c timeout /t 1 /nobreak > NUL & rmdir /s /q \"" + baseDir + "\"",
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    Process.Start(cleanupPsi);
                }
                catch { }

                MessageBox.Show(
                    "SafeDrop 局域网互传已成功从您的计算机中移除。",
                    "SafeDrop 卸载完成",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
            catch (Exception ex)
            {
                MessageBox.Show("卸载过程中出现提示: " + ex.Message, "SafeDrop 卸载", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static void KillProcessOnPort(int port)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = string.Format("/c for /f \"tokens=5\" %a in ('netstat -aon ^| find \":{0}\" ^| find \"LISTENING\"') do taskkill /f /pid %a", port),
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (Process p = Process.Start(psi))
                {
                    if (p != null) p.WaitForExit(2000);
                }
            }
            catch { }
        }
    }
}
