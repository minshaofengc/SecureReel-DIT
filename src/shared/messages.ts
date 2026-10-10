/**
 * 引擎层用户可见消息的双语表。
 *
 * 背景：界面支持中英切换，但拷贝引擎 / 任务管理器产生的错误、日志
 * 曾经全是写死的中文 —— 英文界面下报告的错误清单会中英混排。
 * 现在引擎统一从这张表取文案，语言来自 `settings.language`。
 *
 * 两个刻意的设计：
 *   1. **报告是快照**：错误文案按任务运行时的语言落库，之后改语言设置
 *      不会改写已有报告 —— 和项目信息快照同一哲学。
 *   2. **测试兼容**：中文文案里"校验值与源不一致""目标上不存在该文件"
 *      等关键词保持稳定，单元测试按子串断言。
 */
import type { Language } from './types'

/** 命名冲突错误信息的固定前缀（两种语言）。 */
export const NAME_CONFLICT_PREFIXES: Record<Language, string> = {
  'zh-CN': '目标上已存在同名文件',
  en: 'A file with the same name already exists on the target'
}

export type MsgKey =
  // ---- CopyEngine：任务生命周期 ----
  | 'engine.resumeReset'
  | 'engine.allTargetsUnavailable'
  | 'engine.targetDisabled'
  | 'engine.notDirectory'
  | 'engine.targetUnavailable'
  | 'engine.targetQuarantined'
  | 'engine.cancelledResume'
  | 'engine.cancelled'
  | 'engine.jobInterrupted'
  | 'engine.jobDoneWithFailures'
  | 'engine.jobDoneClean'
  | 'engine.conflictSummary'
  | 'engine.codexZeroByte'
  // ---- CopyEngine：单文件处理 ----
  | 'engine.sourceReadFail'
  | 'engine.sourceReadFailShort'
  | 'engine.noEnabledTargets'
  | 'engine.allTargetsBroken'
  | 'engine.verifyNoFileOnAnyTarget'
  | 'engine.copyBlockedOnAllTargets'
  | 'engine.verifyFileMissing'
  | 'engine.verifySizeMismatch'
  | 'engine.verifyTargetReadFail'
  | 'engine.verifyReadFailLog'
  | 'engine.resumeFrom'
  | 'engine.prepareWriteFail'
  | 'engine.prepareWriteQuarantined'
  | 'engine.writeFail'
  | 'engine.writeInterrupted'
  | 'engine.writeZeroBytes'
  | 'engine.finalizeFail'
  // ---- CopyEngine：命名冲突 ----
  | 'engine.conflictSizeDiff'
  | 'engine.conflictSizeDiffLog'
  | 'engine.conflictSameSize'
  | 'engine.conflictSameSizeLog'
  // ---- CopyEngine：校验 ----
  | 'engine.verifyMismatch'
  | 'engine.verifyMismatchLog'
  | 'engine.verifyMismatchQuarantineLog'
  | 'engine.verifyMismatchTargetError'
  | 'engine.verifyMismatchResult'
  | 'engine.verifyHashFail'
  // ---- JobManager：创建任务 ----
  | 'job.sourceMissing'
  | 'job.sourceEmpty'
  | 'job.nestedPath'
  | 'job.sameVolume'
  | 'job.targetNotWritable'
  | 'job.verifyTargetMissing'
  | 'job.targetNotDirectory'
  | 'job.spaceWarning'
  | 'job.parentMissing'
  | 'job.created'
  | 'job.createdMode'
  | 'job.createdNoParent'
  | 'job.createdWithParent'
  | 'job.notFound'
  | 'job.alreadyRunning'
  | 'job.notRunning'
  | 'job.noFailedFiles'
  | 'job.retryFailed'
  | 'job.addTargetWhileRunning'
  | 'job.maxTargets'
  | 'job.targetAlreadyInList'
  | 'job.nestedPathShort'
  | 'job.runError'
  | 'queueMode.verify'
  | 'queueMode.copy'
  // ---- JobManager：报告与收尾 ----
  | 'job.ejected'
  | 'job.ejectFail'
  | 'job.shutdownScheduled'
  | 'job.shutdownFail'
  // ---- 弹出目标盘：失败原因（两个平台的实现完全不同，原因文案也分开） ----
  | 'eject.done'
  | 'eject.unsupported'
  | 'eject.noShell'
  | 'eject.failedWindows'
  | 'eject.commandFailed'
  | 'eject.exitCode'
  // ---- 关机（任务成功后可选）----
  | 'shutdown.scheduled'
  | 'shutdown.unsupported'
  | 'shutdown.commandFailed'
  | 'shutdown.exitCode'
  | 'job.reportNotCleanNote'
  | 'job.verifyModeNote'
  | 'job.pdfMissingFrames'
  | 'job.inlineSkippedNote'
  | 'job.reportGenFail'
  | 'job.reportWhileRunning'
  | 'job.reportPublished'
  | 'job.reportPublishFail'
  // ---- IPC 处理器层（这些文案会以 { ok:false, error } 原样送到界面） ----
  | 'ipc.pathNotVolume'
  | 'ipc.invalidTargetPath'
  | 'ipc.jobRunningCannotDelete'
  | 'ipc.parentMissing'
  | 'ipc.diagnosticsZipMissing'
  | 'ipc.diagnosticsZipSpawn'
  | 'ipc.diagnosticsZipFailed'

