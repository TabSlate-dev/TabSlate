<div align="center">
  <img src="docs/public/assets/feature-1-light.png" alt="TabSlate Banner"/>
  <h1>TabSlate ✨</h1>
  <p>
    A modern Chrome extension that replaces the default New Tab page. <br>
    Providing advanced tab management, visual bookmark organization, and workspace grouping features.<br>
    <b>Take back control of your browser tabs and bookmarks.</b><br><br>
    <i>An open-source alternative to <a href="https://www.gettoby.com/">Toby</a> and <a href="https://workona.com/">Workona</a>.</i>
  </p>
  
  <p>
    <img src="https://img.shields.io/badge/Chrome-✓-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome">
    <img src="https://img.shields.io/badge/Edge-✓-0078D7?style=flat-square&logo=microsoftedge&logoColor=white" alt="Edge">
  </p>
  <p>
    <img src="https://img.shields.io/github/stars/TabSlate/TabSlate?style=flat-square&logo=github" alt="GitHub stars">
    <img src="https://img.shields.io/github/forks/TabSlate/TabSlate?style=flat-square&logo=github" alt="GitHub forks">
    <img src="https://img.shields.io/github/v/release/TabSlate/TabSlate?style=flat-square&logo=github" alt="Latest version">
  </p>
</div>

<p align="center">
  <a href="./README.md">English</a> •
  <a href="./.github/README_ZH.md">简体中文</a>
</p>

---

## 👋 Why TabSlate?

Are you drowning in dozens of open tabs? Is your bookmarks bar overflowing and chaotic?

That's why **TabSlate** was built. Designed as an open-source alternative to tools like [Toby](https://www.gettoby.com/) and [Workona](https://workona.com/), it replaces your browser's default New Tab page with a powerful, organized, and beautiful dashboard. Whether you're a power user juggling multiple projects, a researcher saving links, or just someone who wants a cleaner browsing experience, TabSlate helps you keep everything structured and easily accessible.

---

## ✨ Features

### 🌌 Core Functionality

- **🗂️ Workspaces & Collections**: Organize your browsing context into dedicated Workspaces and multi-level Collections.
- **🔖 Visual Bookmarks**: A beautiful, grid-based bookmark manager with automatic Favicon fetching and rich metadata support.
- **🔍 Global Search Overlay**: Hit `Ctrl+K` (or `Cmd+K`) anywhere to bring up a powerful command palette. Instantly search through open tabs, bookmarks, and collections, or fallback to your default search engine.
- **☁️ Cloud Sync**: Keep your data synchronized across multiple devices via the self-hosted `TabSlate-server` or the official Cloud service.
- **🗑️ Trash & Recovery**: Accidentally deleted a bookmark? Recover it easily from the built-in Trash bin.

### 📑 Advanced Tab Management

- **📍 Tab Overview**: View and manage all your currently open tabs directly from your New Tab page.
- **📦 Chrome Tab Groups Sync**: Native integration with Chrome's Tab Groups. Save groups persistently and restore them with a single click.
- **🤏 Compact Group Titles**: Save space on your tab bar with compact naming options for your groups.
- **🚫 Duplicate Detection**: Built-in alerts to prevent you from opening the same tab twice.

### 🎨 Design & Personalization

- **🌙 Dark Mode**: Elegant Dark/Light mode support with smooth transitions, built with Tailwind CSS and `shadcn/ui`.
- **🌐 i18n Support**: Native localization support (currently available in English and Simplified Chinese).
- **🎨 Custom Visuals**: Assign distinct colors to your tab groups and collections to keep things visually organized.

---

## 📥 Installation

<div align="center">
  <a href="https://chromewebstore.google.com/detail/hjopekcfkkiphbbdjccdhhlldnnfbchm" target="_blank">
    <img src="https://img.shields.io/badge/Chrome%20Web%20Store-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Web Store" height="36">
  </a>
</div>

> **Note:** TabSlate is currently under active development.

### Manual Installation (Developer Mode)

1. Clone the repository or download the latest release:
   ```bash
   git clone https://github.com/TabSlate/TabSlate.git
   cd TabSlate
   ```
2. Install dependencies (Bun is recommended):
   ```bash
   bun install
   ```
3. Build the extension:
   ```bash
   bun run build
   ```
4. Open Chrome and navigate to `chrome://extensions/`.
5. Enable **"Developer mode"** in the top right corner.
6. Click **"Load unpacked"** and select the `.output/chrome-mv3` folder inside the project directory.

---

## 🛠️ Development

We welcome contributions! 

### Scripts

- `bun run dev` - Start development mode with hot-reloading.
- `bun run build` - Build the production extension.
- `bun run compile` - Run TypeScript type checking.
- `bun run zip` - Package the extension into a `.zip` for Chrome Web Store distribution.

*See `ARCHITECTURE.md` for detailed technical architecture and state management documentation.*

---

## 📄 License

TabSlate is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** - see the [LICENSE](LICENSE) file for details.

### ⚠️ Commercial Use Restriction

**Please note:** This project is intended for personal and non-commercial use only. **Commercial use is strictly prohibited.** You may not use, reproduce, distribute, or monetize this software or any of its derivatives for commercial purposes without prior written permission from the author.

---

<div align="center">
  <p>Made with ❤️ for a better browsing experience.</p>
</div>
