pub mod desktop;
pub mod desktop_backup;
pub mod desktop_chat;
pub mod desktop_edge_strip;
pub mod desktop_import;
pub mod desktop_panel;
pub mod desktop_persona;
pub mod desktop_schedule;
pub mod desktop_trash;
pub mod desktop_weather;
pub mod json_io;
pub mod locales;
pub mod services;
pub mod updater;

use locales::Locale;
use services::notes::{default_store, AppConfig, AppError, Note, NoteMetadata, SaveNoteRequest};
use std::{env, fs, io::Write, path::PathBuf};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
fn app_name() -> Result<String, AppError> {
    let locale = Locale::from_tag(&default_store()?.load_config()?.locale);
    Ok(locales::app_name(locale).to_string())
}

/// 右边缘小条被点击：呼出花笺助手面板。
#[tauri::command]
fn edge_strip_clicked(app: AppHandle) {
    desktop_edge_strip::on_strip_clicked(&app);
}

/// 面板里点「备忘录」：另开原版花笺窗口（面板本身不关，花笺浮在上面）。
#[tauri::command]
fn open_memo_window(app: AppHandle) -> Result<(), String> {
    desktop::show_main_window(&app).map_err(|error| error.to_string())
}

/// 面板天气条：时间 + 温度 + 天气现象 + 城市名。
///
/// 走 Rust 侧的原因见 `desktop_weather` 模块注释。`force` 为 true 时忽略缓存
/// （面板上点天气条手动刷新用）。
#[tauri::command]
async fn panel_weather(force: Option<bool>) -> Result<desktop_weather::PanelWeather, AppError> {
    // 定位与网络请求都是阻塞的，放到 blocking 线程池里，别占 tokio 的异步线程。
    tauri::async_runtime::spawn_blocking(move || desktop_weather::panel_weather(force.unwrap_or(false)))
        .await
        .map_err(|error| AppError {
            code: "weather:join".into(),
            message: error.to_string(),
            details: Default::default(),
        })?
}

/// 面板模型下拉的选项（白名单，前端不能自己拼模型名）。
#[tauri::command]
fn chat_models() -> Vec<desktop_chat::ChatModel> {
    desktop_chat::list_models()
}

/// 发起一次对话。立即返回 requestId，正文通过 `chat-delta` 事件流式推给前端。
#[tauri::command]
fn chat_send(app: AppHandle, model: String, text: String) -> Result<String, AppError> {
    desktop_chat::start_chat(app, model, text)
}

/// 收起面板小窗：隐藏而不是销毁，右边缘小条随之露出来。
#[tauri::command]
fn hide_panel(app: AppHandle) {
    desktop_panel::hide_panel(&app);
}

/// 面板上「我的安排」要显示的那几条：未过期、按时间近的排、最多 3 条。
#[tauri::command]
fn schedules_upcoming() -> Result<Vec<desktop_schedule::ScheduleItem>, AppError> {
    desktop_schedule::upcoming()
}

/// 全部安排（含过期的），给手动录入弹窗用。
#[tauri::command]
fn schedules_list() -> Result<Vec<desktop_schedule::ScheduleItem>, AppError> {
    desktop_schedule::list_all()
}

/// 手动加一条安排。
#[tauri::command]
fn schedules_add(
    app: AppHandle,
    title: String,
    at: String,
    all_day: Option<bool>,
) -> Result<desktop_schedule::ScheduleItem, AppError> {
    let item = desktop_schedule::add(&title, &at, all_day.unwrap_or(false), "manual", "")?;
    let _ = app.emit("schedules-changed", ());
    Ok(item)
}

/// 改一条安排。
#[tauri::command]
fn schedules_update(
    app: AppHandle,
    id: String,
    title: String,
    at: String,
    all_day: Option<bool>,
) -> Result<desktop_schedule::ScheduleItem, AppError> {
    let item = desktop_schedule::update(&id, &title, &at, all_day.unwrap_or(false))?;
    let _ = app.emit("schedules-changed", ());
    Ok(item)
}

/// 删一条安排。
#[tauri::command]
fn schedules_remove(app: AppHandle, id: String) -> Result<(), AppError> {
    desktop_schedule::remove(&id)?;
    let _ = app.emit("schedules-changed", ());
    Ok(())
}

#[tauri::command]
fn notes_list() -> Result<Vec<NoteMetadata>, AppError> {
    default_store()?.list_notes()
}

