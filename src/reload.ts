import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-hmr'
import {
  composeEntries,
  loadOptionalPatches,
  loadProfile,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'

/** One parsed Cordis patch from a profile, bundle, or launcher overlay. */
type ProfilePatch = Profile['patches'][number]

/** Profile-owned layers that can change while the TUI process remains live. */
export interface ProfileReloadGeneration {
  readonly bundles: readonly string[]
  readonly bundlePatches: readonly ProfilePatch[]
  readonly profilePatches: readonly ProfilePatch[]
  readonly homePatches: readonly ProfilePatch[]
}

/** Observable result of one committed profile recomposition. */
export interface ProfileReloadResult {
  readonly changed: boolean
  readonly bundles: readonly string[]
  readonly addedBundles: readonly string[]
  readonly removedBundles: readonly string[]
}

/** Minimal Node module-loader surface needed to resolve one loaded plugin entry. */
export type ReloadableModuleLoader = {
  readonly version: 'v1'
  readonly loadCache: { get(url: string): unknown }
  resolve(specifier: string, parentURL: string, attributes: ImportAttributes): Promise<{ url: string }>
} | {
  readonly version: 'v2'
  readonly loadCache: { get(url: string): unknown }
  resolveSync(parentURL: string, request: { specifier: string; attributes: ImportAttributes }): { url: string }
}

/** Runtime HMR hooks used for module and profile refresh. */
export interface ReloadableHmr {
  readonly stashed: Set<string>
  partialReload(): Promise<void>
}

/** Loader entry metadata needed to find and resolve a nested live plugin. */
export interface ReloadableEntry {
  readonly options: { readonly id?: unknown; readonly name: string }
  readonly parent: { readonly tree: { readonly ctx: { readonly baseUrl?: string } } }
}

/** Find an entry across the complete Loader tree rather than one local group. */
export function findLoadedEntry(entries: Iterable<ReloadableEntry>, id: string): ReloadableEntry | undefined {
  return [...entries].find(entry => entry.options.id === id)
}

/** Resolve one configured plugin specifier exactly like Cordis HMR does. */
export async function resolveLoadedModuleUrl(
  internal: ReloadableModuleLoader,
  specifier: string,
  parentURL: string,
): Promise<string> {
  if (internal.version === 'v1') return (await internal.resolve(specifier, parentURL, {})).url
  return internal.resolveSync(parentURL, { specifier, attributes: {} }).url
}

/** Force Cordis HMR to evict, re-import, and replace one loaded plugin module. */
export async function forceReloadLoadedModule(
  hmr: ReloadableHmr,
  internal: ReloadableModuleLoader,
  url: string,
): Promise<void> {
  const previous = internal.loadCache.get(url)
  if (previous === undefined) throw new Error(`tui reload: module is not present in the live loader cache: ${url}`)
  hmr.stashed.add(url)
  await hmr.partialReload()
  const current = internal.loadCache.get(url)
  if (current === undefined || current === previous) {
    throw new Error(`tui reload: Cordis HMR did not replace the live module: ${url}`)
  }
}

/** Dependencies used by the serialized reload coordinator. */
export interface ProfileReloadRuntimeOptions {
  readonly initial: ProfileReloadGeneration
  readonly launcherPatches: readonly ProfilePatch[]
  readonly load: () => ProfileReloadGeneration
  readonly apply: (
    patches: readonly ProfilePatch[],
    previousPatches: readonly ProfilePatch[],
    changed: boolean,
  ) => Promise<void>
}

/** Flatten the profile-owned prefix in the same order used by the dsh launcher. */
export function profileOwnedPatches(generation: ProfileReloadGeneration): ProfilePatch[] {
  return structuredClone([
    ...generation.bundlePatches,
    ...generation.profilePatches,
    ...generation.homePatches,
  ])
}

/**
 * Retain launch-only overlays after the profile-owned patch count. Include
 * applies later id patches directly to rows held by earlier `insert` patches,
 * so the mounted prefix may already differ from a fresh disk parse even though
 * both describe the same generation. The launcher preserves top-level patch
 * order and count while mounting.
 */
export function captureLauncherPatches(
  mounted: readonly ProfilePatch[],
  initial: ProfileReloadGeneration,
): ProfilePatch[] {
  const profilePatchCount = profileOwnedPatches(initial).length
  if (mounted.length < profilePatchCount) {
    throw new Error('tui reload: mounted patch stack is shorter than the on-disk profile generation')
  }
  return structuredClone(mounted.slice(profilePatchCount))
}

/** Reject a candidate that would replace the TUI or one of its active service providers. */
export function assertEntriesPreserved(
  previousPatches: readonly ProfilePatch[],
  candidatePatches: readonly ProfilePatch[],
  protectedIds: ReadonlySet<string>,
): void {
  const index = (patches: readonly ProfilePatch[]): Map<string, unknown> => new Map(
    composeEntries([[...structuredClone(patches)]])
      .filter(entry => typeof entry.id === 'string')
      .map(entry => [entry.id!, entry]),
  )
  const previous = index(previousPatches)
  const candidate = index(candidatePatches)
  for (const id of protectedIds) {
    if (!isDeepStrictEqual(previous.get(id), candidate.get(id))) {
      throw new Error(`tui reload: candidate changes active TUI dependency row ${JSON.stringify(id)}`)
    }
  }
}

/** Serialize profile recompositions and rerun once when a request arrives mid-apply. */
export class ProfileReloadRuntime {
  private bundles: readonly string[]
  private patches: readonly ProfilePatch[]
  private task: Promise<ProfileReloadResult> | undefined
  private pending = false

  constructor(private readonly options: ProfileReloadRuntimeOptions) {
    this.bundles = Object.freeze([...options.initial.bundles])
    this.patches = Object.freeze([
      ...profileOwnedPatches(options.initial),
      ...structuredClone(options.launcherPatches),
    ])
  }

  /** Re-read bundle membership and all mutable profile layers, then apply once. */
  reload(): Promise<ProfileReloadResult> {
    if (this.task !== undefined) {
      this.pending = true
      return this.task
    }
    const task = this.drain()
    this.task = task
    void task.finally(() => {
      if (this.task === task) this.task = undefined
    }).catch(() => undefined)
    return task
  }

  private async drain(): Promise<ProfileReloadResult> {
    const startedBundles = this.bundles
    let changed = false
    do {
      this.pending = false
      changed = await this.perform() || changed
    } while (this.pending)
    const previous = new Set(startedBundles)
    const current = new Set(this.bundles)
    return Object.freeze({
      changed,
      bundles: this.bundles,
      addedBundles: Object.freeze(this.bundles.filter(name => !previous.has(name))),
      removedBundles: Object.freeze(startedBundles.filter(name => !current.has(name))),
    })
  }

  private async perform(): Promise<boolean> {
    const next = this.options.load()
    const patches = [
      ...profileOwnedPatches(next),
      ...structuredClone(this.options.launcherPatches),
    ]
    const changed = !isDeepStrictEqual(this.patches, patches)
    await this.options.apply(patches, this.patches, changed)
    this.bundles = Object.freeze([...next.bundles])
    this.patches = Object.freeze(structuredClone(patches))
    return changed
  }
}

interface RootIncludeConfig {
  path: string
  patches?: ProfilePatch[]
  [key: string]: unknown
}

interface EntryOwnedFiber {
  entry?: { options: { id?: unknown } }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiReload: TuiReload
  }
}

