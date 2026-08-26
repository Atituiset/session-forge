use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const ENGINE_PORT: u16 = 4177;

/// Set when the app is shutting down so the engine supervisor does not
/// respawn the sidecar we just killed.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

struct EngineHandle(Mutex<Option<CommandChild>>);

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
        .build(tauri::generate_context!())
        .expect("error while building SessionForge")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => kill_engine(app),
            _ => {}
        });
}

fn kill_engine(app: &tauri::AppHandle) {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    if let Some(state) = app.try_state::<EngineHandle>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
            eprintln!("engine sidecar terminated");
        }
    }
}

fn spawn_engine(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(EngineHandle(Mutex::new(None)));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { supervise_engine(handle).await });
    Ok(())
}

/// Engine log lives next to the data store so release builds stay
/// debuggable: sidecar stderr otherwise vanishes on end-user machines,
/// leaving the panel dead with no clue why.
fn engine_log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .home_dir()
        .ok()
        .map(|h| h.join(".session-forge").join("engine.log"))
}

fn log_engine(path: &Option<PathBuf>, line: &str) {
    let Some(p) = path else { return };
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{secs}] {line}");
    }
}

async fn sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// Keeps the engine sidecar alive: spawns it, mirrors its output into the
/// log file, and respawns on unexpected exit. Gives up after 5 rapid
/// failures to avoid a tight crash loop (e.g. port already in use).
async fn supervise_engine(app: tauri::AppHandle) {
    const MAX_RAPID_FAILURES: u32 = 5;
    let log_path = engine_log_path(&app);
    let mut rapid_failures = 0u32;
    loop {
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        let spawned = app
            .shell()
            .sidecar("session-forge-engine")
            .map(|c| c.args(["serve", "--port", &ENGINE_PORT.to_string(), "--headless"]))
            .and_then(|c| c.spawn());
        let (mut rx, child) = match spawned {
            Ok(v) => v,
            Err(e) => {
                rapid_failures += 1;
                log_engine(&log_path, &format!("spawn failed ({rapid_failures}): {e}"));
                if rapid_failures >= MAX_RAPID_FAILURES {
                    log_engine(&log_path, "giving up after repeated spawn failures");
                    return;
                }
                sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        let started = Instant::now();
        if let Some(state) = app.try_state::<EngineHandle>() {
            *state.0.lock().unwrap() = Some(child);
        }
        log_engine(&log_path, "engine started");
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    log_engine(&log_path, String::from_utf8_lossy(&line).trim_end())
                }
                CommandEvent::Error(err) => log_engine(&log_path, &format!("engine error: {err}")),
                CommandEvent::Terminated(status) => {
                    log_engine(&log_path, &format!("engine exited: code={:?}", status.code))
                }
                _ => {}
            }
        }
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        // Surviving past the window proves it was not a crash loop.
        rapid_failures = if started.elapsed() > Duration::from_secs(60) {
            1
        } else {
            rapid_failures + 1
        };
        if rapid_failures >= MAX_RAPID_FAILURES {
            log_engine(&log_path, "giving up after repeated crashes");
            return;
        }
        log_engine(&log_path, "restarting engine");
        sleep(Duration::from_secs(2)).await;
    }
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
