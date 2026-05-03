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
- **InputOTP** (`components/ui/input-otp.tsx`) — 6 格 OTP 输入框（基于 `input-otp` 包），用于邮箱验证和密码重置
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
| `tabslate-workspace` | Zustand JSON `{state: {...}}` | 工作区、集合、标签、localSeq |
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

- **不要在 newtab 页以外使用 store**：popup 和 background 不加载 Zustand；保存书签时优先通过 `chrome.tabs.sendMessage` 发 `{ type: "ADD_BOOKMARK", data }` 消息到 newtab（newtab 在 `App` 的 `useEffect` 中监听），newtab 不存在时回退到直接写 `chrome.storage.local`（`seq: 0`，下次 newtab 打开时由 `sweepUnsynced` 补推）
- **Tab 变更广播**：background.ts 监听所有 tab/group 事件，写 `tabslate-tabs-changed` 信号；newtab 的 `TabsPanel` 和 `GroupsPanel` 监听此信号触发 `loadTabs()`
- **Store hydration**：`App.tsx` 中的 `StoreGate` 组件等待 `bookmarksHydrated && workspaceHydrated && authHydrated` 后才渲染，避免闪烁
- **AuthGate**（`entrypoints/newtab/App.tsx`）：三层守卫：① `accessToken` 为 null → 渲染 `AuthPage`（登录/注册/找回密码）；② `accessToken` 存在但 `user.is_verified === false` → 渲染 `VerifyEmailScreen`（OTP 输入）；③ 两者均通过 → 渲染 dashboard。验证成功后 store 调用 `GET /auth/me` 更新 `is_verified`，`AuthGate` 自动重渲染。`VerifyEmailScreen` 挂载时自动调一次 `POST /auth/resend-verification`：若 OTP 仍在冷却期则收到 `429`，从响应的 `retry_after` 字段直接启动倒计时；否则发送新 OTP 并开始 60s 倒计时。
- **API 客户端**：`lib/api.ts` 是纯函数 HTTP 客户端，不持有状态；server URL 由 `useAuthStore.serverUrl` 管理（默认读取 `VITE_API_URL` 环境变量）。自托管用户可在登录页"Advanced"中修改。
- **Prosopo 验证码**：`components/procaptcha.tsx` 是 iframe 包装组件（Chrome MV3 `script-src 'self'` CSP 限制，无法直接加载外部 JS）。扩展通过 `<iframe>` 嵌入后端的 `GET /captcha/widget` 页面，由服务端加载 Prosopo bundle，验证完成后通过 `postMessage` 传回 token。`VITE_PROSOPO_SITE_KEY` 为空时不渲染验证码。注册页在同 IP 注册数达到 `REGISTER_CAPTCHA_THRESHOLD` 后条件展示（`GET /auth/register-captcha-status`，进入注册模式时查询）；登录页在同邮箱失败次数达到阈值后条件展示（`GET /auth/login-captcha-status`，邮箱 blur 时查询）；OTP 重发页在同 IP 请求次数达到 `OTP_CAPTCHA_THRESHOLD` 后展示（`GET /auth/otp-captcha-status`）。
- **邮箱验证**：使用 6 位数字 OTP，不再发送链接。注册后若 `user.is_verified === false`，`AuthGate` 拦截并显示 `VerifyEmailScreen`，用户输入 OTP 后调用 `POST /auth/verify-email { email, code }`，成功后通过 `GET /auth/me` 确认验证状态。
- **找回密码**：`LoginForm` 新增 `forgot-password` 和 `reset-password` 两个 mode，通过 `POST /auth/forgot-password` 发送 OTP，再通过 `POST /auth/reset-password` 重置密码。
- **密码强度**：前端 `minLength={10}` + 提示文案"At least 10 characters, including a letter and a number"，与后端 `validatePasswordStrength` 规则对齐。
- **Compact group title**：Chrome tab group 标题若为紧凑模式，Chrome 端存单字母；完整标题存于 `tabslate-full-titles`，`fullTitles[groupId]` 取用
- **SyncEngine 生命周期**：`SyncProvider`（`App.tsx`）在 `[accessToken, serverUrl]` 变更时销毁旧引擎并创建新引擎；cleanup 函数先 `engine.forceSync()` 再 `destroySyncEngine()`，确保登出前推送最后变更。不要在组件中直接 `import syncEngine`——通过 `SyncProvider` render props 的 `onForceSync` 触发手动同步。
- **syncEngine?.enqueue() 调用位置**：必须在 Zustand `set()` 调用之前（或完全在外部），不能在 `set((state) => {...})` updater 函数内部调用（updater 必须是纯函数）。
- **localSeq 持久化**：`localSeq` 已合入 `"tabslate-workspace"` Zustand persist state，随工作区数据一同加载，无独立 storage key。`App.tsx` 的 `onPullSuccess` 回调是唯一更新 `localSeq` 的地方；非首次 pull（`needsInitialPush === false`）时还会调用 `sweepUnsynced()` 将所有 `seq === 0` 的实体补推到服务器。
- **软删除**：服务端所有实体删除为软删除（`deleted_at` 字段），Pull 响应包含墓碑；`mergeFromServer` 负责将 `deletedAt != null` 的实体从本地对应数组中移除。
- **详细架构**：见 [ARCHITECTURE.md](ARCHITECTURE.md)。
