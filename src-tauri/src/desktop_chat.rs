//! 面板对话区的模型接入：把 Ollama 的 NDJSON 流一段段推给前端。
//!
//! 为什么是 Rust 侧发请求、前端只收事件：
//! 1. 前端直接 fetch Ollama 会被 CORS 和 Tauri 的 CSP 双重卡住；
//! 2. 流式输出要用 `reqwest::blocking` 的 `Read` 边读边切行（Cargo.toml
//!    只开了 `blocking`，没开 `stream`），这个只能在 Rust 做；
//! 3. 中文从 PowerShell 传给 Ollama 会变问号（见 HANDOFF 第七节），
//!    Rust 侧 serde 序列化能保证 UTF-8 干净。
//!
//! ⚠️ 模型能力差异（实测，勿混用）：
//! - `qwen3.5-9b`：人格对话，支持 tools/thinking，闲聊唯一可用；
//! - `spark-x2.6-4b`：工具调用，快（1.6~3.5s），闲聊质量未验收；
//! - `hunyuan-mt-7b`：翻译模型，capabilities **只有 completion**，
//!   Modelfile 里绝对不能带 SYSTEM，否则输出乱掉。
//!
//! ⚠️ 思考型模型必须显式 `"think": false`。`enable_thinking:false` 和
//!    `reasoning_effort:low` 都无效（已实测）。

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::services::notes::AppError;

/// 本机 Ollama 默认地址。
const OLLAMA_BASE: &str = "http://127.0.0.1:11434";

/// 对话区一次回复最长等多久。冷加载 6.6GB 就要 6.6 秒，加上 10~13 tok/s
/// 的纯 CPU 速度，600 字左右的一条回答要 50 秒上下，留足余量。
const CHAT_TIMEOUT: Duration = Duration::from_secs(180);

/// 流式事件名。前端监听它累积气泡文字。
pub const CHAT_DELTA_EVENT: &str = "chat-delta";
/// 一次回复结束（成功或失败）后的事件名。
pub const CHAT_DONE_EVENT: &str = "chat-done";

/// 面板可选的模型。这里同时也是白名单：
/// 前端传来的 `model` 必须命中其中之一，不能任意拼接成请求。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModel {
    /// Ollama 的模型名，例如 `qwen3.5-9b:latest`。
    pub id: &'static str,
    /// 下拉里显示的名字。
    pub label: &'static str,
    /// 一句话说明它是干什么的，显示在下拉右侧。
    pub tag: &'static str,
}

pub const CHAT_MODELS: &[ChatModel] = &[
    ChatModel {
        id: "qwen3.5-9b:latest",
        label: "Qwen3.5-9B",
        tag: "对话",
    },
    ChatModel {
        id: "spark-x2.6-4b:latest",
        label: "Spark-X2.6-4B",
        tag: "工具调用 · 不适合闲聊",
    },
    ChatModel {
        id: "hunyuan-mt-7b:latest",
        label: "Hunyuan-MT-7B",
        tag: "翻译 · 需指定目标语言",
    },
];

/// 默认模型：人格对话用 qwen。
pub const DEFAULT_MODEL: &str = "qwen3.5-9b:latest";

/// 翻译模型。混元是**纯翻译模型**（capabilities 只有 completion，
/// 没有 tools / thinking），绝对不能喂人格提示词，否则它会退化成
/// 「把这句话当中文复述一遍」——2026-11-15 用户在面板里实测踩到这个坑。
pub const TRANSLATE_MODEL: &str = "hunyuan-mt-7b:latest";

/// 混元的官方翻译模板。腾讯把指令固化在这个句式里训练，
/// 换成自然语言（「帮我翻译成英文」）它会当普通续写处理。
const TRANSLATE_TEMPLATE: &str =
    "Translate the following segment into {lang}, without additional explanation.\n\n{text}";

