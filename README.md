# 侧栏布局 · dsh-sidebar-layout

[![version](https://img.shields.io/badge/version-0.1.6-blue)](https://github.com/Yu-jianhai/dsh-sidebar-layout/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/DSH-0.2.x-black)](https://github.com/Yu-jianhai)

> DSH 左侧栏插件入口的整理器：可滚动、可拖动排序、可拖动调高、可逐个显隐。
> 把被入口吃掉的高度，还给工作区的会话列表。

*[English](#english) below.*


## 痛点

DSH 的左侧栏入口是**固定高度的一整列**，每个入口一行 36px 加 2px 间距。这列的尺寸不随入口数量收敛，
装一个带侧栏的插件，它就长高一行：

- 装到八个入口（plugins、市场、定时任务、上下文洞察、任务看板、技能库、会话进度…），这一列固定吃掉约 **348px**；
- 侧栏总高有限，多出来的地方只能从下面挤，被挤掉的正是**工作区会话列表**的可视行数；
- 结果就是：入口越装越多，会话列表越露越少，选一个会话要反复滚动，装插件反而降低了日常效率。

宿主提供的唯一缓冲是「更多」菜单里的取消固定（不持久、重启即失效、且 Plugins 永远不能隐藏），
既解决不了高度问题，也没法按自己的习惯排序。

## 解决

把这个入口列表变成一个**有上限、能滚动、顺序可调、逐个可关**的窗口：

- **限高滚动**——入口只占你允许的行数（3 行起，最多到「一行一个入口」），多出来的收进窗口里滚动，
  不再无条件向侧栏要高度；
- **拖动排序**——行尾抓手上下拖，顺序按你的使用频率排，结果持久化；设置页另有 ↑↓ 作为键盘可达兜底；
- **拖动调高**——鼠标移到列表底边出现热区，上下拖即改窗口显示几行，双击恢复不限高；
- **逐个显隐**——设置 → 侧栏布局里勾选，不常用的入口彻底不显示；底栏图标也提供同一套开关；
- **行数上限跟着入口数走**——最多拖到「一行一个入口」，拖不出空白；拖到「全部 N 行」后，每新装一个
  带侧栏入口的插件窗口自动长一行；而你主动设小的上限会被尊重，新入口照旧追加在末尾、留在滚动区外。

省下来的高度全部还给工作区的会话列表——装插件不再等于挤掉工作区。

## 它做了什么

| 能力 | 交互 | 落点 |
| --- | --- | --- |
| 限高滚动 | 鼠标移到入口列表底部 → 出现横向热区，上下拖动 | `nav` 的 `max-height`（行数 3…入口数） |
| 排序 | 行内悬浮出现右侧抓手，按住上下拖 | 每行的 CSS `order`（持久化到 localStorage） |
| 显隐 | 设置 → 侧栏布局 → 逐个勾选，或底栏图标的浮层 | 隐藏的行 `display: none` |
| 紧凑密度 | 设置里「实验性」开关，行高 36→28px | `nav[data-dsl-density="compact"]` |

**不改宿主宽度、不改宿主滚动条**：滚动条样式完全继承宿主（`--dsh-scrollbar-width`，5px），
插件只做横向对齐补偿，让列表滚动条与会话列表那条落在同一竖线上；拖动手柄的尺寸也不动。

**设置页自带兜底**：万一设置页在某个 DSH 版本上渲染失败，页面会画出错误文本与 `__dsl` 排查提示，
而不是留一片空白——故障可诊断，侧栏本身也不受影响。

## 安装

这是一个 **DSH 插件包**（`dsh` 字段声明了客户端入口与 bundle patch），安装方式与其它本地插件一致：
把它放进你的 profile 依赖里，并在 bundles 中登记。

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "dsh-sidebar-layout": "link:/path/to/dsh-sidebar-layout" },
  "dsh": { "profile": { "bundles": [ /* … */ "dsh-sidebar-layout" ] } }
}
```

再让 `node_modules/dsh-sidebar-layout` 指向这个目录（联合/联接均可）。
**DSH 的 hmr 若是关闭的**，装或改之后需要重启 DSH 才生效。

无构建步骤：`lib/client.js` 直接是 `window.__ModuleLoader__.load({…})` 形态的客户端 bundle，无需打包。

装好之后有两个入口能到设置：**设置 → 侧栏布局**（左侧导航里，靠近底部的「侧栏布局」一页），
以及**侧栏底部那枚三条横线的图标**（浮层里是同一套开关）。

## 设计边界

- **叠加层，不替换 `sidebar` 单例槽**（该槽 `replaceRisk: shadows-shipped-ui`，替换等于重画整根侧栏，随上游易碎）。
- 定位靠自己的底栏按钮 `[data-dsl-anchor="1"]` 往上找 `nav`，不依赖 hash 化的 CSS 类名，也不猜中文文案。
- 找不到侧栏就**静默降级**：只注入样式与注册按钮，最坏情况等于没装，不影响侧栏本身。
- 与官方「更多」菜单里的 pin 状态**不同步**（宿主没有暴露该状态），所以两处的「隐藏」是两套。

## 调试

控制台有把手 `window.__dsl`：

- `__dsl.state()` — 当前偏好
- `__dsl.mapping()` — 入口 id 与实际渲染行的对应
- `__dsl.nav()` — 找到的那根 `nav`
- `__dsl.align()` — 滚动条横向对齐的实测值 `{ margin, navRight, peerRight, peerWidth }`
- `__dsl.caps()` — 行数上限的派生值 `{ entries, limit, floor, stored, effective }`
- `__dsl.refresh()` — 立即重跑一遍
- `__dsl.reset()` — 清空偏好

偏好存在 localStorage 的 `dsh-sidebar-layout:v1`：`{ v, order: string[], hidden: string[], maxRows: number|null, density: 'comfortable'|'compact' }`。

## 自检

```bash
node --check lib/client.js
node test/boot-smoke.mjs   # 最小 DOM 桩：注册 / 找 nav / 落偏好 / 设置页能渲染 / 卸载还原
```

## 卸载

从 `bundles` 与 `dependencies` 里删掉名字、删掉目录联接，重启。插件在卸载时会自己清掉注入的 `<style>`、
所有行内联样式与浮层节点。

## English

**dsh-sidebar-layout** turns the DSH left sidebar's plugin-entry column into a bounded, scrollable,
reorderable, individually hideable window — and gives the reclaimed height back to the workspace
session list.

### The problem

The left sidebar's entry column has a fixed row height (36px + 2px gap per entry). Every plugin that
contributes a sidebar entry makes the column one row taller. With eight entries the column reserves
about 348px of permanent vertical space; since the sidebar's total height is finite, that space is
taken from the session list below it. The host's only relief valve is the "More" menu's unpin action,
which is not persisted, resets on reload, and can never hide the built-in Plugins entry.

### What it does

- **Bounded scrolling** — the entry list takes only the rows you allow (3 at minimum, up to one row per
  entry); the rest scrolls inside the window instead of expanding the column.
- **Drag to reorder** — grab the handle that appears at a row's trailing edge; the order is persisted.
  The settings page also offers ↑ / ↓ for keyboard users.
- **Drag to resize** — hover the bottom edge of the list to reveal a resize zone; drag to change the
  visible row count, double-click to restore "unlimited".
- **Show / hide per entry** — Settings → 侧栏布局, or the sidebar-footer button; hidden entries are
  removed from view while keeping their position.
- **The row cap follows the entry count** — you can never drag out empty space; once the window shows
  "all N rows", installing another sidebar plugin grows it by one row. A cap you set smaller yourself is
  respected: new entries are appended at the end and stay outside the scroll window.
- **Compact density (experimental)** — 36px → 28px rows.

### Install

This is a DSH plugin package (`dsh.client` + `dsh.bundle.patch`). Add it to your profile's
`dependencies` (a `link:` spec works), list it in `dsh.profile.bundles`, point
`node_modules/dsh-sidebar-layout` at this directory, then restart DSH if HMR is disabled.
There is no build step: `lib/client.js` is a ready-to-load `window.__ModuleLoader__.load({…})` bundle.

Two ways into the settings: **Settings → 侧栏布局** (a page in the settings nav), and the
three-bar icon at the bottom of the sidebar (same toggles in a popover).

### Design boundaries

- An **additive overlay**: the `sidebar` single slot (`replaceRisk: shadows-shipped-ui`) is never replaced.
- The list is located by walking up from this plugin's own footer button — no hashed CSS classes, no
  localized-label matching.
- If the sidebar cannot be located, the plugin degrades silently: worst case it behaves as if uninstalled.
- The host's "More"-menu pin state is **not** mirrored (the host exposes no API for it).

### Debug

`window.__dsl.state() / mapping() / nav() / align() / caps() / refresh() / reset()`.

Preferences live in `localStorage['dsh-sidebar-layout:v1']`.

### Self-check

```bash
node --check lib/client.js
node test/boot-smoke.mjs
```

## License

MIT © 2026 Ne_Rn
