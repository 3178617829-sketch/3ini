// 3.ini 面板小窗的入口脚本。
//
// 定位（2026-11-15 用户拍板）：这个 380×620 的小窗**就是 3.ini 的主窗口**。
// 原版花笺（1180×760）只是「备忘录」功能的容器，点备忘录入场时才由 Rust 侧另开一窗。
//
// 本轮范围（阶段 1 的 A + C）：
// - A 天气条：Rust 侧系统定位 → 逆地理城市名 → Open-Meteo 天气，真实数据；
// - C 对话区：接本机 Ollama 三个模型，走 Rust 侧转发实现流式输出。
//
// ⚠️ 定位与网络都在 Rust 侧（`desktop_weather.rs` / `desktop_chat.rs`），
//    前端只负责 invoke 和收事件。原因见那两个模块的注释。

import "./panel/panel.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
// 关于页的版本号：优先问 Tauri 要真实的应用版本（tauri.conf.json 里的 1.2.0）；
// 拿不到时退回写死的 PANEL_APP_FALLBACK_VERSION（注释里注明来源）。
import { getVersion } from "@tauri-apps/api/app";
// 剪贴板与「在资源管理器里定位」都用官方插件，没有新增任何依赖：
// - clipboard-manager 的 writeText（capabilities 已给 clipboard-manager:allow-write-text）；
// - opener 的 revealItemInDir（capabilities 已给 opener:default）。
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

interface ChatMessage {
  role: "user" | "ai" | "notice";
  who?: string;
  text: string;
}

/** Rust 侧 `desktop_chat::ChatModel` 的镜像。 */
interface ChatModel {
  id: string;
  label: string;
  tag: string;
}

/** Rust 侧 `desktop_weather::PanelWeather` 的镜像。 */
interface PanelWeather {
  temperature: number;
  weatherCode: number;
  weatherText: string;
  tempMax: number | null;
  tempMin: number | null;
  city: string;
  source: string;
  accuracy: number | null;
}

/**
 * Rust 侧 `services::notes::NoteMetadata` 的镜像。
 * 只列出面板用得到的字段，其余后端会给但不读。
 */
interface NoteMeta {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
}

/** Rust 侧 `services::notes::Note` 的镜像（比 meta 多正文）。 */
interface NoteFull extends NoteMeta {
  content: string;
}

/** Rust 侧 `desktop_trash::TrashEntryView` 的镜像（`entry` 是展平的）。 */
interface TrashEntry {
  id: string;
  title: string;
  fileName: string;
  category: string;
  createdAt: string;
  deletedAt: string;
  wordCount: number;
  preview: string;
  /** 正文（读不到时是空串）。 */
  body: string;
  /** 距离自动清理还有几天。 */
  daysLeft: number;
}

/** Rust 侧 `desktop_schedule::ScheduleItem` 的镜像。 */
interface ScheduleItem {
  id: string;
  title: string;
  /** `YYYY-MM-DDTHH:MM`，只记日期时是 `YYYY-MM-DDT00:00`。 */
  at: string;
  allDay: boolean;
  source: string;
  raw: string;
  createdAt: string;
}

/**
 * Rust 侧 `services::notes::AppConfig` 的**局部**镜像。
 *
 * 只声明面板轻设置页真正读写的那几个字段，其余字段后端照给、这里不看。
 * `#[serde(rename_all = "camelCase")]` 已在 notes.rs 里确认，所以前端是 camelCase。
 */
interface PanelAppConfig {
  /** `"light" | "dark" | "system"`，默认值是 `"system"`（notes.rs 的 `fn default_theme`）。 */
  theme: string;
  /** 数据目录，后端保证序列化输出，不会缺字段。 */
  dataDir: string;
  /** 正文字号，u32，默认 14（notes.rs 的 `fn default_font_size`）。 */
  fontSize: number;
  [key: string]: unknown;
}

/**
 * 人物卡：给 qwen 的人格设定（后端 `src-tauri/src/desktop_persona.rs` 的 `PersonaCard`）。
 *
 * 用户拍板（2026-11-15 m00776）：不是导入 SillyTavern 整卡，而是从上到下分项填，
 * 「可以限制一部分，但是不会太限制」——所以上限给得宽松，几千字的卡能进来。
 * 字段名必须和 Rust 侧 `#[serde(rename_all = "camelCase")]` 一致。
 */
interface PersonaCard {
  name: string;
  role: string;
  traitText: string;
  speech: string;
  background: string;
  example: string;
  enabled: boolean;
  updatedAt: string;
}

/** 模型下拉的兜底值：Rust 侧 `chat_models` 还没返回时先用它，避免界面空白。 */
const FALLBACK_MODELS: ChatModel[] = [
  { id: "qwen3.5-9b:latest", label: "Qwen3.5-9B", tag: "对话" },
];

/**
 * 混元的模型 id。它是纯翻译模型（capabilities 只有 completion），
 * 后端会走官方翻译模板而不是人格提示词。用户拍板：**默认翻成中文**，
 * 直接粘句子就能用；只有翻别的语言才需要写目标语言。
 */
const TRANSLATE_MODEL_ID = "hunyuan-mt-7b:latest";

let models: ChatModel[] = FALLBACK_MODELS;
let currentModel: ChatModel = models[0];
/** 当前进行中的请求 id。为空表示没有正在生成的回答。 */
let activeRequestId: string | null = null;
/** 正在流式输出的那个气泡，增量往里追加。 */
let streamingBubble: HTMLElement | null = null;
/** 本次流式已累积的文字，收到 done 时用它校正。 */
let streamingText = "";

/** 关于页兜底的版本号：与 package.json / tauri.conf.json 的 version 一致（都是 1.2.0）。getVersion 失败时才用。 */
const PANEL_APP_FALLBACK_VERSION = "1.2.0";
/** 两个小窗的过渡时长（毫秒），和 panel.css 里的 .22s 对齐；关窗时等它走完再摘节点。 */
const SHEET_FADE_MS = 220;

/** font-size 有效范围：后端 AppConfig.fontSize 是 u32，面板内夹在 12~20 之间，避免撑破 380×620。 */
const PANEL_FONT_MIN = 12;
const PANEL_FONT_MAX = 20;
/** 面板字号落到 CSS 变量的名字（挂在 .panel 的 inline style 上，不动 :root，免得影响别处）。 */
const PANEL_FONT_VAR = "--panel-fs";

// 暴露一行便于在 WebView 的开发工具里核对字体大小当前值，不参与界面渲染。
const PANEL_FONT_BASE = 14;

const root = document.getElementById("panel-root");
if (!root) {
  throw new Error("panel-root missing");
}

root.innerHTML = `
  <div class="panel">
    <div class="titlebar drag-region">
      <div class="appname"><span class="dot"></span>3.ini</div>
      <div class="tb-actions">
        <button class="icon-btn" data-action="settings" title="设置">⚙</button>
        <button class="icon-btn" data-action="minimize" title="最小化">—</button>
      </div>
    </div>

    <div class="weatherbar" id="weatherbar" title="点一下刷新天气">
      <div class="w-left">
        <span class="w-time" id="clock">--:--</span>
        <span class="w-temp" id="temp">--</span>
      </div>
      <div class="w-right">
        <span class="w-icon" id="weather-icon">·</span>
        <span id="weather-text">定位中…</span>
        <span class="w-city" id="weather-city"></span>
      </div>
    </div>

    <div class="sched">
      <div class="sec-head">
        <div class="sec-title">我的安排 <span class="sec-count" id="sched-count">0</span></div>
      </div>
      <div id="sched-list"></div>
    </div>

    <div class="divider"></div>

    <div class="funcarea">
      <div class="sec-head">
        <div class="sec-title">功能区</div>
      </div>
      <button class="memo-entry" id="memo-entry">
        <span class="memo-icon">✎</span>
        <div class="memo-text">
          <div class="title">备忘录</div>
          <div class="sub" id="memo-sub">加载中…</div>
        </div>
        <span class="memo-arrow">›</span>
      </button>
      <!-- 随记按钮放卡片外（button 不能嵌 button，浏览器会把嵌套的拆出去），CSS 浮到卡片右下角 -->
      <button class="memo-quick" id="memo-quick">随记</button>
    </div>

    <div class="chat" id="chat"></div>

    <div class="composer">
      <button class="model-select" id="model-select">
        <span id="cur-model">${currentModel.label}</span>
        <span class="caret">▼</span>
      </button>
      <div class="input-row">
        <textarea id="input" rows="1" placeholder="问我任何事…"></textarea>
        <button class="send-btn" id="send" title="发送">
          <svg class="ico-send" width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M8 13V3M8 3L3.5 7.5M8 3L12.5 7.5" stroke="currentColor"
                  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg class="ico-stop" width="11" height="11" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="3" width="10" height="10" rx="1.6" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="model-menu" id="model-menu"></div>
  </div>
`;

const chatEl = document.getElementById("chat") as HTMLElement | null;
const inputEl = document.getElementById("input") as HTMLTextAreaElement | null;
const modelMenu = document.getElementById("model-menu") as HTMLElement | null;
const curModelEl = document.getElementById("cur-model");
const clockEl = document.getElementById("clock");

