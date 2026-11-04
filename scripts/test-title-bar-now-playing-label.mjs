import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

const source = await readFile(new URL('../src/components/TitleBar.vue', import.meta.url), 'utf8')
const script = compileScript(parse(source).descriptor, {
  id: 'title-bar-now-playing-label-test', genDefaultAs: 'component', inlineTemplate: true,
})
const compiled = ts.transpileModule(script.content, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function element(type) {
  return { type, children: [], props: {} }
}

const renderer = vue.createRenderer({
  createElement: element, createText: text => ({ text }), createComment: text => ({ text }),
  setText(node, text) { node.text = text },
  setElementText(node, text) { node.text = text; node.children = [] },
  patchProp(node, key, _, value) { node.props[key] = value },
  parentNode: node => node.parent ?? null,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  insert(node, parent, anchor = null) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
})

// 淡入淡出容器在测试里只要把默认插槽透出来即可
const PassThrough = { props: ['name', 'mode'], setup(_, { slots }) { return () => slots.default?.() } }
const runtime = { ...vue, Transition: PassThrough, TransitionGroup: PassThrough }

function findNodes(node, className, found = []) {
  if (node?.props?.class === className) found.push(node)
  for (const child of node?.children ?? []) findNodes(child, className, found)
  return found
}

function textOf(node) {
  const texts = node.children.map(child => child.text ?? textOf(child)).join('')
  return `${node.text ?? ''}${texts}`
}

async function mount({ showNowPlayingTitle = true, hasPlaybackSession = true } = {}) {
  const settings = vue.reactive({ showNowPlayingTitle })
  const nativeWindow = {
    isMaximized: () => Promise.resolve(false),
    isFullscreen: () => Promise.resolve(false),
    onResized: async () => () => {},
  }
  const dependencies = {
    vue: runtime, 'vue-i18n': { useI18n: () => ({ t: key => key }) },
    '@tauri-apps/api/window': { getCurrentWindow: () => nativeWindow },
    '@/modules/shortcuts/platform': { isMacPlatform: false },
    '@/stores/settings': { useSettingsStore: () => settings },
  }
  const component = new Function(
    'require', 'exports', 'document', 'setTimeout', 'clearTimeout', `${compiled}\nreturn component`,
  )(name => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, {}, { documentElement: { classList: { toggle() {}, remove() {} } } },
    callback => callback, id => id,
  )
  const props = vue.reactive({
    nowPlaying: true, hasPlaybackSession,
    trackName: '人 (Special Edition)', albumName: '新地球',
  })
  const root = { children: [] }
  const app = renderer.createApp({ setup: () => () => vue.h(component, props) })
  app.mount(root)
  await vue.nextTick()
  return { settings, stop: () => app.unmount(), nodes: () => root }
}

let total = 0, failed = 0
async function test(name, run) {
  total++
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`) }
}

await test('播放页标题开启时顶栏显示"正在播放"', async () => {
  const view = await mount()
  try {
    const labels = findNodes(view.nodes(), 'tb-np-label')
    assert.equal(labels.length, 1, '顶栏应有一个标题元素')
    assert.equal(textOf(labels[0]), 'player.now_playing')
  } finally { view.stop() }
})

await test('关闭播放页标题后顶栏不再显示该文字，专辑行保留', async () => {
  const view = await mount({ showNowPlayingTitle: false })
  try {
    assert.equal(findNodes(view.nodes(), 'tb-np-label').length, 0)
    assert.equal(findNodes(view.nodes(), 'tb-np-track').length, 1)
  } finally { view.stop() }
})

await test('开关中途关闭即时撤掉顶栏文字', async () => {
  const view = await mount()
  try {
    assert.equal(findNodes(view.nodes(), 'tb-np-label').length, 1)
    view.settings.showNowPlayingTitle = false
    await vue.nextTick()
    assert.equal(findNodes(view.nodes(), 'tb-np-label').length, 0)
    view.settings.showNowPlayingTitle = true
    await vue.nextTick()
    assert.equal(findNodes(view.nodes(), 'tb-np-label').length, 1)
  } finally { view.stop() }
})

await test('未播放时标题显示"未播放"且同样受开关控制', async () => {
  const view = await mount({ hasPlaybackSession: false })
  try {
    const labels = findNodes(view.nodes(), 'tb-np-label')
    assert.equal(labels.length, 1, '顶栏应有一个标题元素')
    assert.equal(textOf(labels[0]), 'player.not_playing')
    view.settings.showNowPlayingTitle = false
    await vue.nextTick()
    assert.equal(findNodes(view.nodes(), 'tb-np-label').length, 0)
  } finally { view.stop() }
})

console.log(`Title bar now-playing label: ${total - failed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