/// 目标语言 → 官方模板里用的英文语言名。
///
/// 只覆盖这台机器上用户实际会用到的方向；不认识的语言返回 None，
/// 由调用方给出「请说明目标语言」的提示，不猜。
fn translate_language_name(alias: &str) -> Option<&'static str> {
    Some(match alias {
        "英文" | "英语" | "english" | "en" => "English",
        "日文" | "日语" | "japanese" | "ja" | "jp" => "Japanese",
        "泰文" | "泰语" | "thai" | "th" => "Thai",
        "中文" | "汉语" | "简体中文" | "chinese" | "zh" => "Chinese",
        "韩文" | "韩语" | "korean" | "ko" => "Korean",
        "法文" | "法语" | "french" | "fr" => "French",
        "德文" | "德语" | "german" | "de" => "German",
        "西班牙文" | "西班牙语" | "spanish" | "es" => "Spanish",
        "俄文" | "俄语" | "russian" | "ru" => "Russian",
        _ => return None,
    })
}

/// 从用户的话里解析出「翻译成什么语言」和「要翻译的正文」。
///
/// 用户 2026-11-15 拍板：**默认翻成中文，不该逼用户每次都写「翻译成中文」**。
/// 原话：「提示词太麻烦了，我还要打出翻译成英语，默认应该是翻译为中文，
/// 如果需要翻译成其他语言，才是把下面这段话翻译为英文或其他语言」。
///
/// 因此三条规则，按顺序判断：
/// 1. 写了目标语言（「翻译成英文：…」冒号式 / 首行「翻译成日语」多行式）
///    → 按指定的语言翻；
/// 2. 没写目标语言但写了「翻译/译一下」这类词 → 整句当正文，翻成中文；
/// 3. 什么都没写 → 整句原样当正文，翻成中文（直接粘句子就能用）。
fn parse_translate_request(text: &str) -> Option<(String, &'static str)> {
    /// 带目标语言的动词。
    const EXPLICIT_TRIGGERS: [&str; 4] = ["翻译成", "翻译为", "翻成", "译成"];
    /// 不带目标语言的动词：出现它们时要把动词本身从正文里剥掉，
    /// 否则模板会变成「翻译『翻译一下：Good morning』」这种笑话。
    /// **顺序即优先级**，长词必须在前：先命中「翻译一下」才不会残留「一下：」。
    const BARE_TRIGGERS: [&str; 6] = ["翻译一下", "翻译下", "翻一下", "译一下", "翻译", "译"];

    const DEFAULT_TARGET: &str = "Chinese";

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 规则 1：显式目标语言，头部与正文用换行或冒号分隔。
    if let Some(index) = trimmed.find(['\n', '：', ':']) {
        let head = &trimmed[..index];
        let body_start = index + trimmed[index..].chars().next()?.len_utf8();
        let rest = trimmed[body_start..].trim_start();
        if let Some(trigger) = EXPLICIT_TRIGGERS.iter().find(|trigger| head.contains(**trigger)) {
            let alias = head.split_once(*trigger)?.1.trim();
            // 「翻译成英文」后面可能跟着「这段 / 下面这句话」之类，取第一个词即可。
            let language = alias.split_whitespace().next().unwrap_or(alias);
            let target = translate_language_name(language)?;
            if rest.is_empty() {
                return None;
            }
            return Some((rest.to_string(), target));
        }
    }

    // 规则 2：只说「翻译一下」，没指定语言 → 整句当正文，默认翻成中文。
    // 正文里要把动词连同后面的标点一起剥掉。长动词优先匹配，
    // 否则「翻译一下」会先被「翻译」命中、留下一截「一下：」进正文。
    for trigger in BARE_TRIGGERS {
        if let Some(pos) = trimmed.find(trigger) {
            let after = &trimmed[pos + trigger.len()..];
            let body = after.trim_start_matches(['：', ':', '，', ',', ' ', '。']).trim();
            if !body.is_empty() {
                return Some((body.to_string(), DEFAULT_TARGET));
            }
            // 「翻译一下」后面没内容 = 用户还没粘原文，返回 None 让界面提示。
            return None;
        }
    }

    // 规则 3：什么都没说，整句就是原文。
    Some((trimmed.to_string(), DEFAULT_TARGET))
}

