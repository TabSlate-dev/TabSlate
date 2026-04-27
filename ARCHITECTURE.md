# ARCHITECTURE.md

## 总体结构

TabSlate 是一个 Chrome MV3 扩展，由三个独立入口点组成，通过 `chrome.storage.local` 共享数据。

```
┌─────────────────────────────────────────────────────┐
│  newtab (主应用)                                      │
│  React 19 + Zustand + React Router + dnd-kit        │
│  覆盖 chrome://newtab                                 │
├──────────────┬──────────────────────────────────────┤
│  popup       │  background (Service Worker)          │
│  快速保存当前 │  监听 tab/group 事件                    │
│  页为书签     │  处理右键菜单保存                        │
└──────────────┴──────────────────────────────────────┘
              共享: chrome.storage.local
```

## 目录结构

```
TabSlate/
├── entrypoints/
│   ├── newtab/          # 主应用入口
│   │   ├── main.tsx     # ReactDOM.createRoot
│   │   └── App.tsx      # 路由、布局、StoreGate（等待所有 store 水化）、AuthGate（未登录 → AuthPage）
│   ├── popup/           # 快速保存 popup
│   │   └── App.tsx      # 独立 React 树，不使用 Zustand
│   ├── background.ts    # Service Worker：tab 事件广播 + 右键菜单
│   └── content.ts       # 注入页面：提供 GET_PAGE_INFO 给 background
│
├── components/
│   ├── auth/
│   │   ├── auth-page.tsx            # 全屏认证页，居中渲染 LoginForm
│   │   └── verify-email-screen.tsx  # 全屏 OTP 邮箱验证页（AuthGate 拦截未验证用户时显示）
│   ├── login-form.tsx          # login/register/forgot-password/reset-password 四模式 + Prosopo 验证码 + 密码强度提示
│   ├── procaptcha.tsx          # Prosopo iframe 包装组件（绕过 MV3 CSP 限制；通过 postMessage 接收 token）
│   ├── ui/              # shadcn/ui 基础组件 + 自定义共享组件
│   │   ├── alert.tsx           # 标准 shadcn Alert（内联提示 + 浮动通知）
│   │   ├── color-picker.tsx    # Tab group 颜色选择器（共享）
│   │   ├── favicon-image.tsx   # 带 fallback 的 favicon 图片
│   │   └── input-otp.tsx       # 6 格 OTP 输入框（基于 input-otp 包）
│   └── dashboard/
│       ├── sidebar/            # 左侧书签导航栏
│       │   ├── index.tsx       # BookmarksSidebar（主组件）
│       │   ├── collection-dialog.tsx
│       │   ├── tag-dialog.tsx
│       │   └── group-dialog.tsx
│       ├── tabs-panel/         # /tabs 路由：当前标签页管理
│       │   ├── index.tsx       # TabsPanel（主组件）
│       │   ├── group-card.tsx  # 单个 Chrome tab group 卡片
│       │   ├── ungrouped-section.tsx
│       │   ├── draggable-tab.tsx
│       │   ├── save-collection-dialog.tsx
│       │   └── join-group-dialog.tsx
│       ├── groups-panel/       # /tabs 路由右侧：保存的标签组
│       │   ├── index.tsx       # GroupsPanel（主组件，独立 DnD context）
│       │   ├── droppable-group-card.tsx
│       │   ├── draggable-tab-row.tsx
│       │   └── create-group-bar.tsx
│       ├── group-detail/       # /groups/:groupId 路由：单个保存组详情
│       │   └── index.tsx       # GroupDetail（标签列表、内联编辑、拖拽支持）
│       ├── tabs-dnd-provider.tsx # 全局 DnD context（tab → collection/saved-group）
│       ├── tab-row.tsx         # 单行 tab 组件（React.memo）
│       ├── stats-cards.tsx     # 书签统计卡片
│       ├── content.tsx         # / 路由：书签网格/列表
│       ├── header.tsx          # 顶部搜索/过滤栏
│       ├── workspace-rail.tsx  # 最左侧工作区切换轨道
│       ├── tabs-rail.tsx       # 最右侧标签页快速预览轨道
│       ├── bookmark-card.tsx   # 单个书签卡片/列表项
│       ├── favorites-content.tsx
│       ├── archive-content.tsx
│       └── trash-content.tsx
│
├── store/
│   ├── auth-store.ts       # 认证状态（user、accessToken、refreshToken、serverUrl）— 持久化
│   ├── bookmarks-store.ts  # 书签数据 + UI 过滤状态
│   ├── workspace-store.ts  # 工作区/集合/标签配置
│   ├── groups-store.ts     # 保存的标签组（含 dnd-kit 排序数据）
│   └── tabs-store.ts       # Chrome 当前窗口标签页（非持久化）
│
├── types/
│   └── prosopo.d.ts        # window.procaptcha 全局类型声明（captcha widget 页面使用）
│
├── lib/
│   ├── api.ts              # TabSlate-server HTTP 客户端（register/login/logout/refresh/me/loginCaptchaStatus/resendVerification/verifyEmailOTP/forgotPassword/resetPassword/otpCaptchaStatus）
│   ├── types.ts            # Workspace, Collection, Tag, Bookmark 接口定义
│   ├── utils.ts            # cn() 等工具函数
│   ├── storage.ts          # popup 用的轻量 chrome.storage 读写工具
│   ├── chrome-storage-adapter.ts  # Zustand persist 的 chrome.storage 适配器
│   ├── id.ts               # generateId()
│   ├── bookmark-utils.ts   # findDuplicateBookmark()
│   └── chrome/
│       ├── tabs.ts         # Chrome tabs API 封装
│       └── tab-groups.ts   # Chrome tabGroups API 封装 + 颜色常量
│
├── hooks/
│   ├── use-tab-drag-drop.ts   # 原生 HTML drag-and-drop（tab → 书签内容区）
│   ├── use-group-drag-drop.ts # 原生 HTML drag-and-drop（tab → 保存组详情页）
│   └── use-mobile.ts          # 响应式断点检测
│
└── wxt.config.ts            # 扩展 manifest、权限配置
```

