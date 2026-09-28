/** Profile-backed settings helpers used by the TUI and title provider. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { parse, stringify } from 'yaml'
import type { ThemeMode } from './theme.ts'

export const TUI_SETTINGS_NAMESPACE = 'tui'
export const SESSION_TITLE_SETTINGS_NAMESPACE = 'session-title-llm-tui'

export type SettingsSnapshot = readonly SettingsDescriptor[]

/** Read one active profile entry from an already captured settings snapshot. */
export function settingsValue<T>(snapshot: SettingsSnapshot, namespace: string): T | undefined {
  return snapshot.find(descriptor => descriptor.ns === namespace)?.value as T | undefined
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

export interface LegacySettingsMigration {
  readonly tui?: Readonly<Record<string, unknown>>
  readonly sessionTitle?: Readonly<Record<string, unknown>>
  readonly agentPresetRegistry?: Readonly<Record<string, unknown>>
}

/**
 * Rewrite the removed flat settings sections before DSH's one-shot importer
 * renames the document, and retain the current-shape plugin values so startup
 * can await their native profile writes before accepting input.
 */
export function migrateLegacySettingsDocument(profile: ProfileContext): LegacySettingsMigration {
  const path = join(profile.home, 'settings.yaml')
  if (!existsSync(path)) return {}

  const document = asRecord(parse(readFileSync(path, 'utf8')))
  if (document === undefined) return {}
  let changed = false

  const tui = asRecord(document[TUI_SETTINGS_NAMESPACE])
  const theme = asRecord(tui?.theme) ?? {}
  if (tui !== undefined) {
    const legacyThemeFields: Readonly<Record<string, string>> = {
      themeMode: 'mode',
      themeDark: 'dark',
      themeLight: 'light',
      themeSelected: 'selected',
      themeCustom: 'custom',
      leftPrompt: 'leftPrompt',
      rightPrompt: 'rightPrompt',
    }
    for (const [legacy, current] of Object.entries(legacyThemeFields)) {
      if (!(legacy in tui)) continue
      if (!(current in theme)) theme[current] = tui[legacy]
      delete tui[legacy]
      changed = true
    }
    if (Object.keys(theme).length > 0) tui.theme = theme
  }

  const legacyTitle = asRecord(document['session-title'])
  if (legacyTitle !== undefined) {
    const currentTitle = asRecord(document[SESSION_TITLE_SETTINGS_NAMESPACE])
    document[SESSION_TITLE_SETTINGS_NAMESPACE] = currentTitle === undefined
      ? legacyTitle
      : { ...legacyTitle, ...currentTitle }
    delete document['session-title']
    changed = true
  }

  const legacyAgentPresets = asRecord(document['agent-presets'])
  if (legacyAgentPresets !== undefined) {
    const currentRegistry = asRecord(document['agent-preset-registry']) ?? {}
    if (typeof legacyAgentPresets.default === 'string' && currentRegistry.selectedDefault === undefined) {
      currentRegistry.selectedDefault = legacyAgentPresets.default
    }
    document['agent-preset-registry'] = currentRegistry
    delete document['agent-presets']
    changed = true
  }

  if (changed) writeFileSync(path, stringify(document), 'utf8')

  const migratedTui: Record<string, unknown> = {}
  if (tui !== undefined) {
    for (const field of ['showReasoning', 'maxToolOutputLines', 'keyTools', 'keyReasoning'] as const) {
      if (field in tui) migratedTui[field] = tui[field]
    }
    if (Object.keys(theme).length > 0) migratedTui.theme = theme
  }
  const migratedTitle: Record<string, unknown> = {}
  const title = asRecord(document[SESSION_TITLE_SETTINGS_NAMESPACE])
  if (title !== undefined) {
    if (typeof title.provider === 'string') migratedTitle.provider = title.provider
    if (typeof title.model === 'string') migratedTitle.model = title.model
  }
  const migratedRegistry: Record<string, unknown> = {}
  const registry = asRecord(document['agent-preset-registry'])
  if (typeof registry?.selectedDefault === 'string') {
    migratedRegistry.selectedDefault = registry.selectedDefault
  }
  return {
    ...(Object.keys(migratedTui).length === 0 ? {} : { tui: migratedTui }),
    ...(Object.keys(migratedTitle).length === 0 ? {} : { sessionTitle: migratedTitle }),
    ...(Object.keys(migratedRegistry).length === 0 ? {} : { agentPresetRegistry: migratedRegistry }),
  }
}

/** TUI fields persisted through the profile entry's native Config schema. */
export interface TuiSettingsPatch {
  themeMode?: ThemeMode
  themeDark?: string
  themeLight?: string
  themeSelected?: string
  themeCustom?: Readonly<Record<string, readonly number[]>>
  leftPrompt?: string
  rightPrompt?: string
  keyTools?: string
  keyReasoning?: string
  showReasoning?: boolean
  maxToolOutputLines?: number
}