function appendMessage(message: ChatMessage): HTMLElement | null {
  if (!chatEl) return null;
  const wrap = document.createElement("div");
  wrap.className = `msg ${message.role}`;
  if (message.who) {
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = message.who;
    wrap.appendChild(who);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = message.text;
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

function scrollChatToBottom() {
  if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
}

function renderSchedules() {
  void refreshSchedules();
}

/** 把 `2026-11-16T15:00` 显示成 `11-16 15:00`；只有日期时显示 `11-16 全天`。 */
function formatScheduleAt(item: ScheduleItem): string {
  const date = item.at.slice(0, 10).slice(5); // MM-DD
  if (item.allDay) return `${date} 全天`;
  const time = item.at.slice(11, 16);
  return `${date} ${time}`;
}

async function refreshSchedules() {
  const list = document.getElementById("sched-list");
  const count = document.getElementById("sched-count");
  if (!list) return;

  let items: ScheduleItem[] = [];
  try {
    // 走合并版：笔记里写了 `- [ ] 事 📅 日期` 的待办也会出现在这里。
    items = await invoke<ScheduleItem[]>("schedules_upcoming_merged");
  } catch (error) {
    // 读不到就如实说明，别让界面看起来像「真的没有安排」。
    list.innerHTML = `<div class="row"><span class="txt" style="color:var(--ink-ghost)">安排读不出来</span></div>`;
    if (count) count.textContent = "0";
    console.warn("schedules_upcoming failed", error);
    return;
  }

  if (count) count.textContent = String(items.length);

  if (items.length === 0) {
    list.innerHTML = `<div class="row"><span class="txt" style="color:var(--ink-ghost)">还没有安排</span></div>`;
    return;
  }

  list.innerHTML = items
    .map(
      (item) => `
      <div class="row sched-row" data-id="${item.id}">
        <span class="sched-when">${formatScheduleAt(item)}</span>
        <span class="txt">${escapeHtml(item.title)}</span>
      </div>`,
    )
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── 我的安排 · 弹小窗 ───────────────────────
//
// 用户拍板（2026-11-15）：点「我的安排」在面板内弹小窗，不跳原版花笺窗口。
// 小窗里能看全部（含过期的）、能加、能删。

let scheduleSheet: HTMLElement | null = null;

/**
 * 打开「我的安排」小窗。
 *
 * 显隐走 `open` class（和 `.sheet` 既有写法一致）：插入后下一帧再加 class，
 * 让 CSS 的 scale/opacity 过渡真的跑起来；关闭时先摘 class，等过渡结束再移除节点。
 */
function openScheduleSheet() {
  if (scheduleSheet) return;
  const sheet = document.createElement("div");
  sheet.className = "sched-sheet";
  sheet.innerHTML = `
    <div class="sched-sheet-inner">
      <div class="sched-sheet-head">
        <div class="sec-title">我的安排</div>
        <button class="sched-close" id="sched-close">×</button>
      </div>
      <div class="sched-new">
        <input id="sched-title" class="sched-input" placeholder="要做的事，比如 去社区医院报到" />
        <input id="sched-when" class="sched-input" type="datetime-local" />
        <button class="sched-add" id="sched-add">加进去</button>
      </div>
      <div class="sched-all" id="sched-all"></div>
    </div>`;
  document.body.appendChild(sheet);
  scheduleSheet = sheet;
  // 插入后再加 open，让 CSS 过渡从初始态跑到展开态；同时把焦点送进去。
  requestAnimationFrame(() => {
    sheet.classList.add("open");
    (document.getElementById("sched-title") as HTMLInputElement | null)?.focus();
  });

  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) closeScheduleSheet();
  });
  document.getElementById("sched-close")?.addEventListener("click", closeScheduleSheet);

  document.getElementById("sched-add")?.addEventListener("click", () => {
    void addScheduleFromSheet();
  });

  void renderScheduleSheet();
}

function closeScheduleSheet() {
  if (!scheduleSheet) return;
  const sheet = scheduleSheet;
  scheduleSheet = null;
  sheet.classList.remove("open");
  window.setTimeout(() => sheet.remove(), SHEET_FADE_MS);
}

async function addScheduleFromSheet() {
  const titleEl = document.getElementById("sched-title") as HTMLInputElement | null;
  const whenEl = document.getElementById("sched-when") as HTMLInputElement | null;
  const title = titleEl?.value.trim() ?? "";
  const when = whenEl?.value ?? "";
  if (!title) {
    titleEl?.focus();
    return;
  }
  if (!when) {
    whenEl?.focus();
    return;
  }
  try {
    // datetime-local 给的是 `YYYY-MM-DDTHH:MM`，和 Rust 侧要的格式一致。
    await invoke("schedules_add", { title, at: when, allDay: false });
    if (titleEl) titleEl.value = "";
    if (whenEl) whenEl.value = "";
    await renderScheduleSheet();
    await refreshSchedules();
  } catch (error) {
    console.warn("schedules_add failed", error);
    appendMessage({ role: "notice", text: "加不进去，可能是时间格式不对。" });
  }
}

async function renderScheduleSheet() {
  const box = document.getElementById("sched-all");
  if (!box) return;
  let items: ScheduleItem[] = [];
  try {
    items = await invoke<ScheduleItem[]>("schedules_list");
  } catch (error) {
    box.innerHTML = `<div class="row"><span class="txt">读不出来</span></div>`;
    console.warn("schedules_list failed", error);
    return;
  }
  if (items.length === 0) {
    box.innerHTML = `<div class="row"><span class="txt" style="color:var(--ink-ghost)">一条都没有</span></div>`;
    return;
  }
  const now = new Date();
  box.innerHTML = items
    .map((item) => {
      const past = new Date(item.at) < now;
      return `
        <div class="row sched-item${past ? " past" : ""}" data-id="${item.id}">
          <span class="sched-when">${formatScheduleAt(item)}</span>
          <span class="txt">${escapeHtml(item.title)}</span>
          <button class="sched-del" data-del="${item.id}" title="删掉">×</button>
        </div>`;
    })
    .join("");
  box.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = button.dataset.del;
      if (id) void removeSchedule(id);
    });
  });
}

async function removeSchedule(id: string) {
  try {
    await invoke("schedules_remove", { id });
    await renderScheduleSheet();
    await refreshSchedules();
  } catch (error) {
    console.warn("schedules_remove failed", error);
  }
}

// ── 设置 · 面板内轻设置页 ───────────────────
//
// 用户拍板（2026-11-15，D 项走 B）：**不复用**原版花笺的 React SettingsPanel
// （那个在 1180×760 的大窗口里），就在面板小窗内部做一页轻设置。
//
// 后端命令全部是 lib.rs 里已经注册好的，这一层只调用 + 渲染：
//   config_get -> AppConfig（camelCase；theme 默认 "system"，fontSize 默认 14）
//   config_save -> 整个 AppConfig 原样回写，所以本地要留一份 lastConfig 再改字段
//   schedules_list / schedules_remove -> 清空我的安排
//   （generate_handler! 里**没有** open_data_dir / reveal_in_explorer 这类命令，
//     所以「打开笔记文件夹」这一项由前端 opener 插件负责，不是后端命令。）

let settingsSheet: HTMLElement | null = null;
/** 最近一次读到的完整 AppConfig。config_save 要求整份回写，改字段都基于它。 */
let lastConfig: PanelAppConfig | null = null;
/** 设置弹层里当前显示的错误行（有值时显示在顶部，不用 alert）。 */
let settingsError = "";
/** 清空安排的二次确认状态。 */
let clearConfirmOpen = false;
/** 上次数到的待清空条数，确认条上显示「清空全部 N 条安排」。 */
let clearConfirmCount = 0;
/** 关于页的版本号，取到之后缓存，避免每次渲染都问 Tauri。 */
let appVersionText = "";

/** 人物卡表单的当前值。打开设置页时从 persona_get 读一次，改字段都改这一份。 */
let personaCard: PersonaCard | null = null;
/** 人物卡区展开状态：默认收起，点开才显示六个输入框（设置页不因此变长）。 */
let personaOpen = false;
/** 人物卡区的提示／错误行。 */
let personaHint = "";

/** 人物卡字段上限，必须和 src-tauri/src/desktop_persona.rs 里的常量对得上。 */
const PERSONA_LIMITS = {
  name: 40,
  role: 200,
  traitText: 4000,
  speech: 2000,
  background: 4000,
  example: 2000,
  total: 8000,
} as const;

function emptyPersonaCard(): PersonaCard {
  return {
    name: "",
    role: "",
    traitText: "",
    speech: "",
    background: "",
    example: "",
    enabled: false,
    updatedAt: "",
  };
}

function openSettingsSheet() {
  if (settingsSheet) return;
  const sheet = document.createElement("div");
  sheet.className = "sched-sheet settings-sheet";
  sheet.innerHTML = `
    <div class="sched-sheet-inner">
      <div class="sched-sheet-head">
        <div class="sec-title">设置</div>
        <button class="sched-close" id="set-close" title="关掉">×</button>
      </div>
      <div class="sheet-error" id="set-error" hidden></div>
      <div class="set-body" id="set-body"></div>
    </div>`;
  document.body.appendChild(sheet);
  settingsSheet = sheet;

  requestAnimationFrame(() => sheet.classList.add("open"));

  // 点遮罩关窗（和「我的安排」小窗同一套逻辑：只有点在遮罩自身上才关）。
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) closeSettingsSheet();
  });
  // 事件委托：设置项按钮多，一次性绑在弹层上，重渲染后也不用重绑。
  sheet.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    // 关闭按钮在弹层头部，不属于任何设置项，单独认一下。
    if (target.closest("#set-close")) {
      event.stopPropagation();
      closeSettingsSheet();
      return;
    }
    const button = target.closest("[data-set]") as HTMLElement | null;
    const action = button?.getAttribute("data-set");
    if (!action) return;
    event.stopPropagation();
    void handleSettingsAction(action);
  });
  // 人物卡输入时只更新计数，不重画（重画会让光标跳到开头）。
  sheet.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-persona]")) updatePersonaCounters();
  });

  void renderSettingsSheet();
}

function closeSettingsSheet() {
  if (!settingsSheet) return;
  const sheet = settingsSheet;
  settingsSheet = null;
  // 关窗时把临时状态清掉，下次打开是干净的。
  settingsError = "";
  clearConfirmOpen = false;
  sheet.classList.remove("open");
  window.setTimeout(() => sheet.remove(), SHEET_FADE_MS);
}

