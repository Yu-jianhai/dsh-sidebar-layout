/**
 * 无浏览器冒烟测试：用最小 DOM 桩把 lib/client.js 跑起来。
 *
 * 目的不是模拟 DSH，而是抓真会致命的那一类错误：
 *   - 模块加载契约（__ModuleLoader__.load / factory / exports.apply）
 *   - apply(ctx) 在 slots 服务可用时能否走完注册
 *   - 找到 nav 之后，偏好能否真的落到 DOM（order / display / max-height / 密度）
 *   - 卸载时能否把 DOM 还原（不留 style.order）
 *
 * 跑法：node test/boot-smoke.mjs
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

// #region 最小 DOM 桩
const NOTHING = () => null

class FakeEl {
  constructor(tagName, attrs = {}, options = {}) {
    this.tagName = String(tagName).toUpperCase()
    this.attributes = { ...attrs }
    this.children = []
    this.parentElement = null
    this.style = {}
    this.dataset = {}
    this.listeners = new Map()
    this.innerText = ''
    this.innerHTML = ''
    this.isConnected = options.connected !== false
    this.rect = options.rect || { top: 0, left: 0, width: 180, height: 36, right: 180, bottom: 36 }
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
  }
  removeAttribute(name) {
    delete this.attributes[name]
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
      this.parentElement = null
    }
    this.isConnected = false
  }
  appendChild(child) {
    child.parentElement = this
    child.isConnected = true
    this.children.push(child)
    return child
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn)
  }
  removeEventListener(type) {
    this.listeners.delete(type)
  }
  getBoundingClientRect() {
    return this.rect
  }
  contains(node) {
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }
  querySelector(selector) {
    const want = String(selector).toUpperCase()
    const stack = [...this.children]
    while (stack.length) {
      const node = stack.shift()
      if (node.tagName === want) return node
      stack.push(...node.children)
    }
    return null
  }
  closest(selector) {
    let node = this
    const want = String(selector).toUpperCase()
    while (node) {
      if (node.tagName === want) return node
      node = node.parentElement
    }
    return null
  }
}

const STORE = new Map()
globalThis.localStorage = {
  getItem: (key) => (STORE.has(key) ? STORE.get(key) : null),
  setItem: (key, value) => STORE.set(key, String(value)),
  removeItem: (key) => STORE.delete(key),
}

const head = new FakeEl('head')
const body = new FakeEl('body')
const document_ = {
  head,
  body,
  createElement: (tag) => new FakeEl(tag),
  querySelector: NOTHING,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
}

const timers = []
const window_ = {
  document: document_,
  innerWidth: 1440,
  innerHeight: 900,
  setInterval: (fn) => {
    timers.push(fn)
    return timers.length
  },
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: (fn) => {
    fn()
    return 1
  },
  cancelAnimationFrame: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: {
    load: (definition) => {
      window_.__def = definition
    },
  },
}

globalThis.window = window_
globalThis.document = document_
globalThis.MutationObserver = class {
  constructor(callback) {
    this.callback = callback
  }
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
// #endregion

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial === undefined ? null : initial }),
}
const requireStub = (specifier) => {
  if (specifier === 'react') return ReactStub
  if (specifier === 'react-dom') return { createPortal: (node) => node }
  throw new Error(`unexpected require: ${specifier}`)
}

// 预置一份「已改过」的偏好，用来验证加载路径
STORE.set(
  'dsh-sidebar-layout:v1',
  JSON.stringify({ v: 1, order: [], hidden: ['plugins'], maxRows: 6, density: 'compact' }),
)

const PANELS = [
  { id: 'plugins', order: 0, label: '插件' },
  { id: 'dsh-market', order: 1, label: '插件市场' },
  { id: 'schedules', order: 10, label: '定时任务' },
  { id: 'dsh-context', order: 20, label: '上下文' },
  { id: 'task-board', order: 20, label: '任务板' },
  { id: 'skill-explorer', order: 30, label: '技能' },
  { id: 'dsh-session-progress', order: 40, label: '进度日志' },
  { id: 'dsh-ppt.workbench', order: 57, label: 'PPT 工作台' },
]

// #region 组装侧栏 DOM：root > nav > button* + 更多行；root > foot > anchor
const root = new FakeEl('div', {}, { rect: { top: 0, left: 0, width: 240, height: 900, right: 240, bottom: 900 } })
const nav = new FakeEl('nav', { 'aria-label': '全局面板' }, { rect: { top: 60, left: 0, width: 240, height: 350, right: 240, bottom: 410 } })
const rowEls = PANELS.map((panel, index) => {
  const row = new FakeEl('button', { 'aria-label': panel.label }, { rect: { top: 60 + index * 38, left: 0, width: 216, height: 36, right: 216, bottom: 96 + index * 38 } })
  nav.appendChild(row)
  return row
})
const moreRow = new FakeEl('button', { 'aria-haspopup': 'menu', 'aria-label': '更多' }, { rect: { top: 60 + 8 * 38, left: 0, width: 216, height: 36, right: 216, bottom: 96 + 8 * 38 } })
nav.appendChild(moreRow)
root.appendChild(nav)
const foot = new FakeEl('div')
const footWrap = new FakeEl('div')
const anchor = new FakeEl('button', { 'data-dsl-anchor': '1' }, { rect: { top: 860, left: 0, width: 28, height: 28, right: 28, bottom: 888 } })
footWrap.appendChild(anchor)
foot.appendChild(footWrap)
root.appendChild(foot)

document_.querySelector = (selector) => {
  if (selector === '[data-dsl-anchor="1"]') return anchor
  return null
}
// #endregion

const clientPath = path.resolve(import.meta.dirname, '../lib/client.js')
await import(pathToFileURL(clientPath).href)

assert.ok(window_.__def, '模块没有向 __ModuleLoader__ 注册')
assert.equal(window_.__def.id, 'dsh-sidebar-layout')
const mod = window_.__def.factory(requireStub)
assert.equal(typeof mod.apply, 'function', 'exports.apply 缺失')
assert.deepEqual(mod.inject, ['slots'], 'inject 应只依赖 slots')

const registered = []
const injected = []
let disposer = null
const ctx = {
  slots: {
    register: (options) => {
      registered.push(options)
      return () => {}
    },
    inject: (slot, factory) => {
      injected.push(slot)
      const iterator = factory()
      // 真实框架会驱动 generator 走到第一个 yield，卸载时再 return()
      if (!iterator || typeof iterator.next !== 'function') return () => {}
      const first = iterator.next()
      if (first.done) return () => {}
      const dispose = first.value
      return () => {
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch {
            /* 桩不需要计较 */
          }
        }
        if (typeof iterator.return === 'function') iterator.return()
      }
    },
    entriesOfSlot: (slot) => (slot === 'sidebar.panellist' ? PANELS.map((panel) => ({ options: panel })) : []),
    entries: () => [],
    subscribe: () => () => {},
  },
  effect: (fn) => {
    disposer = fn()
  },
}

