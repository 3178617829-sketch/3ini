//! 「拖进来即收」的收件层。
//!
//! 规则出自 ARCHITECTURE.md 四·2.3（用户杨艺拍板）：
//! - `.txt` / `.md` 从**本地固定盘**拖进来：收进库 + 生成备忘录 + **删掉原文件**；
//! - 从 U 盘 / 移动硬盘 / 网络路径拖进来：照收照生成，**原文件保留**；
//! - 图片同一套规则，只是收进笔记图片区；
//! - 同名文件**绝不覆盖**，自动加序号 `笔记-2.md`。
//!
//! 硬性规则：移动一律「先复制、再校验、后删除」——
//! 1. 复制到临时区（库内 `.import-tmp/`）；
//! 2. 校验大小一致 + 能读完整内容；
//! 3. 挪到正式位置（同盘 rename）；
//! 4. 按**盘的类型**决定是否删源（不看盘符字母）；
//! 5. 任一步失败 → 删掉临时文件与已写入的内容，源文件原样保留，返回明确错误。
//!
//! 判不出盘类型时一律按「只复制」处理：宁可多留一份，不可误删。

use crate::json_io::write_json_atomic;
use crate::services::notes::{default_store, AppError, SaveNoteRequest};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

/// 收件记录文件名，和 `metadata.json` 平级放在 `data_dir`。
const IMPORTS_FILE: &str = "imports.json";
/// 库内临时区目录名（放在 `data_dir` 下，和正式区同盘，才能 rename）。
const TEMP_DIR: &str = ".import-tmp";
/// 收图片时挂靠的那条笔记的标题。
const IMAGE_INBOX_TITLE: &str = "收进来的图片";

/// 能被「收进来」的文本扩展名。
const TEXT_EXTENSIONS: &[&str] = &["txt", "md"];
/// 能被「收进来」的图片扩展名。
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

// ---------------------------------------------------------------------------
// 盘类型
// ---------------------------------------------------------------------------

/// 源文件所在盘的类型。只区分「能不能安全删源」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskKind {
    /// `DRIVE_FIXED`：本地固定盘，收完删源。
    Fixed,
    /// `DRIVE_REMOVABLE`：U 盘 / 移动硬盘，只复制。
    Removable,
    /// `DRIVE_REMOTE`：网络路径，只复制。
    Remote,
    /// 其他类型（光盘、内存盘…）或**判不出来**，一律只复制。
    Other,
}

impl DiskKind {
    /// 写进 `imports.json` 的取值。
    pub fn as_str(self) -> &'static str {
        match self {
            DiskKind::Fixed => "fixed",
            DiskKind::Removable => "removable",
            DiskKind::Remote => "remote",
            DiskKind::Other => "other",
        }
    }

    /// 只有本地固定盘才允许删源。判不出来（`Other`）时返回 false。
    pub fn may_delete_source(self) -> bool {
        matches!(self, DiskKind::Fixed)
    }
}

/// 把 `GetDriveTypeW` 的返回值映射成 `DiskKind`。纯函数，不碰磁盘。
pub fn classify_drive_type(code: u32) -> DiskKind {
    match code {
        // DRIVE_FIXED = 3
        3 => DiskKind::Fixed,
        // DRIVE_REMOVABLE = 2
        2 => DiskKind::Removable,
        // DRIVE_REMOTE = 4
        4 => DiskKind::Remote,
        // DRIVE_UNKNOWN = 0 / DRIVE_NO_ROOT_DIR = 1 / DRIVE_CDROM = 5 /
        // DRIVE_RAMDISK = 6，以及任何意料之外的取值：都当「判不出来」，只复制。
        _ => DiskKind::Other,
    }
}

/// 路径形态（纯字符串判断，不碰磁盘）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathShape {
    DriveLetter(char),
    Unc,
    Unsupported,
}

/// 纯函数：只看字符串判断路径形态。
pub fn classify_path_shape(path: &str) -> PathShape {
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("\\\\?\\unc\\") || path.starts_with("\\\\") || path.starts_with("//") {
        return PathShape::Unc;
    }
    let head: Vec<char> = path.chars().take(3).collect();
    let is_sep = |c: char| c == '\\' || c == '/';
    if head.len() >= 2
        && head[0].is_ascii_alphabetic()
        && head[1] == ':'
        && (head.len() == 2 || is_sep(head[2]))
    {
        return PathShape::DriveLetter(head[0].to_ascii_uppercase());
    }
    PathShape::Unsupported
}

