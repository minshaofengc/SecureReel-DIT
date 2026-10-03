import { useMemo, useState, type ReactNode } from 'react'
import {
  HASH_ALGORITHMS,
  HASH_ALGORITHM_LABELS,
  LANGUAGES,
  MANIFEST_FORMATS,
  THEMES,
  THEME_MODES,
  type HashAlgorithm,
  type ManifestFormat
} from '@shared/types'
import { Card, Field, PathPicker, Segmented, Note, Toggle } from '../components/ui'
import { SelectBox, type ComboOption } from '../components/ComboBox'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

/**
 * 数字设置输入框。
 *
 * 之前是每敲一个键就写一次数据库：把 "4" 改成 "5" 要途经 "45"、
 * 中间值落库，还可能触发越界值被夹紧后输入框跳字。
 * 现在输入过程只动本地状态，失焦或回车才提交（并夹紧到合法区间）。
 */
function NumberSetting({
  value,
  min,
  max,
  onCommit
}: {
  value: number
  min: number
  max: number
  onCommit: (next: number) => void
}): ReactNode {
  const [draft, setDraft] = useState(String(value))
  const [focused, setFocused] = useState(false)

  // 外部值变了（比如设置从别处被重置）且当前没在编辑，就跟上
  const display = focused ? draft : String(value)

  const commit = (): void => {
    const parsed = Number(draft)
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <input
      className="input"
      type="number"
      min={min}
      max={max}
      value={display}
      onFocus={() => {
        setDraft(String(value))
        setFocused(true)
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
      }}
    />
  )
}

