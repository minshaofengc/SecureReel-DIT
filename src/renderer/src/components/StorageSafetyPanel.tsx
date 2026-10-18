import type { ReactNode } from 'react'
import type { TargetPreflightResult } from '@shared/storage-safety'
import { humanBytes } from '@shared/format'
import { storageEvidenceView } from '../state/storage-evidence'
import { useI18n } from '../i18n'

export function StorageSafetyPanel({ result, checking = false, error, onCheck, acknowledged = false, onAcknowledge, disabled = false, historical = false }: {
  result?: TargetPreflightResult | null
  checking?: boolean
  error?: string | null
  onCheck?: () => void
  acknowledged?: boolean
  onAcknowledge?: (value: boolean) => void
  disabled?: boolean
  historical?: boolean
}): ReactNode {
  const { t } = useI18n()
  const evidence = storageEvidenceView(result, historical)
  return (
    <section className="storage-safety" aria-label={t('safety.title')} aria-busy={checking}>
      <div className="storage-safety__head">
        <strong>{t('safety.title')}</strong>
        {onCheck && <button className="btn btn-sm" type="button" disabled={disabled || checking} onClick={onCheck}>
          {t(checking ? 'p0.checking' : 'safety.check')}
        </button>}
      </div>
      <p className="hint">{t(historical ? 'safety.snapshot' : 'safety.scope')}</p>
      {error && <p className="danger" role="alert">{error}</p>}
      {!result ? <p className="hint">{t(evidence.status === 'historical-unknown' ? 'safety.historicalUnknown' : 'safety.notChecked')}</p> : <>
        <p className="storage-safety__summary" role="status">
          {evidence.status === 'independence-unknown'
            ? t('safety.independenceUnknown')
            : t('safety.groupCount', { count: result.independentDeviceGroups ?? 0 })}
          <span className="hint">{new Date(result.checkedAt).toLocaleString()}</span>
        </p>
        <div className="storage-safety__groups">
          {result.groups.map((group, index) => <div key={group.id} className="storage-safety__group" data-state={group.sufficient === false ? 'insufficient' : 'measured'}>
            <strong>{t('safety.pool', { count: index + 1 })}</strong>
            <span>{t('safety.aggregate')}: <b>{humanBytes(group.requiredBytes)}</b> · {t('copy.free')}: <b>{group.availableBytes === null ? t('p0.capacityUnknown') : humanBytes(group.availableBytes)}</b></span>
            {group.paths.map((path) => <code key={path} title={path}>{path}</code>)}
          </div>)}
        </div>
        <details className="workbench-disclosure">
          <summary>{t('safety.identity')}</summary>
          {[result.source, ...result.targets].map((identity, index) => <div className="storage-safety__identity" key={index}>
            <strong>{index === 0 ? t('ops.source') : String.fromCharCode(64 + index)} · {identity.label}</strong>
            <code>{identity.path}</code>
            <span>{t('safety.filesystem')}: <code>{identity.filesystemId ?? t('common.unknown')}</code></span>
            <span>{t('safety.device')}: <code>{identity.physicalDeviceIds.join(', ') || t('common.unknown')}</code></span>
          </div>)}
        </details>
        {result.risks.length > 0 && <ul className="storage-safety__risks">
          {result.risks.map((risk, index) => <li key={index}>
            <strong>{t(`safety.risk.${risk.code}`)}</strong>
            {risk.paths.map((path) => <code key={path}>{path}</code>)}
          </li>)}
        </ul>}
        {result.blockingReasons.length > 0 && <div className="preflight__block" role="alert">
          <strong>{t('p0.cannotStartYet')}</strong>
          <ul>{result.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </div>}
        {onAcknowledge && evidence.riskAcknowledgementAvailable && <label className="storage-safety__ack">
          <input type="checkbox" disabled={disabled || checking} checked={acknowledged} onChange={(event) => onAcknowledge(event.target.checked)} />
          <span>{t('safety.ack')}</span>
        </label>}
      </>}
    </section>
  )
}
