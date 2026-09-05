using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("SafeDrop Setup")]
[assembly: AssemblyDescription("SafeDrop Desktop Hub Installer")]
[assembly: AssemblyConfiguration("")]
[assembly: AssemblyCompany("SafeDrop")]
[assembly: AssemblyProduct("SafeDrop")]
[assembly: AssemblyCopyright("Copyright © 2026 SafeDrop")]
[assembly: AssemblyTrademark("")]
[assembly: AssemblyCulture("")]
[assembly: AssemblyVersion("1.0.1.0")]
[assembly: AssemblyFileVersion("1.0.1.0")]
[assembly: AssemblyInformationalVersion("1.0.1")]

namespace SafeDrop.Setup
{
    public class InstallerForm : Form
    {
        private int currentStep = 0; // 0: Welcome, 1: Directory, 2: Tasks, 3: Progress, 4: Finish

        // UI Header
        private Panel panelHeader;
        private Label lblHeaderTitle;
        private Label lblHeaderSub;
        private PictureBox picHeaderLogo;
        private Panel panelHeaderDivider;

        // Content Panels
        private Panel panelContainer;
        private Panel pageWelcome;
        private Panel pageDirectory;
        private Panel pageTasks;
        private Panel pageProgress;
        private Panel pageFinish;

        // Page 2: Directory Controls
        private TextBox txtInstallPath;
        private Button btnBrowse;
        private Label lblSpaceReq;
        private Label lblSpaceAvail;

        // Page 3: Tasks Controls
        private CheckBox chkDesktopShortcut;
        private CheckBox chkStartMenuShortcut;
        private CheckBox chkAutoStart;

        // Page 4: Progress Controls
        private Label lblProgressStatus;
        private ProgressBar progressBar;
        private Label lblProgressDetail;

        // Page 5: Finish Controls
        private CheckBox chkLaunchNow;

        // Footer Controls
        private Panel panelFooter;
        private Panel panelFooterDivider;
        private Button btnBack;
        private Button btnNext;
        private Button btnCancel;

        private BackgroundWorker worker;
        private string targetDirectory = "";

        public InstallerForm()
        {
            InitializeComponent();
            ShowStep(0);
        }

        private void InitializeComponent()
        {
            this.SuspendLayout();

            this.Text = "SafeDrop 安装向导";
            this.Size = new Size(620, 460);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            this.BackColor = Color.FromArgb(248, 250, 252);

            try
            {
                using (Stream iconStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico"))
                {
                    if (iconStream != null) this.Icon = new Icon(iconStream);
                }
            }
            catch { }

            // 1. Header
            panelHeader = new Panel
            {
                Dock = DockStyle.Top,
                Height = 68,
                BackColor = Color.White
            };

            lblHeaderTitle = new Label
            {
                Text = "SafeDrop 局域网高速安全互传",
                Font = new Font("Microsoft YaHei UI", 10.5F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(20, 14),
                AutoSize = true
            };

            lblHeaderSub = new Label
            {
                Text = "欢迎使用安装向导",
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(22, 38),
                AutoSize = true
            };

            picHeaderLogo = new PictureBox
            {
                Size = new Size(42, 42),
                Location = new Point(545, 12),
                SizeMode = PictureBoxSizeMode.Zoom
            };
            try
            {
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico"))
                {
                    if (s != null) picHeaderLogo.Image = new Icon(s, 48, 48).ToBitmap();
                }
            }
            catch { }

            panelHeaderDivider = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 1,
                BackColor = Color.FromArgb(226, 232, 240)
            };
            panelHeader.Controls.Add(lblHeaderTitle);
            panelHeader.Controls.Add(lblHeaderSub);
            panelHeader.Controls.Add(picHeaderLogo);
            panelHeader.Controls.Add(panelHeaderDivider);

            // 2. Footer
            panelFooter = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 60,
                BackColor = Color.FromArgb(241, 245, 249)
            };

            panelFooterDivider = new Panel
            {
                Dock = DockStyle.Top,
                Height = 1,
                BackColor = Color.FromArgb(226, 232, 240)
            };

            btnCancel = new Button
            {
                Text = "取消",
                Size = new Size(88, 30),
                Location = new Point(505, 15),
                UseVisualStyleBackColor = true
            };
            btnCancel.Click += (s, e) => { CloseInstaller(); };

            btnNext = new Button
            {
                Text = "下一步(N) >",
                Size = new Size(96, 30),
                Location = new Point(400, 15),
                UseVisualStyleBackColor = true
            };
            btnNext.Click += (s, e) => { OnNextClick(); };

            btnBack = new Button
            {
                Text = "< 上一步(B)",
                Size = new Size(96, 30),
                Location = new Point(296, 15),
                UseVisualStyleBackColor = true
            };
            btnBack.Click += (s, e) => { OnBackClick(); };

            panelFooter.Controls.Add(panelFooterDivider);
            panelFooter.Controls.Add(btnBack);
            panelFooter.Controls.Add(btnNext);
            panelFooter.Controls.Add(btnCancel);

            // 3. Central Container
            panelContainer = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.White
            };