## 状态管理

### Store 设计原则

所有 store 使用 Zustand，持久化通过 `chromeStorageAdapter` 写入 `chrome.storage.local`。

```
useAuthStore       ──persist──▶  "tabslate-auth"
useBookmarksStore  ──persist──▶  "tabslate-bookmarks"
useWorkspaceStore  ──persist──▶  "tabslate-workspace"
useGroupsStore     ──persist──▶  "tabslate-groups"
useTabsStore       (不持久化，运行时从 Chrome API 加载)
```

### Store 职责

| Store | 持久化 | 职责 |
|---|---|---|
| `useAuthStore` | ✅ | 登录用户信息（含 `is_verified`）、access/refresh token、server URL；actions：login/register/resendVerification/verifyEmailOTP/forgotPassword/resetPassword/logout |
| `useBookmarksStore` | ✅ | 书签数据（active/archived/trashed）+ 过滤/排序/视图 UI 状态 |
| `useWorkspaceStore` | ✅ | 工作区、集合（Collections）、标签（Tags）、高亮状态 |
| `useGroupsStore` | ✅ | 用户手动保存的标签组及其包含的 tab URL |
| `useTabsStore` | ❌ | Chrome 当前窗口的实时标签页和 tab group 数据 |

### 跨页面同步

```
newtab (Zustand)  ──写入──▶  chrome.storage.local
                                    │
                              onChanged 事件
                                    │
                  ◀──读取──  newtab (另一窗口) / background / popup
```

各 store 文件底部都注册了 `chrome.storage.onChanged` 监听器，用 JSON.stringify 对比变更内容，有差异才 `setState`。

## 路由

使用 `HashRouter`（避免扩展 URL 与 HTML5 History 冲突）：

