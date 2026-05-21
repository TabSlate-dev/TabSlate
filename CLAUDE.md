# CLAUDE.md

## 仓库关系

TabSlate 由三个仓库组成：

| 仓库 | 可见性 | 职责 |
|---|---|---|
| **`TabSlate`**（本仓库） | 公开，AGPL | Chrome 扩展前端，TypeScript + React + WXT |
| **`TabSlate-server`** | 公开，AGPL | Go 后端 OSS 版，可自托管，计费基于本地 License JWT |
| **`TabSlate-cloud`** | 私有 | Go 后端 Cloud 版，以 `TabSlate-server` 为 Go module 依赖，注入 Meteroid 计费 |

前端直接通过 Chrome extension API 与后端 REST API 通信；Cloud 版与 OSS 版暴露完全相同的 API 路由，前端无感知差异。

---

## 项目概述

TabSlate 是一个 Chrome 扩展，用新标签页替换浏览器默认新标签页，提供标签页管理、书签整理、分组等功能。

## 常用命令

```bash
bun run dev        # 开发模式（热重载）
bun run build      # 生产构建（用于验证 TypeScript 是否通过）
bun run compile    # 仅 tsc 类型检查，不构建产物
bun run zip        # 打包为 .zip 供 Chrome Web Store 上传
```

## Dependencies and Upgrading

- Use bun for all dependency management.
- After updating dependency versions, install to update lockfiles:

```bash
bun install
```

## 项目结构

Refer to ARCHITECTURE.md for detailed architecture documentation.

## Instructions

You're an expert in the following areas:

- TypeScript
- React React Router and React.memo
- Zustand
- HTML, Tailwind CSS, shadcn/ui, radix-ui

## General Guidelines

- Critical – Do not create new markdown (.md) files.
- Use early returns for readability.
- Emphasize type safety and static analysis.
- Follow existing code style and formatting conventions.
- Do not replace smart quotes ("") or ('') with simple quotes ("").

## 核心规范

### TypeScript Usage

- Use strict mode.
- Avoid "unknown" unless absolutely necessary.
- Never use "any".
- Prefer type definitions; avoid type assertions (as, !).
- Always use curly braces for if statements.
- Avoid # for private properties.
- Prefer interface over type for object shapes.

### React Usage

- Use functional components with hooks.
- Always use named exports for new components.
- Event handlers should be prefixed with "handle", like "handleClick" for onClick.
- Avoid unnecessary re-renders by using React.memo, useMemo, and useCallback appropriately.
- Use descriptive prop types with TypeScript interfaces.
- Do not import React unless it is used directly.
- Ensure high accessibility (a11y) standards using ARIA roles and semantic HTML.

### Zustand Store 订阅

**必须使用细粒度 selector，禁止解构整个 store：**

```ts
// ❌ 错误 — 任何 store 状态变化都会触发整个组件重渲染
const { selectedCollection, bookmarks } = useBookmarksStore();

// ✅ 正确 — 只在该字段变化时重渲染
const selectedCollection = useBookmarksStore(s => s.selectedCollection);
const bookmarks = useBookmarksStore(s => s.bookmarks);
```

Actions（setter 函数）引用稳定，同样用 selector 取：
```ts
const setSelectedCollection = useBookmarksStore(s => s.setSelectedCollection);
```

### React.memo + useCallback

频繁渲染的列表项（如 `TabRow`）已用 `React.memo` 包裹。向其传递的 callback props 必须用 `useCallback` 包裹，否则 memo 失效。

### useMemo for 派生数据

在组件 render 中对 store 数据做 filter/sort/map 的操作必须用 `useMemo`，依赖数组列明实际用到的 store 字段。

**禁止在 selector 内做派生计算**——selector 每次返回新引用会导致无限重渲染：

```ts
// ❌ 错误 — filter/sort 每次返回新数组，触发无限重渲染
const tabs = useGroupsStore(s => s.groupTabs.filter(t => t.groupId === id));

// ✅ 正确 — selector 取原始数据，useMemo 做派生
const allTabs = useGroupsStore(s => s.groupTabs);
const tabs = React.useMemo(
  () => allTabs.filter(t => t.groupId === id).sort((a, b) => a.position - b.position),
  [allTabs, id]
);
```

### 共享组件