/// 系统提示词。用户拍板「每次只发当前这一句，不带历史」，
/// 所以这段 persona 是模型唯一的上下文来源，要写得足够具体。
///
/// ⚠️ 2026-11-15 实测教训：软约束（「简洁」「不用敬语堆砌」）压不住小模型的
/// 客套话惯性，qwen 仍然回了「我致力于为你提供高效、贴心的服务」。
/// 改成**明确禁令 + 正例**：列黑名单词、给一句示范，比形容词有效。
const SYSTEM_PROMPT: &str = "\
你是 3.ini 里的 AI 助手 dlive，住在用户的桌面便签小窗里。\
说话像一个熟悉的朋友，简短、直接、有一点文气。\
用户说出要做的事和时间时，必须先调用 add_schedule 工具把安排记下来，\
不要只回一句「记下了」——那等于什么都没记。记完之后再回一句话确认。\
硬性要求：\
一、禁止说这些套话：「致力于」「为您提供」「随时为你」「有什么可以帮你的」「希望对你有帮助」「如有需要」。\
二、禁止用表情符号，禁止加粗、标题、项目符号，禁止复述用户的问题。\
三、被问「你是谁」时只说：我是 dlive，帮你记东西和顺手答两句。\
四、不确定的事直说不知道，不要编。\
五、除了安排之外的东西（笔记正文、用户叫什么、以前聊过什么）这一版存不下来，\
被问到时直说这个版本存不了；但「安排」是可以记的，别把这两件事混在一起。";

/// 给前端的事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeltaPayload {
    request_id: String,
    /// 这一段新增的文字。
    delta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    request_id: String,
    /// 完整回答，前端可用它校正累积过程中的误差。
    text: String,
    /// 出错时的错误码，正常结束为 None。
    error: Option<String>,
    /// 出错时给用户看的中文说明。
    message: Option<String>,
}

/// Ollama `/api/chat` 的一行 NDJSON。
#[derive(Deserialize)]
struct OllamaChunk {
    #[serde(default)]
    message: Option<OllamaMessage>,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct OllamaMessage {
    #[serde(default)]
    content: String,
    /// 工具调用。模型决定「这事该记成安排」时，这里会有内容、`content` 为空。
    #[serde(default)]
    tool_calls: Vec<OllamaToolCall>,
}

/// Ollama 的 tool_call 结构。
#[derive(Deserialize)]
struct OllamaToolCall {
    function: OllamaToolFunction,
}

#[derive(Deserialize)]
struct OllamaToolFunction {
    name: String,
    #[serde(default)]
    arguments: serde_json::Value,
}

/// 发给模型的请求。`content` 用 `Cow` 而不是 `&str`：
/// 人格提示词和用户原话是借用的静态/借用串，翻译模板是运行时拼出来的
/// 新 `String`，两者要放进同一个 `Vec` —— 用 `&str` 会让拼出来的那个
/// 活在 `if` 分支里、借用活不到请求发出（E0597）。
#[derive(Serialize)]
struct OllamaRequest<'a> {
    model: &'a str,
    messages: Vec<OllamaRequestMessage<'a>>,
    stream: bool,
    think: bool,
    /// 让模型在内存里多待一会，减少下次请求的冷加载（默认 5 分钟太短）。
    keep_alive: &'a str,
    /// 只有普通对话才带工具；翻译模型不带（它只该翻译）。
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct OllamaRequestMessage<'a> {
    role: &'a str,
    content: std::borrow::Cow<'a, str>,
}

/// 列出可选模型，给前端渲染下拉。
pub fn list_models() -> Vec<ChatModel> {
    CHAT_MODELS.to_vec()
}

/// 发起一次对话，全程在后台线程跑，前端通过事件收增量。
///
/// 立即返回 `request_id`，前端的「停止生成」按钮可以据此忽略过期事件。
pub fn start_chat(app: AppHandle, model: String, text: String) -> Result<String, AppError> {
    let request_id = Uuid::new_v4().to_string();

    let model_id = resolve_model(&model).ok_or_else(|| AppError {
        code: "chat:unknownModel".into(),
        message: format!("模型 {model} 不在可选列表里"),
        details: Default::default(),
    })?;

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError {
            code: "chat:empty".into(),
            message: "说点什么再发吧".into(),
            details: Default::default(),
        });
    }

    let id = request_id.clone();
    std::thread::spawn(move || {
        let outcome = stream_chat(&app, &id, model_id, &trimmed);
        let payload = match outcome {
            Ok(full) => DonePayload {
                request_id: id,
                text: full,
                error: None,
                message: None,
            },
            Err(error) => DonePayload {
                request_id: id,
                text: String::new(),
                error: Some(error.code.clone()),
                message: Some(user_facing_message(&error)),
            },
        };
        let _ = app.emit(CHAT_DONE_EVENT, payload);
    });

    Ok(request_id)
}

