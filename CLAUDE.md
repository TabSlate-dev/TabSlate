# CLAUDE.md

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

### 共享组件

- **FaviconImage** (`components/ui/favicon-image.tsx`) — 所有 favicon 显示都用此组件，禁止裸 `<img onError>`
- **ColorPicker** (`components/ui/color-picker.tsx`) — Tab group 颜色选择器，支持 `size="sm" | "md"`
- **shadcn/ui** (`components/ui/`) — Button、Input、Dialog 等基础组件

### Chrome Storage Key 布局

| Key | 格式 | 用途 |
|---|---|---|
| `tabslate-bookmarks` | Zustand JSON `{state: {...}}` | 书签、归档、回收站 |
| `tabslate-workspace` | Zustand JSON `{state: {...}}` | 工作区、集合、标签 |
| `tabslate-groups` | Zustand JSON `{state: {...}}` | 保存的标签组 |
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
- **Store hydration**：`App.tsx` 中的 `StoreGate` 组件等待 `bookmarksHydrated && workspaceHydrated` 后才渲染，避免闪烁
- **Compact group title**：Chrome tab group 标题若为紧凑模式，Chrome 端存单字母；完整标题存于 `tabslate-full-titles`，`fullTitles[groupId]` 取用