- **FaviconImage** (`components/ui/favicon-image.tsx`) — 所有 favicon 显示都用此组件，禁止裸 `<img onError>`
- **ColorPicker** (`components/ui/color-picker.tsx`) — Tab group 颜色选择器，支持 `size="sm" | "md"`
- **Alert** (`components/ui/alert.tsx`) — 标准 shadcn Alert，用于内联提示和浮动通知（duplicate tab 检测等）
- **InputOTP** (`components/ui/input-otp.tsx`) — 6 格 OTP 输入框（基于 `input-otp` 包），用于邮箱验证和密码重置
- **QuotaAlert** (`components/ui/quota-alert.tsx`) — 配额上限通知，fixed 定位，订阅 `usePlanStore.quotaAlert`，3 秒自动消失；已挂载于 `App.tsx` 根部，无需在各调用方处理
- **SearchBox** (`components/dashboard/search-box.tsx`) — 新标签页英雄区和集合内联搜索栏，合并了原 `HeroSection` 内联搜索与已删除的 `CollectionSearch`；Props：`collectionId?: string`（传入时按集合过滤书签结果，`undefined` 则搜全部；空字符串 `""` 代表未分类集合，同样会过滤，用 `collectionId !== undefined` 判断而非 `collectionId ?`）、`size?: "sm" | "lg"`、`className?: string`；下拉结果顺序：open tabs → bookmarks → search engine fallback；`getEngineIconSrc(engine)` 已导出供复用
- **SearchPanel** (`components/search/search-panel.tsx`) — 全页内联搜索浮层，用于 BookmarksContent 顶部（smartOpen 模式，Ctrl+K 唤起）和 search popup；Props：`openTabs`、`onClose?`、`autoFocus?`、`smartOpen?`；fallback 搜索使用 `useSettingsStore` 中第一个 enabled 引擎（非硬编码 Google）
- **Select** (`components/ui/select.tsx`) — 标准 shadcn Select（基于 `@radix-ui/react-select`），用于 ImportDialog 等表单
- **shadcn/ui** (`components/ui/`) — Button、Input、Dialog 等基础组件

### Favicon 规范化

`normalizeFavicon(favicon, url)` 位于 `lib/bookmark-utils.ts`，将 `data:` URL（`chrome.tabs` 返回的大型 base64 blob）替换为 `https://icons.duckduckgo.com/ip3/${domain}.ico`。书签写入的三个入口（`addBookmark`、`addBookmarks`、`_bulkAddBookmarks`）以及 groups 的 `saveGroupFromChrome` 在存储前均调用此函数。`bookmarks-store.hydrate()` 和 `groups-store.hydrate()` 在首次加载时对已有 IDB 数据执行一次性迁移（幂等，迁移后 `data:` favicon 不再出现）。

### Dialog 样式规范

Dialog 必须使用标准 shadcn 结构，禁止在 `DialogContent` 上添加破坏一致性的覆盖：

```tsx
// ❌ 错误 — 破坏视觉统一性
<DialogContent className="border-none shadow-2xl p-0 backdrop-blur-md">

// ✅ 正确 — 保留边框和默认阴影，p-0 仅在需要自定义内部布局时使用
<DialogContent className="sm:max-w-lg">
```

浮动通知（如重复检测提示）使用 `<Alert>` 配合 fixed 定位，而非自定义颜色 pill：

```tsx
<Alert className="fixed top-4 left-1/2 -translate-x-1/2 z-100 w-auto shadow-lg animate-in fade-in slide-in-from-top-2 pointer-events-none whitespace-nowrap">
  <AlertCircle />
  <AlertDescription>{message}</AlertDescription>
</Alert>
```

### 数据持久化布局

大部分数据已迁移到 **IndexedDB**（`tabslate-db` v2），少量需要 content script 跨上下文读取的数据保留在 `chrome.storage.local`。`accessToken` 单独存入 `chrome.storage.session`（`TRUSTED_CONTEXTS` 级别），content script 无法读取。

#### chrome.storage.session（仅 newtab / background / popup 可读）

| Key | 格式 | 用途 |
|---|---|---|
| `tabslate-auth-token` | `JSON.stringify({ accessToken })` | 短期访问令牌；浏览器关闭后清除；content script 无法读取 |

