// 笔记软删除：删掉的笔记先进 `.huajian\trash\`，留 30 天可还原。
//
// 为什么要单独一层，而不是直接用 Windows 回收站：
// 用户拍板（HANDOFF 需求表第 11 条）「软删除到 `.huajian\trash\`，留 30 天」。
// 回收站虽然也能找回，但用户在应用里看不到、也不知道自己删过什么；
// 放在数据目录下，才谈得上「在应用内还原」和「定期清理」。
//
// 存法：每条被删的笔记在 `.huajian\trash\<id>\` 下放两样东西——
//   `note.md`        正文，按原文件名存（`<uuid>_<标题>.md`），便于人直接打开看；
//   `record.json`    还原所需的全部信息（原 id / 标题 / 分类 / 文件名 / 删除时间）。
// 用「一条一个目录」而不是一个大 json：删到一半断电时，坏掉的只是那一条。

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::services::notes::{AppError, NoteMetadata};

/// 回收站保留天数。用户拍板 30 天。
pub const TRASH_RETAIN_DAYS: i64 = 30;

/// 相对数据目录的回收站路径。
const TRASH_DIR: &str = ".huajian/trash";
/// 记录文件名。
const RECORD_FILE: &str = "record.json";
/// 正文文件名（固定名，原名记在 record 里，避免文件名里带特殊字符出问题）。
const BODY_FILE: &str = "note.md";

/// 一条回收站记录。`record.json` 里存的就是它。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// 原笔记 id，还原时用它重建元数据。
    pub id: String,
    /// 原标题。
    pub title: String,
    /// 原文件名（`<uuid>_<标题>.md`）。
    pub file_name: String,
    /// 原分类。空字符串表示未分类。
    #[serde(default)]
    pub category: String,
    /// 原创建时间。
    pub created_at: DateTime<Utc>,
    /// 删除时间（UTC），也用来算「还剩几天」。
    pub deleted_at: DateTime<Utc>,
    /// 字数，还原时直接放回元数据。
    #[serde(default)]
    pub word_count: usize,
    /// 预览，列表里显示用。
    #[serde(default)]
    pub preview: String,
}

impl TrashEntry {
    /// 距离自动清理还有几天（已过期为负数）。
    pub fn days_left(&self) -> i64 {
        let deadline = self.deleted_at + Duration::days(TRASH_RETAIN_DAYS);
        (deadline - Utc::now()).num_days()
    }
}

/// 回收站列表的一项：记录 + 正文 + 剩余天数。
///
/// `days_left` 要显式放进结构体而不是靠方法：serde 不序列化方法，
/// 前端拿不到就只能自己算 30 天窗口，两处规则早晚会分叉。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryView {
    #[serde(flatten)]
    pub entry: TrashEntry,
    /// 正文（读不到时是空串）。
    pub body: String,
    /// 距离自动清理还有几天（已过期为负数）。
    pub days_left: i64,
}

/// 回收站目录。
pub fn trash_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(TRASH_DIR)
}