mod.apply(ctx)
assert.deepEqual(injected, ['sidebar.footer.action', 'settings.section'], '应注入两个槽')
assert.equal(registered.length, 2, '应注册底栏按钮 + 设置页')
assert.deepEqual(registered.map((item) => item.name), ['sidebar.footer.action', 'settings.section'])
assert.equal(registered[1].order, 70)

// 走一轮 tick（等价于首帧）：应该找到 nav 并把偏好写进 DOM
timers.forEach((fn) => fn())

assert.equal(nav.dataset.dsl, '1', 'nav 应被打上 data-dsl')
assert.equal(nav.dataset.dslWide, '1')
assert.equal(nav.dataset.dslDensity, 'compact', '密度应生效（宽栏）')
assert.equal(nav.dataset.dslCap, '1', '有 maxRows 时应开滚动模式')
const capHeight = Number(String(nav.style.maxHeight).replace('px', ''))
assert.ok(capHeight > 0 && capHeight < 400, `maxHeight 应被设成有限高度，实际 ${nav.style.maxHeight}`)

rowEls.forEach((row, index) => {
  const id = PANELS[index].id
  if (id === 'plugins') {
    assert.equal(row.style.display, 'none', '被隐藏的行应 display:none')
  } else {
    assert.equal(row.style.display, '', `${id} 不应被隐藏`)
  }
  assert.equal(row.style.order, String(index), `${id} 的 order 应为注册序 ${index}`)
  assert.equal(row.dataset.dslId, id, `${id} 应带上 data-dsl-id`)
})
assert.equal(moreRow.style.order, '10000', '「更多」行永远在最后')

