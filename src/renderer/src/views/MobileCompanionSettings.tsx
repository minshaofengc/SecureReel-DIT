import QRCode from 'qrcode'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CompanionSetup, CompanionStatus } from '@shared/ipc'
import { Card, Note } from '../components/ui'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'

export function MobileCompanionSettings(): ReactNode {
  const { t } = useI18n()
  const { pushToast } = useAppState()
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [setup, setSetup] = useState<CompanionSetup | null>(null)
  const pairedCount = useRef(0)
  const statusEpoch = useRef(0)
  const mutating = useRef(false)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    let cancelled = false
    const initialEpoch = statusEpoch.current
    void unwrap(window.securereel.companion.status())
      .then((value) => { if (!cancelled && initialEpoch === statusEpoch.current) setStatus(value) })
      .catch(() => undefined)
    let polling = false
    const timer = window.setInterval(() => {
      setNow(Date.now())
      if (polling || mutating.current) return
      polling = true
      const requestEpoch = statusEpoch.current
      void unwrap(window.securereel.companion.status())
        .then((value) => {
          if (!cancelled && requestEpoch === statusEpoch.current) setStatus(value)
        })
        .catch(() => undefined)
        .finally(() => {
          polling = false
        })
    }, 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    setQr(null)
    if (setup)
      void QRCode.toDataURL(JSON.stringify(setup), {
        width: 320,
        margin: 4,
        errorCorrectionLevel: 'M'
      })
        .then((image) => {
          if (!cancelled) setQr(image)
        })
        .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [setup])
  useEffect(() => {
    if (setup && status && status.clients.length > pairedCount.current) setSetup(null)
  }, [setup, status])
  const perform = (operation: () => Promise<void>): void => {
    if (mutating.current) return
    mutating.current = true
    statusEpoch.current++
    setBusy(true)
    void operation()
      .catch(() => pushToast('error', t('companion.failed')))
      .finally(() => { statusEpoch.current++; mutating.current = false; setBusy(false) })
  }
  const activeSetup = setup !== null && setup.expiresAt > now && status?.running
  return (
    <Card title={t('companion.title')}>
      <div className="companion-overview" role="status" aria-live="polite">
        <div className="companion-overview__identity">
          <span className="field-label">{t('companion.thisComputer')}</span>
          <strong>{status?.desktopName ?? 'SecureReel Desktop'}</strong>
          <span className={'companion-overview__state' + (status?.running ? ' companion-overview__state--on' : '')}>
            {status === null ? t('companion.statusUnknown') : status.running ? t('companion.on') : t('companion.off')}
          </span>
        </div>
        <div className="companion-overview__figures">
          <span>{t('companion.clients', { count: status?.clients.length ?? 0 })}</span>
          <span>{t('companion.approvedCount', { count: status?.roots.length ?? 0 })}</span>
        </div>
      </div>
      <details className="companion-guidance">
        <summary>{t('companion.help')}</summary>
        <Note>{t('companion.description')}</Note>
        <p>{t('companion.steps')}</p>
      </details>
      <div className="row-actions">
        <button
          className="btn btn-sm"
          type="button"
          disabled={busy}
          onClick={() =>
            perform(async () => {
              setStatus(
                await unwrap(
                  status?.running
                    ? window.securereel.companion.stop()
                    : window.securereel.companion.start()
                )
              )
              setSetup(null)
            })
          }
        >
          {status?.running ? t('companion.stop') : t('companion.start')}
        </button>
        <button
          className="btn btn-sm"
          type="button"
          disabled={busy || !status?.running}
          onClick={() =>
            perform(async () => {
              pairedCount.current = status?.clients.length ?? 0
              setSetup(await unwrap(window.securereel.companion.pairing()))
            })
          }
        >
          {t('companion.pair')}
        </button>
        <button
          className="btn btn-sm"
          type="button"
          disabled={busy}
          onClick={() =>
            perform(async () => {
              if (!window.confirm(t('companion.revokeAllConfirm'))) return
              setStatus(await unwrap(window.securereel.companion.revoke()))
              setSetup(null)
            })
          }
        >
          {t('companion.revoke')}
        </button>
      </div>
      {activeSetup && (
        <section className="companion-pairing" aria-label={t('companion.qr')}>
          <Note>{t('companion.setupHint')}</Note>
          {qr && (
            <img
              src={qr}
              width={320}
              height={320}
              style={{ maxWidth: '100%', height: 'auto', borderRadius: 12 }}
              alt={t('companion.qr')}
            />
          )}
          <p>
            {t('companion.expires', {
              seconds: Math.max(0, Math.ceil((setup!.expiresAt - now) / 1000))
            })}
          </p>
          <details className="companion-advanced">
            <summary>{t('companion.advanced')}</summary>
            <p>{t('companion.advancedWarning')}</p>
            <textarea
              className="input mono"
              readOnly
              value={JSON.stringify(setup)}
              rows={5}
              aria-label={t('companion.pair')}
            />
            <button
              className="btn btn-sm"
              type="button"
              onClick={() =>
                perform(async () => {
                  await navigator.clipboard.writeText(JSON.stringify(setup))
                  pushToast('success', t('companion.copied'))
                })
              }
            >
              {t('companion.copy')}
            </button>
          </details>
        </section>
      )}
      {setup && !activeSetup && <Note>{t('companion.expired')}</Note>}
      <section className="companion-access" aria-label={t('companion.clientsTitle')}>
        <strong>{t('companion.clientsTitle')}</strong>
        <p className="hint">{t('companion.contactHint')}</p>
        {status?.clients.length
          ? <ul>{status.clients.map((client) => {
              const lastSeen = client.lastSeenAt === null ? NaN : Date.parse(client.lastSeenAt)
              const recent = status.running && Number.isFinite(lastSeen) && now >= lastSeen && now - lastSeen < 120_000
              return <li key={client.id}>
                <div className="companion-client__identity"><strong>{client.deviceName}</strong><code>{client.id}</code>
                  <span className="hint">{t(recent ? 'companion.recentlyOnline' : 'companion.pairedOnly')}</span>
                  <span className="hint">{t('companion.recent')}: {Number.isFinite(lastSeen) ? new Date(lastSeen).toLocaleString() : t('companion.neverSeen')}</span>
                </div>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} aria-label={`${t('companion.revokeClient')} · ${client.deviceName}`} onClick={() => perform(async () => {
                  if (!window.confirm(`${client.deviceName}\n${t('companion.revokeConfirm')}`)) return
                  setStatus(await unwrap(window.securereel.companion.revokeClient(client.id)))
                })}>{t('companion.revokeClient')}</button>
              </li>
            })}</ul>
          : <p>{t('companion.noClients')}</p>}
      </section>
      <section className="companion-access" aria-label={t('companion.approvalsTitle')}>
        <strong>{t('companion.approvalsTitle')}</strong>
        <p>{t('companion.approvalsWarning')}</p>
        {status?.roots.length
          ? <ul>{status.roots.map((root) => (
              <li key={root.id}>
                <span>{t(root.role === 'source' ? 'companion.sourceRole' : 'companion.targetRole')}</span>
                <code title={root.label}>{root.label}</code>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} aria-label={`${t('companion.removeRoot')} · ${root.label}`} onClick={() => perform(async () => {
                  if (!window.confirm(`${root.label}\n${t('companion.removeRootConfirm')}`)) return
                  setStatus(await unwrap(window.securereel.companion.removeRoot(root.id)))
                })}>{t('companion.removeRoot')}</button>
              </li>
            ))}</ul>
          : <p>{t('companion.noRoots')}</p>}
      </section>
      <div className="row-actions">
        {(['source', 'target'] as const).map((role) => (
          <button
            className="btn btn-sm"
            type="button"
            key={role}
            disabled={busy}
            onClick={() =>
              perform(async () => {
                setStatus(await unwrap(window.securereel.companion.approveRoot(role)))
              })
            }
          >
            {t(role === 'source' ? 'companion.source' : 'companion.target')}
          </button>
        ))}
        <button
          className="btn btn-sm"
          type="button"
          disabled={busy || !status?.roots.length}
          onClick={() =>
            perform(async () => {
              if (!window.confirm(t('companion.clearRootsConfirm'))) return
              setStatus(await unwrap(window.securereel.companion.clearRoots()))
            })
          }
        >
          {t('companion.clearRoots')}
        </button>
      </div>
    </Card>
  )
}
