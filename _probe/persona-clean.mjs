// 清空人物卡测试数据。
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const panel = targets.find((t) => t.url.includes("panel.html"));
if (!panel) {
  console.error("程序没在跑");
  process.exit(1);
}
const ws = new WebSocket(panel.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise((resolve) => ws.addEventListener("open", resolve));
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return res.result?.result?.value;
}
await evaluate(`window.__TAURI_INTERNALS__.invoke("persona_save", { card: { name:"", role:"", traitText:"", speech:"", background:"", example:"", enabled:false, updatedAt:"" } })`);
const check = await evaluate(`window.__TAURI_INTERNALS__.invoke("persona_get")`);
console.log("人物卡已清空:", JSON.stringify(check));
ws.close();