/// 「拖进来即收」：收一批路径进库（文本生成备忘录，图片进笔记图片区）。
#[tauri::command]
fn import_paths(
    app: AppHandle,
    paths: Vec<String>,
    category: Option<String>,
) -> Result<Vec<desktop_import::ImportRecord>, AppError> {
    let records = desktop_import::import_paths(paths, category)?;
    let _ = app.emit("notes-changed", ());
    Ok(records)
}

/// 全部收件记录（倒序）。
#[tauri::command]
fn imports_list() -> Result<Vec<desktop_import::ImportRecord>, AppError> {
    desktop_import::list_imports()
}

/// 把库内副本搬回原位置（同名不覆盖）。
#[tauri::command]
fn import_restore(app: AppHandle, id: String) -> Result<(), AppError> {
    desktop_import::restore_import(&id)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

/// 回收站列表（含正文），给面板的「最近删除」用。
#[tauri::command]
fn trash_list() -> Result<Vec<desktop_trash::TrashEntryView>, AppError> {
    let store = default_store()?;
    desktop_trash::list_trash_with_body(store.data_dir())
}

/// 把回收站里的一条恢复成笔记（同名会自动加序号，不覆盖现有笔记）。
#[tauri::command]
fn trash_restore(app: AppHandle, id: String) -> Result<String, AppError> {
    let store = default_store()?;
    let (entry, body) = {
        let entries = desktop_trash::list_trash(store.data_dir())?;
        let entry = entries
            .into_iter()
            .find(|item| item.id == id)
            .ok_or_else(|| AppError {
                code: "trash:not_found".into(),
                message: "这条已经不在回收站里了".into(),
                details: Default::default(),
            })?;
        let body = desktop_trash::read_trash_body(store.data_dir(), &id);
        (entry, body)
    };
    let request = SaveNoteRequest {
        title: entry.title.clone(),
        content: body,
        category: entry.category.clone(),
    };
    let created = store.create_note(request)?;
    // 恢复成功才把回收站那条清掉；清不掉也无所谓，30 天后自己过期。
    let _ = desktop_trash::purge_one(store.data_dir(), &id);
    let _ = app.emit("notes-changed", ());
    Ok(created.id)
}

/// 彻底删掉回收站里的一条。
#[tauri::command]
fn trash_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    let store = default_store()?;
    desktop_trash::purge_one(store.data_dir(), &id)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

/// 清空回收站。
#[tauri::command]
fn trash_clear(app: AppHandle) -> Result<usize, AppError> {
    let store = default_store()?;
    let removed = desktop_trash::purge_all(store.data_dir())?;
    let _ = app.emit("notes-changed", ());
    Ok(removed)
}

/// 笔记里带 `📅 日期` 的待办行（只读汇总，不改笔记、不写 schedules.json）。
#[tauri::command]
fn notes_todos() -> Result<Vec<desktop_schedule::NoteTodo>, AppError> {
    desktop_schedule::todos_from_notes()}

/// 读人物卡（设置页填表单用）。
#[tauri::command]
fn persona_get() -> Result<desktop_persona::PersonaCard, AppError> {
    desktop_persona::load_card()
}

/// 保存人物卡。超限时返回 persona:too_long，并说明超了几个字。
#[tauri::command]
fn persona_save(card: desktop_persona::PersonaCard) -> Result<desktop_persona::PersonaCard, AppError> {
    desktop_persona::save_card(card)
}

/// 面板「我的安排」用：笔记待办 + 手工录入合并，只取未过期，最多 3 条。
#[tauri::command]
fn schedules_upcoming_merged() -> Result<Vec<desktop_schedule::ScheduleItem>, AppError> {
    desktop_schedule::upcoming_merged()
}

#[tauri::command]
fn notes_get(id: String) -> Result<Note, AppError> {
    default_store()?.read_note(&id)
}

#[tauri::command]
fn notes_create(app: AppHandle, request: SaveNoteRequest) -> Result<Note, AppError> {
    let note = default_store()?.create_note(request)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_update(app: AppHandle, id: String, request: SaveNoteRequest) -> Result<Note, AppError> {
    let note = default_store()?.update_note(&id, request)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    default_store()?.delete_note(&id)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

/// 置顶 / 取消置顶。只改元数据，不碰正文，也不动 `updatedAt`。
#[tauri::command]
fn notes_set_pinned(app: AppHandle, id: String, pinned: bool) -> Result<NoteMetadata, AppError> {
    let note = default_store()?.set_pinned(&id, pinned)?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_import_markdown(
    app: AppHandle,
    path: String,
    category: Option<String>,
) -> Result<Note, AppError> {
    let note = default_store()?
        .import_markdown_file(&PathBuf::from(path), &category.unwrap_or_default())?;
    let _ = app.emit("notes-changed", ());
    Ok(note)
}

#[tauri::command]
fn notes_export_markdown(id: String, path: String) -> Result<(), AppError> {
    default_store()?.export_markdown_file(&id, &PathBuf::from(path))
}

#[tauri::command]
fn read_external_file(path: String) -> Result<String, AppError> {
    std::fs::read_to_string(&path).map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })
}

#[tauri::command]
fn get_file_modified_time(path: String) -> Result<f64, AppError> {
    let metadata = std::fs::metadata(&path).map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })?;
    let modified = metadata.modified().map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok(duration.as_secs_f64() * 1000.0)
}

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, AppError> {
    let metadata = std::fs::metadata(&path).map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })?;
    Ok(metadata.len())
}