function setSettingsError(message: string) {
  settingsError = message;
  const box = document.getElementById("set-error");
  if (!box) return;
  box.textContent = message;
  box.hidden = message === "";
}

async function handleSettingsAction(action: string) {
  if (action === "close") {
    closeSettingsSheet();
    return;
  }
  if (action === "clear-cancel") {
    clearConfirmOpen = false;
    await renderSettingsSheet();
    return;
  }
  if (action.startsWith("theme:")) {
    await saveTheme(action.slice("theme:".length));
    return;
  }
  if (action === "font-minus") {
    await stepFontSize(-1);
    return;
  }
  if (action === "font-plus") {
    await stepFontSize(1);
    return;
  }
  if (action === "copy-data-dir") {
    await copyDataDir();
    return;
  }
  if (action === "reveal-data-dir") {
    await revealDataDir();
    return;
  }
  if (action === "clear-schedules") {
    await requestClearSchedules();
    return;
  }
  if (action === "clear-confirm") {
    await clearAllSchedules();
    return;
  }
  // ── 人物卡 ──
  if (action === "persona-toggle") {
    // 收起前先把正在打字的内容收进来，否则展开回来是旧的。
    if (personaOpen) personaCard = collectPersonaForm();
    personaOpen = !personaOpen;
    personaHint = "";
    await renderSettingsSheet();
    return;
  }
  if (action === "persona-save") {
    await savePersonaCard();
    return;
  }
  if (action === "persona-enable" || action === "persona-disable") {
    const card = collectPersonaForm();
    card.enabled = action === "persona-enable";
    if (card.enabled && card.name.trim().length === 0 && card.traitText.trim().length === 0) {
      personaHint = "至少要填名字或者性格，才能启用";
      await renderSettingsSheet();
      return;
    }
    personaHint = "保存中…";
    personaCard = card;
    await renderSettingsSheet();
    try {
      const saved = await invoke<PersonaCard>("persona_save", { card });
      personaCard = { ...emptyPersonaCard(), ...saved };
      personaHint = saved.enabled ? "已启用，qwen 现在会按这个角色说话" : "已停用，qwen 用默认人格";
    } catch (error) {
      const message = (error as { message?: string })?.message;
      personaHint = message || "切换失败，稍后再试";
    }
    await renderSettingsSheet();
    return;
  }
  if (action === "persona-refresh") {
    // 点摘要那行等于重新读一次磁盘上的卡（比如在别处改过）。
    personaCard = null;
    personaHint = "";
    await renderSettingsSheet();
    return;
  }
}

/** 读 config 并记住整份，供后续 config_save 原样回写。失败时在顶部显示一行错误。 */
async function loadConfig(): Promise<PanelAppConfig | null> {
  try {
    const config = await invoke<PanelAppConfig>("config_get");
    lastConfig = config;
    return config;
  } catch (error) {
    console.warn("config_get failed", error);
    setSettingsError("配置读不出来，请稍后再试");
    return null;
  }
}

/**
 * 改写一个字段并整份保存。
 *
 * config_save 收到的是完整 AppConfig，所以不能用 `{ theme }` 这种局部对象，
 * 必须把 lastConfig 展开后只覆盖要改的键。
 */
async function saveConfigField(
  patch: Partial<PanelAppConfig>,
): Promise<PanelAppConfig | null> {
  const base = lastConfig ?? (await loadConfig());
  if (!base) return null;
  try {
    const saved = await invoke<PanelAppConfig>("config_save", {
      config: { ...base, ...patch },
    });
    lastConfig = saved;
    setSettingsError("");
    return saved;
  } catch (error) {
    console.warn("config_save failed", error);
    setSettingsError("保存失败，配置没有写进磁盘");
    return null;
  }
}

/** light / dark / system -> 实际画到界面上的 light / dark。 */
function resolveThemeOption(option: string): "light" | "dark" {
  if (option === "dark" || option === "light") return option;
  return systemThemeQuery.matches ? "dark" : "light";
}

/** 「跟随系统」用的媒体查询，一路复用，避免每次渲染都新建。 */
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * 应用主题：和原版 `features/settings/theme.ts` 走同一套约定。
 *
 * 面板的深色 token 写在 `html[data-theme="dark"]` 下（见 panel.css 开头），
 * 原版用 data-theme、本面板同时补一个 `dark` class，两种写法都能命中，
 * 也不会影响别的窗口（只改自己的 documentElement）。
 * 顺带把 theme-option 缓存进 localStorage，下次开窗首屏不至于闪错颜色。
 */
function applyPanelTheme(option: string) {
  // 「跟随系统」时要真的跟着系统变：注册一次 onchange，切到别的模式就卸掉。
  systemThemeQuery.onchange =
    option === "system" ? () => applyPanelTheme("system") : null;

  const resolved = resolveThemeOption(option);
  document.documentElement.setAttribute("data-theme", resolved);
  if (resolved === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
  try {
    window.localStorage.setItem("theme-option", option);
  } catch (error) {
    // localStorage 在某些受限环境会抛；主题已经生效了，这里不影响使用。
    console.warn("cache theme-option failed", error);
  }
}

async function saveTheme(option: string) {
  if (option !== "light" && option !== "dark" && option !== "system") return;
  // 先落地到界面，用户点下去立刻见效果；写盘失败再回滚成旧值。
  const previous = lastConfig?.theme ?? "system";
  applyPanelTheme(option);
  const saved = await saveConfigField({ theme: option });
  if (!saved) {
    applyPanelTheme(previous);
  }
  await renderSettingsSheet();
}

/**
 * 字体大小：改 config 里的 fontSize（u32），并同步面板的 CSS 变量。
 *
 * 面板字体没有全局的 rem 基准（各块都是 px 写死的），所以用 --panel-fs 这个
 * 变量配合 `zoom` 在 .panel 上整体缩放，数值变化能真的看见。
 */
function applyPanelFontSize(size: number) {
  const clamped = Math.min(PANEL_FONT_MAX, Math.max(PANEL_FONT_MIN, Math.round(size)));
  const scale = clamped / PANEL_FONT_BASE;
  const panel = document.querySelector(".panel") as HTMLElement | null;
  if (!panel) return;
  panel.style.setProperty(PANEL_FONT_VAR, String(clamped));
  panel.style.zoom = String(Number(scale.toFixed(3)));
}

async function stepFontSize(delta: number) {
  const base = lastConfig ?? (await loadConfig());
  if (!base) return;
  const current = Number(base.fontSize) || PANEL_FONT_BASE;
  const next = Math.min(PANEL_FONT_MAX, Math.max(PANEL_FONT_MIN, current + delta));
  if (next === current) return;
  applyPanelFontSize(next);
  const saved = await saveConfigField({ fontSize: next });
  if (!saved) {
    applyPanelFontSize(current);
  }
  await renderSettingsSheet();
}

/** 复制路径：优先官方剪贴板插件（capabilities 只开了插件这条），失败再退回 navigator。 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch (error) {
    console.warn("clipboard writeText failed, fallback to navigator", error);
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.warn("navigator.clipboard failed", error);
    return false;
  }
}

async function copyDataDir() {
  const dir = lastConfig?.dataDir ?? "";
  if (!dir) {
    setSettingsError("还没有拿到数据目录");
    return;
  }
  const ok = await copyTextToClipboard(dir);
  if (!ok) {
    setSettingsError("复制失败，可以手动选中路径复制");
    return;
  }
  setSettingsError("");
  // 复制成功给一句轻反馈，用弹层里的状态行，不打扰对话区。
  const hint = document.getElementById("set-copy-hint");
  if (hint) {
    hint.textContent = "已复制";
    window.setTimeout(() => {
      if (hint.isConnected) hint.textContent = "";
    }, 1600);
  }
}

/**
 * 打开笔记文件夹。
 *
 * 后端 generate_handler! 里**没有**打开目录的命令，所以不自己造命令，
 * 改用已装好的 opener 插件把目录在资源管理器里定位出来（pre-mount 到 panel 窗口）。
 * 插件/权限不可用时如实报错，并提示用「复制路径」。
 */
async function revealDataDir() {
  const dir = lastConfig?.dataDir ?? "";
  if (!dir) {
    setSettingsError("还没有拿到数据目录");
    return;
  }
  try {
    await revealItemInDir(dir);
    setSettingsError("");
  } catch (error) {
    console.warn("revealItemInDir failed", error);
    setSettingsError("打不开文件夹，可以先点「复制路径」自己打开");
  }
}

/** 第一次点「清空」只掀开确认条，不删任何东西。 */
async function requestClearSchedules() {
  let items: ScheduleItem[] = [];
  try {
    items = await invoke<ScheduleItem[]>("schedules_list");
  } catch (error) {
    console.warn("schedules_list failed", error);
    setSettingsError("安排读不出来，没法清空");
    return;
  }
  if (items.length === 0) {
    clearConfirmOpen = false;
    clearConfirmCount = 0;
    setSettingsError("现在一条安排都没有");
    await renderSettingsSheet();
    return;
  }
  clearConfirmOpen = true;
  clearConfirmCount = items.length;
  setSettingsError("");
  await renderSettingsSheet();
}

/** 真正执行清空：逐条 schedules_remove，成功后刷新列表。 */
async function clearAllSchedules() {
  clearConfirmOpen = false;
  let items: ScheduleItem[] = [];
  try {
    items = await invoke<ScheduleItem[]>("schedules_list");
  } catch (error) {
    console.warn("schedules_list failed", error);
    setSettingsError("安排读不出来，没清空");
    return;
  }
  let removed = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await invoke("schedules_remove", { id: item.id });
      removed += 1;
    } catch (error) {
      console.warn("schedules_remove failed", item.id, error);
      failed += 1;
    }
  }
  await refreshSchedules();
  if (scheduleSheet) await renderScheduleSheet();
  if (failed > 0) {
    setSettingsError(`清掉 ${removed} 条，还有 ${failed} 条没删掉`);
  } else {
    setSettingsError("");
  }
  await renderSettingsSheet();
}

