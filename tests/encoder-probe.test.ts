/**
 * 编码器选择的纯函数契约。
 *
 * `pickEncoder` 决定"用户选的编码 → 实际用哪个 ffmpeg 编码器"。
 * 它最容易坏在**设备缺失**这一支：机器上没有对应硬件时，
 * 绝不能返回一个不可用的名字（那会一路失败到 ffmpeg），必须返回 null
 * 让上层"跳过并说明原因"。
 */
import { describe, expect, it } from 'vitest'
import { isCodecAvailable, pickEncoder, type EncoderCapability } from '../src/main/media/encoder-probe'

const mac: EncoderCapability = {
  h264: { name: 'h264_videotoolbox', hardware: true },
  h265: { name: 'hevc_videotoolbox', hardware: true },
  prores: true
}

const winNvidia: EncoderCapability = {
  h264: { name: 'h264_nvenc', hardware: true },
  h265: { name: 'hevc_nvenc', hardware: true },
  prores: true
}

/** Windows 上既无硬件 H.265、又没软件兜底的情形。 */
const winNoHw: EncoderCapability = {
  h264: { name: 'libopenh264', hardware: false },
  h265: { name: null, hardware: false },
  prores: true
}

describe('pickEncoder', () => {
  it('prores 恒定指向 prores_ks', () => {
    expect(pickEncoder(winNoHw, 'prores')).toEqual({ name: 'prores_ks', hardware: false })
  })

  it('h264 在 mac 上走 VideoToolbox', () => {
    expect(pickEncoder(mac, 'h264')).toEqual({ name: 'h264_videotoolbox', hardware: true })
  })

  it('h265 在 N 卡 Windows 上走 NVENC', () => {
    expect(pickEncoder(winNvidia, 'h265')).toEqual({ name: 'hevc_nvenc', hardware: true })
  })

  it('没有可用编码器时返回 null（而不是给个不能用的名字）', () => {
    expect(pickEncoder(winNoHw, 'h265')).toBeNull()
  })

  it('h264 有软件兜底时也能用（非硬件）', () => {
    expect(pickEncoder(winNoHw, 'h264')).toEqual({ name: 'libopenh264', hardware: false })
  })
})

describe('isCodecAvailable', () => {
  it('prores 在任何机器上都可用', () => {
    expect(isCodecAvailable(winNoHw, 'prores')).toBe(true)
  })

  it('h265 在无硬件时不可用', () => {
    expect(isCodecAvailable(winNoHw, 'h265')).toBe(false)
    expect(isCodecAvailable(winNvidia, 'h265')).toBe(true)
  })

  it('h264 只要有兜底就算可用', () => {
    expect(isCodecAvailable(winNoHw, 'h264')).toBe(true)
  })
})
