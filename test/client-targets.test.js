/*!
 * 兼容性矩阵：对话里出现过的各种渲染形态，右键都应当认到同一条路径；
 * 反例（网页链接、相对路径、斜杠命令）必须认不出来，而不是猜一条错的。
 *
 * client.js 是浏览器 IIFE，这里在 vm 里给最小环境，节点用鸭子类型的假对象。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const origin = 'http://127.0.0.1:50937'

function fakeNode(tagName, attrs = {}, extra = {}) {
  const dataset = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('data-')) {
      dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    }
  }
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    parentElement: null,
    dataset,
    getAttribute(name) {
      return name in attrs ? attrs[name] : null
    },
    ...extra
  }
}

/** 子节点挂在祖先链最底下：右键落在子节点上，路径在祖先身上也一样要认出来。 */
function nest(child, ...parents) {
  let cursor = child
  for (const parent of parents) {
    cursor.parentElement = parent
    cursor = parent
  }
  return child
}

function chain(tagName, attrs, extra, ...parents) {
  return nest(fakeNode(tagName, attrs, extra), ...parents)
}

const body = { nodeType: 1, tagName: 'BODY', parentElement: null, dataset: {}, getAttribute: () => null }

async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let api = null
  const document = {
    baseURI: origin + '/',
    body,
    documentElement: { getAttribute: () => 'zh-CN' },
    createElement: (tag) => fakeNode(tag),
    addEventListener() {},
    removeEventListener() {}
  }
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    document,
    location: { origin, protocol: 'http:', href: origin + '/' },
    navigator: { language: 'zh-CN' },
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {}
    }
  }
  sandbox.window.__ModuleLoader__ = { load: (definition) => { api = definition.factory(() => ({})) } }
  sandbox.window.window = sandbox.window
  sandbox.window.document = document
  sandbox.window.location = sandbox.location
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(api !== null && api.__paths !== undefined, 'client.js 应当导出 __paths')
  return api.__paths
}

const paths = await loadClient()

/** 认出来的路径；认不出来应当是 null，不能是错的那条。 */
function found(node) {
  return paths.pathFromNode(node, null)
}

/* ── 附件/图片/视频 ───────────────────────────────────────────────────── */

test('图片：file URI 与 data-* 上的磁盘位置都能取到', () => {
  assert.equal(found(chain('img', { src: 'file:///C:/work/a%20b.png' })), 'C:/work/a b.png')
  assert.equal(found(chain('img', { src: '/attachments/abc.png', 'data-path': '/Users/example/照片 1.png' })), '/Users/example/照片 1.png')
  assert.equal(found(nest(fakeNode('span'), chain('img', { src: 'file:///tmp/x.jpg' }))), '/tmp/x.jpg')
})

test('图片：页面地址不当成本机文件', () => {
  const image = chain('img', { src: '/attachments/abc.png' })
  assert.equal(paths.imageFilePath(image), null)
  assert.equal(paths.imageTarget(image), image)
})

test('视频与音频：src、source 子元素、srcset 都能认', () => {
  assert.equal(found(chain('video', { src: 'file:///Users/example/clip.mp4' })), '/Users/example/clip.mp4')
  assert.equal(found(chain('source', { src: 'file:///Users/example/a.webm' })), '/Users/example/a.webm')
  assert.equal(found(chain('img', { srcset: '/attachments/s.png 1x, file:///Users/example/大图@2x.png 2x' })), '/Users/example/大图@2x.png')
})

/* ── 链接与芯片 ────────────────────────────────────────────────────────── */

test('链接：问号路径、显式 file 参数、尾斜杠目录', () => {
  assert.equal(found(chain('a', { href: '?path=%2Ftmp%2Fa%20b.md' })), '/tmp/a b.md')
  assert.equal(found(chain('a', { href: '/open?file=%2FUsers%2Fexample%2Fa.md' })), '/Users/example/a.md')
  assert.equal(found(chain('a', { href: '/Users/example/Documents/' })), '/Users/example/Documents')
  assert.equal(found(chain('a', { href: `/Users/example/${'深目录/'.repeat(3)}说明.md` })), `/Users/example/${'深目录/'.repeat(3)}说明.md`)
})

