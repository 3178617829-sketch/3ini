import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        // 主窗口
        main: "index.html",
        // 右边缘小条：独立窗口，只有一条 6px 宽的竖条
        "edge-strip": "edge-strip.html",
        // 花笺助手面板小窗（380×620），这是真正的主窗口
        panel: "panel.html",
      },
      output: {
        // 把体积最大的第三方库拆成独立 chunk：markdown 渲染链（懒加载后
        // 仅预览时才拉取）与基础 vendor 分离，提升窗口间磁盘缓存复用
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "vendor-react";
          }
          if (/[\\/]node_modules[\\/](i18next|react-i18next)[\\/]/.test(id)) {
            return "vendor-i18n";
          }
          if (id.includes("katex")) {
            return "vendor-katex";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    setupFiles: ["./src/locales/test-setup.ts"],
  },
}));
