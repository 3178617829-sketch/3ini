// 右边缘小条的脚本。
//
// 小条是一个独立的 Tauri 窗口，本身只负责「被点一下，就告诉后端呼出主窗口」。
// 窗口的创建、定位、隐藏全部由 Rust 侧负责（src-tauri/src/desktop_edge_strip.rs），
// 这里不做任何几何计算，避免两处各算一套。

import { invoke } from "@tauri-apps/api/core";

const strip = document.getElementById("strip");

strip?.addEventListener("click", () => {
  invoke("edge_strip_clicked").catch((error) => {
    console.error("edge-strip: invoke failed", error);
  });
});