/// 盘符字符 → 根路径 `D:\`。
pub fn root_for_drive_letter(letter: char) -> String {
    format!("{}:\\", letter.to_ascii_uppercase())
}

#[cfg(target_os = "windows")]
fn drive_type_code_of_root(root: &str) -> Option<u32> {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    let mut wide: Vec<u16> = root.encode_utf16().collect();
    wide.push(0);
    // SAFETY: 传的是以 NUL 结尾的宽字符串，生命周期覆盖整个调用。
    let code = unsafe { GetDriveTypeW(wide.as_ptr()) };
    // 0 = DRIVE_UNKNOWN，1 = DRIVE_NO_ROOT_DIR：都算「判不出来」。
    if code == 0 || code == 1 {
        None
    } else {
        Some(code)
    }
}

#[cfg(not(target_os = "windows"))]
fn drive_type_code_of_root(_root: &str) -> Option<u32> {
    None
}

/// 判断某个路径在什么盘上。
///
/// 先按字符串形态分流：UNC / `\\?\UNC\` 直接算网络；盘符交给 `GetDriveTypeW`；
/// 相对的或设备路径（`\\?\Volume{…}`、`\\.\…`）视为判不出来。
/// 盘符报 `DRIVE_FIXED` 时再用 `GetVolumePathNameW` 交叉核对一次（卷挂载点可能不是盘符）；
/// 两者不一致或卷路径查不到时用盘符结果——但任何情况下只有 **确认是固定盘** 才允许删源。
pub fn detect_disk_kind(path: &str) -> DiskKind {
    match classify_path_shape(path) {
        PathShape::Unc => DiskKind::Remote,
        PathShape::Unsupported => DiskKind::Other,
        PathShape::DriveLetter(letter) => {
            let root = root_for_drive_letter(letter);
            let by_root = match drive_type_code_of_root(&root) {
                Some(code) => classify_drive_type(code),
                None => return DiskKind::Other,
            };
            if !by_root.may_delete_source() {
                return by_root;
            }
            // 交叉核对：卷路径也必须判成固定盘。
            match volume_root_of(path) {
                Some(volume) => match drive_type_code_of_root(&volume) {
                    Some(code) if classify_drive_type(code).may_delete_source() => DiskKind::Fixed,
                    // 两个结果打架：按「判不出来」，只复制。
                    _ => DiskKind::Other,
                },
                // 卷路径查不到时，盘符已经明确是固定盘，认它。
                None => by_root,
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn volume_root_of(path: &str) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::GetVolumePathNameW;
    let mut wide: Vec<u16> = path.encode_utf16().collect();
    if wide.is_empty() {
        return None;
    }
    wide.push(0);
    // 卷挂载点最长可以很长，给足缓冲；不够时函数返回 FALSE。
    let mut buffer = vec![0u16; 1024];
    // SAFETY: buffer 的真实长度如实传给 cchBufferLength，API 只写这么多。
    let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
    if ok == 0 {
        return None;
    }
    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    if len == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..len]))
}

#[cfg(not(target_os = "windows"))]
fn volume_root_of(_path: &str) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------
// 收件记录
// ---------------------------------------------------------------------------

/// 一条收件记录。`imports.json` 里存的就是它。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    pub id: String,
    /// 源路径，原样保留，用于「还原到原位置」。
    pub from: String,
    /// 收进库之后的路径：文本是 `notes/<file>`，图片是 `images/<noteId>/<file>`。
    pub to: String,
    /// `fixed` / `removable` / `remote` / `other`。
    pub disk_type: String,
    /// 是否真的删了源文件。
    pub moved: bool,
    /// 本地时区 RFC3339，如 `2026-11-14T14:58:00+08:00`。
    pub at: String,
    /// `note`（文本）或 `image`（图片）。
    #[serde(default)]
    pub kind: String,
    /// 在库里的文件名（文本已做过同名加序号）。
    #[serde(default)]
    pub file_name: String,
    /// 这条其实是失败项时，写失败原因；成功项为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 磁盘上的整体结构。带 `version` 方便以后改结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub items: Vec<ImportRecord>,
}

fn default_version() -> u32 {
    1
}