// #region 回归：连续两次拖拽，第一次的结果不能被第二次覆盖
// 现场症状：拖好一个再拖另一个，先拖好的那个「跳回去」。
// 根因是第二个 drag 的起点索引取自 DOM 顺序（CSS order 不重排 nav.children），
// 而落点按视觉中线算，两个坐标系混用。
const dsl = window_.__dsl
assert.equal(typeof dsl.planDrag, 'function', '__dsl.planDrag 应可用于验算')
const allIds = PANELS.map((p) => p.id)

// 第一次：把最后一个（dsh-ppt.workbench）拖到最顶
const afterFirst = dsl.planDrag(allIds, allIds, 'dsh-ppt.workbench', 0)
assert.equal(afterFirst[0], 'dsh-ppt.workbench', '第一次拖拽应把目标放到首位')
assert.deepEqual(
  afterFirst.slice(1),
  allIds.filter((id) => id !== 'dsh-ppt.workbench'),
  '其余行相对顺序不变',
)

// 第二次：再把 dsh-market 拖到最顶；此时 dsh-ppt.workbench 必须留在第 2 位
const afterSecond = dsl.planDrag(afterFirst, allIds, 'dsh-market', 0)
assert.equal(afterSecond[0], 'dsh-market', '第二次拖拽的目标应到首位')
assert.equal(
  afterSecond[1],
  'dsh-ppt.workbench',
  '第一次拖好的行必须留在第 2 位（这就是「跳回去」的那个 bug）',
)

// 反向：把首位再拖到末尾，其余顺序应保持
const afterThird = dsl.planDrag(afterSecond, allIds, 'dsh-market', allIds.length - 1)
assert.equal(afterThird[afterThird.length - 1], 'dsh-market', '拖到末尾应落到最后一位')
assert.deepEqual(afterThird.slice(0, -1), afterSecond.slice(1), '其余行顺序不变')
assert.equal(new Set(afterThird).size, allIds.length, '不应丢行或重复')
// #endregion

// #region 行数上限：跟着入口数走，不让人拖到空白
const caps0 = dsl.caps()
assert.equal(caps0.entries, 7, 'plugins 被隐藏 → 可见入口 7 个')
assert.equal(caps0.limit, 7, '可拖动的最大行数 = 可见入口数')
assert.equal(caps0.stored, 6, '预置 maxRows 应为 6')
assert.equal(caps0.effective, 6, '生效行数不应超过预置值')
assert.equal(dsl.rowsFor(99), 7, '拖到超出入口数时应被夹到入口数')
assert.equal(dsl.rowsFor(1), 3, '入口够多时下限仍是 MIN_ROWS=3')

// 滚动条横向对齐的纯函数：右沿偏右 8px 时 margin 从 -12 收敛到 -4（右沿左移 8px）
assert.equal(dsl.alignMargin(-12, 8), -4, 'alignMargin(-12, 8) 应为 -4')
assert.equal(dsl.alignMargin(-12, -4), -16, 'alignMargin(-12, -4) 应为 -16')
assert.equal(dsl.alignMargin(-12, 40), 0, '过头的修正应夹到 0')
assert.equal(dsl.alignMargin(-12, -80), -48, '不应把 margin 拉到 -48 以下')
assert.equal(nav.dataset.dslCap, '1', '行数 < 入口数：应裁剪')

