//! 「我的安排」数据层。
//!
//! 存 `schedules.json`，放在花笺自己的 `data_dir` 里（和 `metadata.json` 平级），
//! 这样用户改数据目录时它跟着一起迁移，不会丢。
//!
//! 设计口径（2026-11-15 用户拍板）：
//! - 面板最多显示 3 条，按时间由近到远排；
//! - 过期条目自动从面板收起，但**数据保留**，手动点进去还能看到；
//! - 对话里只要不是翻译模型就自动拆安排（拆解在 `desktop_chat.rs` 里做，
//!   落盘统一走本模块的 `add`）；
//! - 到点不做系统弹窗，只让面板上看得到。

use crate::json_io::write_json_atomic;
use crate::services::notes::{default_store, AppError};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// 数据文件名。和 `metadata.json` 平级放在 `data_dir`。
const SCHEDULE_FILE: &str = "schedules.json";

/// 面板一行最多显示几条。
pub const PANEL_MAX_ITEMS: usize = 3;

/// 一条安排。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleItem {
    pub id: String,
    /// 要做的事，比如「去社区医院做药学实习报到」。
    pub title: String,
    /// 开始时间，本地时区，格式 `YYYY-MM-DDTHH:MM`。只记日期时取 00:00。
    pub at: String,
    /// true = 只有日期没有具体时刻，面板上显示成「全天」。
    #[serde(default)]
    pub all_day: bool,
    /// 来源：`chat` = 对话里自动拆的，`manual` = 手动录的。
    #[serde(default)]
    pub source: String,
    /// 建的时候原话，方便手动核对 AI 拆得对不对。
    #[serde(default)]
    pub raw: String,
    #[serde(default)]
    pub created_at: String,
}

/// 磁盘上的整体结构。带 `version` 方便以后改结构。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ScheduleFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    items: Vec<ScheduleItem>,
}

fn default_version() -> u32 {
    1
}

fn schedule_path() -> Result<PathBuf, AppError> {
    let store = default_store()?;
    Ok(store.data_dir().join(SCHEDULE_FILE))
}

fn read_file(path: &Path) -> Result<ScheduleFile, AppError> {
    if !path.exists() {
        return Ok(ScheduleFile {
            version: default_version(),
            items: Vec::new(),
        });
    }
    let text = std::fs::read_to_string(path)?;
    if text.trim().is_empty() {
        return Ok(ScheduleFile {
            version: default_version(),
            items: Vec::new(),
        });
    }
    serde_json::from_str(&text).map_err(|error| AppError {
        code: "schedule:corrupt".into(),
        message: format!("安排数据读不出来：{error}"),
        details: Default::default(),
    })
}

fn write_file(path: &Path, file: &ScheduleFile) -> Result<(), AppError> {
    write_json_atomic(path, file)
}

fn now_local() -> DateTime<Local> {
    Local::now()
}

fn format_at(at: NaiveDateTime) -> String {
    at.format("%Y-%m-%dT%H:%M").to_string()
}

/// 解析 `YYYY-MM-DDTHH:MM`（也容忍 `YYYY-MM-DD HH:MM` 和纯日期）。
pub fn parse_at(text: &str) -> Option<NaiveDateTime> {
    let text = text.trim();
    if let Ok(dt) = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M") {
        return Some(dt);
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M") {
        return Some(dt);
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Some(date.and_time(NaiveTime::MIN));
    }
    None
}

/// 把一条安排写进去。`source` 用 `chat` 或 `manual`。
pub fn add(
    title: &str,
    at: &str,
    all_day: bool,
    source: &str,
    raw: &str,
) -> Result<ScheduleItem, AppError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError {
            code: "schedule:emptyTitle".into(),
            message: "安排的内容不能是空的。".into(),
            details: Default::default(),
        });
    }
    let parsed = parse_at(at).ok_or_else(|| AppError {
        code: "schedule:badTime".into(),
        message: format!("时间格式看不懂：「{at}」。要 YYYY-MM-DDTHH:MM。"),
        details: Default::default(),
    })?;

    let path = schedule_path()?;
    let mut file = read_file(&path)?;
    let item = ScheduleItem {
        id: Uuid::new_v4().to_string(),
        title: title.to_string(),
        at: format_at(parsed),
        all_day,
        source: source.to_string(),
        raw: raw.to_string(),
        created_at: now_local().format("%Y-%m-%dT%H:%M:%S").to_string(),
    };
    file.items.push(item.clone());
    sort_items(&mut file.items);
    write_file(&path, &file)?;
    Ok(item)
}

