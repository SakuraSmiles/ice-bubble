use tauri::Manager;
use std::process::Command;
use std::fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动内置的 Node.js 代理服务
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    
    let server_path = exe_dir.join("server").join("index.js");
    
    // 如果 server/index.js 存在，启动它
    if server_path.exists() {
        println!("Starting built-in server...");
        let _server_child = Command::new("node")
            .arg(server_path)
            .spawn()
            .expect("Failed to start server");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            println!("ice-bubble-desktop started!");
            let window = app.get_webview_window("main").unwrap();
            window.set_title("IceBubble Desktop").unwrap();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