#### chrome.storage.local

| Key | 格式 | 用途 |
|---|---|---|
| `tabslate-auth` | Zustand JSON `{state: {...}}`（不含 accessToken） | 用户认证持久部分：user、refreshToken、serverUrl、otpSentAt |
| `tabslate-search-engines` | `JSON.stringify(SearchEngine[])` | 用户搜索引擎配置，供 `SearchOverlay`（content script）读取；由 newtab `StoreGate` 在 `searchEngines` 变更时写入 |

适配器：`lib/auth-storage-adapter.ts`（透明合并两个 storage 供 Zustand `persist` 中间件使用；含从旧 `accessToken`-in-local 的迁移路径）。

#### IndexedDB — `tabslate-db` v2（`lib/idb.ts`）

v2 迁移（`oldVersion >= 1 && < 2`）：为 `trashed-bookmarks` 添加 `collectionId` 索引，支持按集合查询回收站书签。新安装直接在 v1 建表时包含此索引。

`lib/idb.ts` 暴露的辅助函数：`idbGet`、`idbPut`、`idbDelete`、`idbGetAll`、`idbGetMany`（批量读取，**单事务** N 个 `get` 请求，性能远优于 `Promise.all(N × idbGet)`）、`idbGetByIndex`、`idbTransaction`、`idbBulkWrite`（跨多 store 原子写，多个 delete/put 在单事务中执行，用于 `mergeFromServer` 同步落盘）。

| Object Store | keyPath | 索引 | 用途 |
|---|---|---|---|
| `bookmarks` | `id` | `collectionId`、`isFavorite` | 活跃书签 |
| `archived-bookmarks` | `id` | `collectionId` | 已归档书签 |
| `trashed-bookmarks` | `id` | `collectionId` | 已删除书签 |
| `workspaces` | `id` | `position` | 工作区 |
| `collections` | `id` | `workspaceId`、`position` | 集合 |
| `tags` | `id` | — | 标签 |
| `groups` | `id` | — | 保存的标签组 |
| `group-tabs` | `id` | `groupId` | 保存组内的 tab |
| `tab-group-titles` | `groupId` | — | Chrome tab group 完整标题（compact 模式下 Chrome 侧只存首字母） |
| `kv` | `key` | — | 键值对：`activeWorkspaceId`、`compactGroupTitles`、`localSeq`、`sync-leader`、`searchEngines` |

#### 跨进程消息信号（不存储，runtime 消息）

| 消息类型 | 方向 | 触发时机 |
|---|---|---|
| `TABS_CHANGED` | background → newtab | 任意 tab/group 增删改 |
| `BOOKMARKS_CHANGED` | background → newtab | background 回退写 IDB 后通知刷新 |
| `ADD_BOOKMARK` | popup/background → newtab | 保存书签（优先路径） |
| `OPEN_SEARCH` | background → active tab | 触发全局搜索快捷键，通知 content script 挂载 SearchOverlay |
| `GET_OPEN_TABS` | content script → background | SearchOverlay 获取当前所有打开的标签页 |
| `FOCUS_TAB` | content script → background | SearchOverlay 选中某个标签页时请求切换 |
| `OPEN_TAB` | content script → background | SearchOverlay 打开新标签页（content script 无法直接调用 `chrome.tabs.create`） |
| `SEARCH_BOOKMARKS` | content script → background | SearchOverlay 代理搜索请求，绕过跨域限制 |

### Highlight Timer 模式

两个 store 中都有 highlight 功能，使用模块级 timer 变量避免重叠：
```ts
let _tabHighlightTimer: ReturnType<typeof setTimeout> | null = null;
// 每次调用先 clearTimeout 旧计时器
```

### React 19 Form Actions

Dialog 中的简单表单可使用 React 19 的 `form action` 模式。**但对于有复杂错误处理、状态保留需求的表单（如 LoginForm），必须使用 `onSubmit` + `e.preventDefault()`**，因为 React 19 的 `form action` 在 action 函数正常返回后会自动清空所有非受控 input，导致用户输入丢失：

```tsx
// ✅ 复杂表单 — 用 onSubmit 保留输入
<form onSubmit={async (e) => {
  e.preventDefault();
  const formData = new FormData(e.currentTarget);
  // 处理提交
}}>

// ✅ 简单 Dialog 表单 — form action 可用
<form action={(formData) => {
  const name = formData.get("name") as string;
  // 处理提交
}}>
```