fn sort_items(items: &mut [ScheduleItem]) {
    items.sort_by(|a, b| {
        let ta = parse_at(&a.at);
        let tb = parse_at(&b.at);
        ta.cmp(&tb)
    });
}

/// 面板要显示的那几条：只取**还没过期**的，按时间由近到远，最多 `PANEL_MAX_ITEMS` 条。
///
/// 过期条目不出现在这里，但文件里还在——手动录入弹窗走 `list_all` 看得到。
pub fn upcoming() -> Result<Vec<ScheduleItem>, AppError> {
    let path = schedule_path()?;
    let file = read_file(&path)?;
    let now = now_local().naive_local();
    let mut items: Vec<ScheduleItem> = file
        .items
        .into_iter()
        .filter(|item| match parse_at(&item.at) {
            Some(at) => at >= now,
            // 时间读不出来的条目（手改坏了）也留着，别静默吞掉
            None => true,
        })
        .collect();
    sort_items(&mut items);
    items.truncate(PANEL_MAX_ITEMS);
    Ok(items)
}

/// 全部条目（含过期），给手动录入弹窗和「历史」用。按时间倒序（最近的在前）。
pub fn list_all() -> Result<Vec<ScheduleItem>, AppError> {
    let path = schedule_path()?;
    let mut file = read_file(&path)?;
    file.items.sort_by(|a, b| parse_at(&b.at).cmp(&parse_at(&a.at)));
    Ok(file.items)
}

/// 删一条。
pub fn remove(id: &str) -> Result<(), AppError> {
    let path = schedule_path()?;
    let mut file = read_file(&path)?;
    let before = file.items.len();
    file.items.retain(|item| item.id != id);
    if file.items.len() == before {
        return Err(AppError {
            code: "schedule:notFound".into(),
            message: "没找到这条安排，可能已经被删掉了。".into(),
            details: Default::default(),
        });
    }
    write_file(&path, &file)
}

/// 改一条（标题和时间）。只给手动录入用。
pub fn update(id: &str, title: &str, at: &str, all_day: bool) -> Result<ScheduleItem, AppError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError {
            code: "schedule:emptyTitle".into(),
            message: "安排的内容不能是空的。".into(),
            details: Default::default(),
        });
    }
    let parsed = parse_at(at).ok_or_else(|| AppError {
        code: "schedule:badTime".into(),
        message: format!("时间格式看不懂：「{at}」。要 YYYY-MM-DDTHH:MM。"),
        details: Default::default(),
    })?;

    let path = schedule_path()?;
    let mut file = read_file(&path)?;
    let mut updated: Option<ScheduleItem> = None;
    for item in file.items.iter_mut() {
        if item.id == id {
            item.title = title.to_string();
            item.at = format_at(parsed);
            item.all_day = all_day;
            updated = Some(item.clone());
            break;
        }
    }
    let updated = updated.ok_or_else(|| AppError {
        code: "schedule:notFound".into(),
        message: "没找到这条安排。".into(),
        details: Default::default(),
    })?;
    sort_items(&mut file.items);
    write_file(&path, &file)?;
    Ok(updated)
}

/// 给对话用的「当前日期」上下文，避免模型把「明天」算错。
///
/// 实测（2026-11-15）：system 里不给日期时，Spark 把「明天」算成 +2 天；
/// 给了「今天是 2026-11-15 星期六」之后四个用例全对。
pub fn today_context() -> String {
    let now = now_local();
    let weekday = match now.format("%u").to_string().as_str() {
        "1" => "星期一",
        "2" => "星期二",
        "3" => "星期三",
        "4" => "星期四",
        "5" => "星期五",
        "6" => "星期六",
        _ => "星期日",
    };
    format!(
        "今天是 {} {}，现在 {}。",
        now.format("%Y-%m-%d"),
        weekday,
        now.format("%H:%M")
    )
}

