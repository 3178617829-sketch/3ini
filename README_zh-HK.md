<!-- markdownlint-disable -->

[简体中文](README.md) | **繁體中文** | [English](README_en-US.md)

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="3.ini 圖示">

# 3.ini

本機筆記 + 本機 AI 助手<br>
以 Tauri 2 + React 建置

[回報問題](https://github.com/3178617829-sketch/3ini/issues) · [更新日誌](https://github.com/3178617829-sketch/3ini/releases)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![Rust 2021](https://img.shields.io/badge/Rust-2021-%23000000?logo=rust)

</div>

<!-- markdownlint-restore -->

---

## 這是什麼

3.ini 是一個常駐系統匣的本機筆記工具。按 `Ctrl+Space` 隨時喚出，隨手記、隨手查，筆記全程存在自己的電腦裡，不需要帳號，也不上傳任何資料。

在筆記之外，它還能接一個本機 AI：透過 [Ollama](https://ollama.com/download) 執行模型，做對話、翻譯、把自然語言拆成日程。模型跑在自己的機器上，不連網也能用。

> 本專案基於 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)（MIT）修改而來。介面、筆記編輯與大部分底層功能來自原專案，此處改動的是品牌與圖示，並加入了本機 AI 能力。原專案是一個很好的軟體，建議也去看看。

## 功能

### 筆記

- Markdown 編輯與預覽，支援 GFM 語法與 LaTeX 公式
- 系統匣常駐，全域快捷鍵（預設 `Ctrl+Space`）喚出便箋視窗，支援多開
- 磁貼模式：把筆記釘在桌面某處
- 分類資料夾、`.md` 匯入匯出
- 每日自動備份（保留 7 天），刪除的筆記會先進資源回收筒（30 天後才真正刪除）

### 本機 AI（選用）

需要自行安裝 Ollama 並拉取模型。三個模型分工如下：

| 用途     | 模型            | 大小   |
| -------- | --------------- | ------ |
| 對話     | `qwen3.5-9b`    | 6.6 GB |
| 翻譯     | `hunyuan-mt-7b` | 4.6 GB |
| 日程解析 | `spark-x2.6-4b` | 2.7 GB |

```bash
ollama pull qwen3.5-9b
ollama pull hunyuan-mt-7b
ollama pull spark-x2.6-4b
```

不安裝 AI 也能正常使用，只是介面上不會出現 AI 相關入口。

## 下載

前往 [Releases](https://github.com/3178617829-sketch/3ini/releases) 下載。

> **注意**：目前官方只提供 **Windows ARM64（驍龍筆記型電腦）** 版本——這是開發者手邊唯一實測通過的機器。Intel/AMD 的 Windows 請自行從原始碼建置，理論上可以執行，但沒有驗證過。

## 從原始碼建置

相依：Node.js 22+、Rust stable、Visual Studio Build Tools（C++ 桌面開發）。

```bash
npm ci
npm run tauri build
```

產物在 `src-tauri/target/release/bundle/`。更詳細的說明見 [CONTRIBUTING.md](CONTRIBUTING.md)。

**Windows ARM64（驍龍筆記本）注意**：從普通終端直接跑 `cargo build` 會在 `ring` 上報 `failed to find tool "clang"`——必須先初始化 ARM64 工具鏈。倉庫裡帶了腳本：

```bat
build-arm64.bat            :: 編譯 aarch64（debug）
build-arm64.bat --release  :: 編譯 aarch64（release）
build-and-deliver.bat      :: 編譯並複製到桌面
```

## 致謝

- 原始專案：[Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)
- 原專案及上游相依的所有貢獻者

## 授權條款

[MIT](LICENSE)