test('链接：行号后缀不进路径', () => {
  assert.equal(found(chain('a', { href: '/Users/example/repo/file.cjs#L12' })), '/Users/example/repo/file.cjs')
  assert.equal(found(chain('a', { href: '/Users/example/repo/file.cjs#L12-L20' })), '/Users/example/repo/file.cjs')
  assert.equal(found(chain('a', { href: '/Users/example/repo/file.cjs:12:3' })), '/Users/example/repo/file.cjs')
})

test('附件卡片：点在预览图上，路径仍来自外层的链接', () => {
  const card = chain('a', { href: '/open?path=%2Ftmp%2F报告.pdf' })
  const preview = nest(fakeNode('img', { src: '/attachments/report-1.png' }), card)
  assert.equal(found(preview), '/tmp/报告.pdf')
  assert.equal(paths.linkTarget(preview), origin + '/open?path=%2Ftmp%2F报告.pdf')
})

test('停在 body 处：不把整页当成一个链接', () => {
  const node = nest(fakeNode('span'), body)
  assert.equal(paths.pathFromNode(node, null), null)
})

test('芯片：路径只在 title 上，或只在组件 props 里', () => {
  assert.equal(found(chain('span', { title: '/Users/example/a.md' })), '/Users/example/a.md')
  const fiber = { memoizedProps: { file: { path: 'C:\\work\\报告.pdf' } }, return: null }
  const chip = chain('span', {}, { __reactFiber$1: fiber })
  assert.equal(found(chip), 'C:\\work\\报告.pdf')
  const deepFiber = { memoizedProps: {}, return: { memoizedProps: { path: '/Users/example/b.md' }, return: null } }
  assert.equal(found(chain('span', {}, { __reactFiber$2: deepFiber })), '/Users/example/b.md')
})

test('Windows：盘符、UNC、带空格与中文', () => {
  assert.equal(found(chain('div', { 'data-path': 'C:\\work\\v1.2 final.md' })), 'C:\\work\\v1.2 final.md')
  assert.equal(found(chain('div', { 'data-path': 'C:/work/混合 目录/a.md' })), 'C:/work/混合 目录/a.md')
  assert.equal(found(chain('div', { title: '\\\\server\\share\\a.md' })), '\\\\server\\share\\a.md')
})

/* ── 反例：宁可没有菜单，也不要指向错的文件 ───────────────────────────── */

test('反例：网页链接、协议、锚点、斜杠命令一律不认', () => {
  for (const href of [
    'https://example.com/a.md',
    'http://example.com/a.md',
    'mailto:someone@example.com',
    'javascript:void(0)',
    'blob:http://127.0.0.1:50937/abc',
    'data:text/plain,hello',
    '#L12',
    '/help',
    '/settings'
  ]) {
    assert.equal(found(chain('a', { href })), null, href)
  }
})

test('反例：相对路径不折算成根目录的文件', () => {
  for (const href of ['./a.md', '../a.md', '~/Documents/a.md', 'docs/a.md', 'a.md']) {
    assert.equal(found(chain('a', { href })), null, href)
  }
})

test('反例：非路径属性的文字不认', () => {
  assert.equal(found(chain('div', { title: '按钮' })), null)
  assert.equal(found(chain('div', { 'data-id': '12345' })), null)
})

/* ── 边界与稳定性 ─────────────────────────────────────────────────────── */

test('畸形百分号、控制字符、超长值都不抛错', () => {
  assert.equal(found(chain('div', { 'data-path': '/tmp/a%E0%A4%A.md' })), '/tmp/a%E0%A4%A.md')
  assert.equal(found(chain('a', { href: '/tmp/%E0%A4%A.md' })), '/tmp/%E0%A4%A.md')
  const long = '/tmp/' + 'a'.repeat(4000) + '.md'
  assert.equal(found(chain('div', { 'data-path': long })), long)
  assert.equal(found(chain('div', { 'data-path': '/tmp/a\u0000b.md' })), '/tmp/a\u0000b.md')
})

