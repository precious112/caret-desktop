<div align="center">
  <h1>Caret IDE</h1>
  <p><strong>An AI design tool in your IDE, where design and code are one.</strong></p>
  <p>
    <a href="https://github.com/precious112/caret-ide/releases/latest"><img src="https://img.shields.io/github/v/release/precious112/caret-ide?label=latest" alt="latest release"/></a>
    <img src="https://img.shields.io/github/downloads/precious112/caret-ide/total?label=downloads" alt="downloads"/>
    <a href="https://open-vsx.org/extension/caretAI/caret"><img src="https://img.shields.io/open-vsx/v/caretAI/caret?label=Open%20VSX" alt="Open VSX"/></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"/></a>
  </p>
</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/precious112/Pstore_backend/refs/heads/master/media/media/caret_main_edit-ezgif.com-video-to-gif-converter.gif" width="100%" alt="Caret, edit your UI with AI on a live canvas" />
</p>

> For decades, design and development have lived in separate worlds: you mock a screen in a design tool, then someone rebuilds it by hand in code, and the two drift apart from the moment they're created. Caret is built on a bet that **this divide no longer needs to exist.** AI is now powerful enough that the design *is* the code.
>
> In Caret you describe and shape your UI on a live canvas inside your editor, and it stays real, version-controlled React the entire time, then you sync it straight into the app you ship. No separate design tool. No handoff. No drift. One source of truth that is design and code at once.
>
> It's for the people building the modern frontend: **designers moving into code, and frontend engineers who'd rather design where they already work.** As AI erases the line between designing and building, Caret is what's on the other side: **design and code, finally the same thing.**

