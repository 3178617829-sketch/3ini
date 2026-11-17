<!-- markdownlint-disable -->

[简体中文](README.md) | [繁體中文](README_zh-HK.md) | **English**

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="3.ini icon">

# 3.ini

A local note-taking app with a local AI assistant<br>
Built with Tauri 2 + React

[Issues](https://github.com/3178617829-sketch/3ini/issues) · [Releases](https://github.com/3178617829-sketch/3ini/releases)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![Rust 2021](https://img.shields.io/badge/Rust-2021-%23000000?logo=rust)

</div>

<!-- markdownlint-restore -->

---

## What is this

3.ini is a note-taking app that lives in the system tray. Hit `Ctrl+Space` to summon it from anywhere, jot something down, get on with your day. Notes never leave your machine — no account, no sync, no upload.

It can also talk to a local AI through [Ollama](https://ollama.com/download): chat, translation, and turning plain language into a schedule. The models run on your own hardware, so it works offline too.

> This project is a fork of [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper) (MIT). The UI, the editor and most of the internals come from that project; what changed here is the branding and icons, plus the local AI integration. The original is a lovely piece of software — go take a look.

## Features

### Notes

- Markdown editing and preview, with GFM and LaTeX support
- System tray + global shortcut (`Ctrl+Space` by default), multiple quick-note windows
- Tile mode: pin a note anywhere on your desktop
- Folders, `.md` import and export
- Daily automatic backups (kept for 7 days); deleted notes go to Trash and are removed after 30 days

### Local AI (optional)

Install [Ollama](https://ollama.com/download) and pull the models. Three models, three jobs:

| Job            | Model           | Size   |
| -------------- | --------------- | ------ |
| Chat           | `qwen3.5-9b`    | 6.6 GB |
| Translation    | `hunyuan-mt-7b` | 4.6 GB |
| Schedule parse | `spark-x2.6-4b` | 2.7 GB |

```bash
ollama pull qwen3.5-9b
ollama pull hunyuan-mt-7b
ollama pull spark-x2.6-4b
```

The app works fine without any of this — the AI entry points simply stay out of the way until a model is available.

## Download

Grab a build from [Releases](https://github.com/3178617829-sketch/3ini/releases).

> **Note**: the official build is **Windows ARM64 (Snapdragon laptops)** only — that is the one machine the maintainer has actually tested. On Intel/AMD Windows, build from source; it should work, but nobody has verified it.

## Building from source

Requirements: Node.js 22+, stable Rust, and Visual Studio Build Tools (Desktop development with C++).

```bash
npm ci
npm run tauri build
```

The bundle lands in `src-tauri/target/release/bundle/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the longer version.

**Windows on ARM64 (Snapdragon laptops)**: running `cargo build` from a plain terminal fails inside `ring` with `failed to find tool "clang"` — the ARM64 toolchain has to be initialised first. The repo ships scripts for that:

```bat
build-arm64.bat            :: build aarch64 (debug)
build-arm64.bat --release  :: build aarch64 (release)
build-and-deliver.bat      :: build and copy to the desktop
```

## Credits

- Original project: [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)
- Every contributor to that project and its upstream dependencies

## License

[MIT](LICENSE)
