// 回收站端到端实测：删一条 -> 看回收站 -> 恢复 -> 再删 -> 彻底删。
// 用法：node trash-check.mjs   （应用需带 --remote-debugging-port=9222 启动）
const listUrl = "http://127.0.0.1:9222/json/list";
const targets = await (await fetch(listUrl)).json();
const target = targets.find((item) => item.url.includes("panel.html"));
if (!target) {
  console.log("找不到 panel.html 页", targets.map((t) => t.url));
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    console.log("!! 页面异常:", JSON.stringify(msg.params.exceptionDetails?.exception?.description ?? msg.params));
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.result?.exceptionDetails) {
    return { error: result.result.exceptionDetails.exception?.description };
  }
  return result.result?.result?.value;
};

await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Runtime.enable");

const invoke = (cmd, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

const out = {};

// 0. 先看现有笔记
out.notesBefore = await invoke("notes_list");

// 1. 造一条测试笔记
const created = await invoke("notes_create", {
  request: { title: "回收站测试", content: "这条会被删掉看看能不能回来", category: "" },
});
out.created = created;

// 2. 删掉它
out.deleted = await invoke("notes_delete", { id: created.id });

// 3. 回收站里应该有一条
const trash = await invoke("trash_list");
out.trashAfterDelete = trash.map((e) => ({
  id: e.id?.slice(0, 8),
  title: e.title,
  body: e.body,
  daysLeft: e.daysLeft,
  hasDeletedAt: !!e.deletedAt,
}));

// 4. 恢复
out.restoredId = await invoke("trash_restore", { id: created.id });
out.trashAfterRestore = (await invoke("trash_list")).length;
const back = await invoke("notes_get", { id: out.restoredId });
out.restoredNote = { title: back.title, content: back.content };

// 5. 再删一次，然后彻底删
await invoke("notes_delete", { id: out.restoredId });
out.trashBeforePurge = (await invoke("trash_list")).length;
await invoke("trash_delete", { id: out.restoredId });
out.trashAfterPurge = (await invoke("trash_list")).length;

// 6. 收尾：如果恢复出来的笔记还在列表里，删干净
out.notesAfter = (await invoke("notes_list")).map((n) => n.title);

console.log(JSON.stringify(out, null, 2));
ws.close();