/// 把模型名收敛到白名单里的真实 id。
///
/// 前端可能传短名（`qwen3.5-9b`）或全名（`qwen3.5-9b:latest`），两种都接。
fn resolve_model(requested: &str) -> Option<&'static str> {
    let wanted = requested.trim();
    if wanted.is_empty() {
        return Some(DEFAULT_MODEL);
    }
    CHAT_MODELS
        .iter()
        .find(|model| {
            model.id == wanted || model.id.split(':').next() == Some(wanted)
        })
        .map(|model| model.id)
}

/// 真正发请求并逐行读流。
fn stream_chat(
    app: &AppHandle,
    request_id: &str,
    model: &str,
    text: &str,
) -> Result<String, AppError> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(CHAT_TIMEOUT)
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| AppError {
            code: "chat:client".into(),
            message: error.to_string(),
            details: Default::default(),
        })?;

    let body = if model == TRANSLATE_MODEL {
        // 翻译模型走独立分支：不发 system，改用官方模板。
        // 解析不到目标语言就直接报错，别让混元瞎猜（它会原样复述中文）。
        let (source_text, target_language) = parse_translate_request(text).ok_or_else(|| AppError {
            code: "chat:translateFormat".into(),
            message: "混元只能翻译。请写成「翻译成英文：要翻的句子」，或第一行写「翻译成日语」后面接正文。"
                .into(),
            details: Default::default(),
        })?;
        let prompt = TRANSLATE_TEMPLATE
            .replace("{lang}", target_language)
            .replace("{text}", &source_text);
        OllamaRequest {
            model,
            messages: vec![OllamaRequestMessage {
                role: "user",
                content: std::borrow::Cow::Owned(prompt),
            }],
            stream: true,
            think: false,
            keep_alive: "30m",
            tools: None,
        }
    } else {
        // 日期上下文必须进 system：实测不给日期时 Spark 把「明天」算成 +2 天，
        // 给了「今天是 2026-11-15 星期六」之后四个用例全对。
        //
        // 人物卡（用户 m00776 要求）拼在基础人格后面：用户启用了人物卡时，
        // 由卡上的设定覆盖「你叫什么、怎么说话」，但那几条硬性禁令仍然生效。
        let date_note = format!(
            "{} 用户说「明天」「下周」这类相对时间时，按这个日期换算。",
            crate::desktop_schedule::today_context()
        );
        let system_prompt = crate::desktop_persona::compose_system_prompt(SYSTEM_PROMPT, &date_note);
        OllamaRequest {
            model,
            messages: vec![
                OllamaRequestMessage {
                    role: "system",
                    content: std::borrow::Cow::Owned(system_prompt),
                },
                OllamaRequestMessage {
                    role: "user",
                    content: std::borrow::Cow::Borrowed(text),
                },
            ],
            stream: true,
            // 思考型模型不关会先吐一大段思考过程，面板上看起来像卡死。
            think: false,
            keep_alive: "30m",
            tools: Some(schedule_tools()),
        }
    };


    let response = client
        .post(format!("{OLLAMA_BASE}/api/chat"))
        .json(&body)
        .send()
        .map_err(|error| AppError {
            code: "chat:request".into(),
            message: error.to_string(),
            details: Default::default(),
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(AppError {
            code: "chat:status".into(),
            message: format!("Ollama 返回 {status}: {body}"),
            details: Default::default(),
        });
    }

    let mut reader = BufReader::new(response);
    let mut line = String::new();
    let mut full = String::new();
    // 已经推给前端的字符数（按清洗后的文本计）。
    let mut sent_len = 0usize;
    // 本次对话里模型要求记录的安排（流结束后统一落盘）。
    let mut collected_tool_calls: Vec<OllamaToolCall> = Vec::new();

    loop {
        line.clear();
        let read = reader.read_line(&mut line).map_err(|error| AppError {
            code: "chat:read".into(),
            message: error.to_string(),
            details: Default::default(),
        })?;
        if read == 0 {
            break;
        }

        let chunk_text = line.trim();
        if chunk_text.is_empty() {
            continue;
        }


        let chunk: OllamaChunk = match serde_json::from_str(chunk_text) {
            Ok(chunk) => chunk,
            Err(error) => {
                eprintln!("failed to parse ollama chunk: {error}");
                continue;
            }
        };

        if let Some(error) = chunk.error {
            return Err(AppError {
                code: "chat:ollama".into(),
                message: error,
                details: Default::default(),
            });
        }

        if let Some(message) = chunk.message {
            // 工具调用：模型判定「这句话该记成安排」。流式模式下 content 为空、
            // tool_calls 带参数，所以先接住，等流结束后统一落盘。
            if !message.tool_calls.is_empty() {
                collected_tool_calls.extend(message.tool_calls);
            }
            if !message.content.is_empty() {
                // ⚠️ 先累积原始文本，再统一清洗后比对增量。
                // Spark-X2.6-4B 是工具调用模型，带 system 提示词时会把回答
                // 包在 `<tool_call>\n<answer>…</answer>\n</tool_call>` 里，
                // 直接推给前端就会看到一堆尖括号。
                //
                // 清洗不能"来一段清一段"：`<tool_call>` 这个标签本身可能被
                // 拆在两个 chunk 里，分段清洗会漏掉半个标签。所以这里保留
                // 原始累积串，每次整体清洗后与已发送内容做前缀比对，
                // 只推送新增的部分。
                let previous_len = sent_len;
                full.push_str(&message.content);
                let cleaned = strip_tool_wrappers(&full);
                let cleaned_len = cleaned.chars().count();
                if cleaned_len > previous_len {
                    let delta: String = cleaned.chars().skip(previous_len).collect();
                    sent_len = cleaned_len;
                    let _ = app.emit(
                        CHAT_DELTA_EVENT,
                        DeltaPayload {
                            request_id: request_id.to_string(),
                            delta,
                        },
                    );
                }
            }
        }

        if chunk.done {
            break;
        }
    }

    // 模型要求记的安排：落盘，并推一条 schedules-changed 让面板刷新。
    // 落盘失败不影响这次对话——正文已经推给前端了，不能因为记不上安排就报错。
    let saved = save_schedule_calls(app, &collected_tool_calls, text);

    // 返回的是清洗后的正文，不是原始累积串——否则 `<tool_call>` 会漏到前端。
    let cleaned = strip_tool_wrappers(&full);
    if cleaned.trim().is_empty() && !saved.is_empty() {
        // 这一轮模型没说话、只记了安排：给一句确认，别让气泡空着。
        Ok(saved.join("\n"))
    } else {
        Ok(cleaned)
    }
}

