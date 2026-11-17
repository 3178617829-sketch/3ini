//! 花笺助手主窗口（面板小窗）。
//!
//! 层级关系（2026-11-15 用户拍板）：
//! - **花笺助手 = 这个 380×620 的面板小窗，它是主窗口**
//! - 原版花笺（1180×760，label="main"）只是「备忘录」功能的容器，
//!   只有在面板里点「备忘录」时才创建，不再自动出现在用户眼前。
//!
//! 呼出路径：右边缘 6px 小条点击、托盘左键、全局快捷键，都指向 `show_panel`。

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

/// 面板小窗的 window label。
pub const PANEL_LABEL: &str = "panel";

/// 小窗尺寸（物理像素之外，这里是逻辑尺寸，按用户拍板的 380×620）。
pub const PANEL_WIDTH: f64 = 380.0;
pub const PANEL_HEIGHT: f64 = 620.0;

/// 距屏幕右下角的留白。
pub const SCREEN_MARGIN: i32 = 24;

/// 显示面板小窗；不存在就创建。
pub fn show_panel(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        sync_strip_for_panel(app);
        return Ok(());
    }

    create_panel(app)?;
    sync_strip_for_panel(app);
    Ok(())
}

/// 创建面板小窗并摆到屏幕右下角。
fn create_panel(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("panel.html".into()))
        .title("3.ini")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(false)
        .skip_taskbar(false)
        .focused(true)
        .visible(false)
        .build()?;

    apply_panel_geometry(&window);
    window.show()?;
    let _ = window.set_focus();
    Ok(())
}

/// 把窗口摆到主屏右下角（留 `SCREEN_MARGIN` 空隙）。
///
/// 只定位置、不定尺寸：`inner_size(380,620)` 已经按逻辑像素设好了大小，
/// 这里如果拿 `outer_size()`（含阴影边框的物理尺寸）再 `set_size` 回去，
/// 会被二次放大（150% 缩放下实测 380×620 → 614×956），所以尺寸一律不碰。
fn apply_panel_geometry(window: &tauri::WebviewWindow) {
    let Some((left, top, right, bottom)) = platform::primary_monitor_bounds() else {
        return;
    };
    let size = window.outer_size().unwrap_or(PhysicalSize::new(
        (PANEL_WIDTH * 1.5) as u32,
        (PANEL_HEIGHT * 1.5) as u32,
    ));
    let x = right - size.width as i32 - SCREEN_MARGIN;
    let y = bottom - size.height as i32 - SCREEN_MARGIN;
    let x = x.max(left);
    let y = y.max(top);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// 面板当前是否可见。
pub fn panel_visible(app: &AppHandle) -> bool {
    app.get_webview_window(PANEL_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 隐藏面板（如果存在）。
pub fn hide_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        let _ = window.hide();
    }
    sync_strip_for_panel(app);
}

/// 面板窗口的关闭请求：隐藏而不是销毁，并露出右边缘小条。
///
/// 面板是常驻窗口——关掉它程序就该退出吗？不该。用户随时可以从小条或托盘再叫回来，
/// 所以这里一律拦下关闭、改为隐藏。
pub fn handle_panel_close(window: &tauri::WebviewWindow) {
    let _ = window.hide();
    sync_strip_for_panel(window.app_handle());
}

/// 面板显隐变化后刷新右边缘小条：面板可见 → 藏起小条；面板不可见 → 露出小条。
pub fn sync_strip_for_panel(app: &AppHandle) {
    crate::desktop_edge_strip::sync_strip_visibility(app);
}

#[cfg(target_os = "windows")]
mod platform {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };

    /// 主屏工作区边界 → (left, top, right, bottom)，物理像素。
    pub fn primary_monitor_bounds() -> Option<(i32, i32, i32, i32)> {
        unsafe {
            let point = POINT { x: 0, y: 0 };
            let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTOPRIMARY);
            if monitor.is_null() {
                return None;
            }
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return None;
            }
            Some((
                info.rcMonitor.left,
                info.rcMonitor.top,
                info.rcMonitor.right,
                info.rcMonitor.bottom,
            ))
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    pub fn primary_monitor_bounds() -> Option<(i32, i32, i32, i32)> {
        None
    }
}
