use tauri::Manager;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use std::fs;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 获取 exe 同目录
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();

    let port_file = exe_dir.join("server").join(".server-port");
    let resource_dir = exe_dir.join("config");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
                        Ok(_) => {
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
                        Ok(_) => {
                            server_started = true;
                        }
                        Err(e) => {
                            eprintln!("Node server also failed: {}", e);
                        }
                    }
                }
            }

            if server_started {
                // 等待 Express server 写入端口文件（用于 API 代理）
                let server_port = wait_for_server_port(&port_file);
                if let Some(port) = server_port {
                    // 前端由 Tauri 内置 serve，API 请求走 Express proxy
                    let _ = window.eval(&format!(
                        "window.__ICE_SERVER_PORT = {};",
                        port
                    ));
                }
            }

            Ok(())
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
