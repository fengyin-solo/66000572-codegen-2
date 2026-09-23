/**
 * 体渲染颜色映射（Transfer Function / Colormap）工具
 *
 * 所有配色都以"窗宽窗位归一化后的灰度 t ∈ [0,1]"为输入，
 * 点阵、实体表面、任意角度切割面三种呈现方式共用同一套映射，
 * 保证切换呈现方式时配色语义一致。
 */

export type ColormapName = 'grayscale' | 'hot' | 'viridis' | 'jet' | 'bone'

export interface ColormapPreset {
  label: string
  /** 配色锚点：[t, r, g, b]，r/g/b 为 0~1 */
  stops: Array<[number, number, number, number]>
}

export const COLORMAP_PRESETS: Record<ColormapName, ColormapPreset> = {
  grayscale: {
    label: '灰度',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [1.0, 1.0, 1.0, 1.0],
    ],
  },
  bone: {
    label: '骨色',
    // 类医学影像 "bone"：黑 → 冷蓝灰 → 暖白
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.45, 0.26, 0.30, 0.38],
      [0.75, 0.62, 0.60, 0.58],
      [1.0, 1.0, 1.0, 0.95],
    ],
  },
  hot: {
    label: '热色',
    stops: [
      [0.0, 0.0, 0.0, 0.0],
      [0.33, 1.0, 0.0, 0.0],
      [0.66, 1.0, 1.0, 0.0],
      [1.0, 1.0, 1.0, 1.0],
    ],
  },
  viridis: {
    label: '翠绿',
    stops: [
      [0.0, 0.267, 0.005, 0.329],
      [0.25, 0.282, 0.14, 0.458],
      [0.5, 0.127, 0.566, 0.551],
      [0.75, 0.369, 0.788, 0.382],
      [1.0, 0.993, 0.906, 0.144],
    ],
  },
  jet: {
    label: '彩虹',
    stops: [
      [0.0, 0.0, 0.0, 0.5],
      [0.125, 0.0, 0.0, 1.0],
      [0.375, 0.0, 1.0, 1.0],
      [0.625, 1.0, 1.0, 0.0],
      [0.875, 1.0, 0.0, 0.0],
      [1.0, 0.5, 0.0, 0.0],
    ],
  },
}

export const COLORMAP_ORDER: ColormapName[] = ['grayscale', 'bone', 'hot', 'viridis', 'jet']

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * 生成 256 级查找表（RGB 三通道，Float32）。
 * @param name    配色名
 * @param invert  反转（t -> 1-t），即"反片"
 */
export function buildLUT(name: ColormapName, invert = false): Float32Array {
  const preset = COLORMAP_PRESETS[name] ?? COLORMAP_PRESETS.grayscale
  const lut = new Float32Array(256 * 3)
  const stops = preset.stops
  for (let i = 0; i < 256; i++) {
    const tSrc = invert ? 1 - i / 255 : i / 255
    // 找到所在锚点区间
    let lo = stops[0]
    let hi = stops[stops.length - 1]
    for (let s = 0; s < stops.length - 1; s++) {
      if (tSrc >= stops[s][0] && tSrc <= stops[s + 1][0]) {
        lo = stops[s]
        hi = stops[s + 1]
        break
      }
    }
    const span = hi[0] - lo[0]
    const f = span <= 0 ? 0 : clamp01((tSrc - lo[0]) / span)
    lut[i * 3] = lo[1] + (hi[1] - lo[1]) * f
    lut[i * 3 + 1] = lo[2] + (hi[2] - lo[2]) * f
    lut[i * 3 + 2] = lo[3] + (hi[3] - lo[3]) * f
  }
  return lut
}

/** CPU 端（点阵 / Marching Cubes 调色板）查表取色 */
export function sampleLUT(lut: Float32Array, t: number, out: { r: number; g: number; b: number }) {
  const i = Math.round(clamp01(t) * 255)
  out.r = lut[i * 3]
  out.g = lut[i * 3 + 1]
  out.b = lut[i * 3 + 2]
}