// ── 笔记里的待办行 ──────────────────────────
//
// 用户拍板（ARCHITECTURE.md 四·2.2）：备忘录里写
// `- [ ] 去社区医院报到 📅 2026-11-16`
// 这一行要自动出现在「我的安排」里，但用户**不用先决定这是备忘还是任务**。
//
// 分工：这里只负责**解析和汇总**，不改笔记原文件、不往 schedules.json 写。
// 原因：笔记是用户亲手写的东西，程序擅自往里加行是污染；
// 而 schedules.json 是「安排」的权威数据源，写进去之后用户删笔记那条
// 会变成幽灵安排。所以这里走「只读汇总」——笔记是源，安排目录实时派生。
//
// 与 schedules.json 手工录入的条目合并显示：面板把两边都拿到，按时间排。

/// 从一段 markdown 正文里解析出的待办。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteTodo {
    /// 待办的事，去掉 `- [ ]` 和日期标记之后的部分。
    pub title: String,
    /// `YYYY-MM-DDT00:00`（只认日期，笔记里不记具体时刻）。
    pub at: String,
    /// 来自哪条笔记的 id，点一下能跳回去改。
    pub note_id: String,
    pub note_title: String,
    /// 原行文字，方便核对解析对不对。
    pub raw: String,
}

/// 一行待办的最小匹配：`- [ ] 内容` 或 `* [ ] 内容`（不认 `- [x]`，完成的不要）。
///
/// 日期标记只用 Obsidian Tasks 通行的 `📅 2026-11-16` 写法
/// （ARCHITECTURE.md 四·2.4 说明过为什么不用别的格式）。
fn parse_todo_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    // 先剥列表符号
    let rest = if let Some(r) = trimmed.strip_prefix("- [ ]") {
        r
    } else if let Some(r) = trimmed.strip_prefix("* [ ]") {
        r
    } else {
        return None;
    };
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }

    // 找 📅 之后紧跟的日期。不用 regex 依赖，手动定位。
    let marker = rest.find('📅')?;
    let tail = rest[marker + '📅'.len_utf8()..].trim_start();
    let date_part: String = tail.chars().take(10).collect();
    // 必须是 YYYY-MM-DD
    if date_part.len() != 10
        || NaiveDate::parse_from_str(&date_part, "%Y-%m-%d").is_err()
    {
        return None;
    }

    let title = rest[..marker].trim().to_string();
    if title.is_empty() {
        return None;
    }
    Some((title, date_part))
}

/// 扫一遍全库笔记，把带日期的待办行汇总出来。
///
/// 失败策略：单条笔记读不出来就跳过它（可能是刚被别处删了），
/// 整体不失败——不能让一条坏笔记把整张安排列表弄空。
pub fn todos_from_notes() -> Result<Vec<NoteTodo>, AppError> {
    let store = default_store()?;
    let mut out: Vec<NoteTodo> = Vec::new();
    let notes = store.list_notes()?;
    for meta in notes {
        let content = match store.read_note(&meta.id) {
            Ok(note) => note.content,
            Err(_) => continue,
        };
        for line in content.lines() {
            if let Some((title, date)) = parse_todo_line(line) {
                out.push(NoteTodo {
                    title,
                    at: format!("{date}T00:00"),
                    note_id: meta.id.clone(),
                    note_title: meta.title.clone(),
                    raw: line.trim().to_string(),
                });
            }
        }
    }
    Ok(out)
}

