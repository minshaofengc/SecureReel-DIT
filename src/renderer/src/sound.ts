/**
 * 提示音的**发声**部分。
 *
 * 用 Web Audio 现场合成，不引入任何音频文件：安装包体积零增长，
 * 也不会出现"资源文件在打包时丢了"这类问题。
 *
 * 三种声音刻意在**音高走向**上区分，为的是不看屏幕也能听出来：
 *   开始 → 上行（事情开始了）
 *   完成 → 两个和谐音（收工）
 *   出错 → 下行小三度（不对劲，要人来看一眼）
 *
 * ⚠️ 「什么时候该响」在 `@shared/types` 的 `cueForJobState()` 里，不在这。
 * 那个是纯逻辑、要能被 node 环境的单测直接引用；而本文件用到 DOM 的
 * AudioContext，一旦被测试引入就会把 DOM 类型拖进主进程的编译范围。
 */
import type { SoundCue } from '@shared/types'

let audioContext: AudioContext | null = null

/**
 * 懒建音频上下文。
 *
 * Chromium 的自动播放策略要求**用户交互之后**才能启动音频上下文 ——
 * 所以第一次播放之前必须发生过一次点击，由 `unlockAudio()` 负责。
 */
function ensureContext(): AudioContext | null {
  if (audioContext !== null) return audioContext
  try {
    audioContext = new AudioContext()
    return audioContext
  } catch {
    // 没有音频设备（某些远程 / 受限环境）时安静放弃，
    // 绝不能因为"放不出声音"而影响拷贝本身
    return null
  }
}

/** 在界面上第一次按下时调一次，把音频上下文唤醒。 */
export function unlockAudio(): void {
  const context = ensureContext()
  if (context !== null && context.state === 'suspended') void context.resume()
}

/**
 * 一个带指数衰减包络的单音。
 *
 * 包络不能省：直接开关增益会听到"啪"的爆音，在安静的现场格外刺耳。
 */
function tone(
  context: AudioContext,
  frequency: number,
  at: number,
  duration: number,
  peak: number
): void {
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  // 起手不能是 0：exponentialRamp 的起点必须是正数
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(at)
  oscillator.stop(at + duration + 0.02)
}

/** 播一声。音量为 0 时直接不播。 */
export function playCue(cue: SoundCue, volume: number): void {
  const level = Math.min(1, Math.max(0, volume))
  if (level <= 0) return

  const context = ensureContext()
  if (context === null) return
  if (context.state === 'suspended') void context.resume()

  const at = context.currentTime + 0.02

  if (cue === 'start') {
    tone(context, 587.33, at, 0.12, 0.28 * level)
    tone(context, 880.0, at + 0.09, 0.16, 0.24 * level)
    return
  }
  if (cue === 'done') {
    tone(context, 659.25, at, 0.14, 0.28 * level)
    tone(context, 987.77, at + 0.11, 0.26, 0.24 * level)
    return
  }
  // 出错：下行小三度
  tone(context, 392.0, at, 0.16, 0.32 * level)
  tone(context, 311.13, at + 0.13, 0.3, 0.28 * level)
}
