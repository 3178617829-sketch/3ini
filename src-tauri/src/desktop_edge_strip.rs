//! 右边缘小条：屏幕右边缘一条常驻的淡竹绿竖条，点一下呼出主窗口。
//!
//! 与旧的「热区」不同，这里不轮询光标位置。小条是一个真正的窗口，
//! 鼠标点进来由系统送 click 事件，程序不需要每秒查 8 次光标——
//! 既省电，也不会因为光标恰好在窗口右缘而反复重定位主窗口。
//!
//! 行为约定（用户 m00379 / m00492 拍板）：
//! - 宽度 6px，高度与主屏同高，贴主屏右边缘；
//! - 一直可见的淡竹绿半透明，不做「鼠标靠近才显色」；
//! - 只响应左键单击：呼出并聚焦主窗口，无右键菜单、不可拖动；
//! - 主窗口打开时小条自动隐藏，主窗口收起后重新出现。

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::desktop_panel::{panel_visible, show_panel};

/// 小条窗口的 label。
pub const EDGE_STRIP_LABEL: &str = "edge-strip";
/// 小条宽度（物理像素）。
pub const STRIP_WIDTH_PX: u32 = 6;

/// 创建（或重新定位）右边缘小条。重复调用是安全的。
pub fn ensure_strip(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some((right, top, bottom)) = platform::primary_monitor_bounds() else {
        // 拿不到主屏信息（非 Windows 或异常），不做小条。
        return Ok(());
    };

    let height = (bottom - top).max(1) as u32;
    let width = STRIP_WIDTH_PX;
    let x = right - width as i32;
    let y = top;

    if let Some(window) = app.get_webview_window(EDGE_STRIP_LABEL) {
        window.set_size(PhysicalSize::new(width, height))?;
        window.set_position(PhysicalPosition::new(x, y))?;
        sync_strip_visibility(app);
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, EDGE_STRIP_LABEL, WebviewUrl::App("edge-strip.html".into()))
        .title("3.ini")
        // 尺寸和位置一律走 PhysicalSize/PhysicalPosition：这台机器缩放是 150%，
        // builder 的 inner_size/position 吃的是逻辑像素，传 6 会被放大成 9 甚至
        // 被系统最小宽度撑到 135——所以先给个占位值，建完立刻用物理单位锁定。
        .inner_size(6.0, 600.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()?;

    window.set_size(PhysicalSize::new(width, height))?;
    window.set_position(PhysicalPosition::new(x, y))?;

    sync_strip_visibility(app);
    let _ = window;
    Ok(())
}

/// 小条是否应该显示：花笺助手面板不可见时才显示。
pub fn sync_strip_visibility(app: &AppHandle) {
    let should_show = !panel_visible(app);
    let Some(window) = app.get_webview_window(EDGE_STRIP_LABEL) else {
        return;
    };
    let result = if should_show {
        window.show()
    } else {
        window.hide()
    };
    if let Err(error) = result {
        eprintln!("edge-strip: failed to toggle visibility: {error}");
    }
}

/// 小条被点击：呼出花笺助手面板。由前端 `invoke` 调用。
pub fn on_strip_clicked(app: &AppHandle) {
    if let Err(error) = show_panel(app) {
        eprintln!("edge-strip: failed to show panel: {error}");
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };

    /// 主屏的 (right, top, bottom)，单位物理像素。
    pub fn primary_monitor_bounds() -> Option<(i32, i32, i32)> {
        let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let ok = unsafe { GetMonitorInfoW(monitor, &mut info) };
        if ok == 0 {
            return None;
        }
        Some((
            info.rcMonitor.right,
            info.rcMonitor.top,
            info.rcMonitor.bottom,
        ))
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    pub fn primary_monitor_bounds() -> Option<(i32, i32, i32)> {
        None
    }
}

/// 供 `desktop.rs` 直接调用。
pub fn primary_monitor_bounds() -> Option<(i32, i32, i32)> {
    platform::primary_monitor_bounds()
}

#[cfg(test)]
mod tests {
    /// 小条几何：贴右边缘、垂直铺满主屏。
    fn strip_geometry(right: i32, top: i32, bottom: i32, width: u32) -> (i32, i32, u32) {
        let height = (bottom - top).max(1) as u32;
        (right - width as i32, top, height)
    }

    #[test]
    fn strip_sits_flush_against_right_edge() {
        let (x, y, h) = strip_geometry(2560, 0, 1600, 6);
        assert_eq!(x, 2554);
        assert_eq!(y, 0);
        assert_eq!(h, 1600);
    }

    #[test]
    fn strip_respects_non_zero_monitor_top() {
        // 副屏或任务栏在上时的情形：top 不是 0。
        let (x, y, h) = strip_geometry(1920, -1080, 0, 6);
        assert_eq!(x, 1914);
        assert_eq!(y, -1080);
        assert_eq!(h, 1080);
    }

    #[test]
    fn degenerate_monitor_height_falls_back_to_one() {
        let (_, _, h) = strip_geometry(1920, 500, 500, 6);
        assert_eq!(h, 1);
    }
}
