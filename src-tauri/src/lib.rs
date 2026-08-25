use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const ENGINE_PORT: u16 = 4177;

struct EngineHandle(CommandChild);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            spawn_engine(app.handle())?;
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running SessionForge");
}

fn spawn_engine(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let sidecar = app
        .shell()
        .sidecar("session-forge-engine")?
        .args(["serve", "--port", &ENGINE_PORT.to_string(), "--headless"]);
    let (mut rx, child) = sidecar.spawn()?;
    app.manage(EngineHandle(child));
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Error(err) = event {
                eprintln!("engine error: {err}");
            }
        }
    });
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开面板", true, None::<&str>)?;
    let scan = MenuItem::with_id(app, "scan", "立即扫描", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 SessionForge", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &scan, &quit])?;

    TrayIconBuilder::with_id("sf-tray")
        .icon(app.default_window_icon().expect("no icon").clone())
        .tooltip("SessionForge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "scan" => {
                show_main(app);
                let _ = app.emit("trigger-scan", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