const THEME_LABELS: { value: string; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

// ── 人物卡 ─────────────────────────────────
//
// 用户 m00745 原话：「在设置里面加一个导入人物卡，是专门给qwen的，记得说明，
// 还有我在想要不要给人物卡一些限制，一些人物卡可能会有几千字」。
// m00776 又定：表单式（名字、性格…从上到下分项），只存纯文本。
//
// 这就是一段**只影响 qwen 对话**的设定：别的模型（hunyuan 的翻译、
// spark 的记安排）不受影响，因为它们走各自的提示词分支。

/** 六栏表单定义。顺序就是从上到下的顺序，别随意调。 */
const PERSONA_FIELDS: {
  key: keyof Pick<PersonaCard, "name" | "role" | "traitText" | "speech" | "background" | "example">;
  label: string;
  hint: string;
  limit: number;
  rows: number;
}[] = [
  { key: "name", label: "名字", hint: "这个角色叫什么", limit: PERSONA_LIMITS.name, rows: 1 },
  { key: "role", label: "身份", hint: "一句话，比如「二手书店店员」", limit: PERSONA_LIMITS.role, rows: 1 },
  { key: "traitText", label: "性格", hint: "他是怎样的人，可以写长", limit: PERSONA_LIMITS.traitText, rows: 4 },
  { key: "speech", label: "说话方式", hint: "语气、用词、口癖", limit: PERSONA_LIMITS.speech, rows: 3 },
  { key: "background", label: "背景", hint: "经历、处境，可以写长", limit: PERSONA_LIMITS.background, rows: 4 },
  { key: "example", label: "说话样例", hint: "几句典型台词，照着这个语气说", limit: PERSONA_LIMITS.example, rows: 3 },
];

/** 打开设置页时读一次人物卡。读不到就当空卡，不挡设置页其他功能。 */
async function loadPersonaCard(): Promise<void> {
  if (personaCard) return;
  try {
    const card = await invoke<PersonaCard>("persona_get");
    personaCard = { ...emptyPersonaCard(), ...card };
    // 有内容就默认展开，省得用户以为没保存上。
    personaOpen = personaCard.enabled || personaCard.name.trim().length > 0;
  } catch (error) {
    console.warn("persona_get failed", error);
    personaCard = emptyPersonaCard();
    personaHint = "人物卡暂时读不出来，可以先编辑，保存会新建一份";
  }
}

/** 人物卡那一块的 HTML。收起时只显示一行摘要。 */
function renderPersonaBlock(): string {
  const card = personaCard ?? emptyPersonaCard();
  const filled = PERSONA_FIELDS.filter((field) => String(card[field.key] ?? "").trim().length > 0);
  const summary = card.enabled
    ? filled.length > 0
      ? `已启用：${card.name.trim() || "（没填名字）"}`
      : "已启用，但还没填内容"
    : "没启用，qwen 用默认的 dlite 人格";

  const toggleLabel = personaOpen ? "收起" : "展开填写";
  const head = `
    <div class="set-label">人物卡</div>
    <div class="set-hint">给 qwen 用的角色设定。填了并在下面打勾启用，对话时 qwen 就会按这个角色说话；
      翻译和记安排那两个模型不受影响。</div>
    <div class="persona-summary" data-set="persona-refresh">${escapeHtml(summary)}</div>
    <button class="set-btn ghost" data-set="persona-toggle">${toggleLabel}</button>
  `;

  if (!personaOpen) {
    return `<div class="set-group">${head}${personaHint ? `<div class="set-hint persona-note">${escapeHtml(personaHint)}</div>` : ""}</div>`;
  }

  const inputs = PERSONA_FIELDS.map((field) => {
    const value = String(card[field.key] ?? "");
    const len = value.length;
    const over = len > field.limit ? " over" : "";
    const tag =
      field.rows <= 1
        ? `<input class="persona-input" data-persona="${field.key}" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.hint)}" maxlength="${field.limit}" />`
        : `<textarea class="persona-input persona-area" data-persona="${field.key}" rows="${field.rows}" placeholder="${escapeHtml(field.hint)}" maxlength="${field.limit}">${escapeHtml(value)}</textarea>`;
    return `
      <div class="persona-field">
        <div class="persona-field-head">
          <span class="persona-field-label">${field.label}</span>
          <span class="persona-count${over}" data-count="${field.key}">${len}/${field.limit}</span>
        </div>
        ${tag}
      </div>`;
  }).join("");

  const total = PERSONA_FIELDS.reduce((sum, field) => sum + String(card[field.key] ?? "").length, 0);
  const totalOver = total > PERSONA_LIMITS.total ? " over" : "";
  const enabledBox = card.enabled
    ? `<button class="set-btn ghost" data-set="persona-disable">停用人物卡</button>`
    : `<button class="set-btn" data-set="persona-enable">启用人物卡</button>`;

  return `
    <div class="set-group">
      ${head}
      <div class="persona-form">${inputs}</div>
      <div class="persona-total${totalOver}" data-count="total">整张卡 ${total}/${PERSONA_LIMITS.total} 字</div>
      <div class="set-row">
        <button class="set-btn" data-set="persona-save">保存人物卡</button>
        ${enabledBox}
      </div>
      ${personaHint ? `<div class="set-hint persona-note">${escapeHtml(personaHint)}</div>` : ""}
    </div>`;
}

/** 把表单里当前的输入收集回 personaCard。 */
function collectPersonaForm(): PersonaCard {
  const card = personaCard ? { ...personaCard } : emptyPersonaCard();
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-persona]").forEach((node) => {
    const key = node.getAttribute("data-persona") as keyof PersonaCard | null;
    if (!key) return;
    (card as unknown as Record<string, string>)[key] = node.value;
  });
  return card;
}

/** 输入时实时更新字数计数（不重渲染，否则光标会跳）。 */
function updatePersonaCounters(): void {
  const card = collectPersonaForm();
  let total = 0;
  PERSONA_FIELDS.forEach((field) => {
    const len = String(card[field.key] ?? "").length;
    total += len;
    const node = document.querySelector<HTMLElement>(`[data-count="${field.key}"]`);
    if (node) {
      node.textContent = `${len}/${field.limit}`;
      node.classList.toggle("over", len > field.limit);
    }
  });
  const totalNode = document.querySelector<HTMLElement>('[data-count="total"]');
  if (totalNode) {
    totalNode.textContent = `整张卡 ${total}/${PERSONA_LIMITS.total} 字`;
    totalNode.classList.toggle("over", total > PERSONA_LIMITS.total);
  }
}

/** 保存人物卡。超限先在前端挡一次，省得跑一趟后端。 */
async function savePersonaCard(): Promise<void> {
  const card = collectPersonaForm();
  for (const field of PERSONA_FIELDS) {
    const len = String(card[field.key] ?? "").length;
    if (len > field.limit) {
      personaHint = `「${field.label}」${len} 字，超过上限 ${field.limit} 字，删掉 ${len - field.limit} 字再保存`;
      await renderSettingsSheet();
      return;
    }
  }
  const total = PERSONA_FIELDS.reduce((sum, field) => sum + String(card[field.key] ?? "").length, 0);
  if (total > PERSONA_LIMITS.total) {
    personaHint = `整张人物卡 ${total} 字，超过 ${PERSONA_LIMITS.total} 字上限，删掉 ${total - PERSONA_LIMITS.total} 字再保存`;
    await renderSettingsSheet();
    return;
  }

  personaHint = "保存中…";
  await renderSettingsSheet();
  try {
    const saved = await invoke<PersonaCard>("persona_save", { card });
    personaCard = { ...emptyPersonaCard(), ...saved };
    personaHint = personaCard.enabled
      ? `已保存并启用：${personaCard.name.trim() || "（没填名字）"}`
      : "已保存，但还没启用";
  } catch (error) {
    // 后端会回 persona:too_long 并说明超了几个字，原样显示给用户。
    const message = (error as { message?: string })?.message;
    personaHint = message || "人物卡保存失败，稍后再试";
  }
  await renderSettingsSheet();
}

// ── 设置页主体 ─────────────────────────────

