// 最终行为验证：随记→白纸弹出且能写字；大卡片→完整花笺窗口打开。
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const panel = targets.find((t) => t.url.includes("panel.html"));
const ws = new WebSocket(panel.webSocketDebuggerUrl);
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) => { const id = nextId++; return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
const evaluate = async (expr) => {
  const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails.exception?.description));
  return res.result?.result?.value;
};

console.log("=== 1. 点「随记」→ 白纸 ===");
await evaluate(`document.getElementById('memo-quick').click()`);
await new Promise((r) => setTimeout(r, 800));
let s = await evaluate(`(() => ({ sheet: !!document.querySelector('.memo-sheet'), visible: (() => { const n = document.querySelector('.memo-sheet'); if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })() }))()`);
console.log(JSON.stringify(s));

console.log("=== 2. 新建一条随记并输入 ===");
await evaluate(`document.getElementById('memo-new')?.click()`);
await new Promise((r) => setTimeout(r, 600));
const typing = await evaluate(`(() => {
  const area = document.querySelector('.memo-paper');
  if (!area) return 'no-textarea';
  area.value = '入口改版测试';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed-ok';
})()`);
console.log(typing);
await new Promise((r) => setTimeout(r, 1200));
const saved = await evaluate(`window.__TAURI_INTERNALS__.invoke('notes_list').then(list => list.map(n => n.title))`);
console.log("库里笔记:", JSON.stringify(saved));

console.log("=== 3. 关白纸 → 点大卡片 → 完整花笺 ===");
await evaluate(`document.getElementById('memo-close')?.click()`);
await new Promise((r) => setTimeout(r, 600));
await evaluate(`(() => { const e = document.getElementById('memo-entry'); e.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()`);
await new Promise((r) => setTimeout(r, 1500));
const pages = await (await fetch("http://127.0.0.1:9222/json/list")).json();
console.log("页面列表:", JSON.stringify(pages.filter((t) => t.type === "page").map((t) => t.url.replace(/^.*\//, ""))));
const sheetStill = await evaluate(`!!document.querySelector('.memo-sheet')`);
console.log("白纸没被误开:", !sheetStill);

console.log("=== 4. 清理测试笔记 ===");
const list = await evaluate(`window.__TAURI_INTERNALS__.invoke('notes_list')`);
for (const n of list) {
  if (n.title === "入口改版测试") {
    await evaluate(`window.__TAURI_INTERNALS__.invoke('notes_delete', { id: ${JSON.stringify(n.id)} }).then(() => 'deleted')`);
    console.log("已删测试笔记");
  }
}
ws.close();
