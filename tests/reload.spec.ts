import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot, loadProfile } from '@deepseek-ai/dsh-app-boot'
import {
  ProfileReloadRuntime,
  assertEntriesPreserved,
  captureLauncherPatches,
  findLoadedEntry,
  forceReloadLoadedModule,
  profileOwnedPatches,
  resolveLoadedModuleUrl,
  type ProfileReloadGeneration,
  type ReloadableHmr,
  type ReloadableModuleLoader,
} from '../src/reload.ts'

function generation(
  bundles: readonly string[],
  bundlePatches: readonly object[] = [],
  profilePatches: readonly object[] = [],
  homePatches: readonly object[] = [],
): ProfileReloadGeneration {
  return {
    bundles,
    bundlePatches,
    profilePatches,
    homePatches,
  } as ProfileReloadGeneration
}

function tuiVersion(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'version' in value && typeof value.version === 'string') {
    return value.version
  }
  throw new Error('fixture TUI service has no string version')
}

describe('profile reload runtime', () => {
  it('finds the nested TUI entry across the complete loader tree', () => {
    const base = { parent: { tree: { ctx: { baseUrl: 'file:///profile/' } } } }
    const entries = [
      { ...base, options: { id: 'include', name: 'cordis:include' } },
      { ...base, options: { id: 'tui', name: '@yoke233/omdsh' } },
    ]
    assert.equal(findLoadedEntry(entries, 'tui'), entries[1])
  })

  it('resolves Node 22 and Node 24 plugin module URLs', async () => {
    const v1 = {
      version: 'v1',
      loadCache: new Map(),
      resolve: async (specifier: string, parentURL: string) => ({ url: `${parentURL}${specifier}` }),
    } as ReloadableModuleLoader
    const v2 = {
      version: 'v2',
      loadCache: new Map(),
      resolveSync: (parentURL: string, request: { specifier: string }) => ({ url: `${parentURL}${request.specifier}` }),
    } as ReloadableModuleLoader

    assert.equal(await resolveLoadedModuleUrl(v1, 'tui.js', 'file:///app/'), 'file:///app/tui.js')
    assert.equal(await resolveLoadedModuleUrl(v2, 'tui.js', 'file:///app/'), 'file:///app/tui.js')
  })

  it('forces HMR to replace the cached live TUI module', async () => {
    const url = 'file:///app/tui.js'
    const first = { generation: 1 }
    const cache = new Map<string, unknown>([[url, first]])
    const internal = {
      version: 'v1',
      loadCache: cache,
      resolve: async () => ({ url }),
    } as ReloadableModuleLoader
    const hmr = {
      stashed: new Set<string>(),
      partialReload: async () => {
        assert.deepEqual([...hmr.stashed], [url])
        cache.set(url, { generation: 2 })
      },
    } satisfies ReloadableHmr

    await forceReloadLoadedModule(hmr, internal, url)
    assert.notEqual(cache.get(url), first)
  })

  it('reports a failed HMR replacement instead of claiming reload succeeded', async () => {
    const url = 'file:///app/tui.js'
    const cache = new Map<string, unknown>([[url, { generation: 1 }]])
    const internal = {
      version: 'v1',
      loadCache: cache,
      resolve: async () => ({ url }),
    } as ReloadableModuleLoader
    const hmr = {
      stashed: new Set<string>(),
      partialReload: async () => undefined,
    } satisfies ReloadableHmr

    await assert.rejects(forceReloadLoadedModule(hmr, internal, url), /did not replace the live module/)
  })
  it('captures launch-only overlays after a profile prefix mutated during Include application', () => {
    const initial = generation(
      ['base', 'tui'],
      [{ insert: [{ id: 'base' }] }],
      [{ id: 'base', config: { title: 'custom' } }],
      [{ id: 'tools', config: { mode: 'native' } }],
    )
    const launcher = [{ id: 'agent-preset-registry', config: { default: 'standard' } }]
    const mounted = [...profileOwnedPatches(initial), ...launcher] as never[]
    const firstInsert = (mounted[0] as { insert: Array<{ config?: unknown }> }).insert[0]!
    firstInsert.config = { title: 'custom' }

    const captured = captureLauncherPatches(mounted, initial)

    assert.deepEqual(captured, launcher)
    assert.notEqual(captured, launcher)
    assert.throws(
      () => captureLauncherPatches([{ id: 'short' }] as never[], initial),
      /mounted patch stack is shorter/,
    )
  })

  it('serializes concurrent requests and applies fresh profile layers before launcher overlays', async () => {
    const initial = generation(['base', 'tui'], [{ id: 'base' }])
    const next = generation(
      ['base', 'tui', 'extra'],
      [{ id: 'base' }, { insert: [{ id: 'extra' }] }],
      [{ id: 'extra', config: { enabled: true } }],
    )
    let loads = 0
    let applies = 0
    let applied: readonly unknown[] = []
    const gate = Promise.withResolvers<void>()
    const runtime = new ProfileReloadRuntime({
      initial,
      launcherPatches: [{ id: 'hard-override', disabled: true }] as never[],
      load: () => {
        loads += 1
        return next
      },
      apply: async (patches) => {
        applies += 1
        applied = patches
        await gate.promise
      },
    })

    const first = runtime.reload()
    const second = runtime.reload()
    assert.equal(first, second)
    assert.equal(loads, 1)
    assert.equal(applies, 1)
    gate.resolve()

    const result = await first
    assert.equal(loads, 2)
    assert.equal(applies, 2)
    assert.equal(result.changed, true)
    assert.deepEqual(result.addedBundles, ['extra'])
    assert.deepEqual(result.removedBundles, [])
    assert.deepEqual(applied, [
      { id: 'base' },
      { insert: [{ id: 'extra' }] },
      { id: 'extra', config: { enabled: true } },
      { id: 'hard-override', disabled: true },
    ])
  })

  it('reports an unchanged generation without asking the loader to update', async () => {
    const initial = generation(['base'], [{ id: 'base' }])
    let committed = false
    const runtime = new ProfileReloadRuntime({
      initial,
      launcherPatches: [],
      load: () => initial,
      apply: async (_patches, _previous, changed) => {
        committed = changed
      },
    })

    const result = await runtime.reload()
    assert.equal(result.changed, false)
    assert.equal(committed, false)
  })

  it('does not advance bundle state when the transactional apply fails', async () => {
    const initial = generation(['base'])
    let next = generation(['base', 'bad'])
    let fail = true
    const runtime = new ProfileReloadRuntime({
      initial,
      launcherPatches: [],
      load: () => next,
      apply: async () => {
        if (fail) throw new Error('candidate rejected')
      },
    })

    await assert.rejects(runtime.reload(), /candidate rejected/)
    fail = false
    next = generation(['base', 'good'])

    const result = await runtime.reload()
    assert.deepEqual(result.addedBundles, ['good'])
    assert.deepEqual(result.removedBundles, [])
  })

  it('rejects changes to rows that own the active TUI lifecycle', () => {
    const previous = [
      { insert: [
        { id: 'tui', name: '@yoke233/omdsh' },
        { id: 'commands', name: '@deepseek-ai/dsh-commands' },
      ] },
    ] as never[]
    const safe = [
      ...previous,
      { insert: [{ id: 'extra', name: 'extra-plugin' }] },
    ] as never[]
    const unsafe = [
      ...previous,
      { id: 'commands', disabled: true },
    ] as never[]

    assert.doesNotThrow(() => assertEntriesPreserved(previous, safe, new Set(['tui', 'commands'])))
    assert.throws(
      () => assertEntriesPreserved(previous, unsafe, new Set(['tui', 'commands'])),
      /candidate changes active TUI dependency row "commands"/,
    )
  })

  it('adds and removes a bundle through the real root Include without replacing unchanged fibers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-tui-reload-'))
    const profileDir = join(home, 'profiles', 'tui')
    const modulesDir = join(profileDir, 'node_modules', 'reload-fixture')
    mkdirSync(modulesDir, { recursive: true })
    const rootConfig = join(profileDir, 'cordis.yml')
    const profilePatch = join(profileDir, 'cordis.patch.yml')
    const profileManifest = join(profileDir, 'package.json')
    const sentinelPlugin = join(profileDir, 'sentinel.mjs')
    const tuiPlugin = join(profileDir, 'tui.mjs')
    const probePlugin = join(modulesDir, 'probe.mjs')
    const require = createRequire(import.meta.url)
    const hmrEntry = require.resolve('@deepseek-ai/dsh-hmr')
    const timerEntry = createRequire(hmrEntry).resolve('@deepseek-ai/cordis-plugin-timer')
    const reloadEntry = pathToFileURL(resolve('src/reload.ts')).href
    writeFileSync(rootConfig, '[]\n')
    writeFileSync(profileManifest, JSON.stringify({
      name: 'dsh-profile-tui',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, undefined, 2) + '\n')
    writeFileSync(sentinelPlugin, [
      'export function apply(ctx) {',
      '  ctx.provide("reloadSentinel", Object.freeze({ active: true }))',
      '}',
      '',
    ].join('\n'))
    writeFileSync(tuiPlugin, [
      'export function apply(ctx) {',
      '  ctx.provide("tui", { version: "v1" })',
      '}',
      '',
    ].join('\n'))
    writeFileSync(probePlugin, [
      'export function apply(ctx) {',
      '  ctx.provide("reloadProbe", "active")',
      '}',
      '',
    ].join('\n'))
    writeFileSync(profilePatch, [
      '- insert:',
      '    - id: timer',
      `      name: ${JSON.stringify(pathToFileURL(timerEntry).href)}`,
      '    - id: hmr',
      `      name: ${JSON.stringify(pathToFileURL(hmrEntry).href)}`,
      '      config:',
      '        root: []',
      '    - id: tui-reload',
      `      name: ${JSON.stringify(reloadEntry)}`,
      '    - id: sentinel',
      `      name: ${JSON.stringify(pathToFileURL(sentinelPlugin).href)}`,
      '    - id: tui',
      `      name: ${JSON.stringify(pathToFileURL(tuiPlugin).href)}`,
      '',
    ].join('\n'))
    writeFileSync(join(modulesDir, 'package.json'), JSON.stringify({
      name: 'reload-fixture',
      version: '1.0.0',
      type: 'module',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, undefined, 2) + '\n')
    writeFileSync(join(modulesDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: reload-probe',
      `      name: ${JSON.stringify(pathToFileURL(probePlugin).href)}`,
      '',
    ].join('\n'))

    const initial = loadProfile('test', 'tui', process.argv[1]!, home)
    const ctx = await boot(
      'test',
      rootConfig,
      [...initial.layers.flatMap(layer => layer.patches), ...initial.patches],
      (host) => {
        // The product launcher exposes Node's module-loader internals. This
        // fixture only exercises exact config watches, so an empty cache is
        // sufficient and keeps the unit process independent of that hook.
        (host.loader as unknown as { internal: unknown }).internal = {
          version: 'v1',
          loadCache: new Map(),
          import: (specifier: string) => import(specifier),
        }
      },
      import.meta.url,
    )
    try {
      const sentinel = ctx.get('reloadSentinel')
      const tui = ctx.get('tui')
      assert.deepEqual(sentinel, { active: true })
      assert.equal(tuiVersion(tui), 'v1')
      writeFileSync(profileManifest, JSON.stringify({
        name: 'dsh-profile-tui',
        private: true,
        dependencies: { 'reload-fixture': '1.0.0' },
        dsh: { profile: { bundles: ['reload-fixture'] } },
      }, undefined, 2) + '\n')

      const added = await ctx.tuiReload.reload()
      assert.deepEqual(added.addedBundles, ['reload-fixture'])
      assert.equal(ctx.get('reloadProbe'), 'active')
      assert.equal(ctx.get('reloadSentinel'), sentinel)

      writeFileSync(tuiPlugin, [
        'export function apply(ctx) {',
        '  ctx.provide("tui", { version: "v2" })',
        '}',
        '',
      ].join('\n'))

      writeFileSync(join(modulesDir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: reload-probe',
        `      name: ${JSON.stringify(pathToFileURL(probePlugin).href)}`,
        '      disabled: true',
        '',
      ].join('\n'))
      const updated = await ctx.tuiReload.reload()
      assert.equal(updated.changed, true)
      assert.deepEqual(updated.addedBundles, [])
      assert.deepEqual(updated.removedBundles, [])
      assert.equal(ctx.get('reloadProbe'), undefined)
      assert.equal(ctx.get('reloadSentinel'), sentinel)
      assert.equal(ctx.get('tui'), tui)
      assert.equal(tuiVersion(ctx.get('tui')), 'v1')


      writeFileSync(profileManifest, JSON.stringify({
        name: 'dsh-profile-tui',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [] } },
      }, undefined, 2) + '\n')
      const removed = await ctx.tuiReload.reload()
      assert.deepEqual(removed.removedBundles, ['reload-fixture'])
      assert.equal(ctx.get('reloadProbe'), undefined)
      assert.equal(ctx.get('reloadSentinel'), sentinel)
      assert.equal(ctx.get('tui'), tui)
      assert.equal(tuiVersion(ctx.get('tui')), 'v1')
    } finally {
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