/// 把一条笔记挪进回收站。
///
/// `source` 是磁盘上的正文文件，`metadata` 是它在元数据里的那份记录。
/// 先写 `record.json` 再挪正文：反过来的话，如果挪完还没写记录就断电，
/// 回收站里会出现一个「有正文、不知道怎么还」的孤儿目录。
pub fn move_to_trash(
    data_dir: &Path,
    source: &Path,
    metadata: &NoteMetadata,
) -> Result<TrashEntry, AppError> {
    let entry = TrashEntry {
        id: metadata.id.clone(),
        title: metadata.title.clone(),
        file_name: metadata.file_name.clone(),
        category: metadata.category.clone(),
        created_at: metadata.created_at,
        deleted_at: Utc::now(),
        word_count: metadata.word_count,
        preview: metadata.preview.clone(),
    };

    // 同一条 id 被删两次时（理论上不会，但别让旧目录挡住新记录），先清掉旧的。
    let dir = trash_dir(data_dir).join(&entry.id);
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
    fs::create_dir_all(&dir).map_err(|error| {
        AppError::new("trash:mkdirFailed", format!("建回收站目录失败: {error}"))
            .with_detail("path", dir.display().to_string())
    })?;

    let record_path = dir.join(RECORD_FILE);
    let json = serde_json::to_vec_pretty(&entry)
        .map_err(|error| AppError::new("trash:encodeFailed", format!("写记录失败: {error}")))?;
    fs::write(&record_path, json).map_err(|error| {
        AppError::new("trash:writeFailed", format!("写回收站记录失败: {error}"))
            .with_detail("path", record_path.display().to_string())
    })?;

    if source.exists() {
        // 同盘 rename 是原子操作，比复制安全：要么成功，要么原文还在。
        let target = dir.join(BODY_FILE);
        if let Err(rename_error) = fs::rename(source, &target) {
            // 跨盘时 rename 会失败，退回复制 + 删源。
            fs::copy(source, &target).map_err(|copy_error| {
                AppError::new(
                    "trash:moveFailed",
                    format!("挪进回收站失败: {rename_error} / {copy_error}，原笔记还在"),
                )
                .with_detail("path", source.display().to_string())
            })?;
            fs::remove_file(source).map_err(|error| {
                AppError::new("trash:moveFailed", format!("挪进回收站后删源失败: {error}"))
                    .with_detail("path", source.display().to_string())
            })?;
        }
    }

    Ok(entry)
}