/** 渲染整页设置内容。每次改动后整块重画，避免局部状态不一致。 */
async function renderSettingsSheet() {
  const body = document.getElementById("set-body");
  if (!body) return;
  const config = lastConfig ?? (await loadConfig());
  if (!config) {
    body.innerHTML = `<div class="set-empty">读不到配置，这一页暂时用不了</div>`;
    return;
  }
  await loadPersonaCard();

  // 开窗时把主题和字号对齐到磁盘上的值，保证「看到的就是保存的」。
  applyPanelTheme(config.theme);
  const fontSize = Number(config.fontSize) || PANEL_FONT_BASE;
  applyPanelFontSize(fontSize);
  const dataDir = config.dataDir || "（未知）";

  const themeButtons = THEME_LABELS.map((item) => {
    const active = item.value === config.theme ? " active" : "";
    return `<button class="set-seg${active}" data-set="theme:${item.value}">${item.label}</button>`;
  }).join("");

  const clearBlock = clearConfirmOpen
    ? `<div class="set-confirm">
         <div class="set-confirm-text">清空全部 ${clearConfirmCount} 条安排？不可恢复</div>
         <div class="set-confirm-actions">
           <button class="set-btn ghost" data-set="clear-cancel">先不清</button>
           <button class="set-btn danger" data-set="clear-confirm">确认清空</button>
         </div>
       </div>`
    : `<button class="set-btn danger" data-set="clear-schedules">清空我的安排</button>`;

  body.innerHTML = `
    <div class="set-group">
      <div class="set-label">明暗模式</div>
      <div class="set-seg-row">${themeButtons}</div>
    </div>

    <div class="set-group">
      <div class="set-label">字体大小</div>
      <div class="set-row">
        <button class="set-step" data-set="font-minus" title="小一点">-</button>
        <span class="set-value">${fontSize} px</span>
        <button class="set-step" data-set="font-plus" title="大一点">+</button>
      </div>
    </div>

    <div class="set-group">
      <div class="set-label">数据目录</div>
      <div class="set-path" id="set-data-dir" title="${escapeHtml(dataDir)}">${escapeHtml(dataDir)}</div>
      <div class="set-row">
        <button class="set-btn ghost" data-set="reveal-data-dir">打开笔记文件夹</button>
        <button class="set-btn ghost" data-set="copy-data-dir">复制路径</button>
        <span class="set-hint" id="set-copy-hint"></span>
      </div>
    </div>

    <div class="set-group">
      <div class="set-label">我的安排</div>
      ${clearBlock}
    </div>

    ${renderPersonaBlock()}

    <div class="set-group">
      <div class="set-label">关于</div>
      <div class="set-about">
        <div class="set-about-name">3.ini</div>
        <div class="set-about-ver">版本 ${escapeHtml(appVersionText || PANEL_APP_FALLBACK_VERSION)}</div>
      </div>
    </div>
  `;

  // 错误行跟着重渲染刷新（body 换了，顶部的错误条还在 sheet 上）。
  setSettingsError(settingsError);
  void loadAppVersion();
}

/** 版本号只问一次 Tauri，失败就用写死的兜底值，不反复重试。 */
async function loadAppVersion() {
  if (appVersionText) return;
  try {
    const version = await getVersion();
    appVersionText = version || PANEL_APP_FALLBACK_VERSION;
  } catch (error) {
    console.warn("getVersion failed, fallback", error);
    appVersionText = PANEL_APP_FALLBACK_VERSION;
  }
  const node = document.querySelector(".set-about-ver");
  if (node) node.textContent = `版本 ${appVersionText}`;
}

// ── 备忘录 · 面板内白纸 ─────────────────────
//
// 用户拍板（2026-11-15）：点「备忘录」先在面板内部弹出白纸，
// 不要一上来就跳原版花笺那个 1180×760 的大窗口。
// 面板里只做「看 + 写」，重活（分类、图片、导出）仍归原版窗口。
//
// 后端能力是原版花笺 `services/notes.rs` 的完整实现，已经在
// `lib.rs` 里注册好 `notes_list / notes_get / notes_create / notes_update`，
// 这一层只负责调用和渲染，不重新实现存储。

let memoSheet: HTMLElement | null = null;
/** 当前正在编辑的笔记 id；为空表示列表态。 */
let memoEditingId: string | null = null;
/** 当前显示的是回收站而不是笔记列表（决定头部的返回键走向）。 */
let memoInTrash = false;
/** 白纸上的输入框。 */
let memoArea: HTMLTextAreaElement | null = null;
/** 自动保存防抖计时器。 */
let memoSaveTimer: number | null = null;
/** 上次成功保存的内容，用来避免重复写盘。 */
let memoSavedText = "";
/** 停手多久才落盘（毫秒）。打字过程中一直重置，停手 700ms 才真正写一次。 */
const MEMO_SAVE_DELAY_MS = 700;
/**
 * 双链返回栈：存「从哪条跳过来的」笔记 id，栈顶是最近一次来源。
 * 只在备忘录弹层内有效，关窗时清空；点头部「返回」弹一条，按栈回退。
 */
let memoBackStack: string[] = [];
/** 最近一次渲染链接条时的目标集合（去重后按出现顺序），用来判断要不要重渲染 DOM。 */
let memoLinkKeys: string[] = [];
/** 正在解析目标标题，防止连点两下 chip 并发创建出两条同名空笔记。 */
let memoLinkJumping = false;

/** `[[` 与 `]]` 之间的目标标题。空标题、换行、内层再套 `[[` 都不算，避免误识别。 */
const MEMO_LINK_PATTERN = /\[\[([^[\]\n]{1,40})\]\]/g;

/** 从整段正文里抽出所有双链目标，按出现顺序去重。 */
function parseMemoLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  MEMO_LINK_PATTERN.lastIndex = 0;
  let match = MEMO_LINK_PATTERN.exec(text);
  while (match !== null) {
    const name = match[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
    match = MEMO_LINK_PATTERN.exec(text);
  }
  return out;
}

async function refreshMemoSub() {
  const sub = document.getElementById("memo-sub");
  if (!sub) return;
  try {
    const notes = await invoke<NoteMeta[]>("notes_list");
    sub.textContent = notes.length === 0 ? "点开直接写" : `${notes.length} 条 · 点开就能写`;
  } catch (error) {
    sub.textContent = "点开直接写";
    console.warn("notes_list failed", error);
  }
}

function openMemoSheet() {
  if (memoSheet) return;
  const sheet = document.createElement("div");
  sheet.className = "memo-sheet";
  sheet.innerHTML = `
    <div class="memo-sheet-inner">
      <div class="memo-sheet-head">
        <button class="memo-back" id="memo-back" title="回到列表" hidden>‹</button>
        <div class="sec-title" id="memo-title">备忘录</div>
        <button class="memo-new" id="memo-new">+ 新</button>
        <button class="sched-close" id="memo-close">×</button>
      </div>
      <div class="memo-body" id="memo-body"></div>
      <div class="memo-links" id="memo-links" hidden></div>
      <div class="memo-foot" id="memo-foot">自动保存</div>
    </div>`;
  document.body.appendChild(sheet);
  memoSheet = sheet;
  // 和「我的安排」弹窗一样：插入后下一帧再加 open，让 CSS 的淡入 + 缩放过渡真的跑起来。
  requestAnimationFrame(() => sheet.classList.add("open"));

  sheet.addEventListener("click", (event) => {
    // 点遮罩才关；点内容区不关（编辑中误触很致命）。
    if (event.target === sheet) closeMemoSheet();
  });
  document.getElementById("memo-close")?.addEventListener("click", closeMemoSheet);
  document.getElementById("memo-new")?.addEventListener("click", () => void createMemo());
  // 编辑态：有返回栈就按栈回退，栈空就照旧回列表。
  document.getElementById("memo-back")?.addEventListener("click", () => void memoBackAction());
  // 链接条是整体重建的，事件挂在容器上用委托，省得每次重画都重新绑。
  document.getElementById("memo-links")?.addEventListener("click", (event) => {
    const chip = (event.target as HTMLElement | null)?.closest(".memo-link-chip") as HTMLElement | null;
    const target = chip?.dataset.target;
    if (target) void jumpMemoLink(target);
  });

  void renderMemoList();
}

function closeMemoSheet() {
  // 关之前把没存的存掉，否则用户以为写了其实丢了。
  flushMemoSave();
  // 先摘 open 播完过渡，再摘节点；早先是直接 remove，画面上就是硬切。
  const sheet = memoSheet;
  if (sheet) {
    sheet.classList.remove("open");
    window.setTimeout(() => sheet.remove(), SHEET_FADE_MS);
  }
  memoSheet = null;
  memoEditingId = null;
  memoArea = null;
  memoSavedText = "";
  // 返回栈只在弹层内有效，关窗清空。
  memoBackStack = [];
  memoLinkKeys = [];
  memoLinkJumping = false;
}

/** 立即保存（不等防抖），关窗/切页时调。 */
function flushMemoSave() {
  if (memoSaveTimer !== null) {
    window.clearTimeout(memoSaveTimer);
    memoSaveTimer = null;
  }
  if (memoEditingId && memoArea) {
    const text = memoArea.value;
    if (text !== memoSavedText) {
      void saveMemo(memoEditingId, text);
    }
  }
}

async function saveMemo(id: string, content: string) {
  try {
    setMemoFoot("保存中…", false, "saving");
    // title 用首行文字，和原版花笺「无标题也用正文起头」的习惯一致。
    const firstLine = content.split("\n").find((line) => line.trim().length > 0) ?? "";
    const title = firstLine.trim().slice(0, 30) || "无标题";
    const note = await invoke<NoteFull>("notes_update", {
      id,
      request: { title, content, category: "" },
    });
    memoSavedText = content;
    setMemoFoot(`已保存 ${nowHm()}`, false);
    if (memoSheet && memoEditingId === id) {
      const titleEl = document.getElementById("memo-title");
      if (titleEl) titleEl.textContent = note.title || "无标题";
    }
    void refreshMemoSub();
  } catch (error) {
    // 保存失败必须让用户看见，不能只写 console。
    setMemoFoot("保存失败，内容还在这一页，别关", true);
    console.error("notes_update failed", error);
  }
}

