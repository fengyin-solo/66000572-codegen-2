import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'
import type { VolumeData, ROIResult, WindowPreset, RenderMode, SlicePlaneState } from '@/types'
import type { ColormapName } from '@/lib/colormap'

export const useImagingStore = defineStore('imaging', () => {
  const loading = ref(false)
  const volumeData = ref<VolumeData | null>(null)
  const preset = ref('brain')
  const windowVal = ref(80)
  const levelVal = ref(40)
  const roiResults = ref<ROIResult[]>([])
  const mprSlice = ref({ axial: 32, coronal: 32, sagittal: 32 })

  // ---- 立体画布：呈现方式 ----
  const renderMode = ref<RenderMode>('points')
  // ---- 立体画布：颜色映射（点阵 / 实体表面 / 切割面共用）----
  const colormapName = ref<ColormapName>('grayscale')
  const colormapInvert = ref(false)
  const colormapOpacity = ref(0.85)
  // ---- 实体表面模式：等值面阈值（窗宽窗位归一化后的 t）----
  const surfaceThreshold = ref(0.55)
  // ---- 切割面模式：任意角度姿态（offset 为半边长归一化，0 为中心）----
  const slicePlane = ref<SlicePlaneState>({ azimuth: 0, elevation: 0, offset: 0 })

  async function loadVolume() {
    loading.value = true
    try {
      const { data } = await axios.post('/api/volume', {
        preset: preset.value, width: 64, height: 64, depth: 64
      })
      volumeData.value = data
      mprSlice.value = { axial: 32, coronal: 32, sagittal: 32 }
      // 新影像载入后把切割面归位到中心，避免旧位移落在新影像之外
      slicePlane.value = { azimuth: slicePlane.value.azimuth, elevation: slicePlane.value.elevation, offset: 0 }
    } finally { loading.value = false }
  }

  async function analyzeROI(rois: any[]) {
    loading.value = true
    try {
      const { data } = await axios.post('/api/roi', { volume: volumeData.value?.volume, rois })
      roiResults.value = data.rois
    } finally { loading.value = false }
  }

  function applyWindow(w: number, l: number) { windowVal.value = w; levelVal.value = l }

  return { loading, volumeData, preset, windowVal, levelVal, roiResults, mprSlice,
    renderMode, colormapName, colormapInvert, colormapOpacity, surfaceThreshold, slicePlane,
    loadVolume, analyzeROI, applyWindow }
})