#[tauri::command]
fn save_external_file(path: String, content: String) -> Result<(), AppError> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError {
            code: "io".into(),
            message: e.to_string(),
            details: Default::default(),
        })?;
    }
    std::fs::write(&path, content).map_err(|e| AppError {
        code: "io".into(),
        message: e.to_string(),
        details: Default::default(),
    })
}

#[tauri::command]
fn categories_list() -> Result<Vec<String>, AppError> {
    default_store()?.list_categories()
}

#[tauri::command]
fn categories_create(app: AppHandle, name: String) -> Result<(), AppError> {
    default_store()?.create_category(&name)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn categories_rename(app: AppHandle, old_name: String, new_name: String) -> Result<(), AppError> {
    default_store()?.rename_category(&old_name, &new_name)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn categories_delete(app: AppHandle, name: String) -> Result<(), AppError> {
    default_store()?.delete_category(&name)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[tauri::command]
fn notes_move_category(
    app: AppHandle,
    id: String,
    category: String,
) -> Result<NoteMetadata, AppError> {
    let result = default_store()?.move_note_to_category(&id, &category)?;
    let _ = app.emit("notes-changed", ());
    Ok(result)
}

#[tauri::command]
fn images_save(request: tauri::ipc::Request<'_>) -> Result<String, AppError> {
    // 前端以 raw payload 直传图片字节流（noteId / 扩展名走 headers），
    // 避免二进制经 JSON 数字数组序列化的巨大内存与耗时开销
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(AppError {
            code: "invalidPayload".into(),
            message: "images_save expects a raw binary payload".into(),
            details: Default::default(),
        });
    };
    let header = |name: &str| -> Result<String, AppError> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| AppError {
                code: "invalidPayload".into(),
                message: format!("missing {name} header"),
                details: Default::default(),
            })
    };
    let note_id = header("x-note-id")?;
    let extension = header("x-image-ext")?;
    default_store()?.save_image(&note_id, data, &extension)
}

#[tauri::command]
fn images_save_from_path(note_id: String, file_path: String) -> Result<String, AppError> {
    let path = PathBuf::from(&file_path);
    let data = std::fs::read(&path)?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("png")
        .to_string();
    default_store()?.save_image(&note_id, &data, &extension)
}

#[tauri::command]
fn images_get_base_dir() -> Result<String, AppError> {
    let store = default_store()?;
    store
        .data_dir()
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError {
            code: "path".into(),
            message: "invalid data dir path".into(),
            details: Default::default(),
        })
}

#[tauri::command]
fn images_clean_unused(note_id: String, content: String) -> Result<Vec<String>, AppError> {
    default_store()?.clean_unused_images(&note_id, &content)
}

#[tauri::command]
fn config_get() -> Result<AppConfig, AppError> {
    default_store()?.load_config()
}

#[tauri::command]
fn copy_background_image(_app: AppHandle, source_path: String) -> Result<String, AppError> {
    let source = PathBuf::from(source_path.trim());
    if !source.is_file() {
        return Err(AppError {
            code: "invalidSource".into(),
            message: "background image source not found".into(),
            details: Default::default(),
        });
    }

    let store = default_store()?;
    let dir = store.data_dir().join("backgrounds");
    fs::create_dir_all(&dir)?;

    let old_config = store.load_config()?;
    if !old_config.background_image_path.is_empty() {
        let old_path = PathBuf::from(&old_config.background_image_path);
        if old_path.starts_with(&dir) && old_path.is_file() {
            let _ = fs::remove_file(&old_path);
        }
    }

    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("png");
    let dest = dir.join(format!("bg-{}.{}", uuid::Uuid::new_v4(), ext));
    fs::copy(&source, &dest)?;

    dest.to_str().map(str::to_string).ok_or_else(|| AppError {
        code: "path".into(),
        message: "invalid destination path".into(),
        details: Default::default(),
    })
}

