# CLAUDE.md

## 仓库关系

TabSlate 由三个仓库组成：

| 仓库 | 可见性 | 职责 |
|---|---|---|
| **`TabSlate`**（本仓库） | 公开，AGPL | Chrome 扩展前端，TypeScript + React + WXT |
| **`TabSlate-server`** | 公开，AGPL | Go 后端 OSS 版，可自托管，计费基于本地 License JWT |
| **`TabSlate-cloud`** | 私有 | Go 后端 Cloud 版，以 `TabSlate-server` 为 Go module 依赖，注入 Lago 计费 |

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
- **shadcn/ui** (`components/ui/`) — Button、Input、Dialog 等基础组件

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

### Chrome Storage Key 布局

| Key | 格式 | 用途 |
|---|---|---|
| `tabslate-bookmarks` | Zustand JSON `{state: {...}}` | 书签、归档、回收站 |
| `tabslate-workspace` | Zustand JSON `{state: {...}}` | 工作区、集合、标签 |
| `tabslate-groups` | Zustand JSON `{state: {...}}` | 保存的标签组 |
| `tabslate-auth` | Zustand JSON `{state: {...}}` | 用户认证（user、accessToken、refreshToken、serverUrl） |
| `tabslate-full-titles` | `Record<number, string>` | Chrome tab group 完整标题 |
| `tabslate-tabs-changed` | `number` (timestamp) | background → newtab 变更信号 |

### Highlight Timer 模式

两个 store 中都有 highlight 功能，使用模块级 timer 变量避免重叠：
```ts
let _tabHighlightTimer: ReturnType<typeof setTimeout> | null = null;
// 每次调用先 clearTimeout 旧计时器
```

### React 19 Form Actions

Dialog 中的表单提交使用 React 19 的 `form action` 模式（而非 `onSubmit`）：
```tsx
<form action={(formData) => {
  const name = formData.get("name") as string;
  // 处理提交
}}>
```

### 文件拆分原则

大型组件按功能拆分为子目录，通过 `index.tsx` 导出主组件：
- `components/dashboard/sidebar/` — `BookmarksSidebar`
- `components/dashboard/tabs-panel/` — `TabsPanel`
- `components/dashboard/groups-panel/` — `GroupsPanel`

导入路径不变：`import { BookmarksSidebar } from "@/components/dashboard/sidebar"`

## 路径别名

`@/` → 项目根目录（由 WXT 配置，等同于 TypeScript `paths` 中的 `@/*`）

## Code Quality

- Type check: `bun run compile`
- Verify build: `bun run build`
- No linter or pre-commit hooks configured yet.

## 注意事项

- **不要在 newtab 页以外使用 store**：popup 和 background 直接读写 `chrome.storage.local`，不加载 Zustand
- **Tab 变更广播**：background.ts 监听所有 tab/group 事件，写 `tabslate-tabs-changed` 信号；newtab 的 `TabsPanel` 和 `GroupsPanel` 监听此信号触发 `loadTabs()`
- **Store hydration**：`App.tsx` 中的 `StoreGate` 组件等待 `bookmarksHydrated && workspaceHydrated && authHydrated` 后才渲染，避免闪烁
- **AuthGate**：`StoreGate` 内部的 `AuthGate` 组件检查 `useAuthStore.accessToken`；为 null 时渲染 `AuthPage`（登录/注册），否则渲染 dashboard。登录后状态变更会自动触发 `AuthGate` 重渲染切换到 dashboard。
- **API 客户端**：`lib/api.ts` 是纯函数 HTTP 客户端，不持有状态；server URL 由 `useAuthStore.serverUrl` 管理（默认读取 `VITE_API_URL` 环境变量）。自托管用户可在登录页"Advanced"中修改。
- **Compact group title**：Chrome tab group 标题若为紧凑模式，Chrome 端存单字母；完整标题存于 `tabslate-full-titles`，`fullTitles[groupId]` 取用
