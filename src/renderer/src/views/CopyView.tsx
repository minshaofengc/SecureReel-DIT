import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  DriveUsage,
  HashAlgorithm,
  ManifestFormat,
  ProjectDetails,
  ProjectDraft,
  ProxyCodec,
  ProxyProfile,
  ProxyResolution,
  ScanResult,
  VolumeKind
} from '@shared/types'
import {
  HASH_ALGORITHMS,
  HASH_ALGORITHM_LABELS,
  MANIFEST_FORMATS,
  MAX_COPY_NOTES_LENGTH,
  PROXY_CODECS,
  PROXY_RESOLUTIONS
} from '@shared/types'
import type { EncodersInfo } from '@shared/ipc'
import { countExtension, humanBytes, todayLocalDate } from '@shared/format'
import {
  emptyProjectDetails,
  emptyProjectDraft,
  mergeTalentIntoParent,
  nextAutoShootDay,
  normalizeProjectDetails
} from '@shared/project'
import { Card, Field, LeadBlock, Note, PageHead, PathPicker, Progress, Toggle } from '../components/ui'
import { SelectBox, type ComboOption } from '../components/ComboBox'
import { ProjectInfoFields } from '../components/ProjectInfoFields'
import { PAGE_INDEX } from '../nav'
import { useNav } from '../state/NavState'
import { unwrap, useAppState } from '../state/AppState'
import { useI18n } from '../i18n'
import { zeroByteNoteKey } from '../platform'

/** 下拉里表示「新建母项目」的哨兵值，不会与真实 ID 冲突 */
const NEW_PARENT_VALUE = '__new_parent__'

/**
 * 取路径的最后一段，用来推默认任务名。
 *
 * 必须 `filter` 掉空段：从文件管理器/终端粘贴的路径常带尾斜杠，
 * `'/Volumes/CARD/'.split('/').slice(-1)[0]` 得到的是**空字符串**而不是 'CARD'，
 * 于是任务名变成空串、创建请求被校验直接拒掉，只弹一句
 * 「请填写任务名称」—— 而用户看到的输入框里本来就是空的，莫名其妙。
 *
 * 两种分隔符都要切：Windows 的路径是 `D:\Cards\A001`，只按 `/` 切会
 * 把整条路径当成任务名（含盘符与反斜杠），既难看又会让落盘目录名走样。
 */
function lastPathSegment(path: string): string | null {
  return path.split(/[/\\]/).filter((part) => part !== '').slice(-1)[0] ?? null
}

/**
 * 上一次**自动**填进「拍摄日」的值。
 *
 * 它只回答一个问题：这个框里现在的内容是程序填的，还是人改过的？
 * 只有"程序填的"才允许被新的日期覆盖 —— 有人故意填昨天的日期去补拷昨天的卡，
 * 那种值绝不能因为过了半夜就被悄悄改掉。
 *
 * 放模块级而不是组件 ref：拷贝页切页时会整个卸载，组件级 ref 跟着丢，
 * 于是"切到别的页跨过午夜、再切回来"就找不回判断依据了。
 * 它不参与任何业务计算，只在这一处判断里用。
 */
let lastAutoShootDay: string | null = null

/** 取这台电脑今天的日期，并记下"这次是程序填的"。 */
function freshShootDay(): string {
  const today = todayLocalDate()
  lastAutoShootDay = today
  return today
}

const KIND_LABEL: Record<VolumeKind, string> = {
  generic: 'copy.type.generic',
  'hde-vfs': 'copy.type.hde-vfs',
  'hde-mxf': 'copy.type.hde-mxf',
  arriraw: 'copy.type.arriraw'
}

