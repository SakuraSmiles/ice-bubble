use tauri::Manager;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use std::fs;
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 启动子进程并隐藏控制台窗口
fn spawn_hidden(cmd: &mut std::process::Command) -> std::io::Result<std::process::Child> {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
}

/// 保存 server 子进程句柄，用于退出时清理
struct ServerChild(Mutex<Option<std::process::Child>>);

impl ServerChild {
    fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn set(&self, child: std::process::Child) {
        if let Ok(mut guard) = self.0.lock() {
            let _ = guard.take().map(|mut old| old.kill());
            *guard = Some(child);
        }
    }

    fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(ref mut child) = *guard {
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();

    let port_file = exe_dir.join("server").join(".server-port");
    let resource_dir = exe_dir.join("config");

    let server_child = ServerChild::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(server_child)
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("IceBubble Desktop").unwrap();

            let mut server_started = false;

            // 方式 1: 尝试启动 sidecar server.exe（Tauri 打包模式）
            let sidecar_patterns = [
                "server-x86_64-pc-windows-msvc.exe",
                "server-aarch64-pc-windows-msvc.exe",
                "server.exe",
            ];

            for pattern in &sidecar_patterns {
                let sidecar_path = exe_dir.join(pattern);
                if sidecar_path.exists() {
                    match spawn_hidden(
                        std::process::Command::new(&sidecar_path)
                            .env("ICE_RESOURCE_DIR", &resource_dir)
                            .env("ICE_DIST_DIR", exe_dir.join("server"))
                            .current_dir(&exe_dir)
                    ) {
                        Ok(child) => {
                            let handle = app.state::<ServerChild>();
                            handle.set(child);
                            server_started = true;
                            break;
                        }
                        Err(e) => {
                            eprintln!("Failed to start sidecar {:?}: {}", pattern, e);
                        }
                    }
                }
            }

            // 方式 2: Fallback — 用 node 启动 index.js（开发环境）
            if !server_started {
                let server_path = exe_dir.join("server").join("index.js");
                if server_path.exists() {
                    match spawn_hidden(
                        std::process::Command::new("node")
                            .arg(&server_path)
                            .env("ICE_RESOURCE_DIR", &resource_dir)
                            .env("ICE_DIST_DIR", exe_dir.join("server"))
                            .current_dir(&exe_dir)
                    ) {
                        Ok(child) => {
                            let handle = app.state::<ServerChild>();
                            handle.set(child);
                            server_started = true;
                        }
                        Err(e) => {
                            eprintln!("Node server also failed: {}", e);
                        }
                    }
                }
            }

            if server_started {
                let server_port = wait_for_server_port(&port_file);
                if let Some(port) = server_port {
                    let _ = window.eval(&format!(
                        "window.__ICE_SERVER_PORT = {};",
                        port
                    ));
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let handle = window.state::<ServerChild>();
                handle.kill();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 等待 Express server 启动并返回其端口号
fn wait_for_server_port(port_file: &PathBuf) -> Option<u16> {
    let start = Instant::now();
    let timeout = Duration::from_secs(5);

    while start.elapsed() < timeout {
        if let Ok(content) = fs::read_to_string(port_file) {
            let port = content.trim();
            if !port.is_empty() {
                std::thread::sleep(Duration::from_millis(200));
                return port.parse::<u16>().ok();
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    None
}