/**
 * In-process profile recomposition service. The root Include remains mounted,
 * so unchanged rows—including the terminal UI—keep their fibers and state.
 */
export class TuiReload extends Service {
  static inject = ['loader']

  private readonly runtime: ProfileReloadRuntime
  private readonly reloadTuiModule: () => Promise<void>

  constructor(ctx: Context) {
    super(ctx, 'tuiReload')
    const loader = ctx.loader
    const rootEntry = loader.resolve('include')
    if (rootEntry.options.name !== 'cordis:include') {
      throw new Error('tui reload: loader entry "include" is not the dsh root Include')
    }
    const initialConfig = rootEntry.options.config as RootIncludeConfig
    if (typeof initialConfig.path !== 'string') {
      throw new Error('tui reload: root Include has no config path')
    }
    const profileDir = dirname(fileURLToPath(initialConfig.path))
    const profileName = basename(profileDir)
    const home = dirname(dirname(profileDir))
    const installAnchor = process.argv[1] ?? join(profileDir, 'package.json')
    const homePatchPath = join(home, 'cordis.patch.yml')

    const loadGeneration = (): { profile: Profile; generation: ProfileReloadGeneration } => {
      const profile = loadProfile('dsh', profileName, installAnchor, home)
      return {
        profile,
        generation: {
          bundles: profile.layers.map(layer => layer.packageName),
          bundlePatches: profile.layers.flatMap(layer => layer.patches),
          profilePatches: profile.patches,
          homePatches: loadOptionalPatches('dsh', homePatchPath) ?? [],
        },
      }
    }

    const loaded = loadGeneration()
    const initial = loaded.generation
    const launcherPatches = captureLauncherPatches(initialConfig.patches ?? [], initial)
    this.reloadTuiModule = async () => {
      const tuiEntry = findLoadedEntry(loader.entries() as Iterable<ReloadableEntry>, 'tui')
      if (tuiEntry === undefined) throw new Error('tui reload: active TUI entry is not mounted')
      const parentURL = tuiEntry.parent.tree.ctx.baseUrl
      if (parentURL === undefined) throw new Error('tui reload: active TUI entry has no base URL')
      const internal = loader.internal as ReloadableModuleLoader | undefined
      if (internal === undefined) throw new Error('tui reload: live module loader internals are unavailable')
      const hmr = ctx.get('hmr', false) as unknown as ReloadableHmr | undefined
      if (hmr === undefined || !(hmr.stashed instanceof Set) || typeof hmr.partialReload !== 'function') {
        throw new Error('tui reload: Cordis HMR module refresh is unavailable')
      }
      const url = await resolveLoadedModuleUrl(internal, tuiEntry.options.name, parentURL)
      await forceReloadLoadedModule(hmr, internal, url)
    }
    let watcherFiberUid: number | undefined
    let watcherClaim: Promise<void> | undefined
    let watcherDisposers: Array<() => Promise<void>> = []
    const disposeReloadWatchers = async (): Promise<void> => {
      const current = watcherDisposers
      watcherDisposers = []
      await Promise.all(current.map(dispose => dispose()))
    }
    ctx.effect(() => disposeReloadWatchers)
    const ensureReloadWatchers = (): Promise<void> => {
      const currentFiber = ctx.reflect._getImpl('hmr', false)?.fiber
      if (currentFiber === undefined) {
        return Promise.reject(new Error('tui reload: Cordis HMR service is unavailable'))
      }
      if (currentFiber.uid === watcherFiberUid) return Promise.resolve()
      if (watcherClaim !== undefined) return watcherClaim
      const claim = (async () => {
        await disposeReloadWatchers()
        // The launcher-installed config watchers close over the bundle list
        // captured at process start. Restarting HMR retires those watchers;
        // replacements below always call this runtime's fresh composition.
        await currentFiber.restart()
        const activeFiber = ctx.reflect._getImpl('hmr', false)?.fiber
        const hmr = ctx.get('hmr', false)
        if (activeFiber === undefined || activeFiber.uid === null || hmr === undefined) {
          throw new Error('tui reload: Cordis HMR service did not restart')
        }
        const refresh = async (): Promise<void> => {
          await this.runtime.reload()
        }
        watcherDisposers = await Promise.all([
          hmr.watchConfig(loaded.profile.patchPath, refresh),
          hmr.watchConfig(homePatchPath, refresh),
        ])
        watcherFiberUid = activeFiber.uid
      })()
      watcherClaim = claim
      void claim.finally(() => {
        if (watcherClaim === claim) watcherClaim = undefined
      }).catch(() => undefined)
      return claim
    }

    const protectedEntryIds = (): ReadonlySet<string> => {
      const ids = new Set<string>(['tui', 'tui-reload'])
      const tuiFiber = ctx.reflect._getImpl('tui', true)?.fiber
      for (const fiber of [tuiFiber, ...Object.values(tuiFiber?.store ?? {}).map(impl => impl.fiber)]) {
        const id = (fiber as typeof fiber & EntryOwnedFiber | undefined)?.entry?.options.id
        if (typeof id === 'string') ids.add(id)
      }
      return ids
    }

    this.runtime = new ProfileReloadRuntime({
      initial,
      launcherPatches,
      load: () => loadGeneration().generation,
      apply: async (patches, previousPatches, changed) => {
        await ensureReloadWatchers()
        if (changed) {
          assertEntriesPreserved(previousPatches, patches, protectedEntryIds())
          const currentConfig = rootEntry.options.config as RootIncludeConfig
          const { patches: _previousPatches, ...includeConfig } = currentConfig
          await rootEntry.update({
            config: {
              ...includeConfig,
              patches: structuredClone(patches),
            },
          })
          await loader.await()
        }
        // A newly installed bundle may replace the HMR row itself. Reclaim its
        // exact config watchers after the candidate tree has settled.
        await ensureReloadWatchers()
      },
    })
  }

  /** Re-read and transactionally apply the complete live profile. */
  reload(): Promise<ProfileReloadResult> {
    return this.runtime.reload()
  }

  /** Evict and hot-replace the active TUI entry module while keeping the process alive. */
  reloadTuiCode(): Promise<void> {
    return this.reloadTuiModule()
  }
}

export default TuiReload
