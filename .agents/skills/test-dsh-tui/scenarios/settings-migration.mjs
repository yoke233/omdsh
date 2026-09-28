import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Exercises legacy settings import, live prompt updates, preset changes, and profile persistence. */
export async function run(tui) {
  const legacySettings = join(tui.config.dshHome, 'settings.yaml')
  writeFileSync(legacySettings, 'tui:\n  themeMode: selected\n  themeSelected: light-catppuccin\n  leftPrompt: "${mode} UPGRADE_LEGACY_PROMPT"\nsession-title:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n')
  await tui.start()
  await tui.waitForOutput(/欢迎回来|Welcome back/, { timeoutMs: 60000, label: 'migrated welcome' })
  await tui.waitForSlashMenu()
  await tui.waitFor(() => existsSync(`${legacySettings}.imported`), 15000, 'legacy settings imported once')
  await tui.waitForScreen(/^.*\bstandard[^\n]*UPGRADE_LEGACY_PROMPT\s*$/m, { timeoutMs: 15000, label: 'volatile legacy prompt applied' })
  tui.key('\x1b')
  tui.key('\x15')
  const pid = tui.pid()
  tui.submit('/mode minimal')
  await tui.waitForScreen(/^.*\bminimal[^\n]*UPGRADE_LEGACY_PROMPT\s*$/m, { timeoutMs: 30000, label: 'minimal preset mounted' })
  tui.submit('/mode standard')
  await tui.waitForScreen(/^.*\bstandard[^\n]*UPGRADE_LEGACY_PROMPT\s*$/m, { timeoutMs: 30000, label: 'standard preset restored' })
  const offset = tui.mark()
  tui.submit('/theme dark-catppuccin')
  await tui.waitFor(() => /selected: dark-catppuccin/.test(readFileSync(join(tui.config.dshHome, 'profiles', 'tui', 'cordis.patch.yml'), 'utf8')), 15000, 'theme persisted')
  assert.doesNotMatch(tui.plainOutput(offset), /设置保存失败|Settings save failed/)
  const patch = readFileSync(join(tui.config.dshHome, 'profiles', 'tui', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /dark-catppuccin/)
  assert.match(patch, /session-title-llm-tui/)
  assert.match(patch, /deepseek-v4-flash/)
  tui.submit('/settings')
  await tui.waitForScreen(/deepseek-official\/deepseek-v4-flash/, { timeoutMs: 15000, label: 'migrated title model visible in settings' })
  const screenshot = await tui.snapshot('upgrade-settings')
  tui.key('\x1b')
  assert.equal(tui.pid(), pid)
  return { legacySettingsMigrated: true, volatilePromptApplied: true, presetSwitchRoundTrip: true, themePersistedInProfile: true, settingsPanelRendered: true, sameProcess: true, pid, screenshot }
}