#[tauri::command]
fn config_save(app: AppHandle, config: AppConfig) -> Result<AppConfig, AppError> {
    let store = default_store()?;
    let previous = store.load_config()?;
    desktop::apply_runtime_config(&app, &previous, &config).map_err(|error| {
        match error.downcast::<AppError>() {
            Ok(app_error) => *app_error,
            Err(error) => AppError {
                code: "desktopConfig".into(),
                message: error.to_string(),
                details: Default::default(),
            },
        }
    })?;
    let saved = store.save_config(config)?;
    if let Err(error) = desktop::refresh_shell_state(&app, &saved) {
        eprintln!("failed to refresh desktop shell state: {error}");
    }
    let _ = app.emit("config-changed", &saved);
    Ok(saved)
}

#[tauri::command]
fn config_migrate_data_dir(app: AppHandle, new_data_dir: String) -> Result<AppConfig, AppError> {
    let store = default_store()?;
    let new_path = PathBuf::from(&new_data_dir).join("floral");
    let new_store = store.migrate_data_to(&new_path)?;

    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(new_path.join("images"), true);
    let _ = scope.allow_directory(new_path.join("backgrounds"), true);

    let config = new_store.load_config()?;
    let _ = app.emit("config-changed", &config);
    Ok(config)
}

#[tauri::command]
fn global_shortcut_check(
    app: AppHandle,
    shortcut: String,
) -> Result<desktop::ShortcutCheckResult, AppError> {
    desktop::check_global_shortcut(&app, &shortcut)
}

#[tauri::command]
fn start_shortcut_recording(app: AppHandle) -> Result<(), AppError> {
    desktop::start_shortcut_recording(&app).map_err(|error| AppError {
        code: "shortcutRecording".into(),
        message: error.to_string(),
        details: Default::default(),
    })
}

#[tauri::command]
fn stop_shortcut_recording(app: AppHandle) -> Result<(), AppError> {
    desktop::stop_shortcut_recording(&app).map_err(|error| AppError {
        code: "shortcutRecording".into(),
        message: error.to_string(),
        details: Default::default(),
    })
}

#[tauri::command]
async fn open_notepad_window(
    app: AppHandle,
    note_id: Option<String>,
    bounds: Option<desktop::WindowBounds>,
) -> Result<String, AppError> {
    desktop::open_notepad_window(app, note_id, bounds).await
}

#[tauri::command]
async fn recycle_notepad_window(app: AppHandle, label: String) -> Result<(), AppError> {
    desktop::recycle_notepad_window(&app, &label)
}

/// Pre-shift the window by `(dx, dy)` logical px before starting an OS drag,
/// so a JS-side deadzone (e.g. tile double-click-to-edit) does not leave the
/// window lagging the cursor by the deadzone displacement.
#[tauri::command]
fn start_window_drag_with_offset(
    window: tauri::WebviewWindow,
    dx: f64,
    dy: f64,
) -> Result<(), AppError> {
    let scale = window.scale_factor()?;
    let pos = window.outer_position()?;
    let next_x = pos.x + (dx * scale).round() as i32;
    let next_y = pos.y + (dy * scale).round() as i32;
    window.set_position(tauri::PhysicalPosition::new(next_x, next_y))?;
    window.start_dragging()?;
    Ok(())
}

#[tauri::command]
async fn open_tile_window(
    app: AppHandle,
    note_id: String,
    bounds: Option<desktop::WindowBounds>,
) -> Result<String, AppError> {
    desktop::open_tile_window(app, note_id, bounds).await
}

#[tauri::command]
async fn toggle_tile_window(
    app: AppHandle,
    note_id: String,
    bounds: Option<desktop::WindowBounds>,
) -> Result<bool, AppError> {
    desktop::toggle_tile_window(app, note_id, bounds).await
}

#[tauri::command]
async fn open_note_in_editor(app: AppHandle, note_id: String) -> Result<(), AppError> {
    desktop::show_main_window(&app)?;
    let _ = app.emit("open-note", &note_id);
    Ok(())
}

#[tauri::command]
fn take_startup_file() -> Option<String> {
    desktop::take_startup_file()
}

fn cli_version_or_help_requested() -> bool {
    env::args().any(|arg| matches!(arg.as_str(), "--version" | "-V" | "--help" | "-h"))
}

#[cfg(windows)]
fn ensure_console() {
    use windows_sys::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};

    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            let _ = AllocConsole();
        }
    }
}

#[cfg(not(windows))]
fn ensure_console() {}

fn flush_attached_console_stdout() {
    let _ = std::io::stdout().flush();
}

