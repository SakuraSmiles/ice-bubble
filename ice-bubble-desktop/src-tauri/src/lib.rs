use tauri::Manager;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use std::fs;

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
            // Tauri 将 sidecar 放在 exe 同级目录，文件名格式: {name}-{target-triple}.exe
            let sidecar_patterns = [
                "server-x86_64-pc-windows-msvc.exe",
                "server-aarch64-pc-windows-msvc.exe",
                "server.exe",
            ];

            for pattern in &sidecar_patterns {
                let sidecar_path = exe_dir.join(pattern);
                if sidecar_path.exists() {
                    println!("Starting sidecar from: {:?}", sidecar_path);
                    match std::process::Command::new(&sidecar_path)
                        .env("ICE_RESOURCE_DIR", &resource_dir)
                        .env("ICE_DIST_DIR", exe_dir.join("server"))
                        .current_dir(&exe_dir)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .spawn()
                    {
                        Ok(_) => {
                            server_started = true;
                            println!("Sidecar server started");
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
                    println!("Starting node server from: {:?}", server_path);
                    match std::process::Command::new("node")
                        .arg(&server_path)
                        .env("ICE_RESOURCE_DIR", &resource_dir)
                        .env("ICE_DIST_DIR", exe_dir.join("server"))
                        .current_dir(&exe_dir)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .spawn()
                    {
                        Ok(_) => {
                            server_started = true;
                            println!("Node server started");
                        }
                        Err(e) => {
                            eprintln!("Node server also failed: {}", e);
                        }
                    }
                }
            }

            if server_started {
                // 等待 Express server 写入端口文件
                let server_url = wait_for_server(&port_file);
                match server_url {
                    Some(url) => {
                        println!("Navigating to: {}", url);
                        let _ = window.eval(&format!(
                            "window.location.href = '{}';",
                            url
                        ));
                    }
                    None => {
                        eprintln!("Server did not start in time, using bundled frontend");
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 等待 Express server 启动并返回其 URL
fn wait_for_server(port_file: &PathBuf) -> Option<String> {
    let start = Instant::now();
    let timeout = Duration::from_secs(5);

    while start.elapsed() < timeout {
        if let Ok(content) = fs::read_to_string(port_file) {
            let port = content.trim();
            if !port.is_empty() {
                std::thread::sleep(Duration::from_millis(200));
                return Some(format!("http://localhost:{}", port));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    eprintln!("Timed out waiting for server port file");
    None
}