impl Default for ImportFile {
    fn default() -> Self {
        Self {
            version: default_version(),
            items: Vec::new(),
        }
    }
}

fn imports_path() -> Result<PathBuf, AppError> {
    Ok(default_store()?.data_dir().join(IMPORTS_FILE))
}

fn corrupt(error: serde_json::Error) -> AppError {
    AppError {
        code: "import:corrupt".into(),
        message: format!("收件记录读不出来：{error}"),
        details: Default::default(),
    }
}

/// 纯函数：解析 `imports.json` 文本。
pub fn parse_import_file(text: &str) -> Result<ImportFile, AppError> {
    serde_json::from_str(text).map_err(corrupt)
}

/// 纯函数：序列化成 `imports.json` 的写法。
pub fn render_import_file(file: &ImportFile) -> Result<String, AppError> {
    serde_json::to_string_pretty(file).map_err(AppError::from)
}

/// 纯函数：单条记录 JSON 往返（测试用）。
pub fn parse_record(text: &str) -> Result<ImportRecord, AppError> {
    serde_json::from_str(text).map_err(AppError::from)
}

fn read_import_file(path: &Path) -> Result<ImportFile, AppError> {
    if !path.exists() {
        return Ok(ImportFile::default());
    }
    let text = fs::read_to_string(path)?;
    if text.trim().is_empty() {
        return Ok(ImportFile::default());
    }
    parse_import_file(&text)
}

fn write_import_file(path: &Path, file: &ImportFile) -> Result<(), AppError> {
    write_json_atomic(path, file)
}

fn now_rfc3339_local() -> String {
    Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

// ---------------------------------------------------------------------------
// 文件名：同名加序号
// ---------------------------------------------------------------------------

/// 纯函数：给文件名加序号。`笔记.md` + 2 → `笔记-2.md`。
pub fn with_sequence(file_name: &str, seq: usize) -> String {
    if seq <= 1 {
        return file_name.to_string();
    }
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if !ext.is_empty() => format!("{stem}-{seq}.{ext}"),
        _ => format!("{stem}-{seq}"),
    }
}

/// 纯函数：在「占用判定」下找一个不冲突的文件名，**从不覆盖**。
pub fn unique_file_name(file_name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    if !taken(file_name) {
        return file_name.to_string();
    }
    let mut seq = 2usize;
    let mut candidate = with_sequence(file_name, seq);
    while taken(&candidate) {
        seq += 1;
        if seq > 10_000 {
            break;
        }
        candidate = with_sequence(file_name, seq);
    }
    candidate
}

// ---------------------------------------------------------------------------
// 复制 → 校验 → 挪位 → 判盘删源
// ---------------------------------------------------------------------------

struct Staged {
    temp_path: PathBuf,
}

/// 1) 复制到临时区，2) 校验大小与可读性。
fn stage_copy(source: &Path, temp_dir: &Path) -> Result<Staged, AppError> {
    let source_size = fs::metadata(source)?.len();
    fs::create_dir_all(temp_dir)?;
    let temp_path = temp_dir.join(format!("stage-{}", Uuid::new_v4()));
    if let Err(error) = fs::copy(source, &temp_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(AppError {
            code: "import:copyFailed".into(),
            message: format!("复制失败，源文件已保留：{error}"),
            details: Default::default(),
        });
    }
    if let Err(error) = verify_copy(&temp_path, source_size) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(Staged { temp_path })
}

/// 校验副本：大小一致，且能从头读到底。
fn verify_copy(copy: &Path, expected_size: u64) -> Result<(), AppError> {
    let actual = fs::metadata(copy)?.len();
    if actual != expected_size {
        return Err(AppError {
            code: "import:sizeMismatch".into(),
            message: format!(
                "复制后大小不一致（期望 {expected_size}，实际 {actual}），已撤销，源文件保留"
            ),
            details: Default::default(),
        });
    }
    let mut file = fs::File::open(copy)?;
    let mut buffer = [0u8; 64 * 1024];
    let mut read_total: u64 = 0;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        read_total += n as u64;
    }
    if read_total != expected_size {
        return Err(AppError {
            code: "import:truncated".into(),
            message: format!("复制后内容读不全（读到 {read_total} 字节），已撤销，源文件保留"),
            details: Default::default(),
        });
    }
    Ok(())
}