const MESSAGES: Record<MsgKey, Record<Language, string>> = {
  /* ---------------- 任务生命周期 ---------------- */
  'engine.resumeReset': {
    'zh-CN': '有 {count} 个文件上次未处理完，已回到待处理状态并将自动断点续传。',
    en: '{count} file(s) from the previous run were reset to pending and will resume from their breakpoints.'
  },
  'engine.allTargetsUnavailable': {
    'zh-CN': '所有启用的目标盘都不可用，任务无法开始。',
    en: 'All enabled targets are unavailable. The job cannot start.'
  },
  'engine.targetDisabled': {
    'zh-CN': '已停用',
    en: 'Disabled'
  },
  'engine.notDirectory': {
    'zh-CN': '目标路径不是目录',
    en: 'Target path is not a directory'
  },
  'engine.targetUnavailable': {
    'zh-CN': '目标盘不可用：{reason}',
    en: 'Target unavailable: {reason}'
  },
  'engine.targetQuarantined': {
    'zh-CN': '目标「{label}」不可用，本次任务已隔离该盘：{reason}',
    en: 'Target "{label}" is unavailable and has been quarantined for this job: {reason}'
  },
  'engine.cancelledResume': {
    'zh-CN': '任务已取消，已写入的分片会保留以便续传。',
    en: 'Job cancelled. Partially written chunks are kept for resuming.'
  },
  'engine.cancelled': {
    'zh-CN': '任务已取消',
    en: 'Job cancelled'
  },
  'engine.jobInterrupted': {
    'zh-CN': '任务中断：{reason}',
    en: 'Job interrupted: {reason}'
  },
  'engine.jobDoneWithFailures': {
    'zh-CN': '任务结束：{count} 个文件未通过校验，请查看失败清单与报告。',
    en: 'Job finished: {count} file(s) failed verification. Check the failure list and the report.'
  },
  'engine.jobDoneClean': {
    'zh-CN': '任务结束：全部文件已拷贝并通过独立重读校验。',
    en: 'Job finished: every file was copied and passed independent re-read verification.'
  },
  'engine.conflictSummary': {
    'zh-CN':
      '另有 {count} 个文件因目标上已存在同名文件而未拷贝（原文件已保留，目标盘本身正常）。请查看各目标的失败清单后人工核对。',
    en:
      'Additionally, {count} file(s) were skipped because a file with the same name already exists on the target (originals kept; the target itself is healthy). Review each target\'s failure list.'
  },
  'engine.codexZeroByte': {
    'zh-CN':
      '{relPath} 扫描记录为 0 字节、实际读出 {bytes} 字节 —— CODEX Device Manager 虚拟文件系统的正常表现，已按实际值记录。',
    en:
      '{relPath} was scanned as 0 bytes but {bytes} bytes were actually read — expected behaviour of the CODEX Device Manager virtual file system; recorded with the real value.'
  },

  /* ---------------- 单文件处理 ---------------- */
  'engine.sourceReadFail': {
    'zh-CN': '无法读取源文件：{reason}',
    en: 'Cannot read source file: {reason}'
  },
  'engine.sourceReadFailShort': {
    'zh-CN': '读取源文件失败：{reason}',
    en: 'Failed to read source file: {reason}'
  },
  'engine.noEnabledTargets': {
    'zh-CN': '没有启用的目标盘。',
    en: 'No enabled targets.'
  },
  'engine.allTargetsBroken': {
    'zh-CN': '所有启用的目标盘都已不可用。',
    en: 'All enabled targets are unavailable.'
  },
  'engine.verifyNoFileOnAnyTarget': {
    'zh-CN': '所有目标上都不存在该文件（或文件大小与源不一致）。',
    en: 'The file does not exist on any target (or its size differs from the source).'
  },
  'engine.copyBlockedOnAllTargets': {
    'zh-CN': '所有目标都无法写入该文件（多为目标上已存在同名但内容不同的文件）。',
    en: 'The file could not be written to any target (usually because a different file with the same name already exists there).'
  },
  'engine.verifyFileMissing': {
    'zh-CN': '仅校验：目标上不存在该文件。',
    en: 'Verify only: the file does not exist on the target.'
  },
  'engine.verifySizeMismatch': {
    'zh-CN':
      '仅校验：目标上该文件大小与源不一致（现有 {actual} 字节，源 {expected} 字节）。该文件可能不完整或不是同一素材；目标文件未做任何改动。',
    en:
      'Verify only: the target file size differs from the source ({actual} vs {expected} bytes). It may be incomplete or a different clip; the target file was not modified.'
  },
  'engine.verifyTargetReadFail': {
    'zh-CN': '仅校验：无法读取目标文件：{reason}',
    en: 'Verify only: cannot read the target file: {reason}'
  },
  'engine.verifyReadFailLog': {
    'zh-CN': '读取失败：{relPath} @ {label} —— {reason}',
    en: 'Read failed: {relPath} @ {label} — {reason}'
  },
  'engine.resumeFrom': {
    'zh-CN': '从 {offset} 字节处续传：{relPath} → {label}',
    en: 'Resuming from byte {offset}: {relPath} → {label}'
  },
  'engine.prepareWriteFail': {
    'zh-CN': '无法准备写入：{reason}',
    en: 'Cannot prepare for writing: {reason}'
  },
  'engine.prepareWriteQuarantined': {
    'zh-CN': '目标「{label}」准备写入失败，该盘已隔离：{reason}',
    en: 'Target "{label}" failed during write preparation and has been quarantined: {reason}'
  },
  'engine.writeFail': {
    'zh-CN': '写入失败：{reason}',
    en: 'Write failed: {reason}'
  },
  'engine.writeInterrupted': {
    'zh-CN': '目标「{label}」写入中断，该盘已隔离，其余目标继续：{reason}',
    en: 'Target "{label}" write interrupted and quarantined; other targets continue: {reason}'
  },
  'engine.writeZeroBytes': {
    'zh-CN': '写入返回 0 字节 —— 目标盘可能已满或被拔出',
    en: 'Write returned 0 bytes — the target may be full or was disconnected'
  },
  'engine.finalizeFail': {
    'zh-CN': '收尾失败：{reason}',
    en: 'Finalization failed: {reason}'
  },

  /* ---------------- 命名冲突 ---------------- */
  'engine.conflictSizeDiff': {
    'zh-CN':
      '{prefix}且大小不同（现有 {actual} 字节，源 {expected} 字节）。为避免覆盖素材，已保留原文件；该文件在此目标上未拷贝，其余文件照常写入。',
    en:
      '{prefix} with a different size ({actual} vs {expected} bytes). To avoid overwriting footage, the original was kept; this file was not copied to this target while everything else continues.'
  },
  'engine.conflictSizeDiffLog': {
    'zh-CN': '「{label}」上已存在同名不同大小的文件，已跳过该文件（目标盘继续使用）：{relPath}',
    en: '"{label}" already has a same-name file of a different size; this file was skipped (the target stays in use): {relPath}'
  },
  'engine.conflictSameSize': {
    'zh-CN':
      '{prefix}（同名同尺寸，但内容与源不一致）。为避免覆盖素材，已保留原文件；该文件在此目标上未拷贝。请人工核对该文件是否为别的素材。',
    en:
      '{prefix} (same name and size, but different content). To avoid overwriting footage, the original was kept and this file was not copied to this target. Please check manually whether it is a different clip.'
  },
  'engine.conflictSameSizeLog': {
    'zh-CN': '「{label}」上已存在同名同尺寸但内容不同的文件，已跳过该文件（目标盘继续使用）：{relPath}',
    en: '"{label}" already has a same-name, same-size file with different content; this file was skipped (the target stays in use): {relPath}'
  },

  /* ---------------- 校验 ---------------- */
  'engine.verifyMismatch': {
    'zh-CN': '仅校验：目标文件的校验值与源不一致（内容不同或已损坏）。目标文件未做任何改动。',
    en: 'Verify only: the target file hash differs from the source (different content or corrupted). The target file was not modified.'
  },
  'engine.verifyMismatchLog': {
    'zh-CN': '校验不一致：{relPath} @ {label} —— 目标内容与源不符，请人工复核。',
    en: 'Hash mismatch: {relPath} @ {label} — target content differs from the source. Please review manually.'
  },
  'engine.verifyMismatchQuarantineLog': {
    'zh-CN': '校验不一致：{relPath} @ {label} —— 该目标已标记为不可信，建议更换介质后重跑。',
    en: 'Hash mismatch: {relPath} @ {label} — this target has been marked untrusted. Re-copy to different media.'
  },
  'engine.verifyMismatchTargetError': {
    'zh-CN': '目标侧重读校验值与源侧不一致',
    en: 'Re-read hash on the target does not match the source'
  },
  'engine.verifyMismatchResult': {
    'zh-CN': '目标侧重读校验值与源侧不一致（文件可能损坏，请更换目标介质后重跑）。',
    en: 'Re-read hash on the target does not match the source (the file may be corrupted; re-copy to different media).'
  },
  'engine.verifyHashFail': {
    'zh-CN': '校验失败：{reason}',
    en: 'Verification failed: {reason}'
  },

  /* ---------------- JobManager：创建任务 ---------------- */
  'job.sourceMissing': {
    'zh-CN': '来源路径不存在：{path}',
    en: 'Source path does not exist: {path}'
  },
  'job.sourceEmpty': {
    'zh-CN': '该来源路径下没有找到任何可校验的文件。',
    en: 'No verifiable files were found under the source path.'
  },
  'job.nestedPath': {
    'zh-CN': '目标「{path}」与来源路径相互包含。把素材拷进自己里面会造成无限递归，已拒绝。',
    en: 'Target "{path}" and the source path contain each other. Copying footage into itself would recurse forever — refused.'
  },
  'job.sameVolume': {
    'zh-CN': '目标「{path}」与来源在同一个卷上。为了保证校验有效，源与目标必须在不同的物理卷。',
    en: 'Target "{path}" is on the same volume as the source. For meaningful verification they must be on different physical volumes.'
  },
  'job.targetNotWritable': {
    'zh-CN': '目标「{path}」无法创建或不可写：{reason}',
    en: 'Target "{path}" cannot be created or is not writable: {reason}'
  },
  'job.verifyTargetMissing': {
    'zh-CN': '目标「{path}」不存在。仅校验模式不会创建目录，请选择已有的拷贝目录。',
    en: 'Target "{path}" does not exist. Verify-only mode never creates directories — pick an existing copy folder.'
  },
  'job.targetNotDirectory': {
    'zh-CN': '目标「{path}」不是目录。',
    en: 'Target "{path}" is not a directory.'
  },
  'job.spaceWarning': {
    'zh-CN': '目标「{label}」剩余空间 {free} 字节，可能放不下 {total} 字节的素材。',
    en: 'Target "{label}" has {free} bytes free, which may not fit {total} bytes of footage.'
  },
  'job.parentMissing': {
    'zh-CN': '选择的母项目不存在，可能已被删除。',
    en: 'The selected parent project no longer exists — it may have been deleted.'
  },
  'job.created': {
    'zh-CN': '已创建任务「{name}」：{files} 个文件 / {bytes} 字节，{targets} 个目标',
    en: 'Created job "{name}": {files} file(s) / {bytes} bytes, {targets} target(s)'
  },
  'job.createdMode': {
    'zh-CN': '（{mode}）',
    en: ' ({mode})'
  },
  'queueMode.verify': {
    'zh-CN': '仅校验',
    en: 'verify-only'
  },
  'queueMode.copy': {
    'zh-CN': '拷贝',
    en: 'copy'
  },
  'job.createdNoParent': {
    'zh-CN': '，未归入母项目。',
    en: ', not assigned to any parent project.'
  },
  'job.createdWithParent': {
    'zh-CN': '，归入母项目「{name}」。',
    en: ', assigned to parent project "{name}".'
  },
  'job.notFound': {
    'zh-CN': '任务不存在。',
    en: 'Job not found.'
  },
  'job.alreadyRunning': {
    'zh-CN': '该任务正在运行中。',
    en: 'This job is already running.'
  },
  'job.notRunning': {
    'zh-CN': '该任务当前没有在运行。',
    en: 'This job is not currently running.'
  },
  'job.noFailedFiles': {
    'zh-CN': '这个任务没有可重试的失败项。',
    en: 'This job has no failed items to retry.'
  },
  'job.retryFailed': {
    'zh-CN': '重试失败项：{count} 个文件已回到待处理，已校验通过的目标不会重拷。',
    en: 'Retrying failed items: {count} file(s) returned to pending; verified targets are not copied again.'
  },
  'job.addTargetWhileRunning': {
    'zh-CN': '任务正在运行，不能修改目标。请先取消任务。',
    en: 'The job is running — targets cannot be changed. Cancel it first.'
  },
  'job.maxTargets': {
    'zh-CN': '最多支持 8 个目标。',
    en: 'A job supports at most 8 targets.'
  },
  'job.targetAlreadyInList': {
    'zh-CN': '该目标已经在列表里了。',
    en: 'That target is already in the list.'
  },
  'job.nestedPathShort': {
    'zh-CN': '目标与来源路径相互包含，已拒绝。',
    en: 'The target and source paths contain each other — refused.'
  },
  'job.runError': {
    'zh-CN': '任务执行异常：{reason}',
    en: 'Job execution error: {reason}'
  },

  /* ---------------- JobManager：报告与收尾 ---------------- */
  'job.ejected': {
    'zh-CN': '已弹出目标盘「{label}」。',
    en: 'Target "{label}" ejected.'
  },
  'job.ejectFail': {
    'zh-CN': '弹出目标盘「{label}」失败：{reason}',
    en: 'Failed to eject target "{label}": {reason}'
  },
  'job.shutdownScheduled': {
    'zh-CN': '任务已完成，系统将在 60 秒后关机。要取消请立即在系统提示中点击取消。',
    en: 'Job complete. The system will shut down in 60 seconds. Cancel now in the system prompt to abort.'
  },
  'job.shutdownFail': {
    'zh-CN': '自动关机未能启动：{reason}',
    en: 'Could not start the automatic shutdown: {reason}'
  },
  // 这些是「弹出失败的原因」本身，会被上面 job.ejectFail 的 {reason} 包住
  'eject.done': {
    'zh-CN': '已弹出',
    en: 'Ejected'
  },
  'eject.unsupported': {
    'zh-CN': '当前系统不支持自动弹出，请手动推出磁盘。',
    en: 'This system does not support automatic ejection; please eject the disk manually.'
  },
  'eject.noShell': {
    'zh-CN':
      '这台电脑上找不到 PowerShell，无法自动弹出。请用任务栏右下角「安全删除硬件并弹出媒体」手动弹出。',
    en:
      'PowerShell was not found on this computer, so the disk cannot be ejected automatically. Please use "Safely Remove Hardware and Eject Media" in the taskbar.'
  },
  'eject.failedWindows': {
    'zh-CN':
      'Windows 无法自动弹出这块盘（读卡器与移动硬盘经常不支持）。请确认写入已经停止后，用任务栏右下角「安全删除硬件并弹出媒体」手动弹出，再拔盘。',
    en:
      'Windows could not eject this disk automatically (card readers and portable drives often do not support it). Once you are sure writes have stopped, use "Safely Remove Hardware and Eject Media" in the taskbar before unplugging.'
  },
  'eject.commandFailed': {
    'zh-CN': '无法调用 diskutil：{reason}',
    en: 'Could not run diskutil: {reason}'
  },
  'eject.exitCode': {
    'zh-CN': 'diskutil 退出码 {code}',
    en: 'diskutil exited with code {code}'
  },
  // 这些是「关机失败的原因」本身，会被上面 job.shutdownFail 的 {reason} 包住
  'shutdown.scheduled': {
    'zh-CN': '已安排关机',
    en: 'Shutdown scheduled'
  },
  'shutdown.unsupported': {
    'zh-CN': '当前系统不支持自动关机，请手动关机。',
    en: 'This system does not support automatic shutdown; please shut down manually.'
  },
  'shutdown.commandFailed': {
    'zh-CN': '无法启动关机命令：{reason}',
    en: 'Could not start the shutdown command: {reason}'
  },
  'shutdown.exitCode': {
    'zh-CN': '关机命令退出码 {code}',
    en: 'Shutdown command exited with code {code}'
  },
  'job.reportNotCleanNote': {
    'zh-CN':
      '本次任务未正常结束（状态：{state}），因此没有把清单写入目标盘。报告仍然完整记录了当时的实际结果。',
    en:
      'This job did not finish normally (state: {state}), so no manifest was written to the targets. The report still records what actually happened.'
  },
  'job.verifyModeNote': {
    'zh-CN':
      '本任务为「仅校验」模式：只读取并比对两侧的校验值，未向目标盘写入或删除任何数据。',
    en:
      'This job ran in verify-only mode: hashes were read and compared on both sides; nothing was written to or deleted from the targets.'
  },
  'job.reportPublished': {
    'zh-CN': '报告已复制到目标盘：{targets}',
    en: 'Report copied to target(s): {targets}'
  },
  'job.reportPublishFail': {
    'zh-CN': '报告复制到「{label}」失败：{reason}',
    en: 'Failed to copy the report to "{label}": {reason}'
  },
  'job.pdfMissingFrames': {
    'zh-CN': 'PDF 中有 {missing} 张首帧图未能载入（共 {total} 张）；网页版报告不受影响。',
    en: '{missing} of {total} first-frame images failed to load in the PDF; the web report is unaffected.'
  },
  'job.inlineSkippedNote': {
    'zh-CN': '有 {count} 张首帧图因超出单文件体积预算未内联，网页版报告需连同 frames/ 目录一起发送。',
    en: '{count} first-frame image(s) exceeded the single-file size budget and were not inlined; send the web report together with its frames/ folder.'
  },
  'job.reportGenFail': {
    'zh-CN': '报告生成失败：{reason}',
    en: 'Report generation failed: {reason}'
  },
  'job.reportWhileRunning': {
    'zh-CN': '任务正在运行，现在生成报告会让它在拷贝中途重做已处理过的文件。请等任务完成或先取消。',
    en: 'The job is running. Generating a report now would make it redo files it has already processed. Wait for it to finish, or cancel it first.'
  },
  'ipc.pathNotVolume': {
    'zh-CN': '无法识别该路径所属的卷。',
    en: 'Could not determine the volume this path belongs to.'
  },
  'ipc.invalidTargetPath': {
    'zh-CN': '目标路径不合法。',
    en: 'The target path is not valid.'
  },
  'ipc.jobRunningCannotDelete': {
    'zh-CN': '任务正在运行，请先取消再删除。',
    en: 'The job is running. Cancel it before deleting.'
  },
  'ipc.parentMissing': {
    'zh-CN': '母项目不存在。',
    en: 'Parent project not found.'
  },
  'ipc.diagnosticsZipMissing': {
    'zh-CN': '系统里没有找到打包工具 /usr/bin/zip，无法生成诊断包。',
    en: 'The packaging tool /usr/bin/zip was not found, so the diagnostics bundle could not be created.'
  },
  'ipc.diagnosticsZipSpawn': {
    'zh-CN': '无法启动 zip：{reason}',
    en: 'Could not start zip: {reason}'
  },
  'ipc.diagnosticsZipFailed': {
    'zh-CN': '打包失败（zip 退出码 {code}）：{reason}',
    en: 'Packaging failed (zip exited with {code}): {reason}'
  }
}

/**
 * 占位符替换：`{name}` → 值。
 *
 * 放在共享层是因为**两个地方都要用**：主进程的 `msg()` 与渲染层的 `t()`。
 * 各写一份的话，两边的占位符写法迟早会漂（这个项目里真的漂过 ——
 * 渲染层曾经用 `%N%`，主进程用 `{name}`）。
 *
 * 没有对应参数的占位符**原样保留**：界面上出现一个 `{count}` 很扎眼，
 * 一眼就能看出漏传参数，比悄悄渲染成空串好。
 */
export function fillTemplate(text: string, params: Record<string, string | number> = {}): string {
  let result = text
  for (const [name, value] of Object.entries(params)) {
    result = result.replaceAll(`{${name}}`, String(value))
  }
  return result
}

/**
 * 取一条引擎消息。占位符写法：`{name}`，用 `params` 替换。
 * 键缺失或语言缺失直接抛错 —— 这是程序员的错误，不该被静默吞掉。
 */
export function msg(lang: Language, key: MsgKey, params: Record<string, string | number> = {}): string {
  const entry = MESSAGES[key]
  if (entry === undefined) throw new Error(`未知消息键：${key}`)
  return fillTemplate(entry[lang], params)
}