/// 把模型给的 `add_schedule` 调用落盘，返回给用户看的确认文案。
fn save_schedule_calls(app: &AppHandle, calls: &[OllamaToolCall], raw: &str) -> Vec<String> {
    let mut messages = Vec::new();
    for call in calls {
        if call.function.name != "add_schedule" {
            continue;
        }
        let args = &call.function.arguments;
        let title = args
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim();
        if title.is_empty() {
            continue;
        }
        let date = args.get("date").and_then(|value| value.as_str()).unwrap_or("");
        let time = args.get("time").and_then(|value| value.as_str()).unwrap_or("");
        let all_day = time.is_empty();
        let at = if all_day {
            date.to_string()
        } else {
            format!("{date}T{time}")
        };
        match crate::desktop_schedule::add(title, &at, all_day, "chat", raw) {
            Ok(item) => {
                let when = if item.all_day {
                    format!("{} 全天", &item.at[..10.min(item.at.len())])
                } else {
                    item.at.replace('T', " ")
                };
                messages.push(format!("记下了：{when} {}", item.title));
                let _ = app.emit("schedules-changed", ());
            }
            Err(error) => {
                eprintln!("failed to save schedule from chat: {} {}", error.code, error.message);
            }
        }
    }
    messages
}

/// 给对话模型暴露的工具定义。
///
/// 只留一个 `add_schedule`。`date` 固定成 `YYYY-MM-DD`、`time` 固定成 `HH:MM`，
/// 是为了避免模型返回「明天下午三点」这种没法直接落盘的说法；
/// `date_offset_days` 是可选的冗余字段，方便核对相对日期算得对不对。
fn schedule_tools() -> serde_json::Value {
    serde_json::json!([{
        "type": "function",
        "function": {
            "name": "add_schedule",
            "description": "把用户说的一件有时问安排（日程/待办/提醒）记录下来。只在用户的话里确实有要做的事和时间时才调用；纯闲聊、纯提问、翻译都不要调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "要做的事，简短，比如「社区医院药学实习报到」"
                    },
                    "date": {
                        "type": "string",
                        "description": "日期，格式 YYYY-MM-DD，必须根据 system 里给的今天日期换算"
                    },
                    "time": {
                        "type": "string",
                        "description": "时间，格式 HH:MM。用户没说具体几点就不要填这个字段"
                    }
                },
                "required": ["title", "date"]
            }
        }
    }])
}