/// 列出回收站里的全部记录，按删除时间倒序（最近的在前）。
///
/// 单个目录读坏不影响其它记录：坏的那个跳过，不把整张列表弄空。
pub fn list_trash(data_dir: &Path) -> Result<Vec<TrashEntry>, AppError> {
    let root = trash_dir(data_dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&root).map_err(|error| {
        AppError::new("trash:readFailed", format!("读回收站失败: {error}"))
            .with_detail("path", root.display().to_string())
    })?;
    for item in read_dir.flatten() {
        let path = item.path();
        if !path.is_dir() {
            continue;
        }
        let record_path = path.join(RECORD_FILE);
        if let Ok(text) = fs::read(&record_path) {
            if let Ok(entry) = serde_json::from_slice::<TrashEntry>(&text) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(entries)
}

/// 读回收站里某条记录的正文。找不到正文时返回空串（记录还在，正文没了）。
pub fn read_trash_body(data_dir: &Path, id: &str) -> String {
    let path = trash_dir(data_dir).join(id).join(BODY_FILE);
    fs::read_to_string(&path).unwrap_or_default()
}

/// 从回收站彻底删掉一条。找不到就当已经删了，不报错。
pub fn purge_one(data_dir: &Path, id: &str) -> Result<(), AppError> {
    let dir = trash_dir(data_dir).join(id);
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|error| {
        AppError::new("trash:purgeFailed", format!("彻底删除失败: {error}"))
            .with_detail("path", dir.display().to_string())
    })
}

/// 清理超过保留期的记录，返回清掉了几条。
///
/// 只在启动时和每次进回收站时调一次，不需要定时器。
/// 判据是 `record.json` 里的 `deleted_at`，不是目录的 mtime——
/// 目录 mtime 会被备份工具、杀软、同步盘改掉，不可信。
pub fn purge_expired(data_dir: &Path) -> Result<usize, AppError> {
    let entries = list_trash(data_dir)?;
    let now = Utc::now();
    let mut removed = 0usize;
    for entry in entries {
        if now - entry.deleted_at >= Duration::days(TRASH_RETAIN_DAYS) {
            if purge_one(data_dir, &entry.id).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// 启动时用：自己从 `NoteStore` 拿数据目录，再清理过期记录。
pub fn purge_expired_store() -> Result<usize, AppError> {
    let store = crate::services::notes::default_store()?;
    purge_expired(store.data_dir())
}

/// 清空整个回收站（不看保留期），返回清掉了几条。
///
/// 用户点「清空」时是按数量确认的，不是按日期——所以这里必须全清，
/// 不能复用 `purge_expired`，否则会「点了清空还剩几条没到期的」。
pub fn purge_all(data_dir: &Path) -> Result<usize, AppError> {
    let entries = list_trash(data_dir)?;
    let mut removed = 0usize;
    for entry in entries {
        if purge_one(data_dir, &entry.id).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 列出回收站（含正文预览），给面板的「最近删除」用。
pub fn list_trash_with_body(data_dir: &Path) -> Result<Vec<TrashEntryView>, AppError> {
    let entries = list_trash(data_dir)?;
    Ok(entries
        .into_iter()
        .map(|entry| {
            let body = read_trash_body(data_dir, &entry.id);
            let days_left = entry.days_left();
            TrashEntryView {
                entry,
                body,
                days_left,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("huajian-trash-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn sample_metadata(id: &str) -> NoteMetadata {
        NoteMetadata {
            id: id.to_string(),
            title: "测试笔记".into(),
            file_name: format!("{id}_测试笔记.md"),
            category: String::new(),
            created_at: Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
            updated_at: Utc.with_ymd_and_hms(2026, 1, 2, 0, 0, 0).unwrap(),
            word_count: 3,
            preview: "预览".into(),
            pinned: false,
        }
    }

    #[test]
    fn move_to_trash_keeps_body_and_record() {
        let data = temp_dir("move");
        let source = data.join("abc_测试笔记.md");
        fs::write(&source, "# 测试笔记\n\n正文").unwrap();

        let metadata = sample_metadata("abc");
        let entry = move_to_trash(&data, &source, &metadata).expect("move into trash");

        assert!(!source.exists(), "源文件应已挪走");
        assert_eq!(entry.id, "abc");
        let body = read_trash_body(&data, "abc");
        assert!(body.contains("正文"), "正文应保留, got {body:?}");

        let listed = list_trash(&data).expect("list trash");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "测试笔记");

        fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn purge_expired_removes_only_old_entries() {
        let data = temp_dir("purge");
        // 一条 40 天前的、一条今天的。
        for (id, days_ago) in [("old", 40i64), ("fresh", 0i64)] {
            let dir = trash_dir(&data).join(id);
            fs::create_dir_all(&dir).unwrap();
            let entry = TrashEntry {
                id: id.to_string(),
                title: id.into(),
                file_name: format!("{id}.md"),
                category: String::new(),
                created_at: Utc::now(),
                deleted_at: Utc::now() - Duration::days(days_ago),
                word_count: 0,
                preview: String::new(),
            };
            let json = serde_json::to_vec(&entry).unwrap();
            fs::write(dir.join(RECORD_FILE), json).unwrap();
            fs::write(dir.join(BODY_FILE), "x").unwrap();
        }

        let removed = purge_expired(&data).expect("purge");
        assert_eq!(removed, 1, "只该清掉过期那一条");

        let left = list_trash(&data).expect("list");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "fresh");

        fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn purge_one_is_idempotent() {
        let data = temp_dir("purge-one");
        // 目录不存在时不该报错。
        purge_one(&data, "nonexistent").expect("purge missing should be ok");
        fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn list_trash_skips_broken_record() {
        let data = temp_dir("broken");
        let good = trash_dir(&data).join("good");
        fs::create_dir_all(&good).unwrap();
        fs::write(
            good.join(RECORD_FILE),
            serde_json::to_vec(&TrashEntry {
                id: "good".into(),
                title: "好".into(),
                file_name: "good.md".into(),
                category: String::new(),
                created_at: Utc::now(),
                deleted_at: Utc::now(),
                word_count: 0,
                preview: String::new(),
            })
            .unwrap(),
        )
        .unwrap();

        let bad = trash_dir(&data).join("bad");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join(RECORD_FILE), b"{ this is not json").unwrap();

        let listed = list_trash(&data).expect("list should survive broken record");
        assert_eq!(listed.len(), 1, "坏记录应被跳过");
        assert_eq!(listed[0].id, "good");

        fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn days_left_counts_from_retain_window() {
        let entry = TrashEntry {
            id: "x".into(),
            title: "x".into(),
            file_name: "x.md".into(),
            category: String::new(),
            created_at: Utc::now(),
            deleted_at: Utc::now() - Duration::days(29),
            word_count: 0,
            preview: String::new(),
        };
        // 29 天前删的，30 天保留期还剩 1 天左右（允许跨秒的边界抖动）。
        assert!(entry.days_left() <= 1);
        assert!(entry.days_left() >= 0);
    }
}