function nowHm(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function setMemoFoot(text: string, isError: boolean, tone?: "saving") {
  const foot = document.getElementById("memo-foot");
  if (!foot) return;
  foot.textContent = text;
  foot.classList.toggle("err", isError);
  foot.classList.toggle("saving", tone === "saving");
}

async function createMemo() {
  if (!memoSheet) return;
  flushMemoSave();
  try {
    const note = await invoke<NoteFull>("notes_create", {
      request: { title: "无标题", content: "", category: "" },
    });
    void refreshMemoSub();
    await openMemoEditor(note.id);
  } catch (error) {
    setMemoFoot("新建失败", true);
    console.error("notes_create failed", error);
  }
}

async function renderMemoList() {
  const body = document.getElementById("memo-body");
  if (!body) return;
  flushMemoSave();
  memoEditingId = null;
  memoArea = null;
  // 回到列表等于离开整条跳转链，栈跟着清空。
  memoBackStack = [];
  memoLinkKeys = [];
  // 列表态不放链接条。
  hideMemoLinks();
  memoInTrash = false;
  setMemoHeadMode(false);

  let notes: NoteMeta[] = [];
  try {
    notes = await invoke<NoteMeta[]>("notes_list");
  } catch (error) {
    body.innerHTML = `<div class="memo-empty">读不出来，看看是不是数据目录不对</div>`;
    console.warn("notes_list failed", error);
    return;
  }

  if (notes.length === 0) {
    body.innerHTML = `<div class="memo-empty">还没有笔记<br />点右上角「+ 新」开始写</div>`;
    setMemoFoot("自动保存", false);
    return;
  }

  body.innerHTML = `<div class="memo-list">${notes
    .map(
      (note) => `
      <button class="memo-item" data-note="${note.id}">
        <div class="memo-item-title">${escapeHtml(note.title || "无标题")}</div>
        <div class="memo-item-preview">${escapeHtml(note.preview || "")}</div>
      </button>`,
    )
    .join("")}</div>
  <div class="memo-trash-entry" id="memo-trash-entry">最近删除 · 点开看看</div>`;
  setMemoFoot(`${notes.length} 条`, false);

  body.querySelectorAll<HTMLButtonElement>("[data-note]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.note;
      if (id) void openMemoEditor(id);
    });
  });
  document
    .getElementById("memo-trash-entry")
    ?.addEventListener("click", () => void renderTrashList());
}

/// 回收站：列出删掉还没到 30 天的笔记，可以「恢复」或「彻底删除」。
async function renderTrashList() {
  const body = document.getElementById("memo-body");
  if (!body) return;
  flushMemoSave();
  memoEditingId = null;
  memoArea = null;
  memoBackStack = [];
  memoLinkKeys = [];
  hideMemoLinks();
  memoInTrash = true;
  // 头部退回「‹ 列表」模式，并让返回键回到笔记列表而不是上一条笔记。
  setMemoHeadMode(true);
  setMemoHeadTitle("最近删除");

  let entries: TrashEntry[] = [];
  try {
    entries = await invoke<TrashEntry[]>("trash_list");
  } catch (error) {
    body.innerHTML = `<div class="memo-empty">读不出来，看看是不是数据目录不对</div>`;
    console.warn("trash_list failed", error);
    return;
  }

  if (entries.length === 0) {
    body.innerHTML = `<div class="memo-empty">这里空的<br />删掉的笔记会在这儿放 30 天</div>`;
    setMemoFoot("最近删除", false);
    return;
  }

  body.innerHTML = `<div class="memo-list">${entries
    .map(
      (entry) => `
      <div class="trash-item">
        <div class="trash-main">
          <div class="memo-item-title">${escapeHtml(entry.title || "无标题")}</div>
          <div class="memo-item-preview">${escapeHtml(entry.preview || entry.body.slice(0, 60) || "")}</div>
          <div class="trash-meta">${formatTrashDate(entry.deletedAt)} 删 · 还有 ${Math.max(
            entry.daysLeft,
            0,
          )} 天</div>
        </div>
        <div class="trash-acts">
          <button class="trash-btn" data-restore="${entry.id}">恢复</button>
          <button class="trash-btn danger" data-purge="${entry.id}">彻底删</button>
        </div>
      </div>`,
    )
    .join("")}</div>
  <div class="memo-trash-entry" id="memo-trash-back">‹ 回到笔记列表</div>`;
  setMemoFoot(`${entries.length} 个 · 30 天后自动清掉`, false);

  document
    .getElementById("memo-trash-back")
    ?.addEventListener("click", () => void renderMemoList());

  body.querySelectorAll<HTMLButtonElement>("[data-restore]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.restore;
      if (!id) return;
      button.disabled = true;
      try {
        await invoke("trash_restore", { id });
        void refreshMemoSub();
        await renderTrashList();
      } catch (error) {
        button.disabled = false;
        setMemoFoot("恢复失败", true);
        console.error("trash_restore failed", error);
      }
    });
  });

  body.querySelectorAll<HTMLButtonElement>("[data-purge]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.purge;
      if (!id) return;
      // 彻底删除不可恢复，必须问一次——这个按钮点错了就是真没了。
      if (!window.confirm("彻底删掉这一条？删了找不回来。")) return;
      button.disabled = true;
      try {
        await invoke("trash_delete", { id });
        await renderTrashList();
      } catch (error) {
        button.disabled = false;
        setMemoFoot("删除失败", true);
        console.error("trash_delete failed", error);
      }
    });
  });
}