### Active Collections 排序规范

为了保证整个应用的用户体验一致，侧边栏（Sidebar）和所有选择器/下拉框（新建书签、标签组卡片、导入弹窗等）中的 **Active Collections (活跃集合)** 排序必须统一：
1. **Default** 默认集合（`isDefault === true`）始终固定在最顶部。
2. 其它集合按**最新保存/创建的排在最上面**（即按 `position` 降序/从大到小排列，新创建的 Collection 拥有更大的 `position` 值）。
3. 统一使用以下排序规则：
```ts
.sort((a, b) => {
  if (a.isDefault) return -1;
  if (b.isDefault) return 1;
  return b.position - a.position;
})
```

### 文件拆分原则

大型组件按功能拆分为子目录，通过 `index.tsx` 导出主组件：
- `components/dashboard/sidebar/` — `BookmarksSidebar`
- `components/dashboard/tabs-panel/` — `TabsPanel`
- `components/dashboard/groups-panel/` — `GroupsPanel`

导入路径不变：`import { BookmarksSidebar } from "@/components/dashboard/sidebar"`

## 路径别名

`@/` → 项目根目录（由 WXT 配置，等同于 TypeScript `paths` 中的 `@/*`）

## 环境变量

| 变量 | 说明 |
|---|---|
| `VITE_API_URL` | 后端 API 地址，默认 `http://localhost:8080` |
| `VITE_PROSOPO_SITE_KEY` | Prosopo 站点公钥（Site Key）；空 = 禁用验证码 |
| `VITE_PROSOPO_CAPTCHA_TYPE` | Prosopo 验证码类型，需与 Prosopo 控制台配置一致：`frictionless` \| `pow` \| `image`；空 = Prosopo 默认 |

## Code Quality

- Type check: `bun run compile`
- Verify build: `bun run build`
- No linter or pre-commit hooks configured yet.

## 注意事项