> This is **Caret IDE**, the Caret extension bundled into a branded **VS Code (OSS) build based on [VSCodium](https://github.com/VSCodium/vscodium)**, so you get a ready-to-go editor with Caret already inside. The core extension lives at **[precious112/caret](https://github.com/precious112/caret)**.

---

## Download

Grab the build for your platform (links always point to the newest release):

| Platform | Download |
|----------|----------|
| **macOS, Apple Silicon** (M1/M2/M3…) | [Caret-macOS-arm64.zip](https://github.com/precious112/caret-ide/releases/latest/download/Caret-macOS-arm64.zip) |
| **macOS, Intel** | [Caret-macOS-x64.zip](https://github.com/precious112/caret-ide/releases/latest/download/Caret-macOS-x64.zip) |
| **Windows**, installer (recommended) | [Caret-Windows-UserSetup-x64.exe](https://github.com/precious112/caret-ide/releases/latest/download/Caret-Windows-UserSetup-x64.exe) |
| **Windows**, system-wide installer | [Caret-Windows-Setup-x64.exe](https://github.com/precious112/caret-ide/releases/latest/download/Caret-Windows-Setup-x64.exe) |
| **Windows**, portable zip | [Caret-Windows-x64.zip](https://github.com/precious112/caret-ide/releases/latest/download/Caret-Windows-x64.zip) |
| **Linux**, Debian/Ubuntu (.deb) | [Caret-Linux-x64.deb](https://github.com/precious112/caret-ide/releases/latest/download/Caret-Linux-x64.deb) |
| **Linux**, Fedora/RHEL (.rpm) | [Caret-Linux-x64.rpm](https://github.com/precious112/caret-ide/releases/latest/download/Caret-Linux-x64.rpm) |
| **Linux**, AppImage (portable) | [Caret-Linux-x86_64.AppImage](https://github.com/precious112/caret-ide/releases/latest/download/Caret-Linux-x86_64.AppImage) |
| **Linux**, tarball | [Caret-Linux-x64.tar.gz](https://github.com/precious112/caret-ide/releases/latest/download/Caret-Linux-x64.tar.gz) |

## ⚠️ The builds are not code-signed yet, here's how to open them

Caret IDE isn't signed with a paid OS code-signing certificate yet (those run **$99–$500/yr**, which we'll invest in once Caret gains traction). **The apps are completely safe.** Your OS just shows a one-time warning because it can't see a signature. The most reliable fix is a single **terminal command** (this worked consistently across machines in testing, more dependable than clicking through the dialogs):

### 🍎 macOS
1. Unzip the download and drag **`Caret.app`** into **Applications**.
2. Run this in **Terminal**, then open Caret normally:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Caret.app
   ```

### 🪟 Windows
1. Download the installer.
2. Open **PowerShell** and unblock it (this removes the "Mark of the Web" that triggers SmartScreen), then run the installer normally:
   ```powershell
   Unblock-File "$HOME\Downloads\Caret-Windows-UserSetup-x64.exe"
   ```
   > Using the portable zip instead? Unblock everything inside after extracting:
   > ```powershell
   > Get-ChildItem -Recurse "$HOME\Downloads\Caret-Windows-x64" | Unblock-File
   > ```

### 🐧 Linux
No signing needed:
```bash
sudo dpkg -i Caret-Linux-x64.deb      # Debian/Ubuntu
sudo rpm -i  Caret-Linux-x64.rpm      # Fedora/RHEL
chmod +x Caret-Linux-x86_64.AppImage && ./Caret-Linux-x86_64.AppImage   # portable
```

## Don't want to install an unsigned IDE? Use Caret in your existing editor

Caret is also published as an extension, so you can add it to an editor you already have, no new app to install:

- **Open VSX** (VSCodium, Cursor, Windsurf, Gitpod, code-server, …): open the **Extensions** panel, search **"Caret"**, and install, or get it here: **https://open-vsx.org/extension/caretAI/caret**

> **Microsoft VS Code** uses its own marketplace (not Open VSX). VS Code users can download the `.vsix` from the Open VSX page above and install it via **Extensions → ⋯ → Install from VSIX…**.

The IDE simply ships this same extension pre-installed and configured, so the experience is identical either way.

---

## How it works

Caret splits your frontend into two layers that live in the same repo:

- A **design layer**, standardized to React and stored under `.caret/`. This is where you design: pages, flows, shared components, and design tokens. Think "Figma frames as code," version-controlled in parallel with your app.
- Your **application layer**, the app you actually ship, in any framework (React, Vue, Svelte, Angular, …). Caret stays unopinionated about it.

You design in the first layer, then sync into the second. The design layer's predictable structure is what unlocks the live canvas, visual editing, flow simulation, and design→app sync below.

### A standardized design layer

Everything you design lives under `.caret/` as plain React: pages in `.caret/pages/`, reusable pieces in `.caret/components/` and `.caret/layouts/`, navigation in `.caret/flows/`, and design tokens in `.caret/tokens/`. Each page carries a small `meta.json` describing its title, type, states, and tags. Because the design layer is always React with a known shape, Caret can reason about your pages reliably no matter what framework your shipped app uses.

### A token-driven design system

A guided wizard captures the foundations of your design system: a **vibe** descriptor, **color** (brand + neutral character + semantic), **typography** (Google Fonts + scale ratio), **spacing**, and **radius**. It shows a live preview of representative components updating as you tune each one. Pick the character, Caret generates the scale, you override what you want. The result is saved as namespaced JSON under `.caret/tokens/` and injected into generation so every page stays visually consistent.

### A live design canvas

All your pages render on a zoomable, pannable canvas, a Figma-style overview of the whole product. The focused page runs as live, interactive React; the rest show as cached thumbnails so the canvas stays fast even with many pages. Click any page to mount it live, switch viewport presets (desktop / tablet / mobile) to check responsiveness, and pan back out to see how everything fits together.

<p align="center">
  <img src="https://raw.githubusercontent.com/precious112/Pstore_backend/refs/heads/master/media/media/caret_res_sec_edit-ezgif.com-video-to-gif-converter.gif" width="100%" alt="Switching viewport presets to check responsiveness on the canvas" />
</p>

### Visual editing

Edit the rendered UI directly. Right-click an element to change its **text**, **color**, or **image** inline. The change is written back to the exact line of source and reflected instantly via hot-reload, no AI round-trip needed. For anything structural, choose **"Edit with AI"**: Caret hands the model rich context about the element (its source location, component, and props) and applies the change. Element targeting is deterministic via stable `data-caret-id` attributes and AST-level source edits, so edits land precisely instead of guessing.

> **Edit with AI** and all source/file edits are powered by [Cline](https://github.com/cline/cline), the open-source coding agent Caret is built on. It makes the precise code changes behind the scenes.

<p align="center">
  <img src="https://raw.githubusercontent.com/precious112/Pstore_backend/refs/heads/master/media/media/caret_inline_edit_third_edit-ezgif.com-video-to-gif-converter.gif" width="100%" alt="Editing text, color, and images inline on the rendered UI" />
</p>

### Flows and simulation

Define user journeys as flow graphs in `.caret/flows/*.flow.json`, referencing pages by ID. Overlay flow connections on the canvas to see how pages link together, restructure a flow by dragging an edge (Caret offers to update the underlying navigation to match), and enter **simulation mode** to click through your app in a device frame as a real user would, jumping between page states (empty, loading, error, success) with a state selector.

<p align="center">
  <img src="https://raw.githubusercontent.com/precious112/Pstore_backend/refs/heads/master/media/media/caret_flow_edit-ezgif.com-video-to-gif-converter.gif" width="100%" alt="Defining and editing user flows between pages on the canvas" />
</p>

### Design → app sync

When the design is ready, sync it into your real app. Caret tracks design changes against a git-based bookmark in `.caret/sync-state.json`, reads the current state of both layers, and produces a reviewable plan covering the UI translation plus any state, routing, or data changes the design implies. You review and accept; Caret applies the changes and advances the bookmark. Sync is one-way (design → app) and reversible. An undo restores your app files and rewinds the bookmark.

---

## Also a full coding agent

Caret is built on the open-source [Cline](https://github.com/cline/cline) coding agent, so beyond design it's a complete autonomous coding assistant: bring any API and model, run terminal commands, create and edit files with reviewable diffs, drive a browser, extend itself with Model Context Protocol (MCP) tools, and roll back to checkpoints, all human-in-the-loop, with you approving each step.

---

## About

Caret IDE is a standalone, branded build of **VS Code (OSS)** produced via [VSCodium](https://github.com/VSCodium/vscodium), with the Caret extension bundled as a built-in. It's licensed under the [MIT License](LICENSE); no Microsoft branding or telemetry is included, and the extension gallery is [Open VSX](https://open-vsx.org). The Caret extension itself is [Apache-2.0](https://github.com/precious112/caret) and built on [Cline](https://github.com/cline/cline).

Build & maintenance docs: [README-CARET.md](README-CARET.md).
