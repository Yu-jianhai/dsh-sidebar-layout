/**
 * dsh-sidebar-layout —— 侧栏布局（客户端半边）
 *
 * 把 DSH 左侧栏的「入口列表」当成一个可以收拾的窗口：
 *   1. 高度可拖：底边一条隐形热区，上下拖改上限；双击恢复「不限」；
 *   2. 顺序可拖：行右侧浮现抓手，按住直接拖动重排（点行主体仍是原来的切换面板行为）；
 *   3. 逐项显隐：设置页里逐个开关，隐藏即彻底不显示，位次保留、随时可开回来；
 *   4. 紧凑密度（实验性）：行高 36 → 28px。
 *
 * 为什么是「叠加层」而不是「重写侧栏」
 * ------------------------------------
 * 官方 `sidebar` 槽是单例、`replaceRisk: shadows-shipped-ui`：替换它要重写整块
 * 品牌行 / 新会话 / 折叠 / 标题栏适配，跟着版本碎。而入口列表本身是普通的
 * `<nav>` 里一排 `<button>`，每个行组件也没有 `style` prop —— 所以 CSS `order`、
 * `display`、`max-height` 这套「只加属性」的做法不被 React 覆盖，也随时能整块撤掉。
 *
 * 零偏好时本插件只做三件事：注入一个样式块、找到 nav、打上 `data-dsl="1"`。
 * 找不到 nav 就什么都不做（不抛错、不改任何节点），最坏情况等于没装。
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-layout',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const VERSION = '0.1.5'
    const PACKAGE_ID = 'dsh-sidebar-layout'
    const STORE_KEY = 'dsh-sidebar-layout:v1'
    const DEBUG_KEY = 'dsh-sidebar-layout:debug'
    const STYLE_ATTR = 'data-plugin-css'

    const PANEL_SLOT = 'sidebar.panellist'
    const FOOTER_SLOT = 'sidebar.footer.action'
    const SETTINGS_SLOT = 'settings.section'
    const SETTINGS_ID = 'sidebar-layout'
    const FOOTER_ID = 'sidebar-layout-footer'
    const FOOTER_LABEL = '侧栏布局'
    const SETTINGS_LABEL = '侧栏布局'

    const MIN_ROWS = 3
    // 只是存储层的绝对卫生边界，不是用户能拖到的上限：
    // 真实上限是「当前可见入口数」（见 rowLimit）。入口数本身由插件/槽注册决定，
    // 所以把窗口拖到比入口还高、露出空白是无意义的。
    const MAX_ROWS = 60
    /** 「更多」行永远压在最后，不参与排序。 */
    const MORE_ORDER = 10000
    const ANCHOR = 'data-dsl-anchor'
    const TICK_MS = 800

    // #region debug + state
    // ---------------------------------------------------------------------
    // 偏好只落一个 localStorage 键；任何字段坏掉都退回默认值，绝不整体崩。
    // ---------------------------------------------------------------------
    const debugOn = () => {
      try {
        return localStorage.getItem(DEBUG_KEY) === '1'
      } catch {
        return false
      }
    }
    const log = (...args) => {
      if (debugOn()) console.log('[sidebar-layout]', ...args)
    }
    const warn = (...args) => console.warn('[sidebar-layout]', ...args)

    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
    const defaults = () => ({ v: 1, order: [], hidden: [], maxRows: null, density: 'comfortable' })

    function sanitize(raw) {
      const out = defaults()
      if (!raw || typeof raw !== 'object') return out
      if (Array.isArray(raw.order)) out.order = raw.order.filter((x) => typeof x === 'string' && x)
      if (Array.isArray(raw.hidden)) out.hidden = raw.hidden.filter((x) => typeof x === 'string' && x)
      if (raw.maxRows === null || raw.maxRows === undefined) out.maxRows = null
      else {
        const n = Math.round(Number(raw.maxRows))
        // 下限是 1：入口总数可能少于 MIN_ROWS（装得少的时候不该被抬高）
        out.maxRows = Number.isFinite(n) ? clamp(n, 1, MAX_ROWS) : null
      }
      out.density = raw.density === 'compact' ? 'compact' : 'comfortable'
      return out
    }

    function loadState() {
      try {
        return sanitize(JSON.parse(localStorage.getItem(STORE_KEY) || 'null'))
      } catch {
        return defaults()
      }
    }

    let state = loadState()
    const listeners = new Set()

    function subscribeStore(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
    function notify() {
      for (const fn of [...listeners]) {
        try {
          fn()
        } catch (error) {
          warn('listener failed', error)
        }
      }
    }
    function persist(next) {
      state = sanitize(next)
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state))
      } catch {
        /* 隐私模式 / 配额满：本次会话继续用内存态 */
      }
      notify()
      applyAll('persist')
    }
    // #endregion

    // #region runtime
    const rt = {
      ctx: null,
      nav: null,
      panels: [],
      rows: [],
      previewOrder: null,
      gripRow: null,
      styleEl: null,
      grip: null,
      hot: null,
      capLabel: null,
      hint: null,
      popHost: null,
      tickTimer: 0,
      raf: 0,
      dragging: null,
      resizing: null,
      capBasis: null,
      hideTimer: 0,
      observers: [],
      disposers: [],
      signature: '',
      warned: false,
    }

    function resolveLabel(entry) {
      const options = (entry && entry.options) || {}
      const raw = options.label
      let label
      try {
        label = typeof raw === 'function' ? raw() : raw
      } catch {
        label = null
      }
      if (label === null || label === undefined || label === '') return String(options.id || '')
      return String(label)
    }

    /** 只读取，不注册：拿到「谁在这个列表里」的当前快照。 */
    function readPanels() {
      const slots = rt.ctx && rt.ctx.slots
      if (!slots) return []
      let entries = []
      try {
        if (typeof slots.entriesOfSlot === 'function') entries = slots.entriesOfSlot(PANEL_SLOT)
        else if (typeof slots.entries === 'function') entries = slots.entries(PANEL_SLOT)
      } catch (error) {
        log('entriesOfSlot failed', error)
        return []
      }
      const seen = new Set()
      const out = []
      for (const entry of entries || []) {
        const options = (entry && entry.options) || {}
        const id = options.id
        if (typeof id !== 'string' || !id || seen.has(id)) continue
        seen.add(id)
        out.push({ id, order: typeof options.order === 'number' ? options.order : 0, label: resolveLabel(entry) })
      }
      // 与侧栏同款：按 order 升序，稳定排序保留注册顺序
      out.sort((a, b) => a.order - b.order)
      return out
    }

    /** 存量顺序 + 新出现的入口（追加到末尾，等用户自己挪）。 */
    function mergedOrder(panels, saved) {
      const ids = panels.map((p) => p.id)
      const out = []
      for (const id of saved) {
        if (ids.includes(id) && !out.includes(id)) out.push(id)
      }
      for (const id of ids) {
        if (!out.includes(id)) out.push(id)
      }
      return out
    }

    const isMoreRow = (el) => el.hasAttribute('aria-haspopup') || el.getAttribute('role') === 'menu'

    function panelRows(nav) {
      return Array.from(nav.children).filter((el) => el.tagName === 'BUTTON' && !isMoreRow(el))
    }

    /**
     * DOM 行 → 面板 id。
     *
     * 首选按 `aria-label` 对齐标签；对不上的行按剩余 id 的就位顺序兜底。
     * 之所以不按索引硬对位：官方「更多」菜单里的取消固定会让某一行整行消失，
     * 索引会整体错位，标签对位至少能保住大部分行。
     */
    function mapRows(nav, panels) {
      const rows = panelRows(nav)
      const byLabel = new Map()
      for (const panel of panels) {
        if (panel.label && !byLabel.has(panel.label)) byLabel.set(panel.label, panel.id)
      }
      const used = new Set()
      const mapped = []
      for (const el of rows) {
        let id = byLabel.get(el.getAttribute('aria-label') || '')
        if (!id || used.has(id)) id = undefined
        mapped.push({ el, id })
        if (id) used.add(id)
      }
      const rest = panels.map((p) => p.id).filter((id) => !used.has(id))
      let cursor = 0
      for (const row of mapped) {
        if (row.id) continue
        while (cursor < rest.length && used.has(rest[cursor])) cursor += 1
        if (cursor >= rest.length) break
        row.id = rest[cursor]
        used.add(row.id)
      }
      return mapped.filter((row) => row.id)
    }

    function rowMetrics(nav) {
      const wide = nav.dataset.dslWide === '1'
      const compact = nav.dataset.dslDensity === 'compact'
      const rowH = wide && compact ? 28 : 36
      const gap = wide ? 2 : 12
      return { rowH, gap, step: rowH + gap }
    }

    function capPx(rows) {
      const nav = rt.nav
      const m = nav ? rowMetrics(nav) : { rowH: 36, gap: 2 }
      return rows * m.rowH + (rows - 1) * m.gap + 2
    }

    // #region 行数上限：跟着入口数走
    function visibleEntryIds(panels, hidden) {
      return panels.filter((panel) => !hidden.includes(panel.id)).map((panel) => panel.id)
    }

    /** 窗口最多长到「一行一个入口」；再高就是空白，没有意义。 */
    function rowLimit(ids) {
      return Math.max(1, ids.length)
    }

    /** 入口够多时才守住 MIN_ROWS，装得少（比如只有 2 个）就按入口数来。 */
    function rowFloor(ids) {
      return Math.min(MIN_ROWS, rowLimit(ids))
    }

    /** 当前生效的显示行数；null = 不限（入口全显示、不裁剪）。 */
    function effectiveRows(ids) {
      if (state.maxRows == null) return null
      return clamp(state.maxRows, rowFloor(ids), rowLimit(ids))
    }

    /**
     * 「拖到底」时窗口等于全部入口；此后每新增一个入口，窗口跟着长高一行——
     * 否则窗口刚好卡住，新入口被挤到折叠线以下，看着像「插件没生效」。
     * 反过来，用户既然主动把窗口拖得比入口数小，就尊重这个选择：
     * 新入口照旧排在末尾，留在滚动区外，不偷偷改他的行数。
     */
    function reconcileRowCap(ids) {
      const count = rowLimit(ids)
      const prev = rt.capBasis
      rt.capBasis = count
      if (state.maxRows == null || prev == null) return
      if (count <= prev) return
      if (state.maxRows < prev) return
      state = sanitize({ ...state, maxRows: count })
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state))
      } catch {
        /* 隐私模式：本地存不下，本次会话照样生效 */
      }
      notify()
      log('cap-grow', { prev, count })
    }
    // #endregion

    function buildOrderFromVisible(base, visibleIds) {
      const out = []
      let cursor = 0
      for (const id of base) {
        if (visibleIds.includes(id)) {
          out.push(visibleIds[cursor])
          cursor += 1
        } else {
          out.push(id)
        }
      }
      for (const id of visibleIds) {
        if (!out.includes(id)) out.push(id)
      }
      return out
    }

    /**
     * 把 `id` 挪到「在它上面的其它可见行有 aboveCount 个」这个位次。
     *
     * 位次必须在**当前生效顺序**这个坐标系里算，不能按 DOM 顺序：CSS `order`
     * 只改渲染次序、不改 `nav.children`，DOM 索引与用户眼里的位置是两套坐标。
     * 之前 `from` 取 DOM 索引、`target` 取视觉中线，两个坐标系混用，拖第二个
     * 入口时会把第一个拖好的结果覆盖掉（表现为「刚拖好的那个跳回去了」）。
     */
    function reorderVisible(visibleIds, id, aboveCount) {
      const rest = visibleIds.filter((item) => item !== id)
      const at = clamp(aboveCount, 0, rest.length)
      rest.splice(at, 0, id)
      return rest
    }

    // #region 滚动条横向对齐
    /** 找会话区那个滚动容器当参照：nav 之后兄弟子树里、与列表同列、overflowY 可滚的那个。 */
    function findPeerScroller(nav) {
      const host = nav.parentElement
      if (!host || !host.children) return null
      const kids = Array.from(host.children)
      const navRect = nav.getBoundingClientRect()
      const found = []
      const consider = (el) => {
        if (!el || el === nav || !el.getBoundingClientRect) return
        if (nav.contains(el)) return
        let cs = null
        try {
          cs = window.getComputedStyle ? window.getComputedStyle(el) : null
        } catch {
          cs = null
        }
        if (!cs) return
        const oy = cs.overflowY
        if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return
        const rect = el.getBoundingClientRect()
        if (rect.width < 60 || rect.height < 40) return
        // 同一列：宽度与列表相差不超过 60px，否则是别的区域
        if (Math.abs(rect.width - navRect.width) > 60) return
        found.push({ el, rect })
      }
      for (let i = kids.indexOf(nav) + 1; i < kids.length; i += 1) {
        consider(kids[i])
        if (kids[i].querySelectorAll) {
          for (const el of kids[i].querySelectorAll('*')) consider(el)
        }
      }
      if (found.length === 0) return null
      // 先看宽度谁最接近列表（同一条列），再取更高的那个
      found.sort((a, b) => {
        const dw = Math.abs(a.rect.width - navRect.width) - Math.abs(b.rect.width - navRect.width)
        return Math.abs(dw) > 0.5 ? dw : b.rect.height - a.rect.height
      })
      return found[0].el
    }

    /** 右沿偏右 delta 像素时 margin-right 要加 delta（更负 = 右沿右移），夹在 [-48, 0]。 */
    function alignMargin(margin, delta) {
      return Math.max(-48, Math.min(0, margin + delta))
    }

    /** 移除内联样式：真实 DOM 走 removeProperty，测试桩里降级成 delete。 */
    function clearStyle(el, prop) {
      if (!el || !el.style) return
      if (typeof el.style.removeProperty === 'function') el.style.removeProperty(prop)
      else delete el.style[prop]
    }

    /**
     * 让 nav 的滚动条与会话区滚动条落在同一条竖线上。
     * 不靠猜：量出 nav 右沿与参照容器右沿的差值，就地修正 margin-right，
     * padding-right 取相反数保证行宽不变。tick 里反复调用会自行收敛。
     */
    function syncScrollbarAlign() {
      const nav = rt.nav
      if (!nav) return
      if (nav.dataset.dslCap !== '1') {
        clearStyle(nav, 'margin-right')
        clearStyle(nav, 'padding-right')
        return
      }
      let cs = null
      try {
        cs = window.getComputedStyle ? window.getComputedStyle(nav) : null
      } catch {
        cs = null
      }
      let margin = cs ? parseFloat(cs.marginRight) : NaN
      if (!Number.isFinite(margin)) margin = -12
      const scroller = findPeerScroller(nav)
      if (!scroller) {
        // 没有参照（会话列表此刻不滚动）：退回宿主内边距里的自然位置，
        // 宁可保守地留 12px，也不要怼到栏边去
        nav.style.marginRight = '0px'
        nav.style.paddingRight = '0px'
        return
      }
      const delta = nav.getBoundingClientRect().right - scroller.getBoundingClientRect().right
      const next = alignMargin(margin, delta)
      if (Math.abs(next - margin) < 0.5) return
      nav.style.marginRight = `${next}px`
      nav.style.paddingRight = `${-next}px`
      log('align', 'scrollbar', next, delta)
    }
    // #endregion

    /** 把所有偏好写进 DOM。幂等：同状态重复调用不会产生副作用。 */
    function applyAll(reason) {
      const nav = rt.nav
      if (!nav) return
      if (!nav.isConnected) {
        teardownNav()
        return
      }
      const panels = readPanels()
      const baseOrder = rt.previewOrder || mergedOrder(panels, state.order)
      const rows = mapRows(nav, panels)
      rt.panels = panels
      rt.rows = rows

      const wide = nav.getBoundingClientRect().width > 100
      nav.dataset.dsl = '1'
      nav.dataset.dslWide = wide ? '1' : '0'
      nav.dataset.dslDensity = wide && state.density === 'compact' ? 'compact' : 'comfortable'

      for (const row of rows) {
        const position = baseOrder.indexOf(row.id)
        row.el.style.order = position >= 0 ? String(position) : ''
        row.el.style.display = state.hidden.includes(row.id) ? 'none' : ''
        row.el.dataset.dslId = row.id
      }
      for (const el of Array.from(nav.children)) {
        if (el.tagName === 'BUTTON' && isMoreRow(el)) el.style.order = String(MORE_ORDER)
      }

      const entryIds = visibleEntryIds(panels, state.hidden)
      reconcileRowCap(entryIds)
      const rowsCap = effectiveRows(entryIds)
      if (rowsCap != null && rowsCap < entryIds.length) {
        nav.dataset.dslCap = '1'
        nav.style.maxHeight = `${capPx(rowsCap)}px`
      } else {
        // 行数 >= 入口数：不裁剪，也就没必要留滚动条槽
        delete nav.dataset.dslCap
        nav.style.maxHeight = ''
      }

      syncScrollbarAlign()
      syncHotZone()
      syncHint()
      log('apply', reason, rows.map((row) => row.id))
    }

    function rowSignature(nav) {
      try {
        return panelRows(nav)
          .map((el) => `${el.getAttribute('aria-label') || ''}@${el.getBoundingClientRect().height}`)
          .join('|')
      } catch {
        return ''
      }
    }

    // #region 侧栏定位
    // 我们的底栏按钮是稳定锚点：从它往上找那个「既含 nav 又是侧栏根」的容器。
    // 不用 hash 化类名（每次构建都变），也不假设 locale 文案（aria-label 会变）。
    function locateNav(anchor) {
      let node = anchor
      for (let depth = 0; depth < 8 && node; depth += 1) {
        node = node.parentElement
        if (!node) return null
        const nav = node.querySelector('nav')
        if (nav && nav.querySelector('button')) return nav
      }
      return null
    }

    function attach() {
      if (rt.nav && rt.nav.isConnected) return true
      const anchor = document.querySelector(`[${ANCHOR}="1"]`)
      if (!anchor) return false
      const nav = locateNav(anchor)
      if (!nav) {
        if (!rt.warned) {
          rt.warned = true
          warn('未找到侧栏入口列表：当前 DSH 版本可能不兼容，增强已停用（侧栏本身不受影响）')
        }
        return false
      }
      rt.nav = nav
      installStyle()
      ensureFloating()
      if (nav.dataset.dslBound !== '1') {
        nav.dataset.dslBound = '1'
        nav.addEventListener('pointermove', onNavPointerMove, { passive: true })
        nav.addEventListener('pointerleave', scheduleHideGrip)
        nav.addEventListener('scroll', () => syncHotZone(), { passive: true })
      }
      try {
        if (rt.navObserver) rt.navObserver.disconnect()
        rt.navObserver = new ResizeObserver(() => syncHotZone())
        rt.navObserver.observe(nav)
      } catch {
        /* ResizeObserver 缺失时只是热区位置不跟手 */
      }
      applyAll('attach')
      return true
    }
    // #endregion

    // #region 样式
    const CSS = `
nav[data-dsl="1"]{position:relative}
/* 竖向滚动条：外壳与位置都交给宿主的全局 scrollbar.css，不自己画，
   否则粗细/配色/圆角会跟会话列表那个不一致。
   - 全局滚动条宽度是 --dsh-scrollbar-width（默认 5px）；
   - 位置：侧栏根节点有 --dsh-sidebar-inline-padding（12px）内边距，
     会话区（regionArea）用 margin-right:-12px 让步给滚动条贴到栏边，
     这里照做，再用等量的 padding-right 把内容宽度补回来，行宽不变。 */
nav[data-dsl="1"][data-dsl-cap="1"]{overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;overscroll-behavior:contain;margin-right:calc(-1*var(--dsh-sidebar-inline-padding,12px));padding-right:var(--dsh-sidebar-inline-padding,12px)}
nav[data-dsl="1"][data-dsl-density="compact"]>button{min-height:28px;padding:4px 8px}
nav[data-dsl="1"]>button[data-dsl-dragging="1"]{opacity:.45}
[data-dsl-grip],[data-dsl-hot],[data-dsl-cap-label]{position:fixed;z-index:2147483000;box-sizing:border-box}
[data-dsl-grip]{display:none;align-items:center;justify-content:center;width:20px;height:24px;border-radius:6px;cursor:grab;color:var(--dsh-fg-muted,rgba(150,150,150,1));touch-action:none}
[data-dsl-grip]:hover{background:rgba(127,127,127,.18)}
[data-dsl-grip][data-on="1"]{display:flex}
[data-dsl-grip][data-drag="1"]{cursor:grabbing}
[data-dsl-hot]{height:8px;cursor:row-resize;background:transparent;touch-action:none;display:none}
[data-dsl-hot]::after{content:"";position:absolute;left:0;right:0;top:3px;height:2px;border-radius:2px;background:transparent;transition:background .15s}
[data-dsl-hot]:hover::after,[data-dsl-hot][data-on="1"]::after{background:var(--dsh-accent,rgba(90,160,255,.9))}
[data-dsl-cap-label]{display:none;pointer-events:none;padding:1px 8px;border-radius:999px;font:12px/18px system-ui,sans-serif;background:rgba(20,20,20,.88);color:#fff}
[data-dsl-cap-label][data-on="1"]{display:block}
[data-dsl-hint]{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;box-sizing:border-box;font:12px/1.2 system-ui,sans-serif;border-radius:8px;cursor:pointer;background:rgba(127,127,127,.16)}
[data-dsl-hint]:hover{background:rgba(127,127,127,.26)}
[data-dsl-pop]{position:fixed;z-index:2147483100;width:280px;max-height:72vh;overflow:auto;box-sizing:border-box;padding:10px;border-radius:12px;font:12px/1.5 system-ui,sans-serif;color:var(--dsh-fg,#e6e6e6);background:var(--dsh-bg-elevated,#1e1f22);border:1px solid rgba(127,127,127,.28);box-shadow:0 12px 32px rgba(0,0,0,.38)}
[data-dsl-pop] h4{margin:0 0 8px;font-size:13px;font-weight:600}
[data-dsl-pop] .dsl-row{display:flex;align-items:center;gap:8px;padding:3px 2px;cursor:pointer;border-radius:6px}
[data-dsl-pop] .dsl-row:hover{background:rgba(127,127,127,.12)}
[data-dsl-pop] .dsl-row span.dsl-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-dsl-pop] .dsl-sep{height:1px;margin:8px 0;background:rgba(127,127,127,.24)}
[data-dsl-pop] button{font:inherit;color:inherit;background:rgba(127,127,127,.16);border:0;border-radius:6px;padding:3px 9px;cursor:pointer}
[data-dsl-pop] button:hover{background:rgba(127,127,127,.3)}
[data-dsl-pop] input[type=range]{accent-color:var(--dsh-accent,#5aa0ff)}
`

    function installStyle() {
      if (rt.styleEl && rt.styleEl.isConnected) return
      const el = document.createElement('style')
      el.setAttribute(STYLE_ATTR, PACKAGE_ID)
      el.textContent = CSS
      document.head.appendChild(el)
      rt.styleEl = el
    }
    // #endregion

    // #region 抓手 / 热区 / 提示
    function ensureFloating() {
      if (!rt.grip) {
        const grip = document.createElement('div')
        grip.setAttribute('data-dsl-grip', '1')
        grip.setAttribute('role', 'button')
        grip.setAttribute('aria-label', '拖动调整入口顺序')
        grip.setAttribute('title', '按住拖动可调整顺序')
        grip.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><g fill="currentColor">' +
          '<circle cx="3" cy="2.5" r="1.05"/><circle cx="9" cy="2.5" r="1.05"/>' +
          '<circle cx="3" cy="6" r="1.05"/><circle cx="9" cy="6" r="1.05"/>' +
          '<circle cx="3" cy="9.5" r="1.05"/><circle cx="9" cy="9.5" r="1.05"/></g></svg>'
        grip.addEventListener('pointerdown', onGripDown)
        grip.addEventListener('pointerenter', () => {
          if (rt.hideTimer) {
            clearTimeout(rt.hideTimer)
            rt.hideTimer = 0
          }
        })
        grip.addEventListener('pointerleave', scheduleHideGrip)
        document.body.appendChild(grip)
        rt.grip = grip
      }
      if (!rt.hot) {
        const hot = document.createElement('div')
        hot.setAttribute('data-dsl-hot', '1')
        hot.setAttribute('role', 'separator')
        hot.setAttribute('aria-label', '拖动调整入口列表高度')
        hot.title = '上下拖动调整入口列表高度；双击恢复「不限」'
        hot.addEventListener('pointerdown', onHotDown)
        hot.addEventListener('dblclick', () => persist({ ...state, maxRows: null }))
        document.body.appendChild(hot)
        rt.hot = hot
      }
      if (!rt.capLabel) {
        const label = document.createElement('div')
        label.setAttribute('data-dsl-cap-label', '1')
        document.body.appendChild(label)
        rt.capLabel = label
      }
    }

    function scheduleHideGrip() {
      if (rt.dragging) return
      if (rt.hideTimer) clearTimeout(rt.hideTimer)
      rt.hideTimer = window.setTimeout(() => {
        rt.hideTimer = 0
        hideGrip()
      }, 260)
    }

    function hideGrip() {
      rt.gripRow = null
      if (rt.grip) rt.grip.dataset.on = '0'
    }

    function onNavPointerMove(event) {
      if (rt.dragging || rt.resizing || !rt.grip) return
      const nav = rt.nav
      if (!nav) return
      if (nav.dataset.dslWide !== '1') {
        hideGrip()
        return
      }
      const target = event.target && event.target.closest ? event.target.closest('button') : null
      if (!target || !nav.contains(target) || isMoreRow(target)) {
        scheduleHideGrip()
        return
      }
      const row = rt.rows.find((item) => item.el === target)
      if (!row || state.hidden.includes(row.id)) {
        scheduleHideGrip()
        return
      }
      const box = target.getBoundingClientRect()
      if (box.height <= 0) {
        scheduleHideGrip()
        return
      }
      if (rt.hideTimer) {
        clearTimeout(rt.hideTimer)
        rt.hideTimer = 0
      }
      rt.gripRow = row
      rt.grip.style.left = `${Math.max(0, box.right - 24)}px`
      rt.grip.style.top = `${box.top + box.height / 2 - 12}px`
      rt.grip.dataset.on = '1'
    }

    function syncHotZone() {
      if (!rt.hot) return
      const nav = rt.nav
      if (!nav || !nav.isConnected || rt.dragging) {
        rt.hot.style.display = 'none'
        return
      }
      const box = nav.getBoundingClientRect()
      const wide = nav.dataset.dslWide === '1'
      if (!wide || box.width <= 0 || box.height <= 0) {
        rt.hot.style.display = 'none'
        return
      }
      // 限高时右侧那几像素是原生滚动条，热区必须让开，
      // 否则按住滑块往下拖会先命中热区、变成改行数（用户报的「拖不动滚动条」）。
      // 宽度用实测差值，跟随宿主的 --dsh-scrollbar-width，不写死 5px。
      const capped = nav.dataset.dslCap === '1'
      let scrollbar = capped ? Math.max(0, nav.offsetWidth - nav.clientWidth) : 0
      if (capped && !scrollbar) {
        // 覆盖式滚动条时 offset 差为 0，退回宿主的变量值，再不济按 6px 让开
        try {
          const v = parseFloat(window.getComputedStyle(nav).getPropertyValue('--dsh-scrollbar-width'))
          scrollbar = Number.isFinite(v) && v > 0 ? v : 6
        } catch {
          scrollbar = 6
        }
      }
      const cut = scrollbar > 0 ? scrollbar + 2 : 0
      rt.hot.style.display = 'block'
      rt.hot.style.left = `${box.left - 6}px`
      rt.hot.style.width = `${Math.max(48, box.width + 12 - cut)}px`
      // 只压到 nav 内 1px：既贴着列表下沿，又不会吃掉行的可点区域
      rt.hot.style.top = `${box.bottom - 1}px`
      rt.hot.dataset.capped = capped ? '1' : '0'
    }

    /** 全部隐藏时的恢复入口：单独一个浮层，不往 React 管的 nav 里塞节点。 */
    function syncHint() {
      const allHidden = rt.panels.length > 0 && rt.panels.every((panel) => state.hidden.includes(panel.id))
      if (!allHidden) {
        if (rt.hint) {
          rt.hint.remove()
          rt.hint = null
        }
        return
      }
      if (!rt.hint) {
        const hint = document.createElement('div')
        hint.setAttribute('data-dsl-hint', '1')
        hint.textContent = '入口已全部隐藏 · 点此恢复'
        hint.addEventListener('click', () => persist({ ...state, hidden: [] }))
        document.body.appendChild(hint)
        rt.hint = hint
      }
      const nav = rt.nav
      if (nav) {
        const box = nav.getBoundingClientRect()
        rt.hint.style.left = `${box.left + 4}px`
        rt.hint.style.top = `${box.top}px`
        rt.hint.style.width = `${Math.max(120, box.width - 8)}px`
        rt.hint.style.display = 'flex'
      }
    }
    // #endregion

    // #region 拖拽排序
    function cleanupDragListeners() {
      window.removeEventListener('pointermove', onDragMove, true)
      window.removeEventListener('pointerup', onDragUp, true)
      window.removeEventListener('pointercancel', onDragUp, true)
      window.removeEventListener('keydown', onDragKey, true)
      document.body.style.cursor = ''
    }

    function onGripDown(event) {
      if (event.button !== 0) return
      const row = rt.gripRow
      if (!row || rt.dragging) return
      event.preventDefault()
      event.stopPropagation()
      const visible = rt.rows.filter((item) => !state.hidden.includes(item.id))
      rt.dragging = {
        id: row.id,
        startY: event.clientY,
        pointerId: event.pointerId,
        order: (rt.previewOrder || mergedOrder(rt.panels, state.order)).slice(),
        visible,
        rects: visible.map((item) => item.el.getBoundingClientRect()),
        active: false,
      }
      try {
        rt.grip.setPointerCapture(event.pointerId)
      } catch {
        /* 某些环境下没有 pointer capture，全局监听兜底 */
      }
      if (rt.grip) rt.grip.dataset.on = '1'
      rt.grip.dataset.drag = '1'
      window.addEventListener('pointermove', onDragMove, true)
      window.addEventListener('pointerup', onDragUp, true)
      window.addEventListener('pointercancel', onDragUp, true)
      window.addEventListener('keydown', onDragKey, true)
    }

    function onDragMove(event) {
      const drag = rt.dragging
      if (!drag) return
      if (!drag.active) {
        if (Math.abs(event.clientY - drag.startY) < 4) return
        drag.active = true
        document.body.style.cursor = 'grabbing'
        const el = rt.rows.find((item) => item.id === drag.id)
        if (el) el.el.dataset.dslDragging = '1'
        hideGrip()
      }
      // 可见 id 必须按「当前生效顺序」列出来（drag.order 是按下时拍的快照），
      // 不能按 DOM 顺序：CSS order 不重排 nav.children。
      const visibleSet = new Set(drag.visible.map((item) => item.id))
      const ids = drag.order.filter((id) => visibleSet.has(id))
      if (!ids.includes(drag.id)) return
      // 落点用「除被拖行以外、中线在光标上方的行数」判定：与遍历次序无关，
      // 行随预览移动时也不会来回跳（数数法比找第一个中点更稳）。
      let above = 0
      for (const item of drag.visible) {
        if (item.id === drag.id) continue
        const rect = item.el.getBoundingClientRect()
        if (event.clientY > rect.top + rect.height / 2) above += 1
      }
      const next = reorderVisible(ids, drag.id, above)
      if (next.join() === ids.join()) return
      drag.previewIds = next
      rt.previewOrder = buildOrderFromVisible(drag.order, next)
      applyAll('drag-preview')
    }

    function onDragKey(event) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      const drag = rt.dragging
      rt.dragging = null
      rt.previewOrder = null
      cleanupDragListeners()
      if (drag) {
        const el = rt.rows.find((item) => item.id === drag.id)
        if (el) delete el.el.dataset.dslDragging
      }
      if (rt.grip) {
        rt.grip.dataset.drag = '0'
        rt.grip.dataset.on = '0'
      }
      applyAll('drag-escape')
    }

    function onDragUp() {
      const drag = rt.dragging
      if (!drag) return
      rt.dragging = null
      cleanupDragListeners()
      if (rt.grip) {
        rt.grip.dataset.drag = '0'
        rt.grip.dataset.on = '0'
      }
      const el = rt.rows.find((item) => item.id === drag.id)
      if (el) delete el.el.dataset.dslDragging
      if (drag.active && rt.previewOrder) {
        const next = rt.previewOrder.slice()
        rt.previewOrder = null
        persist({ ...state, order: next })
      } else {
        rt.previewOrder = null
        applyAll('drag-end-noop')
      }
    }
    // #endregion

    // #region 拖动改高度
    function cleanupResizeListeners() {
      window.removeEventListener('pointermove', onHotMove, true)
      window.removeEventListener('pointerup', onHotUp, true)
      window.removeEventListener('pointercancel', onHotUp, true)
      document.body.style.cursor = ''
    }

    function onHotDown(event) {
      if (event.button !== 0) return
      const nav = rt.nav
      if (!nav) return
      event.preventDefault()
      event.stopPropagation()
      const metrics = rowMetrics(nav)
      const ids = visibleEntryIds(rt.panels, state.hidden)
      const limit = rowLimit(ids)
      const floor = rowFloor(ids)
      // 未限高时按当前实际高度折算行数，起拖不会跳
      const currentRows =
        state.maxRows != null
          ? clamp(effectiveRows(ids) ?? limit, floor, limit)
          : clamp(Math.round((nav.getBoundingClientRect().height - 2) / metrics.step), floor, limit)
      rt.resizing = { startY: event.clientY, metrics, baseRows: currentRows, rows: currentRows, limit, floor, moved: false }
      try {
        rt.hot.setPointerCapture(event.pointerId)
      } catch {
        /* 同上 */
      }
      rt.hot.dataset.on = '1'
      window.addEventListener('pointermove', onHotMove, true)
      window.addEventListener('pointerup', onHotUp, true)
      window.addEventListener('pointercancel', onHotUp, true)
    }

    function onHotMove(event) {
      const resize = rt.resizing
      if (!resize || !rt.nav) return
      // 起拖门槛 2px：误点一下热区不该改写行数
      if (!resize.moved) {
        if (Math.abs(event.clientY - resize.startY) < 2) return
        resize.moved = true
      }
      const delta = Math.round((event.clientY - resize.startY) / resize.metrics.step)
      // 上限 = 入口数：拖再多也只是把窗口拉满，不会拉出空白行
      const rows = clamp(resize.baseRows + delta, resize.floor, resize.limit)
      resize.rows = rows
      rt.nav.dataset.dslCap = '1'
      rt.nav.style.maxHeight = `${capPx(rows)}px`
      if (rt.capLabel) {
        const box = rt.nav.getBoundingClientRect()
        rt.capLabel.textContent = rows >= resize.limit ? `全部 ${resize.limit} 行` : `${rows} / ${resize.limit} 行`
        rt.capLabel.style.left = `${box.left + 8}px`
        rt.capLabel.style.top = `${Math.max(0, box.bottom + 6)}px`
        rt.capLabel.dataset.on = '1'
      }
      syncHotZone()
    }

    function onHotUp() {
      const resize = rt.resizing
      rt.resizing = null
      cleanupResizeListeners()
      if (rt.hot) rt.hot.dataset.on = '0'
      if (rt.capLabel) rt.capLabel.dataset.on = '0'
      if (!resize) return
      if (!resize.moved) {
        // 只是点了一下热区：把盯着拖的临时高度还原，不动偏好
        applyAll('resize-tap')
        return
      }
      // 拖到「全部」时也把行数存下来：这是「窗口=入口数」的标记，
      // 之后新增入口才会自动长高（见 reconcileRowCap）。
      const rows = clamp(resize.rows, resize.floor, resize.limit)
      persist({ ...state, maxRows: rows })
    }
    // #endregion

    // #region 浮层（底栏快捷面板）
    function useStore() {
      const [snap, setSnap] = useState(() => ({ ...state }))
      useEffect(() => {
        const off = subscribeStore(() => setSnap({ ...state }))
        return () => off()
      }, [])
      return snap
    }

    function toggleHidden(snap, id) {
      const hidden = new Set(snap.hidden)
      if (hidden.has(id)) hidden.delete(id)
      else hidden.add(id)
      persist({ ...snap, hidden: [...hidden] })
    }

    /** 行数上限的说明文案：分母永远是「当前可见入口数」。 */
    function capText(snap, ids) {
      const limit = rowLimit(ids)
      if (snap.maxRows == null) return `不限（共 ${limit} 个）`
      const rows = clamp(snap.maxRows, rowFloor(ids), limit)
      return rows >= limit ? `全部 ${limit} 个` : `${rows} / ${limit} 个`
    }

    function QuickPanel({ onClose }) {
      const snap = useStore()
      const panels = rt.panels.length ? rt.panels : readPanels()
      const order = mergedOrder(panels, snap.order)
      const byId = new Map(panels.map((panel) => [panel.id, panel]))
      const entryIds = visibleEntryIds(panels, snap.hidden)
      return h(
        'div',
        {
          'data-dsl-pop': '1',
          role: 'dialog',
          'aria-label': '侧栏布局',
          onPointerDown: (event) => event.stopPropagation(),
        },
        h('h4', null, '侧栏布局'),
        h(
          'div',
          { style: { maxHeight: '46vh', overflow: 'auto' } },
          order.map((id) => {
            const panel = byId.get(id)
            return h(
              'label',
              { className: 'dsl-row', key: id, title: panel ? panel.id : id },
              h('input', {
                type: 'checkbox',
                checked: !snap.hidden.includes(id),
                onChange: () => toggleHidden(snap, id),
              }),
              h('span', { className: 'dsl-name' }, panel ? panel.label : id),
            )
          }),
        ),
        h('div', { className: 'dsl-sep' }),
        h(
          'div',
          { className: 'dsl-row', style: { cursor: 'default' } },
          h('span', { className: 'dsl-name' }, '显示上限'),
          h('span', { style: { opacity: 0.7 } }, capText(snap, entryIds)),
        ),
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8 },
        },
          h('input', {
            type: 'range',
            min: rowFloor(entryIds),
            max: rowLimit(entryIds),
            step: 1,
            value: clamp(effectiveRows(entryIds) ?? rowLimit(entryIds), rowFloor(entryIds), rowLimit(entryIds)),
            disabled: rowLimit(entryIds) <= rowFloor(entryIds),
            style: { flex: 1 },
            onChange: (event) => persist({ ...snap, maxRows: Number(event.target.value) }),
          }),
          h(
            'button',
            { type: 'button', onClick: () => persist({ ...snap, maxRows: null }) },
            '不限',
          ),
        ),
        h('div', { className: 'dsl-sep' }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' } },
          h(
            'button',
            { type: 'button', onClick: () => persist({ ...defaults() }) },
            '恢复默认',
          ),
          h(
            'button',
            { type: 'button', onClick: () => onClose() },
            '关闭',
          ),
        ),
        h(
          'div',
          { style: { marginTop: 8, opacity: 0.6, fontSize: 11, lineHeight: 1.5 } },
          '拖动排序请直接拖侧栏行尾的抓手；「更多」行永远在最后。',
        ),
      )
    }

    function FooterButton() {
      const [open, setOpen] = useState(false)
      const ref = useRef(null)
      const [pos, setPos] = useState(null)

      useEffect(() => {
        if (!open) return undefined
        const rect = ref.current ? ref.current.getBoundingClientRect() : null
        if (rect) {
          setPos({
            left: Math.max(8, Math.min(window.innerWidth - 288, rect.left)),
            bottom: Math.max(8, window.innerHeight - rect.top + 6),
          })
        }
        const onDown = (event) => {
          const pop = document.querySelector('[data-dsl-pop="1"]')
          if (pop && pop.contains(event.target)) return
          if (ref.current && ref.current.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        return () => {
          window.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      const anchorProps = {
        ref,
        type: 'button',
        [ANCHOR]: '1',
        'aria-label': FOOTER_LABEL,
        title: FOOTER_LABEL,
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen((value) => !value),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          padding: 0,
          border: 0,
          borderRadius: 8,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          opacity: 0.75,
        },
      }

      const icon = h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'currentColor' },
        h('rect', { x: 2, y: 3, width: 12, height: 1.6, rx: 0.8 }),
        h('rect', { x: 2, y: 7.2, width: 12, height: 1.6, rx: 0.8 }),
        h('rect', { x: 2, y: 11.4, width: 12, height: 1.6, rx: 0.8 }),
      )

      return h(
        React.Fragment,
        null,
        h('button', anchorProps, icon),
        open && pos
          ? ReactDOM.createPortal(
              h(
                'div',
                {
                  'data-dsl-pop': '1',
                  role: 'dialog',
                  style: { left: pos.left, bottom: pos.bottom },
                },
                h(QuickPanel, { onClose: () => setOpen(false) }),
              ),
              document.body,
            )
          : null,
      )
    }
    // #endregion

    // #region 设置页
    const ui = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px', fontSize: 13 },
      card: {
        border: '1px solid rgba(127,127,127,.24)',
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      title: { fontSize: 12, fontWeight: 600, opacity: 0.85, letterSpacing: '.02em' },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' },
      name: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      mono: { fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 11, opacity: 0.5 },
      small: { fontSize: 11, opacity: 0.6, lineHeight: 1.6 },
      btn: {
        font: 'inherit',
        color: 'inherit',
        background: 'rgba(127,127,127,.16)',
        border: 0,
        borderRadius: 6,
        padding: '2px 7px',
        cursor: 'pointer',
      },
      btnOff: { opacity: 0.35, cursor: 'default' },
    }

    function SettingsPage() {
      const snap = useStore()
      const panels = rt.panels.length ? rt.panels : readPanels()
      const order = mergedOrder(panels, snap.order)
      const byId = new Map(panels.map((panel) => [panel.id, panel]))
      const detected = Boolean(rt.nav && rt.nav.isConnected)
      const entryIds = visibleEntryIds(panels, snap.hidden)
      const limit = rowLimit(entryIds)
      const floor = rowFloor(entryIds)

      const move = (id, delta) => {
        const list = order.slice()
        const from = list.indexOf(id)
        const to = from + delta
        if (from < 0 || to < 0 || to >= list.length) return
        list.splice(from, 1)
        list.splice(to, 0, id)
        persist({ ...snap, order: list })
      }

      return h(
        'div',
        { 'data-dsl-settings': '1', style: ui.wrap },

        h(
          'div',
          { style: { ...ui.card, gap: 4 } },
          h('div', { style: ui.title }, '状态'),
          h(
            'div',
            { style: { fontSize: 12 } },
            detected ? `已检测到 ${panels.length} 个入口 · 侧栏已匹配` : '未检测到左侧栏（DSH 版本可能不兼容，增强已停用；侧栏本身不受影响）',
          ),
        ),

        h(
          'div',
          { style: ui.card },
          h('div', { style: ui.title }, '入口（拖动排序请直接拖侧栏行尾抓手，这里用 ↑↓）'),
          panels.length === 0
            ? h('div', { style: ui.small }, '还没有读到任何入口。侧栏若已正常显示，说明读取接口与当前版本不同，请把这条信息反馈给插件作者。')
            : order.map((id, index) => {
                const panel = byId.get(id)
                const visible = !snap.hidden.includes(id)
                return h(
                  'div',
                  { key: id, style: ui.row },
                  h(
                    'label',
                    { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer', minWidth: 0 } },
                    h('input', {
                      type: 'checkbox',
                      checked: visible,
                      onChange: () => toggleHidden(snap, id),
                    }),
                    h('span', { style: { ...ui.name, opacity: visible ? 1 : 0.45 } }, panel ? panel.label : id),
                    h('span', { style: ui.mono }, id),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: { ...ui.btn, ...(index === 0 ? ui.btnOff : null) },
                      disabled: index === 0,
                      title: '上移',
                      onClick: () => move(id, -1),
                    },
                    '↑',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: { ...ui.btn, ...(index === order.length - 1 ? ui.btnOff : null) },
                      disabled: index === order.length - 1,
                      title: '下移',
                      onClick: () => move(id, 1),
                    },
                    '↓',
                  ),
                )
              }),
          h(
            'div',
            { style: ui.small },
            '隐藏即彻底不显示（位次保留，随时可开回来）。官方「更多」菜单里不会同步这个状态——它没有对外接口，这里只做显示层。',
          ),
        ),

        h(
          'div',
          { style: ui.card },
          h('div', { style: ui.title }, '显示上限'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('input', {
              type: 'range',
              min: floor,
              max: limit,
              step: 1,
              value: clamp(effectiveRows(entryIds) ?? limit, floor, limit),
              disabled: limit <= floor,
              style: { flex: 1 },
              onChange: (event) => persist({ ...snap, maxRows: Number(event.target.value) }),
            }),
            h('span', { style: { minWidth: 64, textAlign: 'right' } }, capText(snap, entryIds)),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'button',
              { type: 'button', style: ui.btn, onClick: () => persist({ ...snap, maxRows: null }) },
              '不限高',
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...ui.btn, ...(limit <= floor ? ui.btnOff : null) },
                disabled: limit <= floor,
                onClick: () => persist({ ...snap, maxRows: limit }),
              },
              `全部 ${limit} 行`,
            ),
          ),
          h(
            'div',
            { style: ui.small },
            '上限就是入口数：拖到「全部」以后，再装新插件会自动多一行；上限小于入口数时，新入口排在末尾、留在滚动区外，不会挤占面板。也可以直接在侧栏列表底边上下拖，双击热区恢复不限。',
          ),
        ),

        h(
          'div',
          { style: ui.card },
          h(
            'label',
            { style: { ...ui.row, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: snap.density === 'compact',
              onChange: (event) => persist({ ...snap, density: event.target.checked ? 'compact' : 'comfortable' }),
            }),
            h('span', { style: { flex: 1 } }, '紧凑密度'),
            h('span', { style: { ...ui.mono, opacity: 0.8 } }, '实验性'),
          ),
          h(
            'div',
            { style: ui.small },
            '行高 36 → 28px（9 个入口约省 80px）。代价：点击区域变小，触摸屏/高 DPI 下更容易误点；折叠成窄栏时不生效；官方若改行高则此档随之失效。',
          ),
        ),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h(
            'button',
            { type: 'button', style: ui.btn, onClick: () => persist({ ...defaults() }) },
            '恢复默认（清空全部偏好）',
          ),
          h('span', { style: ui.small }, `v${VERSION}`),
        ),
      )
    }
    // #endregion

    // #region 生命周期
    function scheduleTick() {
      if (rt.raf) return
      rt.raf = window.requestAnimationFrame(() => {
        rt.raf = 0
        tick()
      })
    }

    function tick() {
      attach()
      const nav = rt.nav
      if (nav && nav.isConnected) {
        const signature = rowSignature(nav)
        if (signature !== rt.signature) {
          rt.signature = signature
          applyAll('row-change')
        }
        syncHotZone()
        syncHint()
      }
    }

    function teardownNav() {
      const nav = rt.nav
      if (nav) {
        try {
          for (const el of Array.from(nav.children)) {
            if (el.tagName !== 'BUTTON') continue
            el.style.order = ''
            el.style.display = ''
            delete el.dataset.dslDragging
            delete el.dataset.dslId
          }
          nav.style.maxHeight = ''
          delete nav.dataset.dsl
          delete nav.dataset.dslCap
          delete nav.dataset.dslDensity
          delete nav.dataset.dslWide
          delete nav.dataset.dslBound
        } catch (error) {
          log('teardown nav failed', error)
        }
      }
      rt.nav = null
      rt.rows = []
      rt.signature = ''
    }

    function teardown() {
      if (rt.tickTimer) window.clearInterval(rt.tickTimer)
      rt.tickTimer = 0
      if (rt.raf) window.cancelAnimationFrame(rt.raf)
      rt.raf = 0
      if (rt.hideTimer) clearTimeout(rt.hideTimer)
      rt.hideTimer = 0
      cleanupDragListeners()
      cleanupResizeListeners()
      for (const observer of rt.observers) {
        try {
          observer.disconnect()
        } catch {
          /* 已断开 */
        }
      }
      rt.observers = []
      try {
        if (rt.navObserver) rt.navObserver.disconnect()
      } catch {
        /* ignore */
      }
      rt.navObserver = null
      for (const off of rt.disposers.splice(0)) {
        try {
          off()
        } catch {
          /* ignore */
        }
      }
      teardownNav()
      for (const el of [rt.styleEl, rt.grip, rt.hot, rt.capLabel, rt.hint]) {
        try {
          if (el) el.remove()
        } catch {
          /* ignore */
        }
      }
      rt.styleEl = null
      rt.grip = null
      rt.hot = null
      rt.capLabel = null
      rt.hint = null
    }

    function apply(ctx) {
      rt.ctx = ctx
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.register !== 'function') {
        warn('slots 服务不可用，插件不启动')
        return
      }

      // 与官方同款写法：inject 里登记「该槽每次被声明时」的注册（返回 generator，
      // cordis 会把它当 effect 收集，槽撤销时自动注销）。
      const registerFooter = function* () {
        yield slots.register(
          { name: FOOTER_SLOT, id: FOOTER_ID, order: 20, label: () => FOOTER_LABEL },
          FooterButton,
        )
      }
      const registerSettings = function* () {
        yield slots.register(
          { name: SETTINGS_SLOT, id: SETTINGS_ID, order: 70, label: () => SETTINGS_LABEL },
          SettingsPage,
        )
      }

      for (const [slot, factory] of [
        [FOOTER_SLOT, registerFooter],
        [SETTINGS_SLOT, registerSettings],
      ]) {
        try {
          slots.inject(slot, factory)
        } catch (error) {
          warn(`注册 ${slot} 失败`, error)
        }
      }

      try {
        if (typeof slots.subscribe === 'function') {
          const off = slots.subscribe(PANEL_SLOT, () => applyAll('slot-subscribe'))
          if (typeof off === 'function') rt.disposers.push(off)
        }
      } catch (error) {
        log('slots.subscribe 不可用', error)
      }

      installStyle()

      try {
        const observer = new MutationObserver(() => scheduleTick())
        observer.observe(document.body, { childList: true, subtree: true })
        rt.observers.push(observer)
      } catch (error) {
        log('MutationObserver 不可用', error)
      }

      tick()
      rt.tickTimer = window.setInterval(tick, TICK_MS)

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => teardown(), 'dsh-sidebar-layout: sidebar list enhancement')
      }

      // 排查用把手；不依赖它，随便删
      window.__dsl = {
        version: VERSION,
        state: () => ({ ...state, hidden: [...state.hidden], order: [...state.order] }),
        mapping: () => rt.rows.map((row) => ({ id: row.id, label: row.el.getAttribute('aria-label') })),
        nav: () => rt.nav,
        refresh: () => applyAll('manual'),
        // 滚动条横向对齐：给定当前 margin 与右沿偏差，返回修正后的 margin
        alignMargin,
        align: () => {
          const nav = rt.nav
          if (!nav) return null
          const scroller = findPeerScroller(nav)
          return {
            margin: parseFloat(getComputedStyle(nav).marginRight),
            navRight: nav.getBoundingClientRect().right,
            peerRight: scroller ? scroller.getBoundingClientRect().right : null,
            peerWidth: scroller ? scroller.getBoundingClientRect().width : null,
          }
        },
        // 拖拽排序的纯函数（坐标域修正后抽出，便于单测与手工验算）
        planDrag: (order, visibleIds, id, aboveCount) =>
          buildOrderFromVisible(order, reorderVisible(order.filter((x) => visibleIds.includes(x)), id, aboveCount)),
        // 行数上限的三件套：给单测与手工算用
        caps: () => {
          const ids = visibleEntryIds(readPanels(), state.hidden)
          return {
            entries: ids.length,
            limit: rowLimit(ids),
            floor: rowFloor(ids),
            stored: state.maxRows,
            effective: effectiveRows(ids),
          }
        },
        rowsFor: (n) => {
          const ids = visibleEntryIds(readPanels(), state.hidden)
          return clamp(n, rowFloor(ids), rowLimit(ids))
        },
        set: (patch) => persist({ ...state, ...patch }),
        reset: () => persist({ ...defaults() }),
      }
      log('client ready', VERSION)
    }

    module.exports = {
      name: 'dsh-sidebar-layout-client',
      inject: ['slots'],
      apply,
    }
    return module.exports
  },
})
