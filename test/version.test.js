/*!
 * 版本号只有一个真源：package.json。诊断里写死的旧版本号曾经让排查走偏。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { PKG_VERSION } from '../index.js'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('诊断版本号取自 package.json', () => {
  assert.equal(PKG_VERSION, pkg.version)
})

test('客户端 ready 回执与 package.json 版本一致', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const match = source.match(/report\("ready ([0-9A-Za-z.-]+)"\)/u)
  assert.ok(match !== null, 'client.js 应当有 ready 回执')
  assert.equal(match[1], pkg.version)
})

test('CHANGELOG 顶部就是当前版本', async () => {
  const log = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const match = log.match(/^## ([0-9A-Za-z.-]+)/u)
  assert.ok(match !== null)
  assert.equal(match[1], pkg.version)
})

test('自用版安装文档显示当前版本，不引导安装 npm 上游包', async () => {
  for (const file of ['README.md', 'WINDOWS.md']) {
    const doc = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    const headingVersion = doc.split('\n')[0].match(/[0-9]+\.[0-9]+\.[0-9]+-lhg(?:\.[0-9]+)?/u)
    assert.equal(headingVersion?.[0], pkg.version, `${file} 的标题版本应与包一致`)
    assert.ok(doc.includes('github:davidLi17/dsh-chat-link-actions#main'), `${file} 应提供自用 Fork 安装源`)
    assert.doesNotMatch(doc, /dsh plugin install dsh-chat-link-actions/u)
  }
})


test('rc1 支持声明与真实宿主检查入口一致', () => {
  assert.equal(pkg.dsh.compatibility.dsh, '0.2.2-rc.1')
  assert.equal(pkg.dsh.compatibility.dshReleases['0.2.2-rc.1'], 'compatible')
  assert.equal(pkg.scripts['test:host'], 'node scripts/check-dsh-host.mjs')
})
