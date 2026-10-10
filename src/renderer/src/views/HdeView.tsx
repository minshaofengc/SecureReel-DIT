import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { HdeCameraModel, HdeCapabilityDecision, HdeToolStatus } from '@shared/types'
import { Card, Note, PageHead, PathPicker } from '../components/ui'
import { SelectBox } from '../components/ComboBox'
import { PAGE_INDEX } from '../nav'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

/**
 * 机型下拉的取值顺序。
 *
 * 机型名是产品名（ALEXA Mini / ALEXA 35…），任何语言下都保持原样；
 * 只有「自动识别」需要跟随界面语言，所以它单独走 i18n。
 * 这里曾经把「自动识别」也写死在常量里 —— 英文界面下会冒出一句中文。
 */
const MODEL_VALUES: (HdeCameraModel | 'auto')[] = [
  'auto',
  'alexa-mini',
  'alexa-mini-lf',
  'alexa-35',
  'alexa-35-xtreme',
  'alexa-265'
]

/** 机型显示名（`auto` 除外，它取自 `t('hde.modelAuto')`）。 */
const MODEL_NAMES: Partial<Record<HdeCameraModel | 'auto', string>> = {
  'alexa-mini': 'ALEXA Mini',
  'alexa-mini-lf': 'ALEXA Mini LF',
  'alexa-35': 'ALEXA 35',
  'alexa-35-xtreme': 'ALEXA 35 Xtreme',
  'alexa-265': 'ALEXA 265'
}

export function HdeView(): ReactNode {
  const { t } = useI18n()
  const { settings, updateSettings, pushToast } = useAppState()
  const [status, setStatus] = useState<HdeToolStatus | null>(null)
  const [sourcePath, setSourcePath] = useState('')
  const [model, setModel] = useState<HdeCameraModel | 'auto'>('auto')
  const [decision, setDecision] = useState<HdeCapabilityDecision | null>(null)
  const [busy, setBusy] = useState(false)

  const modelOptions = useMemo(
    () =>
      MODEL_VALUES.map((value) => ({
        value,
        label: value === 'auto' ? t('hde.modelAuto') : (MODEL_NAMES[value] ?? value)
      })),
    [t]
  )

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await unwrap(window.securereel.hde.status()))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [pushToast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const decide = useCallback(async () => {
    if (sourcePath.trim() === '') {
      pushToast('warn', t('copy.sourcePlaceholder'))
      return
    }
    setBusy(true)
    try {
      // 机型选择通过设置透传（IPC 只接收路径），这里直接调用即可
      const result = await unwrap(window.securereel.hde.decide(sourcePath))
      setDecision({ ...result, model: model === 'auto' ? result.model : model })
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [model, pushToast, sourcePath, t])

  return (
    <div className="page">
      <PageHead
        index={PAGE_INDEX.hde}
        kicker={t('nav.hde')}
        title={t('hde.title')}
        subtitle={t('hde.subtitle')}
      />

      <Card
        title={t('hde.toolStatus')}
        actions={
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void refresh()}>
            {t('common.refresh')}
          </button>
        }
      >
        {status === null ? (
          <div className="faint">{t('common.loading')}</div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  <tr>
                    <td style={{ width: 320 }}>{t('hde.vfs')}</td>
                    <td>
                      <span className={`badge ${status.vfsAvailable ? 'ok' : 'warn'}`}>
                        {status.vfsAvailable ? t('hde.available') : t('hde.missing')}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td>{t('hde.volumes')}</td>
                    <td className="mono">
                      {status.vfsVolumes.length === 0 ? t('common.none') : status.vfsVolumes.join('、')}
                    </td>
                  </tr>
                  <tr>
                    <td>{t('hde.transcoder')}</td>
                    <td>
                      <span className={`badge ${status.transcoderPath !== null ? 'ok' : 'warn'}`}>
                        {status.transcoderPath !== null ? t('hde.available') : t('hde.missing')}
                      </span>
                      {status.transcoderPath !== null && (
                        <div className="mono faint">{status.transcoderPath}</div>
                      )}
                    </td>
                  </tr>
                  {status.transcoderVersion !== null && (
                    <tr>
                      <td>{t('hde.version')}</td>
                      <td className="mono">{status.transcoderVersion}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <Note tone={status.requiresUserConfirmation ? 'warn' : undefined}>
              <pre>{status.message}</pre>
            </Note>

            {status.transcoderPath === null && (
              <label className="row-actions" style={{ marginTop: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.acceptHdeDowngrade}
                  onChange={(event) => void updateSettings({ acceptHdeDowngrade: event.target.checked })}
                />
                <span>{t('hde.acceptDowngrade')}</span>
              </label>
            )}
          </>
        )}
      </Card>

      <Card title={t('hde.decide')}>
        <div style={{ marginBottom: 12 }}>
          <span className="field-label">{t('copy.source')}</span>
          <PathPicker
            value={sourcePath}
            placeholder={t('copy.sourcePlaceholder')}
            buttonLabel={t('copy.pickSource')}
            onPick={() => {
              void (async () => {
                const picked = await window.securereel.volumes.pickPath('directory', t('copy.pickSource'))
                if (picked.ok && picked.data !== null) setSourcePath(picked.data)
              })()
            }}
            onChange={setSourcePath}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <span className="field-label">{t('hde.model')}</span>
          <SelectBox<HdeCameraModel | 'auto'>
            value={model}
            ariaLabel={t('hde.model')}
            options={modelOptions}
            onChange={setModel}
          />
        </div>

        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide()}>
          {t('hde.decide')}
        </button>

        {decision !== null && (
          <div style={{ marginTop: 14 }}>
            <div className="field-label">{t('hde.decision')}</div>
            <Note tone={decision.canProceed ? undefined : 'danger'}>
              <pre>{decision.message}</pre>
            </Note>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <span className="badge">{decision.model}</span>
              {decision.useVfs && <span className="badge info">VFS</span>}
              {decision.requiresTranscoder && (
                <span className="badge warn">{t('hde.needsTranscoder')}</span>
              )}
              {decision.degraded && <span className="badge danger">{t('hde.degraded')}</span>}
            </div>
          </div>
        )}
      </Card>

      <Card title={t('hde.compliance')}>
        <pre className="faint" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>
          {t('hde.complianceBody')}
        </pre>
      </Card>
    </div>
  )
}