/// 面板用：笔记待办 + 手工录入，合成一张表，按时间由近到远，最多 `PANEL_MAX_ITEMS` 条。
///
/// 只取还没过期的。同一件事如果在两边都有，**以笔记的为准**
/// （笔记是用户亲手写的原话，可信度高于 AI 从对话里拆出来的）。
pub fn upcoming_merged() -> Result<Vec<ScheduleItem>, AppError> {
    let mut items = upcoming()?;
    let from_notes = todos_from_notes().unwrap_or_default();
    let now = now_local().naive_local();

    for todo in from_notes {
        let Some(at) = parse_at(&todo.at) else {
            continue;
        };
        if at < now {
            continue;
        }
        let dup = items.iter().any(|item| {
            item.title == todo.title && parse_at(&item.at).map(|t| t == at).unwrap_or(false)
        });
        if dup {
            continue;
        }
        items.push(ScheduleItem {
            id: format!("note:{}", todo.note_id),
            title: todo.title,
            at: todo.at,
            all_day: true,
            source: "note".into(),
            raw: todo.raw,
            created_at: String::new(),
        });
    }

    sort_items(&mut items);
    items.truncate(PANEL_MAX_ITEMS);
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_at_accepts_three_forms() {
        assert_eq!(
            parse_at("2026-11-16T15:00"),
            Some(
                NaiveDate::from_ymd_opt(2026, 11, 16)
                    .unwrap()
                    .and_hms_opt(15, 0, 0)
                    .unwrap()
            )
        );
        assert_eq!(
            parse_at("2026-11-16 15:00"),
            Some(
                NaiveDate::from_ymd_opt(2026, 11, 16)
                    .unwrap()
                    .and_hms_opt(15, 0, 0)
                    .unwrap()
            )
        );
        assert_eq!(
            parse_at("2026-11-16"),
            Some(
                NaiveDate::from_ymd_opt(2026, 11, 16)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
            )
        );
        assert_eq!(parse_at("明天下午三点"), None);
    }

    #[test]
    fn today_context_has_date_and_weekday() {
        let ctx = today_context();
        assert!(ctx.starts_with("今天是 "), "实际：{ctx}");
        assert!(ctx.contains("星期"), "实际：{ctx}");
        assert!(ctx.contains("现在"), "实际：{ctx}");
    }

    #[test]
    fn sort_items_orders_by_time_ascending() {
        let mut items = vec![
            ScheduleItem {
                id: "b".into(),
                title: "晚".into(),
                at: "2026-11-17T09:00".into(),
                all_day: false,
                source: "chat".into(),
                raw: String::new(),
                created_at: String::new(),
            },
            ScheduleItem {
                id: "a".into(),
                title: "早".into(),
                at: "2026-11-16T09:00".into(),
                all_day: false,
                source: "chat".into(),
                raw: String::new(),
                created_at: String::new(),
            },
        ];
        sort_items(&mut items);
        assert_eq!(items[0].id, "a");
        assert_eq!(items[1].id, "b");
    }

    #[test]
    fn parse_todo_line_reads_title_and_date() {
        let got = parse_todo_line("- [ ] 去社区医院报到 📅 2026-11-16");
        assert_eq!(
            got,
            Some(("去社区医院报到".to_string(), "2026-11-16".to_string()))
        );
        // 星号列表也认
        assert_eq!(
            parse_todo_line("* [ ] 交作业 📅 2026-12-01"),
            Some(("交作业".to_string(), "2026-12-01".to_string()))
        );
        // 缩进不影响
        assert_eq!(
            parse_todo_line("    - [ ] 缩进也行 📅 2026-11-20"),
            Some(("缩进也行".to_string(), "2026-11-20".to_string()))
        );
    }

    #[test]
    fn parse_todo_line_rejects_non_todos() {
        // 已完成的不算
        assert_eq!(parse_todo_line("- [x] 已经做完 📅 2026-11-16"), None);
        // 没有日期的不算（用户拍板：只认带 📅 的行）
        assert_eq!(parse_todo_line("- [ ] 没写日期"), None);
        // 日期写坏的不算
        assert_eq!(parse_todo_line("- [ ] 日期写坏了 📅 2026-13-45"), None);
        // 普通正文不算
        assert_eq!(parse_todo_line("今天天气不错 📅 2026-11-16"), None);
        // 只有日期没有内容的不算
        assert_eq!(parse_todo_line("- [ ] 📅 2026-11-16"), None);
    }

    #[test]
    fn parse_todo_line_keeps_extra_text_after_date() {
        // 日期后面还有别的标记（比如 Obsidian Tasks 的优先级），标题只取日期前的部分
        assert_eq!(
            parse_todo_line("- [ ] 复习药理学 📅 2026-11-18 优先级高"),
            Some(("复习药理学".to_string(), "2026-11-18".to_string()))
        );
    }
}
