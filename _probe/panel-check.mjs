// 面板小窗运行时检查：注入一段表达式，回报 JS 报错与关键函数是否就位。
// 用法：node panel-check.mjs
const EXPR = process.env.PROBE_EXPR || "";

async function findPanel() {
  const res = await fetch("http://127.0.0.1:9222/json/list");
  const list = await res.json();
  const panel = list.find((t) => t.url.includes("panel.html"));
  if (!panel) throw new Error("没找到 panel.html 页面");
  return panel.webSocketDebuggerUrl;
}

function call(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const url = await findPanel();
const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
// 先开 Runtime 与 Log，把已有的异常收集起来
await call(ws, nextId++, "Runtime.enable", {});
await call(ws, nextId++, "Log.enable", {});

const errors = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    errors.push(`[exception] ${d.text} ${d.exception?.description || ""}`.trim());
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push(
      `[console.error] ` +
        msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")
    );
  }
});

const probe = `
(() => {
  const out = {};
  out.title = document.title;
  out.panelRoot = !!document.getElementById("panel-root");
  out.hasMemoEntry = !!document.getElementById("memo-entry");
  out.hasSettingsEntry = !!document.getElementById("settings-entry");
  out.hasWeather = !!document.querySelector(".weather");
  out.hasSched = !!document.querySelector(".sched");
  out.bodyChildren = document.body.children.length;
  out.theme = document.documentElement.getAttribute("data-theme");
  out.errors = ${JSON.stringify(errors)};
  return JSON.stringify(out);
})()
`;

const result = await call(ws, nextId++, "Runtime.evaluate", {
  expression: probe,
  returnByValue: true,
  awaitPromise: false,
});

console.log("=== 面板自检 ===");
console.log(result.result.value);

if (EXPR) {
  const extra = await call(ws, nextId++, "Runtime.evaluate", {
    expression: EXPR,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("=== 自定义表达式 ===");
  console.log(JSON.stringify(extra.result.value ?? extra.result.description));
}

// 给异常事件一点时间抵达
await new Promise((r) => setTimeout(r, 600));
console.log("=== 捕获到的错误 ===");
console.log(errors.length ? errors.join("\n") : "（无）");
ws.close();