/// 3) 挪到正式位置。目标已存在就换下一个序号，**绝不覆盖**。
fn move_into_place(staged: &Staged, target_dir: &Path, wanted: &str) -> Result<(String, PathBuf), AppError> {
    fs::create_dir_all(target_dir)?;
    let mut seq = 1usize;
    let mut name = wanted.to_string();
    loop {
        let path = target_dir.join(&name);
        if path.exists() {
            seq += 1;
            if seq > 10_000 {
                let _ = fs::remove_file(&staged.temp_path);
                return Err(AppError {
                    code: "import:nameExhausted".into(),
                    message: format!("同名文件太多，无法为「{wanted}」分配序号"),
                    details: Default::default(),
                });
            }
            name = with_sequence(wanted, seq);
            continue;
        }
        match fs::rename(&staged.temp_path, &path) {
            Ok(()) => return Ok((name, path)),
            Err(_) if path.exists() => {
                // 竞态：刚好被别人占了，换下一个序号再试。
                continue;
            }
            Err(error) => {
                let _ = fs::remove_file(&staged.temp_path);
                return Err(AppError {
                    code: "import:moveFailed".into(),
                    message: format!("挪到库内失败，源文件已保留：{error}"),
                    details: Default::default(),
                });
            }
        }
    }
}

