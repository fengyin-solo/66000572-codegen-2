export interface WindowPreset { window: number; level: number; desc: string }
export interface VolumeData {
  volume: number[][][]
  dimensions: [number, number, number]
  mpr: { axial: number[][]; coronal: number[][]; sagittal: number[][] }
  preset: string
  windowPresets: Record<string, WindowPreset>
}

export interface ROIResult {
  label: string; center: number[]; radius: number
  mean: number; std: number; min: number; max: number; voxelCount: number
  histogram: number[]
}

/** 立体画布呈现方式：点阵 / 实体表面 / 任意角度切割面 */
export type RenderMode = 'points' | 'surface' | 'slice'

/** 切割面姿态：绕 Y 方位角 + 绕 X 俯仰角（度），offset 为沿法向的位移（半边长归一化，±1 为影像边界） */
export interface SlicePlaneState {
  azimuth: number
  elevation: number
  offset: number
}