test('属性不是字符串时不抛错', () => {
  const weird = chain('div', {}, { getAttribute: () => 42, dataset: { path: 42 } })
  assert.equal(found(weird), null)
})

test('目录判断：形状与数据属性两种来源', () => {
  assert.equal(paths.guessDirectory('/Users/example/Documents'), true)
  assert.equal(paths.guessDirectory('/Users/example/a.md'), false)
  assert.equal(paths.guessDirectory('/Users/example/.config'), true)
  assert.equal(paths.directoryHint(chain('div', { 'data-appearance': 'folder' })), true)
  assert.equal(paths.directoryHint(chain('div', { 'data-type': 'file' })), false)
  const fiber = { memoizedProps: { reference: { appearance: 'directory' } }, return: null }
  assert.equal(paths.directoryHint(chain('span', {}, { __reactFiber$3: fiber })), true)
})

test('引用文字：带空格用 @""，不带空格用 @', () => {
  assert.equal(paths.referenceText('/Users/example/a.md'), '@/Users/example/a.md')
  assert.equal(paths.referenceText('/Users/example/a b.md'), '@"/Users/example/a b.md"')
})

test('网址目标：站内补全、协议相对补全', () => {
  assert.equal(paths.linkTarget(chain('a', { href: '/x/y' })), origin + '/x/y')
  assert.equal(paths.linkTarget(chain('a', { href: '//cdn.example.com/x' })), 'http:' + '//cdn.example.com/x')
  assert.equal(paths.linkTarget(chain('a', { href: '/t?path=%2Ftmp%2Fa.md' })), origin + '/t?path=%2Ftmp%2Fa.md')
  assert.equal(paths.linkTarget(chain('a', { href: 'mailto:a@b.c' })), null)
})

/* ── 稳定性：脏属性、深链、随机输入都不能抛错 ─────────────────────────── */

test('属性值不是字符串时目录判断也不抛错', () => {
  const weird = chain('div', {}, { getAttribute: () => 42 })
  assert.equal(paths.directoryHint(weird), undefined)
})

test('深链正常结束：500 层祖先不会卡住', () => {
  let node = fakeNode('span', { title: '/Users/example/深处.md' })
  for (let i = 0; i < 500; i += 1) node = nest(node, fakeNode('div'))
  assert.equal(found(node), '/Users/example/深处.md')
})

test('随机脏属性：不抛错，认出来的也一定是绝对路径', () => {
  const values = [
    '', ' ', '?', '#', '/', '//', '\\\\', 'C:', 'C:', 'http://', 'file://', 'file:///',
    '/tmp/a.md', 'C:\\a.md', '\\\\srv\\share\\a.md', '~/a', './a', '../a', '/a?path=%2Fb',
    '%E0%A4%A', '\u0000', 'a'.repeat(300), '中文 路径.md', '😀/x.png', 'data:text/plain,x',
    'javascript:1', 'mailto:a@b', 'blob:x', 'srcset', 'a, b, c', '/+/%2F'
  ]
  let seed = 20251028
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed
  }
  const attrs = ['href', 'src', 'srcset', 'title', 'data-path', 'data-file-path', 'data-href', 'data-src', 'data-id']
  for (let round = 0; round < 2000; round += 1) {
    const picked = {}
    const count = 1 + (next() % 3)
    for (let i = 0; i < count; i += 1) {
      picked[attrs[next() % attrs.length]] = values[next() % values.length]
    }
    const tag = ['a', 'img', 'video', 'source', 'div', 'span'][next() % 6]
    const target = chain(tag, picked)
    const value = paths.pathFromNode(target, null)
    assert.ok(value === null || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'), JSON.stringify(picked) + ' → ' + value)
    paths.imageFilePath(target)
    paths.imageTarget(target)
    paths.linkTarget(target)
    paths.directoryHint(target)
    paths.srcsetPath(target)
  }
})