export function SettingsView(): ReactNode {
  const { t } = useI18n()
  const { settings, updateSettings, appInfo, pushToast } = useAppState()
  const [diagBusy, setDiagBusy] = useState(false)

  const hashOptions = useMemo<ComboOption<HashAlgorithm>[]>(
    () => HASH_ALGORITHMS.map((algorithm) => ({ value: algorithm, label: HASH_ALGORITHM_LABELS[algorithm] })),
    []
  )

  const manifestOptions = useMemo<ComboOption<ManifestFormat>[]>(
    () =>
      MANIFEST_FORMATS.map((format) => ({
        value: format,
        label: t(format === 'asc-mhl-2.0' ? 'manifest.asc-mhl-2.0' : 'manifest.mhl-v1')
      })),
    [t]
  )

  return (
    <div className="page">
      <header className="page-head">
        <h2>{t('settings.title')}</h2>
      </header>

      <Card title={t('settings.appearance')}>
        <Field label={t('settings.theme')}>
          <div className="theme-grid">
            {THEMES.map((theme) => (
              <button
                type="button"
                key={theme}
                className="theme-card"
                aria-pressed={settings.themeId === theme}
                onClick={() => void updateSettings({ themeId: theme })}
              >
                <span className="theme-name">{t(`settings.theme.${theme}` as never)}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label={t('settings.mode')}>
          <div>
            <Segmented
              value={settings.themeMode}
              onChange={(next) => void updateSettings({ themeMode: next })}
              options={THEME_MODES.map((mode) => ({ value: mode, label: t(`settings.mode.${mode}` as never) }))}
            />
          </div>
        </Field>

        <Field label={t('settings.language')}>
          <div>
            <Segmented
              value={settings.language}
              onChange={(next) => void updateSettings({ language: next })}
              options={LANGUAGES.map((language) => ({
                value: language,
                label: language === 'zh-CN' ? '简体中文' : 'English'
              }))}
            />
          </div>
        </Field>

        {/*
          提示音。现场拷卡时人往往不在机器跟前，"看一眼屏幕发现跑完了"不现实，
          出错更得立刻被注意到 —— 所以三种声音的音高走向刻意做得不一样，
          不看屏幕也能分出是开始、结束还是出问题。
        */}
        <Field label={t('settings.sound')} hint={t('settings.soundHint')}>
          <Toggle
            checked={settings.soundEnabled}
            label={t('settings.soundEnable')}
            onChange={(next) => void updateSettings({ soundEnabled: next })}
          />
          {settings.soundEnabled && (
            <div className="row-actions" style={{ marginTop: 10 }}>
              <span className="field-label">{t('settings.soundVolume')}</span>
              <input
                type="range"
                className="volume-slider"
                min={0}
                max={100}
                step={5}
                aria-label={t('settings.soundVolume')}
                value={Math.round(settings.soundVolume * 100)}
                onChange={(event) => void updateSettings({ soundVolume: Number(event.target.value) / 100 })}
              />
              <span className="faint" style={{ fontSize: 12 }}>
                {Math.round(settings.soundVolume * 100)}%
              </span>
            </div>
          )}
        </Field>
      </Card>

      <Card title={t('settings.defaults')}>
        <Field label={t('copy.hashAlgorithm')}>
          <SelectBox<HashAlgorithm>
            value={settings.hashAlgorithm}
            ariaLabel={t('copy.hashAlgorithm')}
            options={hashOptions}
            onChange={(next) => void updateSettings({ hashAlgorithm: next })}
          />
        </Field>

        <Field label={t('copy.manifestFormat')}>
          <SelectBox<ManifestFormat>
            value={settings.manifestFormat}
            ariaLabel={t('copy.manifestFormat')}
            options={manifestOptions}
            onChange={(next) => void updateSettings({ manifestFormat: next })}
          />
        </Field>

        <label className="row-actions" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.verifyAfterWrite}
            onChange={(event) => void updateSettings({ verifyAfterWrite: event.target.checked })}
          />
          <span>{t('copy.verifyAfterWrite')}</span>
        </label>
      </Card>

      <Card title={t('settings.performance')}>
        <Field label={t('settings.maxParallelTargets')}>
          <NumberSetting
            value={settings.maxParallelTargets}
            min={1}
            max={8}
            onCommit={(next) => void updateSettings({ maxParallelTargets: next })}
          />
        </Field>

        <div className="faint" style={{ fontSize: 12 }}>
          {t('settings.parallelHint')}
        </div>

        <label className="row-actions" style={{ cursor: 'pointer', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={settings.resumePartialFiles}
            onChange={(event) => void updateSettings({ resumePartialFiles: event.target.checked })}
          />
          <span>{t('settings.resume')}</span>
        </label>
        <div className="faint" style={{ fontSize: 12 }}>
          {t('settings.resumeHint')}
        </div>

        <label className="row-actions" style={{ cursor: 'pointer', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={settings.ejectAfterCopy}
            onChange={(event) => void updateSettings({ ejectAfterCopy: event.target.checked })}
          />
          <span>{t('settings.eject')}</span>
        </label>
      </Card>

      <Card title={t('settings.frames')}>
        <label className="row-actions" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.extractFrames}
            onChange={(event) => void updateSettings({ extractFrames: event.target.checked })}
          />
          <span>{t('settings.extractFrames')}</span>
        </label>
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
          {t('settings.extractFramesHint')}
        </div>

        {settings.extractFrames && (
          <>
            <Field label={t('settings.maxFrames')} hint={t('settings.maxFramesHint')}>
              <NumberSetting
                value={settings.maxFrameExtractions}
                min={0}
                max={100000}
                onCommit={(next) => void updateSettings({ maxFrameExtractions: next })}
              />
            </Field>
            {settings.maxFrameExtractions === 0 && (
              <div className="faint" style={{ fontSize: 11, marginTop: -8, marginBottom: 8 }}>
                {t('settings.maxFramesUnlimited')}
              </div>
            )}

            <Field label={t('settings.frameConcurrency')} hint={t('settings.frameConcurrencyHint')}>
              <NumberSetting
                value={settings.frameConcurrency}
                min={1}
                max={8}
                onCommit={(next) => void updateSettings({ frameConcurrency: next })}
              />
            </Field>
          </>
        )}
      </Card>

      <Card title={t('settings.tools')}>
        <Field label={t('settings.ffmpegDir')} hint={t('settings.ffmpegHint')}>
          <PathPicker
            value={settings.ffmpegDir ?? ''}
            buttonLabel={t('copy.pickSource')}
            onPick={() => {
              void (async () => {
                const picked = await window.securereel.volumes.pickPath('directory', t('settings.ffmpegDir'))
                if (picked.ok && picked.data !== null) void updateSettings({ ffmpegDir: picked.data })
              })()
            }}
            onChange={(next) => void updateSettings({ ffmpegDir: next.trim() === '' ? null : next })}
          />
        </Field>

        <Field label={t('settings.arrirawHde')}>
          <PathPicker
            value={settings.arrirawHdePath ?? ''}
            buttonLabel={t('copy.pickSource')}
            onPick={() => {
              void (async () => {
                const picked = await window.securereel.volumes.pickPath('file', t('settings.arrirawHde'))
                if (picked.ok && picked.data !== null) void updateSettings({ arrirawHdePath: picked.data })
              })()
            }}
            onChange={(next) => void updateSettings({ arrirawHdePath: next.trim() === '' ? null : next })}
          />
        </Field>
      </Card>

      <Card title={t('settings.data')}>
        <dl className="kv">
          <dt>{t('settings.userData')}</dt>
          <dd className="mono">{appInfo?.userDataDir ?? '—'}</dd>
          <dt>{t('settings.logs')}</dt>
          <dd className="mono">{appInfo?.logsDir ?? '—'}</dd>
          <dt>{t('settings.reports')}</dt>
          <dd className="mono">{appInfo?.reportsDir ?? '—'}</dd>
        </dl>

        <div className="row-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void (async () => {
                try {
                  await unwrap(window.securereel.logs.reveal())
                } catch (error) {
                  pushToast('error', error instanceof Error ? error.message : String(error))
                }
              })()
            }}
          >
            {t('settings.openLogs')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={diagBusy}
            onClick={() => {
              void (async () => {
                setDiagBusy(true)
                try {
                  const saved = await unwrap(window.securereel.logs.exportDiagnostics())
                  if (saved === null) return
                  pushToast('success', t('settings.diagExported'))
                } catch (error) {
                  pushToast('error', error instanceof Error ? error.message : String(error))
                } finally {
                  setDiagBusy(false)
                }
              })()
            }}
          >
            {t('settings.exportDiagnostics')}
          </button>
        </div>

        <Note>{t('settings.privacy')}</Note>
      </Card>
    </div>
  )
}
