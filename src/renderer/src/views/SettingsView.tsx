import { useMemo, type ReactNode } from 'react'
import {
  HASH_ALGORITHMS,
  HASH_ALGORITHM_LABELS,
  LANGUAGES,
  MANIFEST_FORMATS,
  THEMES,
  THEME_MODES,
  type HashAlgorithm,
  type ManifestFormat,
  type ThemeId
} from '@shared/types'
import { Card, Field, PathPicker, Segmented, Note } from '../components/ui'
import { SelectBox, type ComboOption } from '../components/ComboBox'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

/**
 * 主题预览用的色块。
 *
 * 这里是全项目**唯一**允许写死色值的地方，而且理由充分：
 * 这些色块要展示的是「**别的**主题」长什么样，而当前生效主题的 CSS 变量
 * 里根本没有其它主题的颜色。让每个主题各贡献一组预览色，
 * 比"点一下换一个主题再看效果"的试错方式好用得多。
 *
 * 色条按「底 → 主色 →（辅色）→ 文字」的顺序排。
 * 只有「雾光」是双强调色主题，所以它多一格粉色；竹林和奶酪
 * 的 --accent-2 就是 --accent，多铺一格只会得到一根更宽的色带，
 * 所以它们维持三格不变 —— 观感与从前完全一致。
 */
const THEME_PREVIEW: Record<ThemeId, { light: readonly string[]; dark: readonly string[] }> = {
  qinghe: {
    light: ['#f5f5f0', '#3d7a58', '#1b2a23'],
    dark: ['#131a16', '#74bf95', '#e6efe9']
  },
  wuguang: {
    light: ['#f6f6fa', '#586ec4', '#c2456f', '#232538'],
    dark: ['#14151d', '#8fa3e8', '#ef9ab8', '#e8e9f3']
  },
  cheese: {
    light: ['#f8f3e6', '#c2860f', '#362c18'],
    dark: ['#1c1710', '#e6b23c', '#f3e9d6']
  }
}

function ThemeSwatch({ theme, mode }: { theme: ThemeId; mode: 'light' | 'dark' }): ReactNode {
  const colors = THEME_PREVIEW[theme][mode]
  return (
    <span className="theme-swatch" aria-hidden="true">
      {colors.map((color) => (
        <span key={color} style={{ background: color }} />
      ))}
    </span>
  )
}

export function SettingsView(): ReactNode {
  const { t } = useI18n()
  const { settings, updateSettings, appInfo, pushToast } = useAppState()
  const previewMode = settings.themeMode === 'dark' ? 'dark' : 'light'

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
                <ThemeSwatch theme={theme} mode={previewMode} />
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
          <input
            className="input"
            type="number"
            min={1}
            max={8}
            value={settings.maxParallelTargets}
            onChange={(event) =>
              void updateSettings({ maxParallelTargets: Number(event.target.value) || 1 })
            }
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
              <input
                className="input"
                type="number"
                min={0}
                max={100000}
                value={settings.maxFrameExtractions}
                onChange={(event) =>
                  void updateSettings({ maxFrameExtractions: Math.max(0, Number(event.target.value) || 0) })
                }
              />
            </Field>
            {settings.maxFrameExtractions === 0 && (
              <div className="faint" style={{ fontSize: 11, marginTop: -8, marginBottom: 8 }}>
                {t('settings.maxFramesUnlimited')}
              </div>
            )}

            <Field label={t('settings.frameConcurrency')} hint={t('settings.frameConcurrencyHint')}>
              <input
                className="input"
                type="number"
                min={1}
                max={8}
                value={settings.frameConcurrency}
                onChange={(event) =>
                  void updateSettings({ frameConcurrency: Math.min(8, Math.max(1, Number(event.target.value) || 1)) })
                }
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
        </div>

        <Note>{t('settings.privacy')}</Note>
      </Card>
    </div>
  )
}