/// 4) 按盘类型删源。返回是否真的删掉了（删不掉也只算「没删」，不算失败）。
///
/// 走回收站而不是 `fs::remove_file`：拖入即收是「把桌面上的一份挪进库」，
/// 用户不会预期原文件被永久抹掉。复用 `notes.rs` 里那套 `SHFileOperationW`
/// 实现（`trash` crate 在原生 ARM64 上会因 IFileOperation COM 失败）。
fn maybe_delete_source(source: &Path, disk: DiskKind) -> bool {
    if !disk.may_delete_source() {
        return false;
    }
    crate::services::notes::recycle_path(source).is_ok()
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/// 把一批路径收进库。
///
/// 单个文件失败不中断其余文件：失败项也返回，`error` 里写原因，且**不写收件记录**
/// （避免「记录说收进来了、其实没有」）。成功项一律写收件记录。
pub fn import_paths(
    paths: Vec<String>,
    category: Option<String>,
) -> Result<Vec<ImportRecord>, AppError> {
    let store = default_store()?;
    let data_dir = store.data_dir().to_path_buf();
    let temp_dir = data_dir.join(TEMP_DIR);
    let notes_dir = data_dir.join("notes");
    let category = category.unwrap_or_default();

    let mut taken: Vec<String> = store
        .list_notes()?
        .into_iter()
        .map(|note| note.file_name)
        .collect();
    let mut file = read_import_file(&data_dir.join(IMPORTS_FILE))?;
    let mut results: Vec<ImportRecord> = Vec::new();

    for raw in paths {
        let disk = detect_disk_kind(&raw);
        match import_single(&raw, disk, &category, &data_dir, &notes_dir, &temp_dir, &taken) {
            Ok(record) => {
                taken.push(record.file_name.clone());
                file.items.push(record.clone());
                results.push(record);
            }
            Err(error) => results.push(ImportRecord {
                id: Uuid::new_v4().to_string(),
                from: raw,
                to: String::new(),
                disk_type: disk.as_str().to_string(),
                moved: false,
                at: now_rfc3339_local(),
                kind: String::new(),
                file_name: String::new(),
                error: Some(format!("{}: {}", error.code, error.message)),
            }),
        }
    }

    // 有成功项才写记录文件；全是失败时不动磁盘上的记录。
    if results.iter().any(|r| r.error.is_none()) {
        write_import_file(&data_dir.join(IMPORTS_FILE), &file)?;
    }
    let _ = fs::remove_dir(&temp_dir);
    Ok(results)
}

fn import_single(
    raw: &str,
    disk: DiskKind,
    category: &str,
    data_dir: &Path,
    notes_dir: &Path,
    temp_dir: &Path,
    taken: &[String],
) -> Result<ImportRecord, AppError> {
    let source = PathBuf::from(raw);
    if !source.is_file() {
        return Err(AppError {
            code: "import:notFile".into(),
            message: format!("不是文件或不存在：{raw}"),
            details: Default::default(),
        });
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let original_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        // 先确认是能读的 UTF-8 文本，读不出来直接失败、源码不动。
        fs::read_to_string(&source).map_err(|error| AppError {
            code: "import:unreadable".into(),
            message: format!("读不出来（可能不是 UTF-8 文本），源文件保留：{error}"),
            details: Default::default(),
        })?;

        // ① 复制到临时区 ② 校验。
        let staged = stage_copy(&source, temp_dir)?;
        // ③ 挪到正式位置（同名加序号，绝不覆盖）。
        let taken_fn = |name: &str| taken.iter().any(|t| t == name);
        let wanted = unique_file_name(&original_name, &taken_fn);
        let (final_name, final_path) = move_into_place(&staged, notes_dir, &wanted)?;

        let content = match fs::read_to_string(&final_path) {
            Ok(text) => text,
            Err(error) => {
                let _ = fs::remove_file(&final_path);
                return Err(error.into());
            }
        };
        let title = Path::new(&final_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("笔记")
            .to_string();
        let relative = format!("notes/{final_name}");
        let note = match default_store()?.create_note(SaveNoteRequest {
            title,
            content,
            category: category.to_string(),
        }) {
            Ok(note) => note,
            Err(error) => {
                // 生成备忘录失败：撤销刚挪进库的副本，源文件原样保留。
                let _ = fs::remove_file(&final_path);
                return Err(error);
            }
        };
        let _ = data_dir;

        // ④ 判盘删源（只有确认固定盘才删）。
        let moved = maybe_delete_source(&source, disk);
        Ok(ImportRecord {
            id: Uuid::new_v4().to_string(),
            from: raw.to_string(),
            to: relative,
            disk_type: disk.as_str().to_string(),
            moved,
            at: now_rfc3339_local(),
            kind: "note".into(),
            file_name: note.file_name,
            error: None,
        })
    } else if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        let store = default_store()?;
        // 图片挂到一条「收进来的图片」笔记的图片区；没有就建一条。
        let note_id = match store
            .list_notes()?
            .into_iter()
            .find(|n| n.title == IMAGE_INBOX_TITLE && n.category == category)
        {
            Some(note) => note.id,
            None => store
                .create_note(SaveNoteRequest {
                    title: IMAGE_INBOX_TITLE.into(),
                    content: String::new(),
                    category: category.to_string(),
                })?
                .id,
        };

        // 图片走同一套「复制 → 校验 → 挪位」：先复制进临时区并校验，
        // 再换一个不冲突的名字放进 note 的图片区。
        let staged = stage_copy(&source, temp_dir)?;
        let image_dir = store.images_dir(&note_id);
        let taken_images: Vec<String> = fs::read_dir(&image_dir)
            .map(|iter| {
                iter.flatten()
                    .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let taken_fn = |name: &str| taken_images.iter().any(|t| t == name);
        let wanted = unique_file_name(&original_name, &taken_fn);
        let (final_name, _final_path) = move_into_place(&staged, &image_dir, &wanted)?;

        let moved = maybe_delete_source(&source, disk);
        Ok(ImportRecord {
            id: Uuid::new_v4().to_string(),
            from: raw.to_string(),
            to: format!("images/{note_id}/{final_name}"),
            disk_type: disk.as_str().to_string(),
            moved,
            at: now_rfc3339_local(),
            kind: "image".into(),
            file_name: final_name,
            error: None,
        })
    } else {
        Err(AppError {
            code: "import:unsupported".into(),
            message: format!("只支持 .txt / .md / 图片，跳过：{raw}"),
            details: Default::default(),
        })
    }
}

/// 全部收件记录，按时间倒序。
pub fn list_imports() -> Result<Vec<ImportRecord>, AppError> {
    let path = imports_path()?;
    let mut file = read_import_file(&path)?;
    file.items.sort_by(|a, b| b.at.cmp(&a.at));
    Ok(file.items)
}

/// 把库内副本搬回 `from` 原位置。原位置已有同名文件时**不覆盖**，加序号。
pub fn restore_import(id: &str) -> Result<(), AppError> {
    let path = imports_path()?;
    let mut file = read_import_file(&path)?;
    let index = file
        .items
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| AppError {
            code: "import:notFound".into(),
            message: format!("收件记录不存在：{id}"),
            details: Default::default(),
        })?;
    let item = file.items[index].clone();

    let copy_in_lib = resolve_lib_path(&item.to)?;
    if !copy_in_lib.is_file() {
        return Err(AppError {
            code: "import:missingCopy".into(),
            message: format!("库内副本已经不在了：{}", item.to),
            details: Default::default(),
        });
    }

    let target = PathBuf::from(&item.from);
    let parent = target
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent)?;
    let original_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("restored")
        .to_string();
    let final_name = unique_file_name(&original_name, &|name| parent.join(name).exists());
    let final_path = parent.join(&final_name);

    let size = fs::metadata(&copy_in_lib)?.len();
    fs::copy(&copy_in_lib, &final_path)?;
    if let Err(error) = verify_copy(&final_path, size) {
        let _ = fs::remove_file(&final_path);
        return Err(error);
    }

    // 库内副本删掉，记录改成「已还原、已在原位置」。
    fs::remove_file(&copy_in_lib)?;
    file.items[index].moved = false;
    file.items[index].to = final_path.to_string_lossy().to_string();
    write_import_file(&path, &file)?;
    Ok(())
}

/// `to` 存的是相对 `data_dir` 的路径；也容忍绝对路径（删源失败后手改过记录的情况）。
fn resolve_lib_path(to: &str) -> Result<PathBuf, AppError> {
    let candidate = PathBuf::from(to);
    if candidate.is_absolute() {
        return Ok(candidate);
    }
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err(AppError {
            code: "import:badPath".into(),
            message: format!("收件记录的库内路径不合法：{to}"),
            details: Default::default(),
        });
    }
    Ok(default_store()?.data_dir().join(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_name_gets_sequence_not_overwrite() {
        // 库里已经有 笔记.md，再收一个 笔记.md 应得到 笔记-2.md，而不是覆盖。
        let existing = ["笔记.md".to_string()];
        let name = unique_file_name("笔记.md", &|n| existing.iter().any(|t| t == n));
        assert_eq!(name, "笔记-2.md");

        let existing = ["笔记.md".to_string(), "笔记-2.md".to_string()];
        let name = unique_file_name("笔记.md", &|n| existing.iter().any(|t| t == n));
        assert_eq!(name, "笔记-3.md");

        // 没占用时原样返回。
        assert_eq!(unique_file_name("新的.md", &|_| false), "新的.md");
    }

    #[test]
    fn with_sequence_keeps_extension() {
        assert_eq!(with_sequence("笔记.md", 1), "笔记.md");
        assert_eq!(with_sequence("笔记.md", 2), "笔记-2.md");
        assert_eq!(with_sequence("a.b.txt", 3), "a.b-3.txt");
        assert_eq!(with_sequence("无后缀", 2), "无后缀-2");
    }

    #[test]
    fn import_record_json_round_trip() {
        let record = ImportRecord {
            id: "abc".into(),
            from: "D:\\桌面\\笔记.txt".into(),
            to: "notes/笔记.md".into(),
            disk_type: "fixed".into(),
            moved: true,
            at: "2026-11-14T14:58:00+08:00".into(),
            kind: "note".into(),
            file_name: "笔记.md".into(),
            error: None,
        };
        let text = serde_json::to_string(&record).unwrap();
        // 字段名按契约是 camelCase；中文路径原样保留（不转义）。
        assert!(text.contains("\"diskType\":\"fixed\""), "实际：{text}");
        assert!(text.contains("\"moved\":true"), "实际：{text}");
        assert!(text.contains("\"from\":\"D:"), "实际：{text}");
        assert!(text.contains("桌面"), "实际：{text}");
        let back = parse_record(&text).unwrap();
        assert_eq!(back, record);
    }

    #[test]
    fn imports_file_round_trip() {
        let file = ImportFile {
            version: 1,
            items: vec![
                ImportRecord {
                    id: "1".into(),
                    from: "D:\\a.txt".into(),
                    to: "notes/a.md".into(),
                    disk_type: "removable".into(),
                    moved: false,
                    at: "2026-11-14T14:58:00+08:00".into(),
                    kind: "note".into(),
                    file_name: "a.md".into(),
                    error: None,
                },
                ImportRecord {
                    id: "2".into(),
                    from: "\\\\nas\\share\\b.png".into(),
                    to: "images/n1/b.png".into(),
                    disk_type: "remote".into(),
                    moved: false,
                    at: "2026-11-14T15:01:00+08:00".into(),
                    kind: "image".into(),
                    file_name: "b.png".into(),
                    error: Some("import:copyFailed: x".into()),
                },
            ],
        };
        let text = render_import_file(&file).unwrap();
        let back = parse_import_file(&text).unwrap();
        assert_eq!(back.items, file.items);
        assert_eq!(back.version, 1);
        // 空文件按空记录处理。
        assert!(parse_import_file("{}").unwrap().items.is_empty());
    }

    #[test]
    fn drive_type_mapping() {
        // DRIVE_FIXED 才删源。
        assert_eq!(classify_drive_type(3), DiskKind::Fixed);
        assert_eq!(classify_drive_type(2), DiskKind::Removable);
        assert_eq!(classify_drive_type(4), DiskKind::Remote);
        // 判不出来 / 其他类型一律只复制。
        assert_eq!(classify_drive_type(0), DiskKind::Other);
        assert_eq!(classify_drive_type(1), DiskKind::Other);
        assert_eq!(classify_drive_type(5), DiskKind::Other);
        assert_eq!(classify_drive_type(6), DiskKind::Other);

        assert!(DiskKind::Fixed.may_delete_source());
        assert!(!DiskKind::Removable.may_delete_source());
        assert!(!DiskKind::Remote.may_delete_source());
        assert!(!DiskKind::Other.may_delete_source());

        assert_eq!(DiskKind::Fixed.as_str(), "fixed");
        assert_eq!(DiskKind::Removable.as_str(), "removable");
        assert_eq!(DiskKind::Remote.as_str(), "remote");
    }

    #[test]
    fn path_shape_classification() {
        assert_eq!(
            classify_path_shape("D:\\桌面\\笔记.txt"),
            PathShape::DriveLetter('D')
        );
        assert_eq!(classify_path_shape("c:/tmp/a.md"), PathShape::DriveLetter('C'));
        assert_eq!(classify_path_shape("\\\\nas\\share\\a.md"), PathShape::Unc);
        assert_eq!(
            classify_path_shape("\\\\?\\UNC\\nas\\share\\a.md"),
            PathShape::Unc
        );
        assert_eq!(classify_path_shape("相对/文件.md"), PathShape::Unsupported);
    }

    /// 真实落盘的一轮：复制 → 校验 → 挪位 → 同名再加序号，全程不覆盖。
    #[test]
    fn stage_verify_and_move_never_overwrites() {
        let base = std::env::temp_dir().join(format!("hj-import-test-{}", Uuid::new_v4()));
        let src_dir = base.join("src");
        let notes_dir = base.join("notes");
        let temp_dir = base.join(".import-tmp");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&notes_dir).unwrap();

        let source = src_dir.join("笔记.md");
        fs::write(&source, "# 第一条\n内容").unwrap();
        // 库里已经有一份同名文件。
        fs::write(notes_dir.join("笔记.md"), "旧的，不能被覆盖").unwrap();

        // 第一轮：同名 → 笔记-2.md。
        let staged = stage_copy(&source, &temp_dir).unwrap();
        let (name, path) = move_into_place(&staged, &notes_dir, "笔记.md").unwrap();
        assert_eq!(name, "笔记-2.md");
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 第一条\n内容");
        assert_eq!(
            fs::read_to_string(notes_dir.join("笔记.md")).unwrap(),
            "旧的，不能被覆盖"
        );
        // 源文件还在（stage 阶段绝不删源）。
        assert!(source.exists());

        // 第二轮：再来一个同名 → 笔记-3.md。
        let staged = stage_copy(&source, &temp_dir).unwrap();
        let (name2, _) = move_into_place(&staged, &notes_dir, "笔记.md").unwrap();
        assert_eq!(name2, "笔记-3.md");

        // 校验能抓出大小不符。
        let bogus = temp_dir.join("bogus");
        fs::create_dir_all(&temp_dir).unwrap();
        fs::write(&bogus, "短").unwrap();
        let err = verify_copy(&bogus, 999).unwrap_err();
        assert_eq!(err.code, "import:sizeMismatch");

        // 不可删源的盘一律不删。
        assert!(!maybe_delete_source(&source, DiskKind::Removable));
        assert!(source.exists());
        assert!(!maybe_delete_source(&source, DiskKind::Other));
        assert!(source.exists());
        // 固定盘才会删。
        assert!(maybe_delete_source(&source, DiskKind::Fixed));
        assert!(!source.exists());

        let _ = fs::remove_dir_all(&base);
    }
}
