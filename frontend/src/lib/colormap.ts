// 可调颜色映射：归一化强度 t ∈ [0,1] → RGB
// 每套配色由若干控制点(位置, 颜色)线性插值生成，并缓存为 256 项查找表

export type RGB = [number, number, number]
export interface ColorStop { t: number; color: RGB }
export interface ColorMapDef { name: string; label: string; stops: ColorStop[] }

export const COLOR_MAPS: ColorMapDef[] = [
  {
    name: 'bone',
    label: '骨色 (默认)',
    stops: [
      { t: 0.0, color: [0.02, 0.02, 0.05] },
      { t: 0.35, color: [0.45, 0.42, 0.38] },
      { t: 0.7, color: [0.82, 0.78, 0.7] },
      { t: 1.0, color: [1.0, 0.98, 0.92] },
    ],
  },
  {
    name: 'gray',
    label: '灰度',
    stops: [
      { t: 0.0, color: [0, 0, 0] },
      { t: 1.0, color: [1, 1, 1] },
    ],
  },
  {
    name: 'hot',
    label: '热力 (黑-红-黄)',
    stops: [
      { t: 0.0, color: [0, 0, 0] },
      { t: 0.33, color: [0.85, 0.05, 0] },
      { t: 0.66, color: [1, 0.55, 0] },
      { t: 1.0, color: [1, 1, 0.6] },
    ],
  },
  {
    name: 'coolwarm',
    label: '冷暖 (蓝-红)',
    stops: [
      { t: 0.0, color: [0.05, 0.15, 0.6] },
      { t: 0.5, color: [0.93, 0.93, 0.93] },
      { t: 1.0, color: [0.7, 0.05, 0.1] },
    ],
  },
  {
    name: 'tissue',
    label: '组织 (紫-青)',
    stops: [
      { t: 0.0, color: [0.08, 0.0, 0.16] },
      { t: 0.5, color: [0.35, 0.15, 0.55] },
      { t: 0.78, color: [0.15, 0.55, 0.65] },
      { t: 1.0, color: [0.75, 0.98, 0.9] },
    ],
  },
]

const LUT_SIZE = 256
const lutCache = new Map<string, Uint8ClampedArray>()

function buildLut(def: ColorMapDef): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(LUT_SIZE * 3)
  const stops = [...def.stops].sort((a, b) => a.t - b.t)
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1)
    let lo = stops[0]
    let hi = stops[stops.length - 1]
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s].t && t <= stops[s + 1].t) {
        lo = stops[s]
        hi = stops[s + 1]
        break
      }
    }
    const span = hi.t - lo.t
    const k = span <= 0 ? 0 : (t - lo.t) / span
    lut[i * 3] = Math.round((lo.color[0] + (hi.color[0] - lo.color[0]) * k) * 255)
    lut[i * 3 + 1] = Math.round((lo.color[1] + (hi.color[1] - lo.color[1]) * k) * 255)
    lut[i * 3 + 2] = Math.round((lo.color[2] + (hi.color[2] - lo.color[2]) * k) * 255)
  }
  return lut
}

export function getLut(name: string): Uint8ClampedArray {
  let lut = lutCache.get(name)
  if (!lut) {
    const def = COLOR_MAPS.find(m => m.name === name) ?? COLOR_MAPS[0]
    lut = buildLut(def)
    lutCache.set(name, lut)
  }
  return lut
}

/** 归一化强度 t → RGB（0~1，供 Three.js 使用） */
export function mapColor(name: string, t: number, out: RGB): RGB {
  const lut = getLut(name)
  const i = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(t * (LUT_SIZE - 1))))
  out[0] = lut[i * 3] / 255
  out[1] = lut[i * 3 + 1] / 255
  out[2] = lut[i * 3 + 2] / 255
  return out
}

/** 生成配色预览的 CSS 渐变字符串（供图例使用） */
export function gradientCss(name: string): string {
  const def = COLOR_MAPS.find(m => m.name === name) ?? COLOR_MAPS[0]
  const parts = [...def.stops]
    .sort((a, b) => a.t - b.t)
    .map(s => `rgb(${s.color.map(c => Math.round(c * 255)).join(',')}) ${Math.round(s.t * 100)}%`)
  return `linear-gradient(90deg, ${parts.join(',')})`
}
