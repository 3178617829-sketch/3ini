// 重截：确认随记按钮位置 + 逐个点验证。
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const panel = targets.find((t) => t.url.includes("panel.html"));
const ws = new WebSocket(panel.webSocketDebuggerUrl);
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
function send(method, params = {}) { const id = nextId++; return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expr) {
  const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails.exception?.description));
  return res.result?.result?.value;
}

// 关掉可能开着的白纸和完整窗口状态干扰
await evaluate(`document.getElementById('memo-close')?.click()`);
await new Promise((r) => setTimeout(r, 600));

const geo = await evaluate(`(() => {
  const entry = document.getElementById('memo-entry').getBoundingClientRect();
  const quick = document.getElementById('memo-quick').getBoundingClientRect();
  return {
    entry: { x: Math.round(entry.x), y: Math.round(entry.y), w: Math.round(entry.width), h: Math.round(entry.height) },
    quick: { x: Math.round(quick.x), y: Math.round(quick.y), w: Math.round(quick.width), h: Math.round(quick.height) },
    quickInEntry: quick.x > entry.x && quick.x < entry.x + entry.width && quick.y > entry.y && quick.y < entry.y + entry.height,
  };
})()`);
console.log("几何:", JSON.stringify(geo));

const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("D:/NDSH/hua-jian/_src/hua-jian/_probe/memo-entry2.png", Buffer.from(shot.result.data, "base64"));
console.log("截图已存");
ws.close();
