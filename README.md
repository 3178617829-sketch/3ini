<!-- markdownlint-disable -->

**简体中文** | [繁體中文](README_zh-HK.md) | [English](README_en-US.md)

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="3.ini 图标">

# 3.ini

本地笔记 + 本地 AI 助手<br>
基于 Tauri 2 + React 构建

[反馈问题](https://github.com/3178617829-sketch/3ini/issues) · [更新日志](https://github.com/3178617829-sketch/3ini/releases)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![Rust 2021](https://img.shields.io/badge/Rust-2021-%23000000?logo=rust)

</div>

<!-- markdownlint-restore -->

---

## 这是什么

3.ini 是一个常驻托盘的本地笔记工具。按 `Ctrl+Space` 随时唤出，随手记、随手查，笔记全程存在自己电脑里，不需要账号，也不上传任何数据。

在笔记之外，它还能接一个本地 AI：通过 [Ollama](https://ollama.com/download) 跑模型，做对话、翻译、把自然语言拆成日程。模型跑在自己机器上，不联网也能用。

> 本项目基于 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)（MIT）修改而来。界面、笔记编辑与大部分底层功能来自原项目，此处改动的是品牌与图标，并加入了本地 AI 能力。原项目是一个很好的软件，建议也去看看。

## 功能

### 笔记

- Markdown 编辑与预览，支持 GFM 语法与 LaTeX 公式
- 托盘常驻，全局快捷键（默认 `Ctrl+Space`）唤出便签窗口，支持多开
- 磁贴模式：把笔记钉在桌面某处
- 分类文件夹、`.md` 导入导出
- 每日自动备份（保留 7 天），删除的笔记先进回收站（30 天后真正删除）

### 本地 AI（可选）

需要自己安装 Ollama 并拉取模型。三个模型分工如下：

| 用途     | 模型            | 大小   |
| -------- | --------------- | ------ |
| 对话     | `qwen3.5-9b`    | 6.6 GB |
| 翻译     | `hunyuan-mt-7b` | 4.6 GB |
| 日程解析 | `spark-x2.6-4b` | 2.7 GB |

```bash
ollama pull qwen3.5-9b
ollama pull hunyuan-mt-7b
ollama pull spark-x2.6-4b
```

不装 AI 也能正常用，只是界面上不出现 AI 相关入口。

## 下载

前往 [Releases](https://github.com/3178617829-sketch/3ini/releases) 下载。

> **注意**：目前官方只提供 **Windows ARM64（骁龙笔记本）** 版本——这是开发者手头唯一实测通过的机器。Intel/AMD 的 Windows 请从源码自行构建，理论上可以跑，但没有验证过。

## 从源码构建

依赖：Node.js 22+、Rust stable、Visual Studio Build Tools（C++ 桌面开发）。

```bash
npm ci
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`。更详细的说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

**Windows ARM64（骁龙笔记本）注意**：从普通终端直接跑 `cargo build` 会在 `ring` 上报 `failed to find tool "clang"`——必须先初始化 ARM64 工具链。仓库里带了脚本：

```bat
build-arm64.bat            :: 编译 aarch64（debug）
build-arm64.bat --release  :: 编译 aarch64（release）
build-and-deliver.bat      :: 编译并复制到桌面
```

## 致谢

- 原始项目：[Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)
- 原项目及上游依赖的所有贡献者

## 许可证

[MIT](LICENSE)
