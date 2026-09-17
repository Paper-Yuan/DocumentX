using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("SafeDrop")]
[assembly: AssemblyDescription("SafeDrop Desktop Hub")]
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
    static class Program
    {
        private const int Port = 8899;
        private static readonly string TargetUrl = "http://localhost:" + Port + "/";

        [STAThread]
        static void Main()
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string[] candidates = new string[]
                {
                    Path.Combine(baseDir, @"computer-design\desktop_hub\server.js"),
                    Path.Combine(baseDir, @"desktop_hub\server.js"),
                    Path.Combine(baseDir, @"server.js"),
                    @"e:\Workbox\DocumentX\computer-design\desktop_hub\server.js"
                };

                string serverScript = null;
                foreach (var c in candidates)
                {
                    if (File.Exists(c))
                    {
                        serverScript = c;
                        break;
                    }
                }

                // 1. 检查 8899 端口是否已在运行
                if (!IsPortListening("127.0.0.1", Port))
                {
                    if (serverScript != null && File.Exists(serverScript))
                    {
                        string localNode = Path.Combine(baseDir, "node.exe");
                        if (!File.Exists(localNode))
                        {
                            localNode = Path.Combine(baseDir, @"runtime\node.exe");
                        }
                        bool hasLocalNode = File.Exists(localNode);

                        ProcessStartInfo serverPsi = new ProcessStartInfo
                        {
                            FileName = hasLocalNode ? localNode : "cmd.exe",
                            Arguments = hasLocalNode ? ("\"" + serverScript + "\"") : ("/c node \"" + serverScript + "\""),
                            WorkingDirectory = Path.GetDirectoryName(serverScript),
                            CreateNoWindow = true,
                            UseShellExecute = false,
                            WindowStyle = ProcessWindowStyle.Hidden
                        };

                        try
                        {
                            Process.Start(serverPsi);
                        }
                        catch (Exception ex)
                        {
                            MessageBox.Show(
                                "未能启动 SafeDrop 后台服务：请确认已安装 Node.js 并已配置在系统 PATH 中。\n\n详情: " + ex.Message,
                                "SafeDrop 启动错误",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Error
                            );
                            return;
                        }

                        // 等待服务监听端口建立 (最多 4 秒)
                        for (int i = 0; i < 40; i++)
                        {
                            Thread.Sleep(100);
                            if (IsPortListening("127.0.0.1", Port))
                            {
                                break;
                            }
                        }
                    }
                }

                // 2. 唤起独立应用视窗 (Edge 或 Chrome App 模式)
                string edgePath1 = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
                string edgePath2 = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
                string chromePath1 = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
                string chromePath2 = @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe";

                string browserExe = null;
                if (File.Exists(edgePath1)) browserExe = edgePath1;
                else if (File.Exists(edgePath2)) browserExe = edgePath2;
                else if (File.Exists(chromePath1)) browserExe = chromePath1;
                else if (File.Exists(chromePath2)) browserExe = chromePath2;

                if (browserExe != null)
                {
                    ProcessStartInfo appPsi = new ProcessStartInfo
                    {
                        FileName = browserExe,
                        Arguments = "--app=" + TargetUrl + " --window-size=1040,740",
                        UseShellExecute = true
                    };
                    Process.Start(appPsi);
                }
                else
                {
                    // 兜底启动系统默认浏览器
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = TargetUrl,
                        UseShellExecute = true
                    });
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动失败: " + ex.Message, "SafeDrop", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static bool IsPortListening(string host, int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    var result = client.BeginConnect(host, port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(250);
                    if (success)
                    {
                        client.EndConnect(result);
                        return true;
                    }
                }
            }
            catch
            {
            }
            return false;
        }
    }
}