            BuildWelcomePage();
            BuildDirectoryPage();
            BuildTasksPage();
            BuildProgressPage();
            BuildFinishPage();

            this.Controls.Add(panelContainer);
            this.Controls.Add(panelHeader);
            this.Controls.Add(panelFooter);

            this.AcceptButton = btnNext;
            this.CancelButton = btnCancel;

            this.ResumeLayout(false);
        }

        // ======================= Pages =======================

        private void BuildWelcomePage()
        {
            pageWelcome = new Panel { Dock = DockStyle.Fill, Padding = new Padding(30) };

            Label lblTitle = new Label
            {
                Text = "欢迎使用 SafeDrop 安装向导",
                Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(30, 20),
                AutoSize = true
            };

            Label lblDesc = new Label
            {
                Text = "SafeDrop 是一款专为跨设备打造的高速、安全、零云端依赖的局域网文件与剪贴板互传系统。\n\n" +
                       "• 毫秒级配对：手机端与电脑端二维码秒级识别，即时网络拓扑发现\n" +
                       "• 军工级安全：采用流式加密与分块高速传输，单文件支持 100GB+ 无损速传\n" +
                       "• 点对点纯净：纯局域网高速通道直连，不消耗任何公网流量，数据不出内网\n\n" +
                       "本向导将指引您在当前计算机上完成 SafeDrop 的安装与环境配置。\n\n" +
                       "建议在继续安装前，关闭其他正在运行的 SafeDrop 实例。\n\n" +
                       "单击 [下一步] 继续，或单击 [取消] 退出安装程序。",
                Font = new Font("Microsoft YaHei UI", 9.5F),
                ForeColor = Color.FromArgb(51, 65, 85),
                Location = new Point(30, 60),
                Size = new Size(540, 210)
            };

            pageWelcome.Controls.Add(lblTitle);
            pageWelcome.Controls.Add(lblDesc);
            panelContainer.Controls.Add(pageWelcome);
        }

        private void BuildDirectoryPage()
        {
            pageDirectory = new Panel { Dock = DockStyle.Fill, Padding = new Padding(30) };

            Label lblTitle = new Label
            {
                Text = "选择目标安装文件夹",
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(30, 20),
                AutoSize = true
            };

            Label lblDesc = new Label
            {
                Text = "安装向导将把 SafeDrop 文件安装到下列文件夹中。\n若要安装到不同的文件夹，请单击 [浏览] 并选择其他目录：",
                Font = new Font("Microsoft YaHei UI", 9.5F),
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(30, 50),
                Size = new Size(540, 40)
            };

            GroupBox grpBox = new GroupBox
            {
                Text = "目标文件夹",
                Location = new Point(30, 100),
                Size = new Size(540, 75)
            };

            string defaultPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "SafeDrop");
            if (!IsAdministrator())
            {
                string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                defaultPath = Path.Combine(localApp, "Programs", "SafeDrop");
            }

