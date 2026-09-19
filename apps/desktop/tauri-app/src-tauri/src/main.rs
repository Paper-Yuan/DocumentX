// SafeDrop Desktop - Tauri Native Window Manager with System Tray and Global Shortcuts

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Start Node.js backend server (non-blocking)
            start_node_backend();
            
            // Background health check thread (non-blocking startup)
            thread::spawn(move || {
                wait_for_backend_ready();
            });

            // Setup system tray immediately
            setup_system_tray(app)?;

            // Register global shortcuts immediately
            register_global_shortcuts(app.handle())?;

            // Window is immediately visible, frontend will handle loading state
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running SafeDrop application");
}

/// Register all global shortcuts with cross-platform support and conflict detection
fn register_global_shortcuts(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut_manager = app.global_shortcut();

    // Define shortcuts with cross-platform modifier support
    // macOS uses Command key, Windows/Linux use Ctrl
    let shortcuts = vec![
        (
            "toggle_window",
            if cfg!(target_os = "macos") {
                "CommandOrControl+Shift+S"
            } else {
                "Ctrl+Shift+S"
            },
            "Show/Hide main window",
        ),
        (
            "quick_send",
            if cfg!(target_os = "macos") {
                "CommandOrControl+Shift+Q"
            } else {
                "Ctrl+Shift+Q"
            },
            "Quick send file",
        ),
        (
            "refresh_devices",
            if cfg!(target_os = "macos") {
                "CommandOrControl+Shift+R"
            } else {
                "Ctrl+Shift+R"
            },
            "Refresh device list",
        ),
    ];

    // Register each shortcut with error handling for conflicts
    for (id, shortcut_str, description) in shortcuts {
        match shortcut_manager.register(shortcut_str) {
            Ok(_) => {
                println!("✓ Global shortcut registered: {} - {}", shortcut_str, description);
            }
            Err(e) => {
                eprintln!(
                    "✗ Failed to register {}: {} - {}",
                    shortcut_str, description, e
                );
                eprintln!("  This shortcut may conflict with system or other application shortcuts");
                eprintln!("  The application will continue without this shortcut");
            }
        }
    }

    // Set up shortcut event listener
    let app_handle = app.clone();
    shortcut_manager.on_shortcut(move |_app, shortcut, event| {
        if event.state == ShortcutState::Pressed {
            handle_shortcut_event(&app_handle, shortcut);
        }
    });

    Ok(())
}

/// Handle shortcut events and dispatch to appropriate handlers
fn handle_shortcut_event(app: &AppHandle, shortcut: &tauri_plugin_global_shortcut::Shortcut) {
    let shortcut_str = format!("{:?}", shortcut);

    // Parse the shortcut to determine which action to take
    // Check for toggle window shortcut (Ctrl+Shift+S or Cmd+Shift+S)
    if (shortcut_str.contains("SHIFT") && shortcut_str.contains("S"))
        && (shortcut_str.contains("CONTROL") || shortcut_str.contains("SUPER"))
    {
        toggle_main_window(app);
    }
    // Check for quick send shortcut (Ctrl+Shift+Q or Cmd+Shift+Q)
    else if (shortcut_str.contains("SHIFT") && shortcut_str.contains("Q"))
        && (shortcut_str.contains("CONTROL") || shortcut_str.contains("SUPER"))
    {
        trigger_quick_send(app);
    }
    // Check for refresh devices shortcut (Ctrl+Shift+R or Cmd+Shift+R)
    else if (shortcut_str.contains("SHIFT") && shortcut_str.contains("R"))
        && (shortcut_str.contains("CONTROL") || shortcut_str.contains("SUPER"))
    {
        trigger_refresh_devices(app);
    }
}

/// Toggle main window visibility (Ctrl+Shift+S or Cmd+Shift+S)
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                if let Err(e) = window.hide() {
                    eprintln!("Failed to hide window: {}", e);
                } else {
                    println!("Window hidden via global shortcut");
                }
            }
            Ok(false) => {
                if let Err(e) = window.show() {
                    eprintln!("Failed to show window: {}", e);
                } else if let Err(e) = window.set_focus() {
                    eprintln!("Failed to focus window: {}", e);
                } else {
                    println!("Window shown and focused via global shortcut");
                }
            }
            Err(e) => eprintln!("Error checking window visibility: {}", e),
        }
    }
}

/// Trigger quick send file dialog (Ctrl+Shift+Q or Cmd+Shift+Q)
fn trigger_quick_send(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Ensure window is visible and focused
        let _ = window.show();
        let _ = window.set_focus();

        // Emit event to frontend to open file selection dialog
        if let Err(e) = window.emit("shortcut-quick-send", ()) {
            eprintln!("Failed to emit quick-send event: {}", e);
        } else {
            println!("Quick send triggered via global shortcut");
        }
    }
}