/// `2026-11-15T21:03:00Z` → `11月15日 21:03`；解析不出来就原样给日期部分。
function formatTrashDate(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(
    2,
    "0",
  )}:${String(date.getMinutes()).padStart(2, "0")}`;
}

async function openMemoEditor(id: string) {
  const body = document.getElementById("memo-body");
  if (!body) return;
  // 切到另一条笔记前先落盘，自动保存的内容不能丢。
  flushMemoSave();
  // 从回收站点进来会带着回收站状态，进了编辑器就得清掉。
  memoInTrash = false;

  // 先取到正文再换 DOM：取失败时不动当前这一页，用户还能继续写。
  let note: NoteFull;
  try {
    note = await invoke<NoteFull>("notes_get", { id });
  } catch (error) {
    body.innerHTML = `<div class="memo-empty">这条读不出来</div>`;
    // 列表态没有链接条；编辑态保留旧链接条，等用户继续改。
    if (!memoEditingId) hideMemoLinks();
    setMemoHeadMode(Boolean(memoEditingId));
    console.warn("notes_get failed", error);
    return;
  }

  memoEditingId = id;
  setMemoHeadMode(true);
  body.innerHTML = `<textarea class="memo-paper" id="memo-paper" spellcheck="false"></textarea>`;
  const area = document.getElementById("memo-paper") as HTMLTextAreaElement | null;
  if (!area) return;
  memoArea = area;
  memoSavedText = note.content;
  area.value = note.content;
  const titleEl = document.getElementById("memo-title");
  if (titleEl) titleEl.textContent = note.title || "无标题";
  setMemoFoot("自动保存", false);
  // 打开时先按正文里现有的双链画一次链接条。
  renderMemoLinks(area.value, true);
  area.focus();
  // 光标落到末尾，接着上次写。
  area.setSelectionRange(area.value.length, area.value.length);

  area.addEventListener("input", () => {
    // 三段状态：正在写（待保存）→ 保存中（已发起请求）→ 已保存 HH:MM。
    setMemoFoot("正在写…", false, "saving");
    // 双链目标集合变了才重画链接条，否则不动 DOM，避免打字闪烁。
    renderMemoLinks(area.value, false);
    if (memoSaveTimer !== null) window.clearTimeout(memoSaveTimer);
    memoSaveTimer = window.setTimeout(() => {
      memoSaveTimer = null;
      if (memoEditingId && memoArea) void saveMemo(memoEditingId, memoArea.value);
    }, MEMO_SAVE_DELAY_MS);
  });
}

/** 列表态 / 编辑态切换：标题、返回按钮、新建按钮。 */
function setMemoHeadMode(editing: boolean) {
  const back = document.getElementById("memo-back");
  const newBtn = document.getElementById("memo-new");
  if (back) {
    // 编辑态：栈空时返回按钮就是「回列表」，有栈时才是「回上一条」。
    back.hidden = !editing;
    back.title = !editing ? "回到列表" : memoBackStack.length > 0 ? "回到上一条" : "回到列表";
  }
  if (newBtn) newBtn.hidden = editing;
  if (!editing) {
    hideMemoLinks();
    setMemoHeadTitle("备忘录");
  }
}

/// 改头部标题（回收站等子视图要用，回收站走 `<` 回列表而不是 Esc）。
function setMemoHeadTitle(text: string) {
  const titleEl = document.getElementById("memo-title");
  if (titleEl) titleEl.textContent = text;
}

// ── 备忘录 · 双链 [[标题]] ───────────────────
//
// textarea 没法点文字跳转，所以编辑态在正文下方加一条窄链接条，
// 把当前正文里出现的 `[[标题]]` 列成一排 chip，点 chip 跳到目标笔记。
// 目标不存在就现场建一条同名空笔记（和 Obsidian 的习惯一致），
// 跳转前把来源 id 压进返回栈，头部「返回」按栈回退。

/** 画链接条；force 为 false 时目标集合没变就直接返回，不动 DOM。 */
function renderMemoLinks(text: string, force: boolean) {
  const bar = document.getElementById("memo-links");
  if (!bar) return;
  const names = parseMemoLinks(text);
  const nextKeys = names.map((name) => name.toLowerCase());
  if (!force && nextKeys.length === memoLinkKeys.length && nextKeys.every((key, i) => key === memoLinkKeys[i])) {
    return;
  }
  memoLinkKeys = nextKeys;

  if (names.length === 0) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }

  const frag = document.createDocumentFragment();
  names.forEach((name) => {
    // 用 button 而不是 span：键盘也能 Tab 到，点击语义也对。
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "memo-link-chip";
    chip.dataset.target = name;
    chip.title = `打开「${name}」`;
    chip.textContent = name;
    frag.appendChild(chip);
  });
  bar.replaceChildren(frag);
  bar.hidden = false;
}

/** 收起链接条（列表态、关窗时用）。 */
function hideMemoLinks() {
  const bar = document.getElementById("memo-links");
  if (bar) {
    bar.hidden = true;
    bar.replaceChildren();
  }
  memoLinkKeys = [];
}

/**
 * 点 chip：按标题找到目标笔记并打开，找不到就新建一条同名空笔记。
 * 跳转前先 flush 当前笔记，再把当前 id 压进返回栈。
 */
async function jumpMemoLink(target: string) {
  const name = target.trim();
  if (!name || memoLinkJumping) return;
  memoLinkJumping = true;
  try {
    let notes: NoteMeta[];
    try {
      notes = await invoke<NoteMeta[]>("notes_list");
    } catch (error) {
      setMemoFoot("读不到笔记列表，跳不过去", true);
      console.warn("notes_list failed", error);
      return;
    }

    // 同名笔记可能有两条：取最近更新的那条，并在脚注里说明，避免用户以为跳错了。
    let hit = notes.find((note) => note.title === name);
    const sameName = notes.filter((note) => note.title === name);
    let dupHint = "";
    if (sameName.length > 1) {
      hit = [...sameName].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
      dupHint = `（同名 ${sameName.length} 条，打开最近更新的）`;
    }

    // 跳到自己就什么也不做，免得返回栈里压进重复 id。
    if (hit && hit.id === memoEditingId) {
      setMemoFoot(`就是这一条${dupHint}`, false);
      return;
    }

    let targetId = hit?.id;
    if (!targetId) {
      try {
        const created = await invoke<NoteFull>("notes_create", {
          request: { title: name, content: "", category: "" },
        });
        targetId = created.id;
        void refreshMemoSub();
      } catch (error) {
        setMemoFoot("新建这条失败", true);
        console.error("notes_create failed", error);
        return;
      }
    }

    // 先落盘再换页：flushMemoSave 之后当前编辑内容已经交给后端。
    const from = memoEditingId;
    flushMemoSave();
    if (from) memoBackStack.push(from);
    await openMemoEditor(targetId);
    setMemoHeadMode(true);
    if (memoEditingId === targetId) {
      setMemoFoot(hit ? `跳到「${name}」${dupHint}` : `新建了「${name}」`, false);
    }
  } finally {
    memoLinkJumping = false;
  }
}

/// 头的返回键：在回收站里就回笔记列表，其余走双链的返回栈。
async function memoBackAction() {
  if (memoInTrash) {
    await renderMemoList();
    return;
  }
  await memoGoBack();
}

/** 头部「返回」：有栈就回上一条，栈空就回列表。 */
async function memoGoBack() {
  const prev = memoBackStack.pop();
  if (!prev) {
    await renderMemoList();
    return;
  }
  // 先用当前状态判断来源是否还在（可能刚被删了）。
  // 列表读失败时当作「不知道」照常尝试打开，别凭一次失败就跳栈。
  let lost = false;
  try {
    const notes = await invoke<NoteMeta[]>("notes_list");
    lost = !notes.some((note) => note.id === prev);
  } catch (error) {
    console.warn("notes_list failed", error);
  }

  flushMemoSave();
  if (lost) {
    // 来源笔记已经没了：跳过它继续往回找。
    await memoGoBack();
    return;
  }
  await openMemoEditor(prev);
  setMemoHeadMode(true);
}

function tickClock() {
  if (!clockEl) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  clockEl.textContent = `${hh}:${mm}`;
}

// ── 天气条 ────────────────────────────────

function renderWeather(weather: PanelWeather) {
  const tempEl = document.getElementById("temp");
  const textEl = document.getElementById("weather-text");
  const iconEl = document.getElementById("weather-icon");
  const cityEl = document.getElementById("weather-city");

  if (tempEl) tempEl.textContent = `${Math.round(weather.temperature)}°`;
  if (textEl) {
    // 高低温塞在现象后面，56px 高度里刚好一行。
    const range =
      weather.tempMax !== null && weather.tempMin !== null
        ? ` ${Math.round(weather.tempMin)}~${Math.round(weather.tempMax)}°`
        : "";
    textEl.textContent = weather.weatherText + range;
  }
  if (iconEl) iconEl.textContent = weatherIcon(weather.weatherCode);
  if (cityEl) cityEl.textContent = weather.city;
}

function weatherIcon(code: number): string {
  if (code === 0 || code === 1) return "☀";
  if (code === 2) return "⛅";
  if (code === 3) return "☁";
  if (code === 45 || code === 48) return "≡";
  if (code >= 51 && code <= 57) return "🌦";
  if (code >= 61 && code <= 67) return "🌧";
  if (code >= 71 && code <= 77) return "❄";
  if (code >= 80 && code <= 82) return "🌧";
  if (code === 85 || code === 86) return "🌨";
  if (code >= 95) return "⛈";
  return "·";
}

async function refreshWeather(force = false) {
  const textEl = document.getElementById("weather-text");
  try {
    const weather = await invoke<PanelWeather>("panel_weather", { force });
    renderWeather(weather);
  } catch (error) {
    // 定位失败是正常情况（系统定位被关、无网络），如实显示，不编造天气。
    console.error("panel_weather failed", error);
    if (textEl) textEl.textContent = "天气获取失败";
  }
}

// ── 模型下拉 ──────────────────────────────

function renderModelMenu() {
  if (!modelMenu) return;
  modelMenu.innerHTML = models
    .map(
      (model) =>
        `<button class="model-item${model.id === currentModel.id ? " active" : ""}"
                 data-model="${model.id}">${model.label} <span class="tag">${model.tag}</span></button>`,
    )
    .join("");
}

async function loadModels() {
  try {
    const list = await invoke<ChatModel[]>("chat_models");
    if (Array.isArray(list) && list.length > 0) {
      models = list;
      currentModel = models[0];
      if (curModelEl) curModelEl.textContent = currentModel.label;
      renderModelMenu();
      syncInputHint();
    }
  } catch (error) {
    console.error("chat_models failed", error);
    renderModelMenu();
  }
}

// ── 对话 ──────────────────────────────────

function setSending(sending: boolean) {
  const sendBtn = document.getElementById("send");
  if (sendBtn) {
    sendBtn.classList.toggle("busy", sending);
    sendBtn.title = sending ? "停止生成" : "发送";
  }
}

/**
 * 停止生成（用户 2026-11-15 拍板的 G 项）。
 *
 * 实现方式是**前端丢弃**：把 activeRequestId 清空，之后到达的
 * chat-delta / chat-done 因为 requestId 对不上会被 `wireChatEvents` 丢掉。
 * 后端那条 Ollama 流仍在跑完（本地模型没有可靠的取消接口），
 * 但它不再污染界面，用户看到的就是「停住了」。
 */
function stopStream() {
  if (!activeRequestId) return;
  activeRequestId = null;
  if (streamingBubble) {
    const wrap = streamingBubble.parentElement;
    const text = streamingText || "（已停止）";
    streamingBubble.textContent = text;
    if (wrap) {
      wrap.classList.remove("streaming");
      wrap.classList.add("stopped");
    }
  }
  streamingBubble = null;
  streamingText = "";
  setSending(false);
  scrollChatToBottom();
}

function sendMessage() {
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text) return;
  if (activeRequestId) {
    // 上一句还在生成，不并发，避免两段流混在同一个气泡里。
    return;
  }

  // 混元默认翻成中文，直接粘句子就能用，**不再拦截**。
  // 只有「翻译一下」这种光有动词没粘原文的情况才提醒一句——
  // 后端会返回 chat:translateFormat，这里提前拦住省一次等待。
  if (currentModel.id === TRANSLATE_MODEL_ID && /^(翻译一下|翻译|翻一下|译一下)$/.test(text)) {
    appendMessage({ role: "user", text });
    inputEl.value = "";
    inputEl.style.height = "auto";
    appendMessage({
      role: "notice",
      text: "直接把要翻译的句子粘进来就行，默认翻成中文；要翻成别的语言，写「翻译成英文：…」。",
    });
    return;
  }

  appendMessage({ role: "user", text });
  inputEl.value = "";
  inputEl.style.height = "auto";

  // 先放一个三点占位，第一个增量到了再换成正文。
  streamingText = "";
  streamingBubble = appendMessage({ role: "ai", who: currentModel.label, text: "" });
  if (streamingBubble) {
    // 纯 CPU 上首 token 要等 4~14 秒（冷加载 6.6GB 时更久），
    // 只放三个点用户不知道是在加载还是卡死，加一行状态字。
    // 第一个增量到达时 `textContent = streamingText` 会把这里整块替换掉。
    const hint = currentModel.id === TRANSLATE_MODEL_ID ? "翻译中…" : "模型思考中…";
    streamingBubble.innerHTML =
      `<div class="typing"><i></i><i></i><i></i></div>` +
      `<div class="typing-hint" id="typing-hint">${hint}</div>`;
    // 气泡外层挂 streaming：左侧竖条随呼吸亮一下，长回答往下滚也看得出还在生成。
    streamingBubble.parentElement?.classList.add("streaming");
  }
  setSending(true);

  invoke<string>("chat_send", { model: currentModel.id, text })
    .then((requestId) => {
      activeRequestId = requestId;
    })
    .catch((error) => {
      console.error("chat_send failed", error);
      finishStream("", String(error));
    });
}

/** 收尾：把占位气泡定稿，或显示错误。 */
function finishStream(fullText: string, errorMessage?: string) {
  setSending(false);
  activeRequestId = null;

  // 先摘呼吸竖条，无论下面走错误分支还是定稿都要摘。
  streamingBubble?.parentElement?.classList.remove("streaming");

  if (errorMessage) {
    if (streamingBubble) {
      const wrap = streamingBubble.parentElement;
      streamingBubble.remove();
      if (wrap) wrap.className = "msg notice";
      const notice = document.createElement("div");
      notice.className = "bubble";
      notice.textContent = errorMessage;
      wrap?.appendChild(notice);
    } else {
      appendMessage({ role: "notice", text: errorMessage });
    }
  } else if (streamingBubble) {
    const finalText = fullText || streamingText;
    streamingBubble.textContent = finalText || "（没有返回内容）";
  }

  streamingBubble = null;
  streamingText = "";
  scrollChatToBottom();
}

async function wireChatEvents() {
  await listen<{ requestId: string; delta: string }>("chat-delta", (event) => {
    const payload = event.payload;
    if (payload.requestId !== activeRequestId) {
      // 「停止生成」或新请求后到达的残片，丢掉。
      return;
    }
    streamingText += payload.delta;
    if (streamingBubble) {
      // 第一个增量到达时，`textContent = ...` 会整体替换掉
      // 「三点 + 模型思考中…」的占位内容；之后只是继续往同一个文本节点追加。
      streamingBubble.textContent = streamingText;
      scrollChatToBottom();
    }
  });

  await listen<{
    requestId: string;
    text: string;
    error: string | null;
    message: string | null;
  }>("chat-done", (event) => {
    const payload = event.payload;
    if (activeRequestId && payload.requestId !== activeRequestId) return;
    finishStream(payload.text, payload.message ?? undefined);
  });
}

// ── 事件绑定 ──────────────────────────────

// 顶栏：右侧「—」= 最小化到任务栏（用户拍板 2026-11-17：以前这里是「收起」，
// 面板直接消失只剩边缘小条，用户当成软件被关了）；Esc 才是「收起」；齿轮 = 在面板内弹轻设置页。
root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest("[data-action]")?.getAttribute("data-action");
  if (action === "minimize") {
    getCurrentWindow()
      .minimize()
      .catch((error) => console.error("minimize failed", error));
    return;
  }
  if (action === "hide") {
    invoke("hide_panel").catch((error) => console.error("hide_panel failed", error));
    return;
  }
  if (action === "settings") {
    openSettingsSheet();
  }
});

// 备忘录入口（用户拍板 2026-11-15 m00986）：
// 点「备忘录」直接进完整花笺（1180×760 原版窗口），面板内不再弹白纸；
// 面板内的白纸写笔记改由旁边那个「随记」小按钮进（用户原话「小按钮就叫随记」）。
document.getElementById("memo-entry")?.addEventListener("click", () => {
  void openFullNotepad();
});
document.getElementById("memo-quick")?.addEventListener("click", (event) => {
  // 它是卡片外面单独一个 button，靠 CSS 绝对定位贴到卡片右下角；
  // stopPropagation 是保险，防止将来有人把它挪回卡片内部后点它变成开完整花笺。
  event.stopPropagation();
  openMemoSheet();
});

/** 打开完整花笺（label = main 的 1180×760 窗口）。 */
async function openFullNotepad(): Promise<void> {
  try {
    await invoke("open_memo_window");
  } catch (error) {
    console.error("open_memo_window failed", error);
    appendMessage({ role: "notice", text: "打不开主窗口，稍后再试" });
  }
}

// 设置只有一个入口：顶栏齿轮（功能区那张卡片重复了，已删）。

// Esc：小窗开着时先关小窗
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (settingsSheet) {
      // 二次确认条开着时，Esc 先收起确认条，再按一次才关窗。
      if (clearConfirmOpen) {
        clearConfirmOpen = false;
        void renderSettingsSheet();
      } else {
        closeSettingsSheet();
      }
      return;
    }
    if (memoSheet) {
      // 编辑态先回列表（有返回栈时回到上一条）；回收站先回笔记列表；
      // 真正在列表态才关窗，避免误按丢掉正在看的东西。
      if (memoEditingId) {
        void memoGoBack();
      } else if (memoInTrash) {
        void renderMemoList();
      } else {
        closeMemoSheet();
      }
      return;
    }
    if (scheduleSheet) {
      closeScheduleSheet();
      return;
    }
    invoke("hide_panel").catch((error) => console.error("hide_panel failed", error));
  }
});

// 模型选择菜单
document.getElementById("model-select")?.addEventListener("click", (event) => {
  event.stopPropagation();
  modelMenu?.classList.toggle("open");
});

modelMenu?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest("[data-model]") as HTMLElement | null;
  if (!button) return;
  const id = button.getAttribute("data-model");
  const picked = models.find((model) => model.id === id);
  if (!picked) return;
  currentModel = picked;
  if (curModelEl) curModelEl.textContent = picked.label;
  renderModelMenu();
  modelMenu.classList.remove("open");
  syncInputHint();
});

/** 换模型时把输入框占位提示换成对应写法，让用户不用背格式。 */
function syncInputHint() {
  if (!inputEl) return;
  inputEl.placeholder =
    currentModel.id === TRANSLATE_MODEL_ID
      ? "粘一句外文，默认翻成中文"
      : "问我任何事…";
}

document.addEventListener("click", () => modelMenu?.classList.remove("open"));

// 天气条点一下强制刷新（忽略缓存）
document.getElementById("weatherbar")?.addEventListener("click", () => {
  void refreshWeather(true);
});

// 输入框：自动增高 + Enter 发送
inputEl?.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 76)}px`;
});