            txtInstallPath = new TextBox
            {
                Text = defaultPath,
                Location = new Point(15, 30),
                Size = new Size(415, 26),
                Font = new Font("Segoe UI", 9F)
            };
            txtInstallPath.TextChanged += (s, e) => { UpdateDiskSpace(txtInstallPath.Text); };

            btnBrowse = new Button
            {
                Text = "浏览(B)...",
                Location = new Point(440, 28),
                Size = new Size(85, 28)
            };
            btnBrowse.Click += (s, e) =>
            {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.Description = "请选择 SafeDrop 的安装目录：";
                    fbd.SelectedPath = txtInstallPath.Text;
                    if (fbd.ShowDialog(this) == DialogResult.OK)
                    {
                        txtInstallPath.Text = Path.Combine(fbd.SelectedPath, "SafeDrop");
                    }
                }
            };

            grpBox.Controls.Add(txtInstallPath);
            grpBox.Controls.Add(btnBrowse);

            lblSpaceReq = new Label
            {
                Text = "所需磁盘空间: 约 38.5 MB (内置独立便携运行环境)",
                Location = new Point(32, 195),
                AutoSize = true,
                ForeColor = Color.FromArgb(100, 116, 139)
            };

            lblSpaceAvail = new Label
            {
                Text = "可用磁盘空间: 计算中...",
                Location = new Point(32, 220),
                AutoSize = true,
                ForeColor = Color.FromArgb(100, 116, 139)
            };

            pageDirectory.Controls.Add(lblTitle);
            pageDirectory.Controls.Add(lblDesc);
            pageDirectory.Controls.Add(grpBox);
            pageDirectory.Controls.Add(lblSpaceReq);
            pageDirectory.Controls.Add(lblSpaceAvail);

            UpdateDiskSpace(defaultPath);
            panelContainer.Controls.Add(pageDirectory);
        }

        private void BuildTasksPage()
        {
            pageTasks = new Panel { Dock = DockStyle.Fill, Padding = new Padding(30) };

            Label lblTitle = new Label
            {
                Text = "选择附加任务",
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(30, 20),
                AutoSize = true
            };

            Label lblDesc = new Label
            {
                Text = "请选择您希望在安装 SafeDrop 时创建的快捷方式与系统配置选项：",
                Font = new Font("Microsoft YaHei UI", 9.5F),
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(30, 50),
                Size = new Size(540, 30)
            };

            GroupBox grpTasks = new GroupBox
            {
                Text = "快捷方式与自启动",
                Location = new Point(30, 90),
                Size = new Size(540, 140)
            };

            chkDesktopShortcut = new CheckBox
            {
                Text = "创建桌面快捷方式 (Desktop Shortcut)",
                Checked = true,
                Location = new Point(20, 30),
                AutoSize = true
            };

            chkStartMenuShortcut = new CheckBox
            {
                Text = "创建开始菜单快捷方式 (Start Menu Shortcut)",
                Checked = true,
                Location = new Point(20, 65),
                AutoSize = true
            };

            chkAutoStart = new CheckBox
            {
                Text = "开机时自动在后台启动 SafeDrop 局域网监听中枢 (可选)",
                Checked = false,
                Location = new Point(20, 100),
                AutoSize = true
            };

            grpTasks.Controls.Add(chkDesktopShortcut);
            grpTasks.Controls.Add(chkStartMenuShortcut);
            grpTasks.Controls.Add(chkAutoStart);

            pageTasks.Controls.Add(lblTitle);
            pageTasks.Controls.Add(lblDesc);
            pageTasks.Controls.Add(grpTasks);

            panelContainer.Controls.Add(pageTasks);
        }

        private void BuildProgressPage()
        {
            pageProgress = new Panel { Dock = DockStyle.Fill, Padding = new Padding(30) };

            Label lblTitle = new Label
            {
                Text = "正在安装 SafeDrop",
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(30, 20),
                AutoSize = true
            };

            lblProgressStatus = new Label
            {
                Text = "正在准备安装，请稍候...",
                Font = new Font("Microsoft YaHei UI", 9.5F),
                ForeColor = Color.FromArgb(71, 85, 105),
                Location = new Point(30, 55),
                Size = new Size(540, 25)
            };

            progressBar = new ProgressBar
            {
                Location = new Point(30, 90),
                Size = new Size(540, 24),
                Style = ProgressBarStyle.Continuous,
                Minimum = 0,
                Maximum = 100,
                Value = 0
            };

            lblProgressDetail = new Label
            {
                Text = "",
                Font = new Font("Segoe UI", 8.5F),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(30, 125),
                Size = new Size(540, 100)
            };

            pageProgress.Controls.Add(lblTitle);
            pageProgress.Controls.Add(lblProgressStatus);
            pageProgress.Controls.Add(progressBar);
            pageProgress.Controls.Add(lblProgressDetail);

            panelContainer.Controls.Add(pageProgress);
        }

        private void BuildFinishPage()
        {
            pageFinish = new Panel { Dock = DockStyle.Fill, Padding = new Padding(30) };

            Label lblTitle = new Label
            {
                Text = "SafeDrop 安装完成！",
                Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold),
                ForeColor = Color.FromArgb(22, 101, 52), // Success green
                Location = new Point(30, 30),
                AutoSize = true
            };

            Label lblDesc = new Label
            {
                Text = "SafeDrop 局域网高速安全互传客户端已成功安装到您的计算机。\n\n" +
                       "已为您配置：\n" +
                       "• 零依赖全功能便携运行环境与加密传输引擎\n" +
                       "• 桌面与开始菜单快捷访问方式\n" +
                       "• 系统应用列表安全卸载通道\n\n" +
                       "单击 [完成] 按钮退出安装向导。",
                Font = new Font("Microsoft YaHei UI", 9.5F),
                ForeColor = Color.FromArgb(51, 65, 85),
                Location = new Point(30, 75),
                Size = new Size(540, 140)
            };

            chkLaunchNow = new CheckBox
            {
                Text = "立即运行 SafeDrop (Launch SafeDrop now)",
                Checked = true,
                Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(32, 225),
                AutoSize = true
            };

            pageFinish.Controls.Add(lblTitle);
            pageFinish.Controls.Add(lblDesc);
            pageFinish.Controls.Add(chkLaunchNow);

            panelContainer.Controls.Add(pageFinish);
        }

        // ======================= Navigation =======================

        private void ShowStep(int step)
        {
            currentStep = step;
            pageWelcome.Visible = (step == 0);
            pageDirectory.Visible = (step == 1);
            pageTasks.Visible = (step == 2);
            pageProgress.Visible = (step == 3);
            pageFinish.Visible = (step == 4);

            switch (step)
            {
                case 0:
                    lblHeaderSub.Text = "欢迎使用安装向导";
                    btnBack.Enabled = false;
                    btnNext.Text = "下一步(N) >";
                    btnCancel.Enabled = true;
                    break;
                case 1:
                    lblHeaderSub.Text = "选择安装位置";
                    btnBack.Enabled = true;
                    btnNext.Text = "下一步(N) >";
                    btnCancel.Enabled = true;
                    break;
                case 2:
                    lblHeaderSub.Text = "选择附加任务";
                    btnBack.Enabled = true;
                    btnNext.Text = "安装(I)";
                    btnCancel.Enabled = true;
                    break;
                case 3:
                    lblHeaderSub.Text = "正在提取与配置核心文件...";
                    btnBack.Enabled = false;
                    btnNext.Enabled = false;
                    btnCancel.Enabled = false;
                    StartInstallation();
                    break;
                case 4:
                    lblHeaderSub.Text = "安装向导已就绪";
                    btnBack.Visible = false;
                    btnCancel.Visible = false;
                    btnNext.Text = "完成(F)";
                    btnNext.Enabled = true;
                    this.AcceptButton = btnNext;
                    break;
            }
        }

        private void OnNextClick()
        {
            if (currentStep == 0)
            {
                ShowStep(1);
            }
            else if (currentStep == 1)
            {
                targetDirectory = txtInstallPath.Text.Trim();
                if (string.IsNullOrEmpty(targetDirectory))
                {
                    MessageBox.Show("请指定有效的安装路径。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                ShowStep(2);
            }
            else if (currentStep == 2)
            {
                ShowStep(3);
            }
            else if (currentStep == 4)
            {
                // Finished
                if (chkLaunchNow.Checked)
                {
                    string exePath = Path.Combine(targetDirectory, "SafeDrop.exe");
                    if (File.Exists(exePath))
                    {
                        try
                        {
                            Process.Start(new ProcessStartInfo
                            {
                                FileName = exePath,
                                WorkingDirectory = targetDirectory
                            });
                        }
                        catch { }
                    }
                }
                this.Close();
            }
        }

        private void OnBackClick()
        {
            if (currentStep > 0 && currentStep < 3)
            {
                ShowStep(currentStep - 1);
            }
        }

        private void CloseInstaller()
        {
            if (currentStep == 3)
            {
                return; // Installing, do not cancel
            }
            if (MessageBox.Show("您确定要退出 SafeDrop 安装向导吗？", "退出安装", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
            {
                this.Close();
            }
        }

        private void UpdateDiskSpace(string path)
        {
            try
            {
                string root = Path.GetPathRoot(Path.GetFullPath(path));
                if (!string.IsNullOrEmpty(root) && Directory.Exists(root))
                {
                    DriveInfo di = new DriveInfo(root);
                    double freeGb = (double)di.AvailableFreeSpace / (1024 * 1024 * 1024);
                    lblSpaceAvail.Text = string.Format("目标驱动器 ({0}) 可用空间: {1:0.0} GB", root.TrimEnd('\\'), freeGb);
                    return;
                }
            }
            catch { }
            lblSpaceAvail.Text = "目标驱动器可用空间: 充足";
        }

        // ======================= Installation Worker =======================

        private void StartInstallation()
        {
            worker = new BackgroundWorker();
            worker.WorkerReportsProgress = true;
            worker.DoWork += Worker_DoWork;
            worker.ProgressChanged += Worker_ProgressChanged;
            worker.RunWorkerCompleted += Worker_RunWorkerCompleted;
            worker.RunWorkerAsync();
        }

        private void Worker_ProgressChanged(object sender, ProgressChangedEventArgs e)
        {
            progressBar.Value = Math.Min(100, Math.Max(0, e.ProgressPercentage));
            if (e.UserState != null)
            {
                lblProgressDetail.Text = e.UserState.ToString();
            }
        }

        private void Worker_RunWorkerCompleted(object sender, RunWorkerCompletedEventArgs e)
        {
            if (e.Error != null)
            {
                MessageBox.Show("安装过程中发生错误:\n" + e.Error.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                btnCancel.Enabled = true;
                btnBack.Enabled = true;
                return;
            }
            ShowStep(4);
        }

        private void Worker_DoWork(object sender, DoWorkEventArgs e)
        {
            worker.ReportProgress(5, "正在停止可能正在运行的旧版本进程...");
            KillExistingProcesses();

            worker.ReportProgress(10, "正在创建安装目标目录: " + targetDirectory);
            if (!Directory.Exists(targetDirectory))
            {
                Directory.CreateDirectory(targetDirectory);
            }

            // Extract payload.zip
            worker.ReportProgress(15, "正在读取内置安装载荷包...");
            using (Stream zipStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (zipStream == null)
                {
                    throw new Exception("安装程序内部损坏：未找到内置载荷资源 (payload.zip)。");
                }

                using (ZipArchive archive = new ZipArchive(zipStream, ZipArchiveMode.Read))
                {
                    int count = archive.Entries.Count;
                    int i = 0;
                    foreach (var entry in archive.Entries)
                    {
                        string outPath = Path.Combine(targetDirectory, entry.FullName);
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(outPath);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(outPath));
                            entry.ExtractToFile(outPath, true);
                        }
                        i++;
                        int pct = 15 + (int)((float)i / count * 65);
                        worker.ReportProgress(pct, "正在解压: " + entry.FullName);
                        Thread.Sleep(5); // Smooth UI animation
                    }
                }
            }

            string mainExe = Path.Combine(targetDirectory, "SafeDrop.exe");
            string iconPath = Path.Combine(targetDirectory, "app.ico");

            // Create Desktop Shortcut
            if (chkDesktopShortcut.Checked)
            {
                worker.ReportProgress(83, "正在创建桌面快捷方式...");
                string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string lnk = Path.Combine(desktopDir, "SafeDrop.lnk");
                CreateShortcut(lnk, mainExe, targetDirectory, "SafeDrop 局域网高速安全互传", iconPath);
            }

            // Create Start Menu Shortcut
            if (chkStartMenuShortcut.Checked)
            {
                worker.ReportProgress(88, "正在创建开始菜单快捷方式...");
                string programsDir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                string startDir = Path.Combine(programsDir, "SafeDrop");
                if (!Directory.Exists(startDir)) Directory.CreateDirectory(startDir);

                string startLnk = Path.Combine(startDir, "SafeDrop.lnk");
                CreateShortcut(startLnk, mainExe, targetDirectory, "SafeDrop 局域网高速安全互传", iconPath);

                string uninstLnk = Path.Combine(startDir, "卸载 SafeDrop.lnk");
                CreateShortcut(uninstLnk, Path.Combine(targetDirectory, "uninstall.exe"), targetDirectory, "卸载 SafeDrop", iconPath);
            }

            // Auto Start
            if (chkAutoStart.Checked)
            {
                worker.ReportProgress(92, "正在配置开机自启动...");
                try
                {
                    using (RegistryKey rk = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                    {
                        if (rk != null) rk.SetValue("SafeDrop", "\"" + mainExe + "\"");
                    }
                }
                catch { }
            }

            // Register Uninstaller in Control Panel
            worker.ReportProgress(96, "正在注册系统控制面板卸载项...");
            RegisterUninstaller(targetDirectory);

            worker.ReportProgress(100, "安装已顺利完成！");
            Thread.Sleep(300);
        }

        private void KillExistingProcesses()
        {
            try
            {
                foreach (var p in Process.GetProcessesByName("SafeDrop"))
                {
                    try { p.Kill(); p.WaitForExit(1000); } catch { }
                }
            }
            catch { }
        }

        private static void CreateShortcut(string shortcutPath, string targetExePath, string workingDir, string description, string iconPath)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = targetExePath;
                shortcut.WorkingDirectory = workingDir;
                shortcut.WindowStyle = 1;
                shortcut.Description = description;
                if (!string.IsNullOrEmpty(iconPath) && File.Exists(iconPath))
                {
                    shortcut.IconLocation = iconPath + ",0";
                }
                shortcut.Save();
            }
            catch { }
        }

        private static void RegisterUninstaller(string installDir)
        {
            try
            {
                string uninstallerExe = Path.Combine(installDir, "uninstall.exe");
                string mainExe = Path.Combine(installDir, "SafeDrop.exe");
                string regPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\SafeDrop";

                RegistryKey baseKey = Registry.CurrentUser;
                try
                {
                    if (IsAdministrator())
                    {
                        baseKey = Registry.LocalMachine;
                    }
                }
                catch { }

                using (RegistryKey key = baseKey.CreateSubKey(regPath))
                {
                    if (key != null)
                    {
                        key.SetValue("DisplayName", "SafeDrop 局域网高速安全互传");
                        key.SetValue("DisplayIcon", mainExe + ",0");
                        key.SetValue("DisplayVersion", "1.0.1");
                        key.SetValue("Publisher", "SafeDrop Team");
                        key.SetValue("UninstallString", "\"" + uninstallerExe + "\"");
                        key.SetValue("InstallLocation", installDir);
                        key.SetValue("EstimatedSize", 38000, RegistryValueKind.DWord);
                        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    }
                }
            }
            catch { }
        }

        private static bool IsAdministrator()
        {
            try
            {
                WindowsIdentity id = WindowsIdentity.GetCurrent();
                WindowsPrincipal principal = new WindowsPrincipal(id);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch
            {
                return false;
            }
        }

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }
}