- **不要在 newtab/search popup 以外使用 store**：popup 和 background 不加载 Zustand；保存书签时优先通过 `chrome.tabs.sendMessage` 发 `{ type: "ADD_BOOKMARK", data }` 消息到 newtab（newtab 在 `App` 的 `useEffect` 中监听），newtab 不存在时回退到直接写 `chrome.storage.local`（`seq: 0`，下次 newtab 打开时由 `sweepUnsynced` 补推）
- **Tab 变更广播**：background.ts 监听所有 tab/group 事件，写 `tabslate-tabs-changed` 信号；newtab 的 `TabsPanel` 和 `GroupsPanel` 监听此信号触发 `loadTabs()`
- **Store hydration**：`App.tsx` 中的 `StoreGate` 组件等待 `bookmarksHydrated && workspaceHydrated && authHydrated` 后才渲染，避免闪烁
- **AuthGate**（`entrypoints/newtab/App.tsx`）：三层守卫：① `accessToken` 和 `refreshToken` 均为 null → 渲染 `AuthPage`（登录/注册/找回密码）；② 用户存在但 `user.is_verified === false` → 渲染 `VerifyEmailScreen`（OTP 输入）；③ 两者均通过 → 渲染 dashboard。重启浏览器时 `accessToken` 因 session storage 清除而为 null，但 `refreshToken` 仍在，此时直接渲染 dashboard（`silentRefresh` 在后台刷新 token），避免因网络问题导致重新登录。验证成功后 store 调用 `GET /auth/me` 更新 `is_verified`，`AuthGate` 自动重渲染。`VerifyEmailScreen` 挂载时从 store 的 `otpSentAt` 字段本地计算剩余冷却时间（不发 API 请求），同时调 `GET /auth/otp-captcha-status` 检查 IP 是否需要验证码。
- **API 客户端**：`lib/api.ts` 是纯函数 HTTP 客户端，不持有状态；server URL 由 `useAuthStore.serverUrl` 管理（默认读取 `VITE_API_URL` 环境变量）。自托管用户可在登录页"Advanced"中修改。`searchBookmarks(serverUrl, accessToken, query)` 调用 `GET /search?q=`，最少 2 个字符。
- **GET_PAGE_INFO 响应字段**：content script 在 `GET_PAGE_INFO` 消息响应中返回 `{ title, url, selectedText, favicon, ogTitle, metaDescription }`。三条保存路径（tabs-store `_saveTabsToCollectionHelper`、popup `handleSave`、background 右键菜单）均优先使用 `ogTitle` 作为书签标题，`metaDescription` 作为描述；content script 无响应时静默回退到 tab 默认值。
- **全局搜索 Overlay**：通过 `chrome.commands.onCommand("open-search")` (`Ctrl+Shift+K`) 触发。background 拦截后向当前 active tab 发送 `OPEN_SEARCH` 消息。Content script (`entrypoints/content.ts`) 收到后，使用 WXT 的 `createShadowRootUi` 将 `SearchOverlay` 组件注入到当前页面的 Shadow DOM 中（使用 `isolateEvents: true` 防止键盘事件冒泡到宿主页）。由于 content script 受宿主页面的 CORS 限制，Overlay 内的书签搜索请求通过 `SEARCH_BOOKMARKS { query }` 消息代理到 background 执行（**不携带认证信息**，background 自行从 `chrome.storage.session` 读取 `accessToken`）；打开新标签页通过 `OPEN_TAB` 消息代理（content script 无权直接调用 `chrome.tabs.create`）。搜索引擎图标（`search-engine-icon/*.svg`）需在 `wxt.config.ts` 的 `web_accessible_resources` 中声明，否则 Shadow DOM 内的 `<img>` 无法加载扩展资源。对于无法注入 content script 的页面（如 `chrome://`），扩展会静默忽略快捷键。
- **Prosopo 验证码**：`components/procaptcha.tsx` 是 iframe 包装组件（Chrome MV3 `script-src 'self'` CSP 限制，无法直接加载外部 JS）。扩展通过 `<iframe>` 嵌入后端的 `GET /captcha/widget` 页面，由服务端加载 Prosopo bundle，验证完成后通过 `postMessage` 传回 token。`VITE_PROSOPO_SITE_KEY` 为空时不渲染验证码。注册页在同 IP 注册数达到 `REGISTER_CAPTCHA_THRESHOLD` 后条件展示（`GET /auth/register-captcha-status`，进入注册模式时查询）；登录页在同邮箱失败次数达到阈值后条件展示（`GET /auth/login-captcha-status`，邮箱 blur 时查询）；OTP 重发页：挂载时调 `GET /auth/otp-captcha-status`；若 `captcha_required=true`，点击 Resend 弹出 Dialog 展示 Procaptcha，验证通过后 Dialog 自动关闭并触发发送；无需验证码时直接发送。
- **可选权限与动态注入**：为了规避安装时的“读取并更改所有网站数据”警告，`<all_urls>` 被配置为 `optional_host_permissions`。
    - **wxt.config.ts**：通过 `hooks.build:manifestGenerated` 钩子强制删除 WXT 自动生成的 `host_permissions`，确保权限严格可选。
    - **content.ts**：配置 `registration: "runtime"`，防止 WXT 将其静态写入 manifest。
    - **background.ts**：实现 `syncContentScriptRegistration`，在权限变更（`chrome.permissions.onAdded/onRemoved`）或启动时使用 `chrome.scripting` API 动态注册/注销内容脚本。
    - **SettingsDialog**：提供开关，调用 `chrome.permissions.request/remove` 触发系统授权弹窗。