export function CopyView(): ReactNode {
  const { t } = useI18n()
  /*
   * 建完任务要跳到监控页。此前是 App 传下来的 `onCreated` 回调，
   * 2026-10-05 改成从导航上下文取（见 state/NavState.tsx）。
   */
  const { navigate } = useNav()
  const {
    settings,
    updateSettings,
    refreshJobs,
    refreshParents,
    parents,
    projectDraft,
    setProjectDraft,
    pushToast,
    appInfo
  } = useAppState()

  const [jobName, setJobName] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [usage, setUsage] = useState<DriveUsage[]>([])
  const [busy, setBusy] = useState(false)
  const [verify, setVerify] = useState(settings.verifyAfterWrite)
  /** 仅校验模式：选好源和已有拷贝目录后，只比对校验值，不写任何数据 */
  const [verifyOnlyMode, setVerifyOnlyMode] = useState(false)
  /** 用户对"空间可能不足仍要继续"的明确确认（P1 #11：只提醒不拦 → 需明确勾选） */
  const [spaceAck, setSpaceAck] = useState(false)

  const [parentId, setParentId] = useState<string | null>(null)
  const [newParentOpen, setNewParentOpen] = useState(false)
  const [newParentName, setNewParentName] = useState('')

  /*
   * 代理选项 —— **每任务**（初值取自全局设置，提交时作为任务字段传出）。
   *
   * 与 hashAlgorithm/manifestFormat 的区别：那两个是"改一次以后都这样"的全局偏好，
   * 而"这次要不要出代理、出多重、用什么编"是**这一次拷贝**的事 —— 同一台机器上，
   * 给剪辑交片和纯备份是两种活。所以照 verifyAfterWrite 的模式做局部 state。
   */
  const [proxyOn, setProxyOn] = useState(settings.proxyEnabled)
  const [proxyResolution, setProxyResolution] = useState<ProxyResolution>(settings.proxyResolution)
  const [proxyCodec, setProxyCodec] = useState<ProxyCodec>(settings.proxyCodec)
  const [proxyProfile, setProxyProfile] = useState<ProxyProfile>(settings.proxyProfile)
  /** 本次任务要套的 LUT（.cube 绝对路径）；'' = 不套 */
  const [proxyLutPath, setProxyLutPath] = useState(settings.proxyLutPath ?? '')

  /** 本机可用的编码器（决定 H.264/H.265 能不能选）。null = 还在探测 */
  const [encoders, setEncoders] = useState<EncodersInfo | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const info = await unwrap(window.securereel.media.encoders())
        if (alive) setEncoders(info)
      } catch {
        // 探测失败就当作"只有 ProRes 可用"，不挡用户出 ProRes
        if (alive) setEncoders({ h264: false, h265: false, h264Hardware: false, h265Hardware: false })
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const requiredBytes = scan?.totalBytes ?? null

  /*
   * 来源里有没有佳能 Cinema RAW Light（.CRM）。
   *
   * 为什么要专门提示：这类素材**能拷、能校验、能读元数据，但出不了画面** ——
   * ffmpeg 没有 CRAW 解码器，而且文件里也没有内嵌预览图（.R3D/.BRAW 那种退路它没有）。
   * 用户开了"首帧提取"或"代理"却在这批素材上拿不到图，会以为软件坏了。
   * 提前在选源这一步就说清楚，并指一条明确的路：先用佳能官方工具转码再拷。
   *
   * 判定只用 scan 里已有的后缀直方图（`extensions.ext` 一律小写），
   * 不需要任何主进程改动。
   */
  const crmCount = scan === null ? 0 : countExtension(scan.extensions, 'crm')

  // 首次进入拷贝页时准备好表单。
  // 只做一次：这些状态在切页面回来后不该被重新覆盖。
  const draftLoaded = useRef(false)
  useEffect(() => {
    if (draftLoaded.current || projectDraft !== null) return
    draftLoaded.current = true
    void (async () => {
      /*
       * 两条预填来源各管一摊：
       *   · template  —— "跟着戏走"的项目信息（机型 / 镜头 / 人员）
       *   · lastDraft —— "跟着操作走"的来源、目标与项目名
       * 各自失败也不影响：最差就是一张空表单。
       */
      const [template, lastDraft] = await Promise.all([
        unwrap(window.securereel.project.template()).catch(() => null),
        unwrap(window.securereel.jobs.lastDraft()).catch(() => null)
      ])

      const base =
        template === null
          ? { ...emptyProjectDraft(), shootDay: freshShootDay() }
          : {
              projectName: template.projectName,
              /*
               * 拍摄日**刻意不沿用**上一次填的。
               *
               * 它记的是"上一回拷的那批卡是哪天拍的"，隔天再拷就必然错一天 ——
               * 而且格式完全合法（`2026-9-30`），不报任何错，一路错进报告和清单，
               * 等发现时报告已经发出去了。默认永远是这台电脑今天的日期，要改随手改。
               * 也正因此 `hasSubstance()` 不看这个字段。
               */
              shootDay: freshShootDay(),
              camera: template.camera,
              lenses: template.lenses,
              notes: template.notes,
              crew: template.crew,
              // 卡号与本次备注属于"这一张卡"，绝不沿用上一次 ——
              // 卡号会进报告，填错比空着更糟
              cardLabel: '',
              copyNotes: ''
            }

      setProjectDraft(
        // 上次实际填过的项目名优先：母项目下的任务不会被 template 覆盖到
        lastDraft !== null && lastDraft.projectName !== ''
          ? { ...base, projectName: lastDraft.projectName }
          : base
      )

      if (lastDraft !== null) {
        // 现场常是同一张卡连拷到几块盘，每次都重新选一遍路径纯属浪费。
        // 目标盘列表也一并带回来 —— 这是最省事的一步。
        setSourcePath(lastDraft.sourcePath)
        setTargets(lastDraft.targetPaths)
      }
    })()
  }, [projectDraft, setProjectDraft])

  const draft = projectDraft
  const selectedParent = parents.find((project) => project.id === parentId) ?? null

  const patchDraft = useCallback(
    (patch: Partial<ProjectDraft>) => {
      if (draft === null) return
      setProjectDraft({ ...draft, ...patch })
    },
    [draft, setProjectDraft]
  )

  /**
   * 把母项目的项目信息带进表单。
   *
   * 传进来的 `details` 来自主进程的 `parents.recall()`：**档案里空着的职员与镜头，
   * 会从该母项目名下历史任务的快照里补回来**。旧版本只把内容存进任务、不写回档案，
   * 不补的话切到母项目会看到一份空档案，用户会以为从前填的丢了。
   *
   * 拍摄日**不跟随母项目**：它是"这一次拷的卡是哪天拍的"，每次重置为当天。
   */
  const applyParentDetails = useCallback(
    (parentDetails: ProjectDetails | null) => {
      if (draft === null) return
      setProjectDraft({
        ...draft,
        ...(parentDetails === null ? emptyProjectDraft() : parentDetails),
        shootDay: freshShootDay(),
        // 卡号与本次备注不受母项目影响
        cardLabel: draft.cardLabel,
        copyNotes: draft.copyNotes
      })
    },
    [draft, setProjectDraft]
  )

  const pickParent = useCallback(
    async (value: string) => {
      const next = value === '' ? null : value
      setParentId(next)
      if (next === null) {
        applyParentDetails(null)
        return
      }
      try {
        applyParentDetails(await unwrap(window.securereel.parents.recall(next)))
      } catch (error) {
        // 回捞失败退回档案本身：取不到历史不该挡住选母项目这件正事
        const fallback = parents.find((project) => project.id === next)
        applyParentDetails(fallback === undefined ? null : normalizeProjectDetails(fallback.details))
        pushToast('warn', error instanceof Error ? error.message : String(error))
      }
    },
    [applyParentDetails, parents, pushToast]
  )

  const createParent = useCallback(async () => {
    const name = newParentName.trim()
    if (name === '') return
    try {
      const created = await unwrap(
        window.securereel.parents.create(name, {
          ...emptyProjectDetails(),
          // 把刚填好的职员与镜头一起带进新母项目：现场常常是先填了才想起建档，
          // 建完还要再填一遍纯属折腾。
          ...(draft === null ? {} : { lenses: draft.lenses, crew: draft.crew })
        })
      )
      await refreshParents()
      setParentId(created.id)
      setNewParentName('')
      setNewParentOpen(false)
      pushToast('success', t('parent.created'))
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : String(error))
    }
  }, [draft, newParentName, pushToast, refreshParents, t])

  const clearAll = useCallback(() => {
    setParentId(null)
    setProjectDraft({ ...emptyProjectDraft(), shootDay: freshShootDay() })
  }, [setProjectDraft])

  /*
   * 开着软件跨过午夜时，把「拍摄日」跟上电脑的日期。
   *
   * 为什么需要它：日期是在**进拷贝页那一刻**填好的。现场很常见的是
   * "晚上把软件打开放那儿不动，凌晨/第二天接着拷" —— 那时框里还停在前一天，
   * 谁也不会想到去改它，于是整批卡的拍摄日默默错一天，格式还完全合法。
   *
   * 只改**程序填的值**：`lastAutoShootDay` 对得上才动。有人故意填昨天的日期
   * 去补拷昨天的卡，那种值必须原样留着。
   *
   * 三个触发点缺一不可：挂载时（切页面回来）、窗口重新获得焦点（盖着盖子打开）、
   * 以及每分钟一次（一直开着不动的机器）。拷贝是长跑，中途没人会去点窗口。
   */
  useEffect(() => {
    const syncShootDay = (): void => {
      const today = todayLocalDate()
      const previous = lastAutoShootDay
      if (previous === null || today === previous) return
      /*
       * 先记账再改表单。`setProjectDraft` 的更新函数必须是纯的（React 可能调用两次），
       * 所以"这次是程序填的"这个记录只能写在外面。
       *
       * 即使最终没改表单也要记账：那说明用户手动填过日期了，不该再每分钟去撞他的输入。
       */
      lastAutoShootDay = today
      setProjectDraft((current) => {
        if (current === null) return current
        const next = nextAutoShootDay(current.shootDay, previous, today)
        return next === null ? current : { ...current, shootDay: next }
      })
    }

    syncShootDay()
    const timer = window.setInterval(syncShootDay, 60_000)
    window.addEventListener('focus', syncShootDay)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', syncShootDay)
    }
  }, [setProjectDraft])

  const refreshUsage = useCallback(
    async (paths: string[], required: number | null) => {
      if (paths.length === 0) {
        setUsage([])
        return
      }
      try {
        const result = await window.securereel.volumes.usage(paths)
        if (result.ok) {
          setUsage(
            result.data.map((item) => ({ ...item, requiredBytes: required, sufficient: required === null ? null : item.freeBytes >= required }))
          )
        }
      } catch {
        setUsage([])
      }
    },
    []
  )

  const pickSource = useCallback(async () => {
    const picked = await window.securereel.volumes.pickPath('directory', t('copy.pickSource'))
    if (!picked.ok || picked.data === null) return
    const path = picked.data
    setSourcePath(path)
    if (jobName.trim() === '') {
      const derived = lastPathSegment(path)
      if (derived !== null) setJobName(derived)
    }
    setScanning(true)
    try {
      const result = await unwrap(window.securereel.volumes.scan(path))
      setScan(result)
      await refreshUsage(targets, result.totalBytes)
      if (result.warnings.length > 0) {
        pushToast('warn', result.warnings[0] as string)
      }
    } catch (error) {
      setScan(null)
      pushToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setScanning(false)
    }
  }, [jobName, pushToast, refreshUsage, t, targets])

  const addTarget = useCallback(async () => {
    const picked = await window.securereel.volumes.pickPath('directory', t('copy.pickTargetTitle'))
    if (!picked.ok || picked.data === null) return
    const path = picked.data
    if (targets.includes(path)) {
      pushToast('warn', t('copy.targetDuplicate'))
      return
    }
    if (targets.length >= 8) {
      pushToast('warn', t('copy.targetLimit', { count: 8 }))
      return
    }
    const next = [...targets, path]
    setTargets(next)
    await refreshUsage(next, requiredBytes)
  }, [pushToast, refreshUsage, requiredBytes, t, targets])

  const removeTarget = useCallback(
    async (path: string) => {
      const next = targets.filter((item) => item !== path)
      setTargets(next)
      await refreshUsage(next, requiredBytes)
    },
    [refreshUsage, requiredBytes, targets]
  )

  const submit = useCallback(
    async (start: boolean) => {      if (sourcePath.trim() === '') {
        pushToast('warn', t('copy.sourcePlaceholder'))
        return
      }
      if (targets.length === 0) {
        pushToast('warn', t('copy.noTarget'))
        return
      }
      // 空间不足不再"只提醒不拦"：必须明确勾选确认才能带着已知风险开跑
      const hasInsufficient = usage.some((item) => item.sufficient === false)
      if (!verifyOnlyMode && hasInsufficient && !spaceAck) {
        pushToast('warn', t('copy.spaceAckRequired'))
        return
      }
      /*
       * 预判主进程接下来会不会真的把职员与镜头写进母项目。
       *
       * 用的是与主进程同一个纯函数，两边判断一致。只在"填了、而且和档案里不一样"
       * 时才成立 —— 没变化还弹一句"已记入"是空话，用户下次就不会信这个提示了。
       */
      const willRememberTalent =
        draft !== null &&
        selectedParent !== null &&
        mergeTalentIntoParent(normalizeProjectDetails(selectedParent.details), {
          lenses: draft.lenses,
          crew: draft.crew
        }).changed
      setBusy(true)
      try {
        // 项目信息随创建一次带全，不在创建后再补一次保存 ——
        // 那样会多一次 IPC，而且整包覆盖容易把主进程按来源盘推出的卡号冲掉。
        const created = await unwrap(
          window.securereel.jobs.create({
            name:
              jobName.trim() === ''
                ? (lastPathSegment(sourcePath) ?? t('copy.defaultJobName'))
                : jobName.trim(),
            sourcePath,
            targets: targets.map((path) => ({ path })),
            mode: verifyOnlyMode ? 'verify' : 'copy',
            hashAlgorithm: settings.hashAlgorithm,
            manifestFormat: settings.manifestFormat,
            verifyAfterWrite: verify,
            // 代理是**每任务**的：把这次选的三个值带进任务记录。
            proxyEnabled: proxyOn,
            proxyResolution,
            proxyCodec,
            proxyProfile,
            // 空串 = 不套 LUT（主进程按 null 处理）
            proxyLutPath: proxyLutPath.trim() === '' ? null : proxyLutPath.trim(),
            parentProjectId: parentId,
            ...(draft === null ? {} : { project: draft })
          })
        )
        if (start) {
          await unwrap(window.securereel.jobs.start(created.job.id))
        }
        await refreshJobs()
        pushToast('success', t('copy.created'))
        // 主进程会在创建任务时把职员与镜头记进母项目档案，这里把列表拉回来同步。
        if (parentId !== null) await refreshParents()
        // 只有真的会记进去才提示，避免"什么都没变却说已保存"的空话
        if (willRememberTalent && selectedParent !== null) {
          pushToast('info', t('copy.talentRemembered', { name: selectedParent.name }))
        }
        setJobName('')
        setSourcePath('')
        setTargets([])
        setScan(null)
        setUsage([])
        setSpaceAck(false)
        // 母项目选择与项目信息草稿都清掉：下一张卡重新开始，
        // 未分组时下一次会自动沿用这次填的内容（由主进程挑最近一条）。
        setParentId(null)
        setProjectDraft(null)
        navigate('queue')
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [
      draft,
      jobName,
      navigate,
      parentId,
      proxyCodec,
      proxyLutPath,
      proxyOn,
      proxyProfile,
      proxyResolution,
      pushToast,
      refreshJobs,
      refreshParents,
      selectedParent,
      setProjectDraft,
      settings.hashAlgorithm,
      settings.manifestFormat,
      sourcePath,
      spaceAck,
      usage,
      t,
      targets,
      verify,
      verifyOnlyMode
    ]
  )

  const insufficient = useMemo(() => usage.filter((item) => item.sufficient === false), [usage])

  // 目标或扫描结果一变，之前的"空间不足我知晓"确认就作废 —— 必须重新确认
  useEffect(() => {
    setSpaceAck(false)
  }, [usage])

  /*
   * 母项目下拉的选项。
   *
   * 最后那一项「+ 新建母项目…」是**哨兵值**：它看起来是个选项，其实不是值 ——
   * 选中它只会打开下面的新建输入行，parentId 一点都不变。所以给它 tone: 'action'，
   * 渲染成带分隔线、用辅色的一行，和真实母项目分开。
   * 它必须留在列表末尾（原生 <select> 里也是这个位置）。
   */
  const parentOptions = useMemo<ComboOption<string>[]>(
    () => [
      { value: '', label: t('copy.parentNone') },
      ...parents.map((project) => ({ value: project.id, label: project.name })),
      { value: NEW_PARENT_VALUE, label: t('copy.parentCreate'), tone: 'action' }
    ],
    [parents, t]
  )

  /*
   * 清单格式选项。
   *
   * ⚠️ 曾经这里是 `isAsc ? 'manifest.asc-mhl-2.0' : 'manifest.mhl-v1'` ——
   * 只分了两支，而 MANIFEST_FORMATS 有四种，于是 **CSV 与 JSON 都显示成「MHL v1」**，
   * 下拉里出现两个一模一样的「MHL v1」，看着就像重复了。改为按格式名逐一取标签。
   */
  const manifestOptions = useMemo<ComboOption<ManifestFormat>[]>(
    () => MANIFEST_FORMATS.map((format) => ({ value: format, label: t(`manifest.${format}` as never) })),
    [t]
  )

  const proxyResolutionOptions = useMemo<ComboOption<ProxyResolution>[]>(
    () =>
      PROXY_RESOLUTIONS.map((resolution) => ({
        value: resolution,
        label: t(`proxy.res.${resolution}` as never)
      })),
    [t]
  )

  const proxyProfileOptions = useMemo<ComboOption<ProxyProfile>[]>(
    () => [
      { value: '422-proxy', label: t('settings.proxyProfileProx') },
      { value: '422-lt', label: t('settings.proxyProfileLt') },
      { value: '422', label: t('settings.proxyProfile422') },
      { value: '422-hq', label: t('settings.proxyProfileHq') }
    ],
    [t]
  )

  /*
   * 编码选项。本机不可用的（典型：Windows 上没有可用的 H.265 硬件编码器）
   * 标成 disabled —— 让用户看得见这个选项、也知道为什么选不了，
   * 比"从列表里凭空消失"好理解。
   */
  const proxyCodecOptions = useMemo<ComboOption<ProxyCodec>[]>(() => {
    const h264Ok = encoders === null ? true : encoders.h264
    const h265Ok = encoders === null ? true : encoders.h265
    const available: Record<ProxyCodec, boolean> = { prores: true, h264: h264Ok, h265: h265Ok }
    return PROXY_CODECS.map((codec) => {
      const base = t(`proxy.codec.${codec}` as never)
      return {
        value: codec,
        label: available[codec] ? base : `${base}（${t('proxy.codecUnavailable')}）`,
        disabled: !available[codec]
      }
    })
  }, [t, encoders])

  // 探测结果回来后，若当前选中的编码其实不可用，自动退回 ProRes ——
  // 否则用户会带着一个选不了的值去创建任务。
  useEffect(() => {
    if (encoders === null) return
    if (proxyCodec === 'h264' && !encoders.h264) setProxyCodec('prores')
    if (proxyCodec === 'h265' && !encoders.h265) setProxyCodec('prores')
  }, [encoders, proxyCodec])

  return (
    <div className="page">
      <PageHead
        index={PAGE_INDEX.copy}
        kicker={t('nav.copy')}
        title={t('copy.title')}
        subtitle={t('copy.subtitle')}
      />

      {/*
       * ① 来源 —— 这一页唯一的主区块。
       *
       * 推倒重做的核心改动：此前"母项目"排在第一个，但用户真正卡住的是
       * "卡在哪儿、怎么选" —— 那是这一步之前就已经卡住的地方。
       * 把来源提到最前面并给足视觉权重（近黑反色 + 电光绿编号），
       * 页面一打开就知道从哪儿下手。
       */}
      <LeadBlock step={1} title={t('copy.source')} hint={t('copy.sourcePlaceholder')}>
        <Field label={t('copy.jobName')}>
          <input
            className="input"
            value={jobName}
            placeholder={t('copy.jobNamePlaceholder')}
            onChange={(event) => setJobName(event.target.value)}
          />
        </Field>
        <PathPicker
          value={sourcePath}
          placeholder={t('copy.sourcePlaceholder')}
          buttonLabel={t('copy.pickSource')}
          onPick={() => void pickSource()}
          onChange={setSourcePath}
          disabled={scanning || busy}
        />

        {scanning && <Note>{t('copy.scanning')}</Note>}

        {scan !== null && (
          <>
            <div className="grid-2" style={{ marginTop: 14 }}>
              <div>
                <div className="field-label">{t('copy.fileCount')}</div>
                <div className="scanStat">{scan.fileCount}</div>
              </div>
              <div>
                <div className="field-label">{t('copy.totalSize')}</div>
                <div className="scanStat">{humanBytes(scan.totalBytes)}</div>
              </div>
              <div>
                <div className="field-label">{t('copy.kind')}</div>
                <div>
                  <span className="badge accent">{t(KIND_LABEL[scan.kind] as never)}</span>
                </div>
              </div>
            </div>

            {scan.kind === 'hde-vfs' && <Note tone="warn">{t(zeroByteNoteKey(appInfo?.platform))}</Note>}

            {/*
              佳能 Cinema RAW Light：能拷能校验，但出不了画面。
              开首帧/代理却拿不到图时，这条提示就是"为什么"的答案 + 出路。
            */}
            {crmCount > 0 && <Note tone="warn">{t('copy.crmNotice')}</Note>}

            {scan.warnings.length > 0 && (
              <Note tone="warn">
                <strong>{t('copy.scanWarnings')}</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {scan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Note>
            )}

            {scan.preview.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary className="field-label" style={{ cursor: 'pointer' }}>
                  {t('copy.biggestFiles')}
                </summary>
                <div className="table-wrap" style={{ marginTop: 8 }}>
                  <table className="data">
                    <tbody>
                      {scan.preview.slice(0, 12).map((file) => (
                        <tr key={file.relPath}>
                          <td className="mono">{file.relPath}</td>
                          <td className="num">{humanBytes(file.sizeBytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
      </LeadBlock>

      <Card title={t('copy.parentSection')} hint={t('copy.parentHintTitle')}>
        <div className="path-row">
          <SelectBox<string>
            value={parentId ?? ''}
            disabled={busy}
            ariaLabel={t('copy.parentSection')}
            options={parentOptions}
            onChange={(next) => {
              if (next === NEW_PARENT_VALUE) {
                setNewParentOpen(true)
                return
              }
              void pickParent(next)
            }}
          />
        </div>

        {newParentOpen && (
          <div className="path-row" style={{ marginTop: 10 }}>
            <input
              className="input"
              autoFocus
              value={newParentName}
              placeholder={t('copy.parentNamePlaceholder')}
              onChange={(event) => setNewParentName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createParent()
                if (event.key === 'Escape') {
                  setNewParentOpen(false)
                  setNewParentName('')
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={newParentName.trim() === ''}
              onClick={() => void createParent()}
            >
              {t('copy.parentCreateConfirm')}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setNewParentOpen(false)
                setNewParentName('')
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}

        <div className="hint faint" style={{ marginTop: 10 }}>
          {selectedParent === null
            ? t('copy.parentHintUnassigned')
            : `${t('copy.parentHintAssigned')}${selectedParent.name}`}
        </div>
      </Card>

      <Card
        title={t('copy.projectInfo')}
        hint={t('copy.projectHint')}
        actions={
          <>
            {selectedParent !== null && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || draft === null}
                onClick={() => void pickParent(selectedParent.id)}
              >
                {t('copy.resetToParent')}
              </button>
            )}
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={clearAll}>
              {t('common.clear')}
            </button>
          </>
        }
      >
        {selectedParent !== null && (
          <Note>
            {t('copy.inheritedFrom')}
            {selectedParent.name} · {t('copy.inheritedHint')}
          </Note>
        )}

        {draft === null ? (
          <div className="faint">{t('common.loading')}</div>
        ) : (
          <>
            <ProjectInfoFields
              value={draft}
              disabled={busy}
              sections={['basic', 'lenses', 'crew', 'notes']}
              /*
               * 已选母项目时：
               *   · 不再单独问「项目名称」—— 那时它就是母项目的名字，再问一遍是重复
               *     （还会让报告出现「母项目：X / 项目：X」两行同名）。值仍保留在
               *     draft 里，报告与清单照常写。
               *   · 把镜头/人员/项目备注折叠起来 —— 它们刚被母项目整包带进来，
               *     铺在眼前只会让表单又长又重复。想改点开就是。
               */
              showProjectName={selectedParent === null}
              collapsedSections={selectedParent === null ? [] : ['lenses', 'crew', 'notes']}
              onChange={(next) => patchDraft(next)}
            />

            <div className="sub-block">
              <label className="field">
                <span className="field-label">{t('copy.cardLabel')}</span>
                <input
                  className="input"
                  value={draft.cardLabel}
                  disabled={busy}
                  placeholder={t('copy.cardLabelAuto')}
                  onChange={(event) => patchDraft({ cardLabel: event.target.value })}
                />
                {/* 同一句 copy.cardLabelAuto 曾经 placeholder 与常驻 hint 各画一遍，
                    删掉常驻那份 —— 和 copy.verifyHint 的去重是同一个道理。 */}
              </label>

              <label className="field">
                <span className="field-label">{t('copy.copyNotes')}</span>
                <textarea
                  className="textarea"
                  value={draft.copyNotes}
                  disabled={busy}
                  maxLength={MAX_COPY_NOTES_LENGTH}
                  onChange={(event) => patchDraft({ copyNotes: event.target.value })}
                />
                <span className="hint faint" style={{ fontSize: 11 }}>
                  {t('copy.copyNotesHint')}
                </span>
                <div className="counter">
                  {draft.copyNotes.length} / {MAX_COPY_NOTES_LENGTH}
                </div>
              </label>
            </div>
          </>
        )}
      </Card>

      <Card
        title={t('copy.targets')}
        hint={`${targets.length} / 8`}
        actions={
          <button type="button" className="btn btn-sm" onClick={() => void addTarget()} disabled={busy}>
            + {t('copy.addTarget')}
          </button>
        }
      >
        {targets.length === 0 ? (
          <div className="faint">{t('copy.noTarget')}</div>
        ) : (
          <div className="target-list">
            {targets.map((path, index) => {
              const info = usage.find((item) => item.path === path)
              return (
                <div className="target-item" key={path}>
                  <span className="badge">{index + 1}</span>
                  <span className="target-path" title={path}>
                    {path}
                  </span>
                  {info !== undefined && (
                    <span className={`badge ${info.sufficient === false ? 'danger' : 'ok'}`}>
                      {info.sufficient === false
                        ? `${t('copy.insufficient')} · ${humanBytes(info.freeBytes)}`
                        : `${t('copy.free')} ${humanBytes(info.freeBytes)}`}
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void removeTarget(path)}
                    disabled={busy}
                  >
                    {t('common.remove')}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {requiredBytes !== null && targets.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="field-label">
              {t('copy.required')} {humanBytes(requiredBytes)}
            </div>
            {insufficient.length > 0 && (
              <Note tone="danger">
                {t('copy.insufficientNotice', { count: insufficient.length })}
                <label className="row-actions" style={{ cursor: 'pointer', marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={spaceAck}
                    onChange={(event) => setSpaceAck(event.target.checked)}
                  />
                  <span>{t('copy.spaceAck')}</span>
                </label>
              </Note>
            )}
          </div>
        )}
      </Card>

      <Card title={t('copy.advanced')}>
        <Field label={t('copy.hashAlgorithm')}>
          <SelectBox<HashAlgorithm>
            value={settings.hashAlgorithm}
            ariaLabel={t('copy.hashAlgorithm')}
            options={HASH_ALGORITHMS.map((algorithm) => ({
              value: algorithm,
              label: HASH_ALGORITHM_LABELS[algorithm]
            }))}
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

        <Toggle checked={verify} onChange={setVerify} label={t('copy.verifyAfterWrite')} />
        {/* 同一句说明曾经渲染两遍（常驻 .faint + 关掉校验时的警告），
            划掉了常驻那份 —— 只在"真的关了校验、需要提醒"时才出现。 */}
        {!verify && <Note tone="warn">{t('copy.verifyHint')}</Note>}

        {/*
          「仅校验（不拷贝）」原先独占一整个 Card，只放一个 checkbox + 一段长说明，
          白白占掉一大块纵向空间。挪进「校验与清单」这张本就讲校验的卡片里，
          语义更贴，也省掉一整张卡。
        */}
        <label className="row-actions" style={{ cursor: 'pointer', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={verifyOnlyMode}
            onChange={(event) => setVerifyOnlyMode(event.target.checked)}
          />
          <span>{t('copy.verifyOnly')}</span>
        </label>
        {verifyOnlyMode && (
          <div className="hint" style={{ marginTop: 6 }}>
            {t('copy.verifyOnlyHint')}
          </div>
        )}

        {/*
          代理素材（**本次任务**）。开关与编码/分辨率/规格只对这一次拷贝生效；
          设置页里的同名项只提供默认值。

          字段顺序：**编码 → 分辨率 →（仅 ProRes）规格 → LUT**。
          先定编码再谈规格 —— 选了 H.264/H.265 就不该看到 ProRes 规格，
          那会让人以为"选了 264 还要配 ProRes"。
        */}
        <div className="sub-block" style={{ marginTop: 16 }}>
          <Toggle checked={proxyOn} onChange={setProxyOn} label={t('copy.proxyEnabled')} />
          {proxyOn && (
            <>
              <Field label={t('copy.proxyCodec')}>
                <SelectBox<ProxyCodec>
                  value={proxyCodec}
                  ariaLabel={t('copy.proxyCodec')}
                  options={proxyCodecOptions}
                  onChange={setProxyCodec}
                />
              </Field>
              <Field label={t('copy.proxyResolution')}>
                <SelectBox<ProxyResolution>
                  value={proxyResolution}
                  ariaLabel={t('copy.proxyResolution')}
                  options={proxyResolutionOptions}
                  onChange={setProxyResolution}
                />
              </Field>
              {/* ProRes 规格只在选了 ProRes 时才有意义 */}
              {proxyCodec === 'prores' && (
                <Field label={t('copy.proxyProfile')} hint={t('settings.proxyProfileHint')}>
                  <SelectBox<ProxyProfile>
                    value={proxyProfile}
                    ariaLabel={t('copy.proxyProfile')}
                    options={proxyProfileOptions}
                    onChange={setProxyProfile}
                  />
                </Field>
              )}
              <Field label={t('copy.proxyLut')} hint={t('copy.proxyLutHint')}>
                <PathPicker
                  value={proxyLutPath}
                  placeholder={t('copy.proxyLutPlaceholder')}
                  buttonLabel={t('copy.proxyLutPick')}
                  onPick={() => {
                    void (async () => {
                      const picked = await window.securereel.volumes.pickPath('file', t('copy.proxyLutPick'))
                      if (picked.ok && picked.data !== null) setProxyLutPath(picked.data)
                    })()
                  }}
                  onChange={setProxyLutPath}
                />
              </Field>
              <div className="hint faint" style={{ fontSize: 11 }}>
                {t('copy.proxyHint')}
              </div>
            </>
          )}
        </div>
      </Card>

      <div className="action-bar">
        <button
          type="button"
          className="btn btn--xl"
          disabled={busy || scanning}
          onClick={() => void submit(true)}
        >
          {t('copy.createAndStart')}
          <span className="kbd">空格</span>
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || scanning}
          onClick={() => void submit(false)}
        >
          {t('copy.createOnly')}
        </button>
        <span className="faint" style={{ fontSize: 12 }}>
          {t('copy.willStartHint')}
        </span>
      </div>

      {/*
        这里曾经是 <Progress value={40} />。
        创建任务时要先把源盘扫一遍统计文件数与总字节，一张满卡可能是好几分钟 ——
        那是一段**时长完全未知**的工作，画一个固定 40% 的条等于谎报进度：
        它一动不动地挂在那儿，反而让人以为程序卡死了。
        改成不定态（来回走的条）+ 一句说明，只表达"在动、还没完"。
      */}
      {busy && (
        <div>
          <Progress indeterminate />
          <span className="hint faint">{t('copy.creating')}</span>
        </div>
      )}
    </div>
  )
}
