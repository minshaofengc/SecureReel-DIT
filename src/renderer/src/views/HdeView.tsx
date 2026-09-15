import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { HdeCameraModel, HdeCapabilityDecision, HdeToolStatus } from '@shared/types'
import { Card, Note, PathPicker } from '../components/ui'
import { SelectBox } from '../components/ComboBox'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

const MODELS: { value: HdeCameraModel | 'auto'; label: string }[] = [
  { value: 'auto', label: '自动识别' },
  { value: 'alexa-mini', label: 'ALEXA Mini' },
  { value: 'alexa-mini-lf', label: 'ALEXA Mini LF' },
  { value: 'alexa-35', label: 'ALEXA 35' },
  { value: 'alexa-35-xtreme', label: 'ALEXA 35 Xtreme' },
  { value: 'alexa-265', label: 'ALEXA 265' }
]

export function HdeView(): ReactNode {
  const { t } = useI18n()
  const { settings, updateSettings, pushToast } = useAppState()
  const [status, setStatus] = useState<HdeToolStatus | null>(null)
  const [sourcePath, setSourcePath] = useState('')
  const [model, setModel] = useState<HdeCameraModel | 'auto'>('auto')
  const [decision, setDecision] = useState<HdeCapabilityDecision | null>(null)
  const [busy, setBusy] = useState(false)

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
      <header className="page-head">
        <h2>{t('hde.title')}</h2>
        <p>{t('hde.subtitle')}</p>
      </header>

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
            options={MODELS}
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
              {decision.requiresTranscoder && <span className="badge warn">官方转码器</span>}
              {decision.degraded && <span className="badge danger">{t('common.unknown')}</span>}
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