/// Trigger device list refresh (Ctrl+Shift+R or Cmd+Shift+R)
fn trigger_refresh_devices(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Emit event to frontend to refresh devices
        if let Err(e) = window.emit("shortcut-refresh-devices", ()) {
            eprintln!("Failed to emit refresh-devices event: {}", e);
        } else {
            println!("Device refresh triggered via global shortcut");
        }
    }
}

fn setup_system_tray<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::MenuItemBuilder;
    
    // Create tray menu items
    let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
    let hide_item = MenuItemBuilder::with_id("hide", "隐藏窗口").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    // Build the menu
    let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

    // Build the tray icon
    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .menu_on_left_click(false)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "hide" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
                "quit" => {
                    show_quit_confirmation_dialog(app);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Show cross-platform quit confirmation dialog
fn show_quit_confirmation_dialog(app: &AppHandle) {
    let app_handle = app.clone();
    
    thread::spawn(move || {
        let confirmed = show_native_confirm_dialog();
        
        if confirmed {
            std::process::exit(0);
        }
    });
}

/// Display native confirmation dialog (cross-platform)
#[cfg(target_os = "windows")]
fn show_native_confirm_dialog() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    
    let output = Command::new("powershell")
        .creation_flags(CREATE_NO_WINDOW)
        .arg("-NoProfile")
        .arg("-Command")
        .arg(r#"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('确定要退出 SafeDrop 吗？', 'SafeDrop', 'OKCancel', 'Warning')"#)
        .output();
    
    if let Ok(output) = output {
        let result = String::from_utf8_lossy(&output.stdout);
        result.trim() == "OK"
    } else {
        false
    }
}

#[cfg(target_os = "macos")]
fn show_native_confirm_dialog() -> bool {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(r#"display dialog "确定要退出 SafeDrop 吗？" buttons {"取消", "确定"} default button "确定" with icon caution with title "SafeDrop""#)
        .output();
    
    output.is_ok()
}

#[cfg(target_os = "linux")]
fn show_native_confirm_dialog() -> bool {
    // Try zenity first
    let zenity = Command::new("zenity")
        .arg("--question")
        .arg("--title=SafeDrop")
        .arg("--text=确定要退出 SafeDrop 吗？")
        .arg("--width=300")
        .output();
    
    if let Ok(output) = zenity {
        return output.status.success();
    }
    
    // Fallback to kdialog
    let kdialog = Command::new("kdialog")
        .arg("--yesno")
        .arg("确定要退出 SafeDrop 吗？")
        .arg("--title")
        .arg("SafeDrop")
        .output();
    
    if let Ok(output) = kdialog {
        return output.status.success();
    }
    
    // No dialog available, default to true
    true
}

fn start_node_backend() {
    let backend_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .map(|mut p| {
            p.push("desktop_hub");
            p
        })
        .expect("Failed to locate desktop_hub directory");

    let server_js = backend_dir.join("server.js");
    
    if !server_js.exists() {
        eprintln!("Warning: server.js not found at: {:?}", server_js);
        return;
    }

    // Try to find Node.js
    let node_cmd = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };

    thread::spawn(move || {
        let result = Command::new(node_cmd)
            .arg(server_js.to_str().unwrap())
            .current_dir(&backend_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        if let Err(e) = result {
            eprintln!("Failed to start Node.js backend: {}", e);
        }
    });
}

fn wait_for_backend_ready() {
    use std::time::Instant;
    
    let start = Instant::now();
    let max_wait = Duration::from_secs(3);
    
    loop {
        if start.elapsed() > max_wait {
            eprintln!("Warning: Backend did not respond within 3 seconds");
            break;
        }
        
        // Try HTTP health check first (faster and more reliable)
        if check_http_health() {
            println!("Backend ready in {:?}", start.elapsed());
            break;
        }
        
        // Fallback: Try TCP port check
        if is_port_listening(8899) {
            println!("Backend port available in {:?}", start.elapsed());
            break;
        }
        
        thread::sleep(Duration::from_millis(50)); // Reduced from 100ms
    }
}

fn check_http_health() -> bool {
    match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(100))
        .build()
    {
        Ok(client) => {
            match client.get("http://127.0.0.1:8899/health").send() {
                Ok(response) => response.status().is_success(),
                Err(_) => false,
            }
        }
        Err(_) => false,
    }
}

fn is_port_listening(port: u16) -> bool {
    use std::net::TcpStream;
    
    TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(50) // Reduced from 100ms
    ).is_ok()
}
