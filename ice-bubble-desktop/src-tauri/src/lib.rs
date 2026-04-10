use tauri::Manager;
use std::process::Command;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 获取 exe 同目录下的 server
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    
    let server_path = exe_dir.join("server").join("index.js");
    
    // 尝试启动内置 server
    if server_path.exists() {
        println!("Starting built-in server from {:?}", server_path);
        match Command::new("node").arg(&server_path).spawn() {
            Ok(_child) => {
                println!("Server started successfully");
            },
            Err(e) => {
                // 端口冲突或其他错误：静默跳过
                eprintln!("Server not started: {} - using external", e);
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            println!("IceBubble Desktop started!");
            let window = app.get_webview_window("main").unwrap();
            window.set_title("IceBubble Desktop").unwrap();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