- **邮箱验证**：使用 6 位数字 OTP，不再发送链接。注册后若 `user.is_verified === false`，`AuthGate` 拦截并显示 `VerifyEmailScreen`，用户输入 OTP 后调用 `POST /auth/verify-email { email, code }`，成功后通过 `GET /auth/me` 确认验证状态。`InputOTP` 的 `onChange` 在 `value.length === 6` 时立即调 `submitCode`，无需用户点击"Verify"按钮（自动提交）。
- **找回密码**：`LoginForm` 新增 `forgot-password` 和 `reset-password` 两个 mode，通过 `POST /auth/forgot-password` 发送 OTP，再通过 `POST /auth/reset-password` 重置密码。
- **密码强度**：前端 `minLength={10}` + 提示文案"At least 10 characters, including a letter and a number"，与后端 `validatePasswordStrength` 规则对齐。
- **Compact group title**：Chrome tab group 标题若为紧凑模式，Chrome 端存单字母；完整标题存于 `tabslate-full-titles`，`fullTitles[groupId]` 取用
- **SyncEngine 生命周期**：`SyncProvider`（`App.tsx`）在 `[accessToken, serverUrl]` 变更时销毁旧引擎并创建新引擎；cleanup 函数依次调用 `engine.forceSync()`（fire-and-forget）、`engine.destroy()`、`releaseSyncEngine(engine)`，确保登出前推送最后变更。**禁止在 cleanup 中调用 `destroySyncEngine()`**——`.finally()` 触发时新引擎已写入全局变量，`destroySyncEngine()` 会错误销毁新引擎。`releaseSyncEngine(engine: SyncEngine)` 位于 `lib/sync-engine.ts`，仅在全局指针仍指向同一实例时清空，保证安全。不要在组件中直接 `import syncEngine`——通过 `SyncProvider` render props 的 `onForceSync` 触发手动同步。`SyncProvider` render props 签名为 `(syncStatus, onForceSync, syncErrorMessage)`；`syncErrorMessage` 在 `status === "error"` 时携带错误原因文本，其他状态下为 `null`。`SyncStatusIndicator` 在 error 状态下悬停时通过 Tooltip 展示该错误原因。push 收到 `quota_exceeded` 拒绝时，`onPushSuccess` 从 `Rejected.type` 字段（`"collection"` | `"saved_group"` | `"workspace"`）读取资源类型，调用 `showQuotaAlert(type)` 并触发 `fetchPlan()`，不将 sync status 设为 error。`SyncEngine.OnStatusChange` 类型为 `(status, errorMessage?) => void`；push 网络错误和 pull catch 分别传入对应错误消息。
- **syncEngine?.enqueue() 调用位置**：必须在 Zustand `set()` 调用之前（或完全在外部），不能在 `set((state) => {...})` updater 函数内部调用（updater 必须是纯函数）。
- **localSeq 持久化**：`localSeq` 已合入 `"tabslate-workspace"` Zustand persist state，随工作区数据一同加载，无独立 storage key。`App.tsx` 的 `onPullSuccess` 回调是唯一更新 `localSeq` 的地方；非首次 pull（`needsInitialPush === false`）时还会调用 `sweepUnsynced()` 将所有 `seq === 0` 的实体补推到服务器。`bookmarks-store.sweepUnsynced` 和 `enqueueAllToSync` 若 archived/trashed 尚未加载，会先调 `loadArchivedBookmarks()` / `loadTrashedBookmarks()` 加载并保留在 state（load-and-keep），避免读取并丢弃产生 GC 峰值。
- **书签延迟加载（archived / trashed）**：`useBookmarksStore` 启动时仅通过 `hydrate()` 加载 `bookmarks`（活跃书签）；`archivedBookmarks` 和 `trashedBookmarks` 两个 bucket 在首次进入 `/archive` 或 `/trash` 路由时由 `ArchiveContent` / `TrashContent` 的 `useEffect` 触发 `loadArchivedBookmarks()` / `loadTrashedBookmarks()` 加载（幂等，多次调用只执行一次）。`mergeFromServer` 在 store 未加载时使用 `idbGetMany`（单事务批量读取仅 pull delta 涉及的 ID，远优于 `idbGetAll` 全表读取）。**`_archivedLoaded` / `_trashedLoaded` 标志只能由对应 loader 设置；store action 在修改 `archivedBookmarks` / `trashedBookmarks` 前必须检查该标志，未加载时通过 IDB 直接操作而不修改 state，防止空数组覆盖真实数据。**
- **软删除 / 归档（集合三态）**：集合有三种状态：active（`!deletedAt && !archivedAt`）、archived（`archivedAt && !deletedAt`）、trashed（`deletedAt`）。`deleteCollection` / `archiveCollection` 均为软删除——只写 `deletedAt` / `archivedAt` 并 `idbPut`，不做 `idbDelete`；`permanentlyDeleteCollection` 才真正 `idbDelete`。**`permanentlyDeleteCollection` 采用异步 push-first 模式**：先乐观移除 UI（从 `collections` state 过滤），调用 `syncEngine.forcePush({ collections: [...] })` 直接推送 `is_deleted: 2` 到服务端（非防抖队列）；push 失败时回滚 UI，push 成功后才执行 `idbDelete` + `decrementUsage("collection")`，确保 IDB 与服务端始终一致。删除/归档集合时，其下所有书签同步批量移入 `trashed-bookmarks` / `archived-bookmarks`（`trashCollectionBookmarks` / `archiveCollectionBookmarks`）；`restoreCollection` 时全部还原。**`trashCollectionBookmarks(id)` 同时覆盖 `bookmarks`（活跃）和 `archivedBookmarks`（已归档）两个 bucket**——若集合内有已归档书签，也会一并移入 `trashedBookmarks`，避免孤儿归档。`permanentlyDeleteCollectionBookmarks(id)` 同样对 `archivedBookmarks` 做防御性清理。**`deleteWorkspace` 会对所有子集合调用 `trashCollectionBookmarks`**，确保删除工作区时书签不会以孤儿状态残留在 `bookmarks` 中。**`reassignCollection(fromId, toId)`** 是独立的工具方法，将 `bookmarks`（活跃）中属于 `fromId` 的书签批量改写为 `toId`；适用于集合合并等场景，与 trash/archive 生命周期操作不冲突。`mergeFromServer` 中本地待确认墓碑（`seq === 0 && (deletedAt || archivedAt)`）优先于服务端的存活状态（跳过服务端值），解决重登录后集合重新出现的 bug；`sweepUnsynced` 会在下次同步时将 `seq=0` 的墓碑补推给服务器。集合的 `isDefault` 由服务端 pull 响应携带（字段 `sc.is_default`，服务端 CTE 计算：每个 workspace 中 position 最小的活跃集合为 `true`）；`workspace-store.mergeFromServer` 直接读取 `sc.is_default` 写入 state，不再本地修复。离线/首次 hydrate 时若无 `isDefault=true` 的集合，`hydrate()` 用轻量 fallback 将最低 position 活跃集合临时标记为默认，下次 pull 后被服务端确认值覆盖。服务端配额检查条件为 `deleted_at IS NULL AND archived_at IS NULL`。**`mergeFromServer` 对服务端确认删除的集合必须 update+keep（不可从 `collections` 数组移除）**：`getTrashedCollections()` 依赖 `collections.filter(c => !!c.deletedAt)` 找到回收站集合，移除后回收站在同步后失去集合分组，退化为单个书签列表。**`mergeFromServer` collections 的 `sc.is_deleted === 2` 检查是第一个条件**：state=2 记录直接 `idbDelete("collections", sc.id)` 并跳过所有合并逻辑，永不写入本地 state 或 IDB。**恢复回收站书签（`restoreFromTrash`）三级优先**：`restoreFromTrash(bookmarkId, collectionIdOverride?)` 接受可选目标集合 ID；`TrashedBookmarkCard.handleRestore` 按以下顺序解析：① 原 `collectionId` 仍为活跃集合 → 直接使用；② 同名活跃集合存在 → 使用同名集合；③ 回退到 default 集合。此逻辑在 UI 层（`trash-content.tsx`）而非 store 层实现，避免 `bookmarks-store` 反向依赖 `workspace-store`（循环依赖）。
- **groups 两态软删除 + 永久删除同步**：groups 只有 active / trashed 两态，无 archived 状态。`deleteGroup` 写 `deletedAt = Date.now()`，保留 group 在 `groups` 数组（供回收站视图过滤）；`restoreGroup` 清除 `deletedAt`，重置 `seq = 0` 并立即入队同步；**`permanentlyDeleteGroup` 采用异步 push-first 模式**：先乐观移除 UI（从 `groups` / `groupTabs` state 过滤），调用 `syncEngine.forcePush({ groups: [...] })` 直接推送 `is_deleted: 2`（非防抖队列）；push 失败时回滚 UI，push 成功后才执行 `idbDelete("groups", id)` + `idbDelete("group-tabs", tabId)` 清理本地。`mergeFromServer` groups 的 state=2 处理：`permDeletedGroupIds` 在 `set()` 外收集（保持 updater 纯函数），`set()` 内过滤掉 state=2 的 group 和对应 tabs；`set()` 后 `idbDelete("groups", id)` 和 `idbDelete("group-tabs", tabId)`；IDB persist 循环跳过 `permDeletedGroupIds` 中的记录。`TrashContent` 用 `useMemo(() => allGroups.filter(g => !!g.deletedAt && g.workspaceId === activeWorkspaceId), ...)` 派生回收站列表，支持单条 / 批量 Restore + Delete Permanently + Empty Trash。渲染活跃 groups 的所有组件必须用 `!g.deletedAt && g.workspaceId === activeWorkspaceId` 过滤。
- **Workspace 切换与内容过滤**：所有 route-level content 组件必须按 `activeWorkspaceId` 过滤数据。`BookmarksContent` 在 `activeWorkspaceId` 变更时重置 `selectedCollection → "all"`；`FavoritesContent`、`ArchiveContent`、`TrashContent` 的 `useMemo` 均将 `activeWorkspaceId` 纳入依赖，确保切换后自动重新过滤；`ArchiveContent` / `TrashContent` 还通过 `useEffect([activeWorkspaceId])` 清空选中状态。**`groups` 有 `workspaceId: string` 字段**；sidebar、GroupsPanel 按 `!g.deletedAt && g.workspaceId === activeWorkspaceId` 过滤活跃 groups；回收站的 `trashedGroups` 同样按 `activeWorkspaceId` 过滤（工作区隔离）。
- **`collectionId` 规范**：未分类书签用空字符串 `""`，**禁止用字面量 `"all"` 存入书签**——`getFilteredBookmarks` 只识别 `=== ""`，写入 `"all"` 会导致书签永久不可见。DnD 将书签拖到侧边栏"All Bookmarks"时，同 tab-drop 行为一致，解析为 default collection ID（而非 `""`）。
- **前端配额执行**（`store/plan-store.ts`）：`usePlanStore` 从 `GET /api/plan` 获取套餐限额和当前用量，缓存 5 分钟（TTL），落地到 `chrome.storage.local`（key `"tabslate-plan"`）。所有 create 类 store action 开头执行标准三步：`planStore.ensureFresh()` → `checkQuota(resource)` → 若超限则 `showQuotaAlert(resource)` + `return`；成功写入本地后调用 `incrementUsage(resource)`。**永久删除** action 末尾调用 `decrementUsage(resource)`；软删除（trash/archive）不调用 `decrementUsage`——配额以永久删除为界。`guardQuota` 的 `currentCount` 参数现为可选（`number | undefined`）。各资源配额计数方式：workspace = `get().workspaces.length`（`localCount` 传入）；collection = `get().collections.length`（含 active + archived + 软删除，`localCount` 传入）；tag = `get().tags.length`（`localCount` 传入）；**bookmark = `usage.bookmarks`（不传 `localCount`，由 plan-store 维护）**；saved_group = `get().groups.filter(g => !g.deletedAt).length`（`localCount` 传入）。**书签配额规则**：后端 `WHERE is_trashed < 2`（active + trashed 均计入，永久删除才退出配额），与集合的 `is_deleted = 0` 语义一致；前端 `incrementUsage("bookmark")` 在 add 时调用，`decrementUsage("bookmark")` 在 `permanentlyDelete` / `permanentlyDeleteCollectionBookmarks` 时调用；`trashCollectionBookmarks` / `restoreCollectionBookmarks` 不再调用 increment/decrement。**集合配额 decrement 必须在 `permanentlyDeleteCollection` 上，而非 `deleteCollection`**。`addTabToGroup` 在入口处对空 `groupId` 提前返回，防止配额拦截返回空字符串时产生孤儿 IDB 记录。`onPullSuccess` 末尾调用 `usePlanStore.getState().ensureFresh()` 以在每次 pull 后自动刷新用量展示（TTL 内 no-op）。
- **全局 Dialog 触发机制**：对于跨组件调用的对话框（如 `SettingsDialog` 和 `ImportDialog`），使用统一的 DOM 自定义事件（如 `tabslate-open-settings` 和 `tabslate-open-import`）在全局派发。`WorkspaceRail` 作为持久常驻组件，统一注册事件监听器并挂载这些弹窗，实现零耦合的解耦触发。
- **详细架构**：见 [ARCHITECTURE.md](ARCHITECTURE.md)。