// 高度热区必须让开原生滚动条列，否则按住滑块往下拖会被热区截走、变成改行数
nav.offsetWidth = 228
nav.clientWidth = 223
dsl.refresh()
const hotEl = body.children.find((el) => typeof el.getAttribute === 'function' && el.getAttribute('data-dsl-hot') === '1')
assert.ok(hotEl, '应创建高度热区')
assert.equal(hotEl.dataset.capped, '1', '限高时热区应标记 capped')
const hotWidth = Number(String(hotEl.style.width).replace('px', ''))
const navBox = nav.getBoundingClientRect()
assert.ok(hotWidth <= navBox.width + 12 - 7, `热区应让开 5px 滚动条 + 2px 余量，实际宽 ${hotWidth}`)
assert.equal(hotEl.style.top, `${navBox.bottom - 1}px`, '热区只压住 nav 下沿 1px，不吃行的可点区域')

// 拖到「全部」→ 不再裁剪，也不留滚动条槽
dsl.set({ maxRows: 7 })
assert.equal(nav.dataset.dslCap, undefined, '行数 = 入口数时不该裁剪')
assert.equal(nav.style.maxHeight, '', '行数 = 入口数时不该设 maxHeight')

// 装一个新插件：窗口自动长高一行（因为之前正好是「全部」）
PANELS.push({ id: 'dsh-new', order: 90, label: '新入口' })
const newRow = new FakeEl('button', { 'aria-label': '新入口' }, { rect: { top: 60 + 7 * 38, left: 0, width: 216, height: 36, right: 216, bottom: 96 + 7 * 38 } })
newRow.parentElement = nav
nav.children.splice(nav.children.indexOf(moreRow), 0, newRow)
dsl.refresh()
assert.equal(dsl.state().maxRows, 8, '「全部」状态下新增入口应自动长到 8 行')
assert.equal(nav.dataset.dslCap, undefined, '自动长高后依然不裁剪')

// 反过来：主动把窗口拖得比入口少，新入口就该留在滚动区外，不偷偷改行数
dsl.set({ maxRows: 5 })
assert.equal(nav.dataset.dslCap, '1', '5 < 8 → 恢复裁剪')
PANELS.push({ id: 'dsh-extra', order: 91, label: '再加一个' })
const extraRow = new FakeEl('button', { 'aria-label': '再加一个' }, { rect: { top: 60 + 8 * 38, left: 0, width: 216, height: 36, right: 216, bottom: 96 + 8 * 38 } })
extraRow.parentElement = nav
nav.children.splice(nav.children.indexOf(moreRow), 0, extraRow)
dsl.refresh()
assert.equal(dsl.state().maxRows, 5, '用户主动设的小窗口不该被自动放大')
assert.equal(dsl.caps().entries, 9, '新入口计入可见入口数（排在末尾）')
assert.equal(dsl.caps().limit, 9, '上限随入口数增长')
assert.equal(nav.dataset.dslCap, '1', '仍然裁剪')
// #endregion

// 卸载应还原 DOM
assert.equal(typeof disposer, 'function', 'ctx.effect 应收到一个清理函数')
disposer()
assert.equal(nav.dataset.dsl, undefined, '卸载后 data-dsl 应被移除')
assert.equal(nav.style.maxHeight, '', '卸载后 maxHeight 应被清空')
rowEls.forEach((row) => {
  assert.equal(row.style.order, '', '卸载后 order 应被清空')
  assert.equal(row.style.display, '', '卸载后 display 应被清空')
})

console.log('boot-smoke: OK（注册 / 找 nav / 落偏好 / 卸载还原 全部通过）')
