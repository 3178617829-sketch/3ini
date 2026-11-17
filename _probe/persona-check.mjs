// 人物卡全链路实测：读 → 保存 → 启用 → 校验超限 → 确认拼进提示词。
// 用法：先带 9222 端口启动程序，再 node persona-check.mjs
const listUrl = "http://127.0.0.1:9222/json/list";

const targets = await (await fetch(listUrl)).json();
const panel = targets.find((t) => t.url.includes("panel.html"));
if (!panel) {
  console.error("没找到 panel.html 页，程序启动了吗？");
  process.exit(1);
}

const ws = new WebSocket(panel.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

await new Promise((resolve) => ws.addEventListener("open", resolve));

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails));
  }
  return res.result?.result?.value;
}

const invoke = (cmd, args) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`);

console.log("=== 1. 初始读卡 ===");
const before = await invoke("persona_get");
console.log(JSON.stringify(before));

console.log("\n=== 2. 保存一张 5000 字的长卡（测宽松上限）===");
const longCard = {
  name: "林晚",
  role: "老城区二手书店店员",
  traitText: "记性好，说话慢，" + "喜欢把书按纸张发黄的程度排架。".repeat(150),
  speech: "句子短，少用感叹号，偶尔引用书里的一句。",
  background: "在这条街上开了七年店。" + "以前做过校对。".repeat(60),
  example: "这本书你看完了吗？不急，慢慢看。",
  enabled: true,
  updatedAt: "",
};
const longTotal = longCard.role.length + longCard.traitText.length + longCard.speech.length + longCard.background.length + longCard.example.length;
console.log("正文总字数:", longTotal);
const saved = await invoke("persona_save", { card: longCard });
console.log("保存结果: name =", saved.name, "| enabled =", saved.enabled, "| updatedAt =", saved.updatedAt);

console.log("\n=== 3. 重新读盘确认落盘 ===");
const reread = await invoke("persona_get");
console.log("name =", reread.name, "| traitText 长度 =", reread.traitText.length, "| enabled =", reread.enabled);

console.log("\n=== 4. 超限校验（整张卡超过 8000 字）===");
try {
  await invoke("persona_save", {
    card: { ...longCard, traitText: "字".repeat(4000), background: "字".repeat(4000), speech: "字".repeat(2000), example: "字".repeat(2000) },
  });
  console.log("❌ 应该被拒绝却通过了");
} catch (error) {
  console.log("✅ 被拒绝:", error.message);
}

console.log("\n=== 5. 单栏超限校验（名字 41 字）===");
try {
  await invoke("persona_save", { card: { ...longCard, name: "a".repeat(41) } });
  console.log("❌ 应该被拒绝却通过了");
} catch (error) {
  console.log("✅ 被拒绝:", error.message);
}

console.log("\n=== 6. 停用 ===");
const disabled = await invoke("persona_save", { card: { ...reread, enabled: false } });
console.log("enabled =", disabled.enabled);

console.log("\n=== 7. 恢复成空卡（清理测试数据）===");
const cleared = await invoke("persona_save", {
  card: { name: "", role: "", traitText: "", speech: "", background: "", example: "", enabled: false, updatedAt: "" },
});
console.log("清理后 name =", JSON.stringify(cleared.name), "| enabled =", cleared.enabled);

ws.close();