| 路径 | 组件 | 说明 |
|---|---|---|
| `/` | `BookmarksContent` | 书签主界面（grid/list） |
| `/favorites` | `FavoritesContent` | 收藏夹 |
| `/archive` | `ArchiveContent` | 已归档书签 |
| `/trash` | `TrashContent` | 回收站 |
| `/tabs` | `TabsPanel` | 当前标签页管理 |
| `/groups/:groupId` | `GroupDetail` | 保存组详情（标签列表、内联编辑、删除、从 TabsRail 拖入） |

## 布局结构

```
┌──────┬──────────┬────────────────────────┬──────────┐
│ Work │ Bookmark │                        │  Tabs    │
│ space│ Sidebar  │   Content Area         │  Rail    │
│ Rail │          │  (route-dependent)     │ (右侧预览)│
│      │          │                        │          │
│ 52px │ 240px    │   flex-1               │ 240px    │
└──────┴──────────┴────────────────────────┴──────────┘
```

- `WorkspaceRail`：最左侧，工作区切换 + 主题切换
- `BookmarksSidebar`：左侧，集合/分组/标签导航，同时是 DnD drop target
- 内容区：响应路由
- `TabsRail`：右侧，当前标签页快速浏览（仅桌面端 lg+）

## DnD（拖拽）系统

项目存在两套独立的拖拽系统：

### 1. TabsDndProvider（主 DnD context）
- 范围：整个 newtab 应用（`tabs-dnd-provider.tsx`）
- 用途：从 `TabsPanel` 拖 tab/tab-group → 到 `BookmarksSidebar`（保存为书签/保存组）
- 技术：dnd-kit `DndContext`
- Drop targets：`sidebar-collection-{id}`、`sidebar-groups`

### 2. GroupsPanel 内部 DnD
- 范围：仅 `GroupsPanel` 组件内部
- 用途：从左侧 open tabs 列表拖 tab → 到右侧 saved groups
- 技术：独立的 dnd-kit `DndContext`（不与外层 context 共享）

### 3. HTML5 原生拖拽（use-tab-drag-drop）
- 范围：`TabsRail` → `BookmarksContent`
- 用途：从右侧标签页轨道拖 tab 到书签内容区，含重复检测与高亮
- 技术：原生 `draggable` + `dragover` 事件，MIME type `application/tabslate-tab`

### 4. HTML5 原生拖拽（use-group-drag-drop）
- 范围：`TabsRail` → `GroupDetail`
- 用途：从右侧标签页轨道拖 tab 到保存组详情页
- 技术：与 system 3 相同 MIME type，drop 后调用 `addTabToGroup()`（自动去重）

## Chrome 扩展事件流

```
Chrome tab 变化
    │
    ▼
background.ts
  └── broadcastTabChange()
        └── chrome.storage.local.set({ "tabslate-tabs-changed": Date.now() })
              │
              ▼
        chrome.storage.onChanged
              │
    ┌─────────┴──────────┐
    ▼                     ▼
TabsPanel             GroupsPanel
  └── loadTabs(true)     └── loadTabs()
```

## 核心数据模型

```ts
// lib/types.ts
Workspace { id, name, color, position }
  └── Collection[] { id, workspaceId, name, icon, position, isDefault? }
         └── Bookmark[] { id, title, url, favicon, description, collectionId, tags[], createdAt, isFavorite }
Tag { id, name, color }   // color 为 Tailwind class 字符串

// store/groups-store.ts
SavedGroup { id, name, color: TabGroupColor, isCompact, createdAt }
  └── GroupTab[] { id, groupId, title, url, favicon, position }

// lib/chrome/tab-groups.ts
BrowserTabGroup { id, title, color, collapsed, windowId }  // Chrome 实时数据
BrowserTab { id, title, url, favIconUrl, groupId, active, windowId }
```

## 权限

| 权限 | 用途 |
|---|---|
| `tabs` | 读取当前窗口 tab 列表、focus/close tab |
| `tabGroups` | 读取/创建/更新/删除 Chrome tab group |
| `storage` | chrome.storage.local 读写 |
| `bookmarks` | （暂未使用 Chrome 原生书签 API） |
| `contextMenus` | 右键菜单"Save to TabSlate" |
| `host_permissions: <all_urls>` | 读取任意页面的 favicon |