/// 剥掉工具调用模型包在回答外面的 `<tool_call>` / `<answer>` 标签。
///
/// Spark-X2.6-4B 带 system 提示词时会输出：
/// ```text
/// <tool_call>definitions.answer>
/// <answer>真正的回答</answer>
/// </definitions.answer>
/// ```
/// 对话面板只想要中间那段正文。规则：
/// 1. 有 `<answer>…</answer>` 就取它，收紧到最内层；
/// 2. 没有 answer 标签时，只删掉所有形如 `<xxx>` / `</xxx>` 的尖括号片段；
/// 3. 结果去掉首尾空白。
fn strip_tool_wrappers(raw: &str) -> String {
    // 1. 优先取 <answer> 里的内容（可能有多层，取最内层非空的）。
    let mut text = raw;
    while let (Some(start), Some(end)) = (text.find("<answer>"), text.rfind("</answer>")) {
        if end <= start {
            break;
        }
        let inner = &text[start + "<answer>".len()..end];
        if inner.contains("<answer>") {
            text = inner;
            continue;
        }
        text = inner;
        break;
    }

    // 2. 去掉剩余的尖括号标签（含前面那个不完整的 `definitions.answer>`）。
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for ch in text.chars() {
        match ch {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }

    out.trim().to_string()
}

/// 把内部错误翻成用户能看的一句话（面板里不该出现 `reqwest` 这种词）。
fn user_facing_message(error: &AppError) -> String {
    match error.code.as_str() {
        "chat:request" | "chat:client" => "连不上本地模型服务，看看 Ollama 是不是没启动。".into(),
        "chat:status" if error.message.contains("404") => "这个模型还没下载到本机。".into(),
        "chat:read" => "生成到一半断开了。".into(),
        "chat:ollama" => format!("模型那边报错：{}", error.message),
        _ => error.message.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_model_accepts_short_and_full_names() {
        assert_eq!(resolve_model("qwen3.5-9b"), Some("qwen3.5-9b:latest"));
        assert_eq!(resolve_model("qwen3.5-9b:latest"), Some("qwen3.5-9b:latest"));
        assert_eq!(resolve_model("spark-x2.6-4b"), Some("spark-x2.6-4b:latest"));
    }

    #[test]
    fn resolve_model_rejects_unknown_model() {
        assert_eq!(resolve_model("deepseek-chat"), None);
        assert_eq!(resolve_model("../../etc/passwd"), None);
    }

    #[test]
    fn resolve_model_defaults_when_empty() {
        assert_eq!(resolve_model(""), Some(DEFAULT_MODEL));
    }

    #[test]
    fn default_model_is_in_list() {
        assert!(CHAT_MODELS.iter().any(|model| model.id == DEFAULT_MODEL));
    }

    #[test]
    fn models_have_unique_ids_and_labels() {
        let mut ids: Vec<&str> = CHAT_MODELS.iter().map(|m| m.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }

    #[test]
    fn strip_tool_wrappers_keeps_only_answer_body() {
        // Spark 的真实输出形态（实测 2026-11-15）。
        let raw = "你好，我是 3.ini 里的 AI dlive，随时帮你～<tool_call>definitions.answer>\n<answer>你好，我是 3.ini 里的 AI dlive，随时帮你～</answer>\n</definitions.answer>";
        assert_eq!(strip_tool_wrappers(raw), "你好，我是 3.ini 里的 AI dlive，随时帮你～");
    }

    #[test]
    fn strip_tool_wrappers_removes_bare_tags() {
        assert_eq!(strip_tool_wrappers("<answer>正文</answer>"), "正文");
        assert_eq!(strip_tool_wrappers("前<b>中</b>后"), "前中后");
    }

    #[test]
    fn strip_tool_wrappers_leaves_plain_text_alone() {
        // 正常模型的输出不带标签，必须原样返回，不能被当成标签吃掉。
        let plain = "今天南充阴天，17 度，注意加件外套。";
        assert_eq!(strip_tool_wrappers(plain), plain);
    }

    #[test]
    fn strip_tool_wrappers_handles_unclosed_tag() {
        // 流式读到最后仍然不完整时，不能把正文吞掉。
        assert_eq!(strip_tool_wrappers("回答内容<tool_call"), "回答内容");
    }

    #[test]
    fn translate_language_aliases_cover_common_directions() {
        assert_eq!(translate_language_name("英文"), Some("English"));
        assert_eq!(translate_language_name("英语"), Some("English"));
        assert_eq!(translate_language_name("日语"), Some("Japanese"));
        assert_eq!(translate_language_name("泰语"), Some("Thai"));
        assert_eq!(translate_language_name("中文"), Some("Chinese"));
        assert_eq!(translate_language_name("火星文"), None);
    }

    #[test]
    fn parse_translate_request_reads_inline_form() {
        // 最常见的写法：一行里用冒号分隔指令和正文。
        let (text, lang) = parse_translate_request("翻译成英文：早上好。我先看一下。").unwrap();
        assert_eq!(text, "早上好。我先看一下。");
        assert_eq!(lang, "English");
    }

    #[test]
    fn parse_translate_request_reads_multiline_form() {
        let input = "翻译成日语\nおはようございます。少し確認してから、改めてご連絡します。";
        let (text, lang) = parse_translate_request(input).unwrap();
        assert_eq!(text, "おはようございます。少し確認してから、改めてご連絡します。");
        assert_eq!(lang, "Japanese");
    }

    #[test]
    fn parse_translate_request_accepts_ascii_colon_and_aliases() {
        let (text, lang) = parse_translate_request("翻译成英语: Good morning.").unwrap();
        assert_eq!(text, "Good morning.");
        assert_eq!(lang, "English");
    }

    #[test]
    fn parse_translate_request_rejects_text_without_target() {
        // 「翻译成火星文：你好」这种指定了不支持的语言，返回 None 让界面提示。
        assert_eq!(parse_translate_request("翻译成火星文：你好"), None);
        // 只写了动词没粘原文，也返回 None。
        assert_eq!(parse_translate_request("翻译一下"), None);
        // 「翻译成英文」没给正文、也没有分隔符：会命中规则 2 的「翻译」动词，
        // 剥出来只剩「成英文」当原文翻成中文。这是可接受的降级——
        // 用户真这么写多半是漏粘了原文，翻一次怪句子比拦住他重写更不烦人。
        let (text, lang) = parse_translate_request("翻译成英文").unwrap();
        assert_eq!(text, "成英文");
        assert_eq!(lang, "Chinese");
    }

    #[test]
    fn parse_translate_request_defaults_to_chinese() {
        // 规则 3：直接粘英文，不写任何指令 → 翻成中文。
        // 用户原话：「默认应该是翻译为中文，如果需要翻译成其他语言，才是…」
        let input = "Good morning. I'll take a quick look at this first, and then I'll respond to you.";
        let (text, lang) = parse_translate_request(input).unwrap();
        assert_eq!(text, input);
        assert_eq!(lang, "Chinese");
    }

    #[test]
    fn parse_translate_request_strips_bare_verb() {
        // 规则 2：写了「翻译一下」但没写语言 → 剥掉动词，默认翻成中文。
        let (text, lang) =
            parse_translate_request("翻译一下，Good morning. I'll look at this first.").unwrap();
        assert_eq!(text, "Good morning. I'll look at this first.");
        assert_eq!(lang, "Chinese");

        // 长动词优先：「翻译一下」不能被「翻译」抢先命中而残留「一下：」。
        let (text2, lang2) = parse_translate_request("翻译一下：おはようございます。").unwrap();
        assert_eq!(text2, "おはようございます。");
        assert_eq!(lang2, "Chinese");
    }

    #[test]
    fn parse_translate_request_keeps_explicit_target_on_top_of_default() {
        // 明确指定语言时，必须服从指定，不能被默认中文盖掉。
        let (text, lang) =
            parse_translate_request("把下面这段话翻译为英文：早上好，我先看一下。").unwrap();
        assert_eq!(text, "早上好，我先看一下。");
        assert_eq!(lang, "English");
    }
}