fn print_cli_version() {
    let _ = writeln!(
        std::io::stdout(),
        "floral-notepaper {}",
        env!("CARGO_PKG_VERSION")
    );
    flush_attached_console_stdout();
}

fn print_cli_help() {
    let _ = writeln!(
        std::io::stdout(),
        "floral-notepaper {}\nFloral Notepaper - lightweight local note app\n\nUSAGE:\n    floral-notepaper [OPTIONS]\n\nOPTIONS:\n    -V, --version\n            Print version\n    -h, --help\n            Print help",
        env!("CARGO_PKG_VERSION"),
    );
    flush_attached_console_stdout();
}

pub fn try_exit_for_cli_version_or_help() {
    if !cli_version_or_help_requested() {
        return;
    }

    ensure_console();

    let wants_version = env::args().any(|arg| arg == "--version" || arg == "-V");
    let wants_help = env::args().any(|arg| arg == "--help" || arg == "-h");

    if wants_version {
        print_cli_version();
        std::process::exit(0);
    }

    if wants_help {
        print_cli_help();
        std::process::exit(0);
    }

    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(file_path) = desktop::extract_file_arg(&args) {
                let _ = app.emit("open-external-file", file_path);
            }
            let _ = desktop_panel::show_panel(app);
        }))
        .setup(|app| {
            if let Ok(store) = default_store() {
                let data = store.data_dir();
                let scope = app.asset_protocol_scope();
                let _ = scope.allow_directory(data.join("images"), true);
                let _ = scope.allow_directory(data.join("backgrounds"), true);
            }
            let updater_state = updater::UpdaterState::new(app.package_info().version.to_string());
            if let Err(error) = updater_state.initialize() {
                eprintln!("failed to initialize updater infrastructure: {error}");
            }
            app.manage(updater_state);
            // MSIX installs are updated by the Microsoft Store; the scheduler
            // must never drive in-app updates against a read-only package.
            if !updater::platform::has_package_identity() {
                updater::start_auto_check_scheduler(app.handle().clone());
            }
            desktop::setup_desktop(app)?;
            // 每天第一次启动备一份笔记，留最近 7 份；顺带清掉回收站里超过 30 天的。
            // 两件事都不允许影响启动：失败只留一行日志，窗口照常出来。
            match desktop_backup::backup_once() {
                Ok(outcome) => println!("[backup] {outcome:?}"),
                Err(error) => eprintln!("[backup] skipped: {}", error.message),
            }
            match desktop_trash::purge_expired_store() {
                Ok(0) => {}
                Ok(removed) => println!("[trash] purged {removed} expired note(s)"),
                Err(error) => eprintln!("[trash] purge skipped: {}", error.message),
            }
            Ok(())
        })
        .on_window_event(desktop::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            app_name,
            edge_strip_clicked,
            open_memo_window,
            hide_panel,
            panel_weather,
            chat_models,
            chat_send,
            schedules_upcoming,
            schedules_upcoming_merged,
            schedules_list,
            notes_todos,
            schedules_add,
            schedules_update,
            schedules_remove,
            notes_list,
            import_paths,
            imports_list,
            import_restore,
            trash_list,
            trash_restore,
            trash_delete,
            trash_clear,
            persona_get,
            persona_save,
            notes_get,
            notes_create,
            notes_update,
            notes_delete,
            notes_set_pinned,
            notes_import_markdown,
            notes_export_markdown,
            notes_move_category,
            read_external_file,
            save_external_file,
            get_file_modified_time,
            get_file_size,
            categories_list,
            categories_create,
            categories_rename,
            categories_delete,
            images_save,
            images_save_from_path,
            images_get_base_dir,
            images_clean_unused,
            config_get,
            copy_background_image,
            config_save,
            config_migrate_data_dir,
            global_shortcut_check,
            start_shortcut_recording,
            stop_shortcut_recording,
            open_notepad_window,
            recycle_notepad_window,
            start_window_drag_with_offset,
            open_tile_window,
            toggle_tile_window,
            open_note_in_editor,
            updater::commands::update_status,
            updater::commands::update_settings_get,
            updater::commands::update_settings_save,
            updater::commands::update_mirror_chyan_cdk_set,
            updater::commands::update_mirror_chyan_cdk_clear,
            updater::commands::update_mirror_chyan_cdk_get,
            updater::commands::update_check,
            updater::commands::update_download,
            updater::commands::update_install,
            updater::commands::update_install_prepare_report,
            updater::commands::update_cancel,
            take_startup_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = _event
            {
                if !has_visible_windows {
                    if let Err(error) = desktop_panel::show_panel(_app_handle) {
                        eprintln!("failed to show panel on dock click: {error}");
                    }
                }
            }
        });
}
