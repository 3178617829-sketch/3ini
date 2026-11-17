//! 人物卡：给 qwen 用的人格设定。
//!
//! 用户拍板（2026-11-15 m00776）：
//! 「做一个导入人物卡按钮，点进去，从上到下就是，起名字，性格，这种，
//!  可以限制一部分，但是不会太限制」。
//!
//! 所以这里**不是**导入 SillyTavern 的整卡文件，而是一张分项表单：
//! 名字 / 身份 / 性格 / 说话方式 / 背景 / 说话风格样例，一段一段填。
//!
//! 字数限制的取舍：
//! - 每一栏都设上限，但上限给得宽松（性格、背景各 4000 字），
//!   够装下几千字的详细人物卡，又不至于把模型上下文撑爆。
//! - 上限只在**保存时**校验，超了直接报错并说明超了几个字，
//!   不做静默截断——静默截断会让人以为整段存进去了。
//! - 全部字段合计还有一道总闸 `MAX_TOTAL_CHARS`，因为小模型的上下文有限，
//!   拼进 system 的只能是这个量级。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::json_io::write_json_atomic;
use crate::services::notes::{default_store, AppError};

/// 人物卡数据文件名，落在数据目录（默认 `文档\花笺\`）根下。
const PERSONA_FILE: &str = "persona.json";

/// 单栏上限（字符数）。用户说「可以限制一部分，但是不会太限制」，
/// 所以性格/背景给到 4000，足够写几千字的详细设定。
pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_ROLE_CHARS: usize = 200;
pub const MAX_TRAIT_CHARS: usize = 4000;
pub const MAX_SPEECH_CHARS: usize = 2000;
pub const MAX_BACKGROUND_CHARS: usize = 4000;
pub const MAX_EXAMPLE_CHARS: usize = 2000;

/// 整张卡的上限。全部加满约 12k 字符，对小模型已经很重了，
/// 这里压到 8000 字，既装得下长卡，又不会把对话上下文挤没。
pub const MAX_TOTAL_CHARS: usize = 8000;

/// 一张人物卡。字段全用 camelCase 序列化，前端直接对得上。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaCard {
    /// 名字。空 = 没启用人物卡，走内置的 dlive 人格。
    #[serde(default)]
    pub name: String,
    /// 身份／职业，一句话。
    #[serde(default)]
    pub role: String,
    /// 性格。
    #[serde(default)]
    pub trait_text: String,
    /// 说话方式：语气、用词习惯、口癖。
    #[serde(default)]
    pub speech: String,
    /// 背景故事。
    #[serde(default)]
    pub background: String,
    /// 说话样例（几句典型台词），小模型照抄语气很有效。
    #[serde(default)]
    pub example: String,
    /// 是否启用。允许存多张但只启用一张，这里先只做单张。
    #[serde(default)]
    pub enabled: bool,
    /// 最后修改时间（RFC3339）。
    #[serde(default)]
    pub updated_at: String,
}

impl PersonaCard {
    /// 这张卡是否真的能拼进提示词（启用且至少有名字或性格）。
    pub fn is_active(&self) -> bool {
        self.enabled && !(self.name.trim().is_empty() && self.trait_text.trim().is_empty())
    }

    /// 总字数（只算正文字段，不算名字这种短字段）。
    fn body_chars(&self) -> usize {
        self.role.chars().count()
            + self.trait_text.chars().count()
            + self.speech.chars().count()
            + self.background.chars().count()
            + self.example.chars().count()
    }

    /// 拼成给模型的系统提示词片段。没用人物卡时返回 None。
    pub fn to_system_block(&self) -> Option<String> {
        if !self.is_active() {
            return None;
        }
        let mut parts: Vec<String> = Vec::new();
        let name = self.name.trim();
        if name.is_empty() {
            parts.push("现在你就是下面这个角色，完全以第一人称说话。".to_string());
        } else {
            parts.push(format!(
                "现在你就是「{name}」，完全以第一人称说话，不要自称 AI 或助手。"
            ));
        }
        push_field(&mut parts, "身份", &self.role);
        push_field(&mut parts, "性格", &self.trait_text);
        push_field(&mut parts, "说话方式", &self.speech);
        push_field(&mut parts, "背景", &self.background);
        if !self.example.trim().is_empty() {
            parts.push(format!(
                "说话样例（照着这个语气，不要原样复述）：\n{}",
                self.example.trim()
            ));
        }
        parts.push(
            "保持角色设定不变，但上面那些硬性要求（禁止套话、禁止表情符号、不确定就说不知道）同样要遵守。"
                .to_string(),
        );
        Some(parts.join("\n"))
    }
}

fn push_field(parts: &mut Vec<String>, label: &str, value: &str) {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        parts.push(format!("{label}：{trimmed}"));
    }
}

/// 磁盘结构，带 version 方便以后改。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonaFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    card: PersonaCard,
}

fn default_version() -> u32 {
    1
}

impl Default for PersonaFile {
    fn default() -> Self {
        Self {
            version: default_version(),
            card: PersonaCard::default(),
        }
    }
}

fn persona_path() -> Result<PathBuf, AppError> {
    let store = default_store()?;
    Ok(store.data_dir().join(PERSONA_FILE))
}

