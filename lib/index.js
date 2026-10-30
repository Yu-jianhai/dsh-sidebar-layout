/**
 * dsh-sidebar-layout — 宿主半边。
 *
 * 这个插件是纯客户端 UI（`dsh.client.platform = "web"`）：所有逻辑都在
 * `lib/client.js` 里，通过官方 slot（`sidebar.footer.action` / `settings.section`）
 * 注册界面，再在 DOM 外侧做一层显示增强。
 *
 * 宿主这边故意什么都不做——它存在的原因只有两个：
 *   1. bundle 的 patch 需要一条可加载的入口（`name: dsh-sidebar-layout`）；
 *   2. 让 web 端能按包名解析到 `./client` 导出，从而加载 `lib/client.js`。
 *
 * 不注册工具、不开路由、不读写任何文件，所以卸载后宿主侧零残留。
 */

export const name = 'dsh-sidebar-layout'

export function apply() {
  /* client-only plugin: see lib/client.js */
}