inputEl?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

document.getElementById("send")?.addEventListener("click", () => {
  // 生成中，同一个按钮变成「停止」。用户拍板（G 项）。
  if (activeRequestId) {
    stopStream();
    return;
  }
  sendMessage();
});


// ── 启动 ──────────────────────────────────

renderSchedules();
void refreshMemoSub();
tickClock();
setInterval(tickClock, 10_000);
renderModelMenu();
void loadModels();
void wireChatEvents();
void refreshWeather();
void wireFileDrop();

// 点「我的安排」那一块弹小窗（用户拍板：面板内弹窗，不跳原版花笺）
document.querySelector(".sched")?.addEventListener("click", openScheduleSheet);

// 开窗就把磁盘上的主题和字号对到面板上：config 读不到时什么都不做，界面按默认走。
// 注意这里是「读」而不是「写」，不会把用户的配置改掉。
void (async () => {
  const config = await loadConfig();
  if (!config) return;
  applyPanelTheme(config.theme);
  applyPanelFontSize(Number(config.fontSize) || PANEL_FONT_BASE);
})();

// 对话里自动拆出的安排、手动增删，都会推 schedules-changed，这里跟着刷新。
void listen("schedules-changed", () => {
  void refreshSchedules();
  if (scheduleSheet) void renderScheduleSheet();
});

// ── 拖进来即收 ──────────────────────────────────────────
//
// 用户拍板（m00057「3所有东西」）：「拖进来即收」是本轮 E 项。
// 拖放由 Tauri 的原生窗口事件给出（WebView2 里 HTML5 的 drop 拿不到真实文件路径），
// 所以走 `getCurrentWebview().onDragDropEvent()`，落盘与校验全在 Rust 侧
// （`desktop_import.rs`），前端只负责「告诉用户要发生什么」和「报告结果」。

/** 拖到面板上方时铺满的那层提示。只在拖动过程中存在，松开/移出就撤。 */
let dropHint: HTMLElement | null = null;
/** 正在收件，避免用户连拖两批把同一份文件收两次。 */
let importing = false;

function showDropHint(paths: string[]) {
  if (!dropHint) {
    const hint = document.createElement("div");
    hint.className = "drop-hint";
    hint.innerHTML = `
      <div class="drop-hint-inner">
        <div class="drop-hint-title">松手就收进来</div>
        <div class="drop-hint-sub" id="drop-hint-sub"></div>
      </div>`;
    document.body.appendChild(hint);
    dropHint = hint;
    requestAnimationFrame(() => hint.classList.add("open"));
  }
  const sub = document.getElementById("drop-hint-sub");
  if (sub) {
    sub.textContent =
      paths.length === 1
        ? fileBaseName(paths[0])
        : `共 ${paths.length} 个文件`;
  }
}

function hideDropHint() {
  if (!dropHint) return;
  const hint = dropHint;
  dropHint = null;
  hint.classList.remove("open");
  window.setTimeout(() => hint.remove(), SHEET_FADE_MS);
}

function fileBaseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

async function wireFileDrop() {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        showDropHint(payload.type === "enter" ? payload.paths : []);
        return;
      }
      if (payload.type === "leave") {
        hideDropHint();
        return;
      }
      if (payload.type === "drop") {
        hideDropHint();
        void receiveDroppedFiles(payload.paths);
      }
    });
  } catch (error) {
    // WebView 不支持原生拖放时不值得打断启动，只是这个功能用不了。
    console.error("onDragDropEvent unavailable", error);
  }
}

/** 把拖进来的一批路径交给 Rust 收进库，然后在对话区报告结果。 */
async function receiveDroppedFiles(paths: string[]) {
  if (importing) {
    appendMessage({ role: "notice", text: "上一批还在收，稍等一下。" });
    return;
  }
  if (!paths || paths.length === 0) return;
  importing = true;
  appendMessage({
    role: "notice",
    text: `收到 ${paths.length} 个文件，正在收进来…`,
  });
  try {
    const records = await invoke<ImportRecord[]>("import_paths", {
      paths,
      category: null,
    });
    const failed = records.filter((record) => record.error);
    const ok = records.length - failed.length;
    if (ok > 0) {
      appendMessage({
        role: "notice",
        text: `已收进 ${ok} 个文件，可以在备忘录里找到。`,
      });
    }
    for (const record of failed) {
      appendMessage({
        role: "notice",
        text: `「${record.fileName || fileBaseName(record.from)}」没收进来：${record.error}`,
      });
    }
    if (ok > 0) void refreshMemoSub();
  } catch (error) {
    appendMessage({ role: "notice", text: `收不进来：${String(error)}` });
  } finally {
    importing = false;
  }
}

/** Rust 侧 `desktop_import::ImportRecord` 的镜像（serde camelCase）。 */
interface ImportRecord {
  id: string;
  from: string;
  to: string;
  diskType: string;
  moved: boolean;
  at: string;
  kind: string;
  fileName: string;
  error?: string;
}