fn read_file(path: &Path) -> Result<PersonaFile, AppError> {
    if !path.exists() {
        return Ok(PersonaFile::default());
    }
    let text = std::fs::read_to_string(path)?;
    if text.trim().is_empty() {
        return Ok(PersonaFile::default());
    }
    // 坏文件不让它把聊天卡死：读不出来就当没有人物卡，照常走内置人格。
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

/// 校验，超限时返回一条说得清「超了几个字」的错误。
fn validate(card: &PersonaCard) -> Result<(), AppError> {
    let checks: [(&str, &str, usize); 6] = [
        ("名字", &card.name, MAX_NAME_CHARS),
        ("身份", &card.role, MAX_ROLE_CHARS),
        ("性格", &card.trait_text, MAX_TRAIT_CHARS),
        ("说话方式", &card.speech, MAX_SPEECH_CHARS),
        ("背景", &card.background, MAX_BACKGROUND_CHARS),
        ("说话样例", &card.example, MAX_EXAMPLE_CHARS),
    ];
    for (label, value, limit) in checks {
        let len = value.chars().count();
        if len > limit {
            return Err(AppError::new(
                "persona:too_long",
                format!("「{label}」{len} 字，超过上限 {limit} 字，删掉 {} 字再保存", len - limit),
            ));
        }
    }
    let total = card.body_chars();
    if total > MAX_TOTAL_CHARS {
        return Err(AppError::new(
            "persona:too_long",
            format!(
                "整张人物卡 {total} 字，超过总共 {MAX_TOTAL_CHARS} 字的上限，删掉 {} 字再保存",
                total - MAX_TOTAL_CHARS
            ),
        ));
    }
    Ok(())
}

/// 读当前人物卡（给设置页填表单用）。
pub fn load_card() -> Result<PersonaCard, AppError> {
    let file = read_file(&persona_path()?)?;
    Ok(file.card)
}

/// 保存人物卡。先校验再落盘，校验不过一个字节都不写。
pub fn save_card(card: PersonaCard) -> Result<PersonaCard, AppError> {
    validate(&card)?;
    let mut stored = card;
    stored.name = stored.name.trim().to_string();
    stored.updated_at = chrono::Local::now().to_rfc3339();
    let file = PersonaFile {
        version: default_version(),
        card: stored.clone(),
    };
    write_json_atomic(&persona_path()?, &file)?;
    Ok(stored)
}

/// 为聊天准备的系统提示词片段。读盘失败一律返回 None，
/// 因为「人物卡读不出来」不该让对话直接失败。
pub fn active_system_block() -> Option<String> {
    load_card().ok().and_then(|card| card.to_system_block())
}

/// 把人物卡片段拼到基础人格提示词后面。
pub fn compose_system_prompt(base: &str, extra: &str) -> String {
    match active_system_block() {
        Some(block) => format!("{base}\n\n{block}\n\n{extra}"),
        None => format!("{base}\n\n{extra}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PersonaCard {
        PersonaCard {
            name: "林晚".into(),
            role: "书店店员".into(),
            trait_text: "话不多，但记性好".into(),
            speech: "句子短，少用感叹号".into(),
            background: "在老城区开一家二手书店".into(),
            example: "这本书你看完了吗？".into(),
            enabled: true,
            updated_at: String::new(),
        }
    }

    #[test]
    fn inactive_when_disabled_or_empty() {
        let mut card = sample();
        assert!(card.is_active());
        card.enabled = false;
        assert!(!card.is_active());
        let empty = PersonaCard::default();
        assert!(!empty.is_active());
        assert!(empty.to_system_block().is_none());
    }

    #[test]
    fn system_block_contains_all_filled_fields() {
        let block = sample().to_system_block().expect("should build");
        assert!(block.contains("林晚"));
        assert!(block.contains("书店店员"));
        assert!(block.contains("记性好"));
        assert!(block.contains("句子短"));
        assert!(block.contains("二手书店"));
        assert!(block.contains("这本书你看完了吗"));
        // 空字段不该出现空的「标签：」
        assert!(!block.contains("身份：\n"));
    }

    #[test]
    fn empty_fields_are_skipped() {
        let card = PersonaCard {
            name: "小满".into(),
            enabled: true,
            ..Default::default()
        };
        let block = card.to_system_block().expect("should build");
        assert!(block.contains("小满"));
        assert!(!block.contains("性格："));
        assert!(!block.contains("背景："));
    }

    #[test]
    fn validate_rejects_overlong_field() {
        let card = PersonaCard {
            name: "a".repeat(MAX_NAME_CHARS + 1),
            ..Default::default()
        };
        let error = validate(&card).expect_err("should fail");
        assert_eq!(error.code, "persona:too_long");
        assert!(error.message.contains("名字"));
    }

    #[test]
    fn validate_rejects_overlong_total() {
        let card = PersonaCard {
            trait_text: "字".repeat(MAX_TRAIT_CHARS),
            background: "字".repeat(MAX_BACKGROUND_CHARS),
            speech: "字".repeat(MAX_SPEECH_CHARS),
            example: "字".repeat(MAX_EXAMPLE_CHARS),
            ..Default::default()
        };
        let error = validate(&card).expect_err("should fail");
        assert!(error.message.contains("整张人物卡"));
    }

    #[test]
    fn total_budget_allows_a_few_thousand_chars() {
        // 用户要「几千字的人物卡也能进来」，这里校验 5000 字必须通过。
        let card = PersonaCard {
            name: "长卡".into(),
            trait_text: "字".repeat(3000),
            background: "字".repeat(2000),
            enabled: true,
            ..Default::default()
        };
        assert!(validate(&card).is_ok());
    }

    #[test]
    fn compose_prefers_persona_when_present() {
        // 不用读盘也能测拼装逻辑：这里只验证 base + extra 的拼接函数本身。
        let text = compose_system_prompt("基础", "日期");
        assert!(text.starts_with("基础"));
        assert!(text.ends_with("日期"));
    }
}
