<template>
  <div ref="container" class="viewer3d">
    <!-- 呈现方式 + 配色工具条 -->
    <div class="toolbar">
      <div class="seg">
        <button v-for="m in modes" :key="m.name"
                :class="{ active: mode === m.name }"
                @click="mode = m.name">{{ m.label }}</button>
      </div>
      <label class="ctl">
        <span>配色</span>
        <select v-model="colorMap">
          <option v-for="c in colorMaps" :key="c.name" :value="c.name">{{ c.label }}</option>
        </select>
      </label>
      <div class="legend" :style="{ background: legendCss }" :title="`当前配色：${colorMap}`"></div>

      <template v-if="mode === 'surface'">
        <label class="ctl grow">
          <span>等值度 {{ isoValue }} HU</span>
          <input type="range" min="-1000" max="1000" step="10" v-model.number="isoValue">
        </label>
      </template>

      <template v-if="mode === 'slice'">
        <div class="slice-ctls grow">
          <div class="orient-btns">
            <button v-for="o in orientations" :key="o.name" @click="orient(o)">{{ o.label }}</button>
            <button @click="sliceDistance = 0">归位</button>
          </div>
          <label class="ctl"><span>方位角 {{ sliceAzimuth }}°</span>
            <input type="range" min="0" max="360" step="5" v-model.number="sliceAzimuth"></label>
          <label class="ctl"><span>仰角 {{ sliceElevation }}°</span>
            <input type="range" min="-90" max="90" step="5" v-model.number="sliceElevation"></label>
          <label class="ctl" :class="{ out: sliceOutsideHint }">
            <span>切面偏移 {{ sliceDistance.toFixed(2) }}</span>
            <input type="range" :min="-SLICE_RANGE" :max="SLICE_RANGE" step="0.05" v-model.number="sliceDistance"></label>
        </div>
      </template>
    </div>

    <!-- 重新渲染失败：保留上一幅画面并说明原因 -->
    <div v-if="renderError" class="banner error">
      <span>⚠ 渲染失败，已保留上一幅可用画面：{{ renderError }}</span>
      <button @click="schedule(true)">重试</button>
    </div>
    <!-- 非致命提示（如切面移出影像范围） -->
    <div v-if="notice" class="banner warn">
      <span>{{ notice }}</span>
      <button v-if="canRecoverNotice" @click="notice = ''">知道了</button>
    </div>

    <!-- 影像未就绪时的兜底，绝不只给一片空白 -->
    <div v-if="!store.volumeData" class="waiting">
      <div class="placeholder">影像数据还未准备好，请先载入影像</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useImagingStore } from '../store/imaging'
import { COLOR_MAPS, mapColor, gradientCss, type RGB } from '../lib/colormap'

type RenderMode = 'points' | 'surface' | 'slice'
interface VolumeInfo { volume: number[][][]; dimensions: [number, number, number] }
/** 构建过程没有可显示内容但并非崩溃：保留上一幅画面，提示用警告色 */
class RenderIssue extends Error {}

const store = useImagingStore()
const container = ref<HTMLDivElement>()

// ---- 呈现方式与可调参数（仅本地状态，切换不触碰相机/控件） ----
const mode = ref<RenderMode>('points')
const colorMap = ref('bone')
const isoValue = ref(150)
const sliceDistance = ref(0)
const sliceAzimuth = ref(0)
const sliceElevation = ref(0)
const sliceOutsideHint = ref(false)

// ---- 反馈状态 ----
const renderError = ref('')
const notice = ref('')
const canRecoverNotice = ref(false)

const modes = [
  { name: 'points' as const, label: '点阵' },
  { name: 'surface' as const, label: '实体表面' },
  { name: 'slice' as const, label: '切割面' },
]
const orientations = [
  { name: 'axial', label: '横断面', az: 0, el: 90 },
  { name: 'coronal', label: '冠状面', az: 90, el: 0 },
  { name: 'sagittal', label: '矢状面', az: 0, el: 0 },
]
const colorMaps = COLOR_MAPS
const legendCss = computed(() => gradientCss(colorMap.value))
const SLICE_RANGE = 2.6

function orient(o: { az: number; el: number }) {
  sliceAzimuth.value = o.az
  sliceElevation.value = o.el
}

// ---- three.js 对象 ----
let scene!: THREE.Scene
let camera!: THREE.PerspectiveCamera
let renderer!: THREE.WebGLRenderer
let controls!: OrbitControls
let animId = 0
let resizeObs: ResizeObserver | null = null
let sceneReady = false
let pending = false
const volGroup = new THREE.Group()

// 立体画布半边长（体素坐标 → 世界坐标），与原始点阵缩放保持一致
const HALF = 1.5
const tmpColor: RGB = [0, 0, 0]

function initScene() {
  const c = container.value!
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0d1117)
  camera = new THREE.PerspectiveCamera(45, c.clientWidth / c.clientHeight, 0.1, 50)
  camera.position.set(3, 2, 4) // 初始观察角度
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setSize(c.clientWidth, c.clientHeight)
  c.appendChild(renderer.domElement)

  // 原有的旋转 / 缩放交互，参数保持不变
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.target.set(0, 0, 0)

  scene.add(new THREE.AmbientLight(0xffffff, 0.6))
  const dir = new THREE.DirectionalLight(0xffffff, 0.8)
  dir.position.set(3, 4, 5)
  scene.add(dir)

  // 常驻参照：坐标十字 + 立体包围盒，任何模式 / 异常下都不会只剩空白
  const axGeom = new THREE.BufferGeometry()
  axGeom.setAttribute('position', new THREE.Float32BufferAttribute(
    [-2, 0, 0, 2, 0, 0, 0, -2, 0, 0, 2, 0, 0, 0, -2, 0, 0, 2], 3))
  scene.add(new THREE.Line(axGeom, new THREE.LineBasicMaterial({ color: 0x30363d })))
  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2)),
    new THREE.LineBasicMaterial({ color: 0x30363d }))
  scene.add(box)

  scene.add(volGroup)
  sceneReady = true

  resizeObs = new ResizeObserver(() => {
    const w = c.clientWidth, h = c.clientHeight
    if (w === 0 || h === 0) return
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  })
  resizeObs.observe(c)
}

/** 与旧版一致的窗宽窗位归一化（windowVal 为窗位中心、levelVal 为宽度） */
function normalize(val: number): number {
  const lower = store.windowVal - store.levelVal / 2
  const span = store.levelVal
  if (span === 0) return 0
  return Math.max(0, Math.min(1, (val - lower) / span))
}

// ---------- 模式一：点阵 ----------
function buildPoints(group: THREE.Group, vd: VolumeInfo) {
  const [d, h, w] = vd.dimensions
  const vol = vd.volume
  const step = 2
  const sx = (HALF * 2) / w, sy = (HALF * 2) / h, sz = (HALF * 2) / d
  const positions: number[] = []
  const colors: number[] = []

  for (let z = 0; z < d; z += step) {
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const t = normalize(vol[z][y][x])
        if (t > 0.05) {
          positions.push((x - w / 2) * sx, (y - h / 2) * sy, (z - d / 2) * sz)
          mapColor(colorMap.value, t, tmpColor)
          colors.push(tmpColor[0], tmpColor[1], tmpColor[2])
        }
      }
    }
  }
  if (!positions.length) throw new RenderIssue('当前窗宽窗位 / 配色下没有可显示的体素点，请放宽窗口范围')

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 0.04, vertexColors: true, blending: THREE.AdditiveBlending,
    depthWrite: true, transparent: true, opacity: 0.8,
  })
  group.add(new THREE.Points(geom, mat))
}

// ---------- 模式二：实体表面（等值面，实例化体素方块） ----------
function buildSurface(group: THREE.Group, vd: VolumeInfo) {
  const [d, h, w] = vd.dimensions
  const vol = vd.volume
  const sx = (HALF * 2) / w, sy = (HALF * 2) / h, sz = (HALF * 2) / d
  const iso = isoValue.value

  const collect = (step: number) => {
    const cells: { x: number; y: number; z: number; t: number }[] = []
    for (let z = 0; z < d; z += step) {
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          if (vol[z][y][x] < iso) continue
          // 六邻域中存在低于等值度的体素（影像外按 -∞ 计）→ 表面体素
          const exposed =
            x - 1 < 0 || vol[z][y][x - 1] < iso ||
            x + 1 >= w || vol[z][y][x + 1] < iso ||
            y - 1 < 0 || vol[z][y - 1][x] < iso ||
            y + 1 >= h || vol[z][y + 1][x] < iso ||
            z - 1 < 0 || vol[z - 1][y][x] < iso ||
            z + 1 >= d || vol[z + 1][y][x] < iso
          if (exposed) cells.push({ x, y, z, t: normalize(vol[z][y][x]) })
        }
      }
    }
    return cells
  }

  let step = 2
  let cells = collect(step)
  const MAX_CELLS = 20000
  if (cells.length > MAX_CELLS) { step = 3; cells = collect(step) }
  if (cells.length > MAX_CELLS) cells = cells.slice(0, MAX_CELLS)
  if (!cells.length) {
    throw new RenderIssue(`等值度 ${iso} HU 下未提取到任何表面，请调低等值度后重试`)
  }

  const geom = new THREE.BoxGeometry(sx * step, sy * step, sz * step)
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05 })
  const mesh = new THREE.InstancedMesh(geom, mat, cells.length)
  mesh.frustumCulled = false
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const color = new THREE.Color()
  cells.forEach((cell, i) => {
    m.compose(
      new THREE.Vector3((cell.x - w / 2) * sx, (cell.y - h / 2) * sy, (cell.z - d / 2) * sz),
      q,
      new THREE.Vector3(1, 1, 1))
    mesh.setMatrixAt(i, m)
    mapColor(colorMap.value, cell.t, tmpColor)
    color.setRGB(tmpColor[0], tmpColor[1], tmpColor[2])
    mesh.setColorAt(i, color)
  })
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  group.add(mesh)
  notice.value = ''
}

// ---------- 模式三：任意角度切割面 ----------
const SLICE_TEX_SIZE = 256

function buildSlice(group: THREE.Group, vd: VolumeInfo) {
  const [d, h, w] = vd.dimensions
  const vol = vd.volume
  const sx = (HALF * 2) / w, sy = (HALF * 2) / h, sz = (HALF * 2) / d

  const az = (sliceAzimuth.value * Math.PI) / 180
  const el = (sliceElevation.value * Math.PI) / 180
  // 法线：az=0/el=0 → +x（矢状）；az=90 → +y（冠状）；el=90 → +z（横断）
  const n = new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.cos(el) * Math.sin(az),
    Math.sin(el)).normalize()
  const ref = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(ref, n).normalize()
  const v = new THREE.Vector3().crossVectors(n, u).normalize()

  const dist = sliceDistance.value
  const center = n.clone().multiplyScalar(dist)
  const S = Math.SQRT2 * HALF * 2 * 1.05 // 足以覆盖整块立体的任意朝向

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SLICE_TEX_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建切割面画布（2D 上下文不可用）')
  const img = ctx.createImageData(SLICE_TEX_SIZE, SLICE_TEX_SIZE)
  const lutName = colorMap.value

  let hit = 0
  for (let j = 0; j < SLICE_TEX_SIZE; j++) {
    for (let i = 0; i < SLICE_TEX_SIZE; i++) {
      const wx = center.x + (i / (SLICE_TEX_SIZE - 1) - 0.5) * S * u.x
                        + (0.5 - j / (SLICE_TEX_SIZE - 1)) * S * v.x
      const wy = center.y + (i / (SLICE_TEX_SIZE - 1) - 0.5) * S * u.y
                        + (0.5 - j / (SLICE_TEX_SIZE - 1)) * S * v.y
      const wz = center.z + (i / (SLICE_TEX_SIZE - 1) - 0.5) * S * u.z
                        + (0.5 - j / (SLICE_TEX_SIZE - 1)) * S * v.z
      const ix = Math.round(wx / sx + w / 2)
      const iy = Math.round(wy / sy + h / 2)
      const iz = Math.round(wz / sz + d / 2)
      const o = (j * SLICE_TEX_SIZE + i) * 4
      if (ix >= 0 && ix < w && iy >= 0 && iy < h && iz >= 0 && iz < d) {
        mapColor(lutName, normalize(vol[iz][iy][ix]), tmpColor)
        img.data[o] = tmpColor[0] * 255
        img.data[o + 1] = tmpColor[1] * 255
        img.data[o + 2] = tmpColor[2] * 255
        img.data[o + 3] = 255
        hit++
      }
      // 影像范围之外的像素保持全透明，而不是渲染成一片空白
    }
  }

  const outside = hit === 0
  if (outside) {
    // 整块切面都在影像外：半透明红色底提示，绝不留空
    ctx.fillStyle = 'rgba(248,81,73,0.22)'
    ctx.fillRect(0, 0, SLICE_TEX_SIZE, SLICE_TEX_SIZE)
    ctx.strokeStyle = 'rgba(248,81,73,0.9)'
    ctx.lineWidth = 6
    ctx.strokeRect(3, 3, SLICE_TEX_SIZE - 6, SLICE_TEX_SIZE - 6)
  } else {
    ctx.putImageData(img, 0, 0)
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.colorSpace = THREE.SRGBColorSpace

  const planeGroup = new THREE.Group()
  planeGroup.position.copy(center)
  planeGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n))
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(S, S),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true }))
  planeGroup.add(plane)
  const h2 = S / 2
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-h2, -h2, 0), new THREE.Vector3(h2, -h2, 0),
      new THREE.Vector3(h2, h2, 0), new THREE.Vector3(-h2, h2, 0)]),
    new THREE.LineBasicMaterial({ color: outside ? 0xf85149 : 0x58a6ff }))
  planeGroup.add(border)
  group.add(planeGroup)

  // 原点 → 切面中心的虚线，标示切面偏移方向与距离
  const connGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), center.clone()])
  const conn = new THREE.Line(connGeo, new THREE.LineDashedMaterial({
    color: outside ? 0xf85149 : 0x8b949e, dashSize: 0.08, gapSize: 0.05 }))
  conn.computeLineDistances()
  group.add(conn)

  sliceOutsideHint.value = outside
  if (outside) {
    notice.value =
      `切割面已拖到影像范围之外（偏移 ${dist.toFixed(2)}，影像半边长 ${HALF.toFixed(2)}），未切到任何体素；红色为切割框，可拖动偏移滑块或点击“归位”`
    canRecoverNotice.value = true
  } else {
    notice.value = ''
    canRecoverNotice.value = false
  }
}

// ---------- 资源释放 ----------
function disposeGroup(group: THREE.Group) {
  group.traverse(obj => {
    const anyObj = obj as unknown as {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    anyObj.geometry?.dispose()
    const mats = Array.isArray(anyObj.material) ? anyObj.material : [anyObj.material]
    for (const mat of mats) {
      if (!mat) continue
      for (const key of Object.keys(mat)) {
        const v = (mat as unknown as Record<string, unknown>)[key]
        if (v instanceof THREE.Texture) v.dispose()
      }
      mat.dispose()
    }
  })
  group.clear()
}

// ---------- 重新渲染：先在游离组里构建，成功才替换；失败则旧画面原样保留 ----------
function rebuild() {
  if (!sceneReady) return
  const vd = store.volumeData as VolumeInfo | null
  if (!vd || !vd.volume || !vd.dimensions || vd.dimensions.length !== 3) {
    // 影像还没准备好 / 数据不完整：不动现有画面
    renderError.value = ''
    if (vd) notice.value = '影像数据不完整，暂无法重新渲染，已保留当前画面'
    return
  }

  const candidate = new THREE.Group()
  try {
    sliceOutsideHint.value = false
    if (mode.value !== 'slice') { notice.value = ''; canRecoverNotice.value = false }

    if (mode.value === 'points') buildPoints(candidate, vd)
    else if (mode.value === 'surface') buildSurface(candidate, vd)
    else buildSlice(candidate, vd)

    // 构建成功：原子替换
    scene.remove(volGroup)
    disposeGroup(volGroup)
    candidate.children.forEach(ch => volGroup.add(ch))
    scene.add(volGroup)
    renderError.value = ''
  } catch (e) {
    // 丢弃半成品，volGroup 原封不动留在场景里 —— 上一幅可用画面继续显示
    disposeGroup(candidate)
    const msg = e instanceof Error ? e.message : String(e)
    if (e instanceof RenderIssue) {
      notice.value = msg
      canRecoverNotice.value = false
    } else {
      renderError.value = msg
    }
  }
}

// 高频滑块输入用 rAF 合并，避免一次拖动触发上百次重建
function schedule(force = false) {
  if (force) { pending = false; rebuild(); return }
  if (pending) return
  pending = true
  requestAnimationFrame(() => { pending = false; rebuild() })
}

function animate() {
  animId = requestAnimationFrame(animate)
  controls.update()
  renderer.render(scene, camera)
}

onMounted(() => {
  initScene()
  rebuild()
  animate()
})

// 切换呈现方式 / 配色 / 各参数 → 重建（相机与控件完全不动，角度与缩放自然保留）
watch(
  [mode, colorMap, isoValue, sliceDistance, sliceAzimuth, sliceElevation],
  () => schedule())
// 影像载入或窗宽窗位变化
watch(
  () => [store.volumeData, store.windowVal, store.levelVal],
  () => schedule(), { deep: true })

onUnmounted(() => {
  cancelAnimationFrame(animId)
  resizeObs?.disconnect()
  controls?.dispose()
  disposeGroup(volGroup)
  renderer?.dispose()
  renderer?.domElement?.parentNode?.removeChild(renderer.domElement)
})
</script>

<style scoped>
.viewer3d { position: relative; width: 100%; height: 100%; min-height: 400px; overflow: hidden; }

.toolbar {
  position: absolute; top: 10px; left: 10px; right: 10px; z-index: 5;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: rgba(22, 27, 34, 0.85); border: 1px solid #30363d;
  border-radius: 6px; padding: 6px 10px; backdrop-filter: blur(4px);
  font-size: 11px; color: #c9d1d9;
}
.seg { display: inline-flex; border: 1px solid #30363d; border-radius: 4px; overflow: hidden; }
.seg button {
  background: #0d1117; color: #8b949e; border: none; padding: 4px 10px;
  font-size: 11px; cursor: pointer;
}
.seg button + button { border-left: 1px solid #30363d; }
.seg button.active { background: #1f6feb; color: #fff; }
.seg button:hover:not(.active) { color: #c9d1d9; }

.ctl { display: inline-flex; align-items: center; gap: 6px; }
.ctl.grow { flex: 1; min-width: 160px; }
.ctl span { white-space: nowrap; color: #8b949e; }
.ctl select {
  background: #0d1117; color: #c9d1d9; border: 1px solid #30363d;
  border-radius: 3px; font-size: 11px; padding: 2px 4px;
}
.ctl input[type=range] { width: 110px; accent-color: #58a6ff; }
.ctl.out span { color: #f85149; }

.legend {
  width: 72px; height: 10px; border-radius: 2px;
  border: 1px solid #30363d; image-rendering: pixelated;
}

.slice-ctls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex: 1; }
.slice-ctls .ctl input[type=range] { width: 90px; }
.orient-btns { display: inline-flex; gap: 4px; }
.orient-btns button {
  background: #0d1117; color: #8b949e; border: 1px solid #30363d;
  border-radius: 3px; font-size: 10px; padding: 2px 7px; cursor: pointer;
}
.orient-btns button:hover { color: #58a6ff; border-color: #58a6ff; }

.banner {
  position: absolute; bottom: 10px; left: 10px; right: 10px; z-index: 6;
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  border-radius: 5px; padding: 7px 10px; font-size: 11px; line-height: 1.4;
}
.banner.error { background: rgba(248, 81, 73, 0.18); border: 1px solid #f85149; color: #ffd7d5; }
.banner.warn { background: rgba(210, 153, 34, 0.15); border: 1px solid #d29922; color: #f5d68a; }
.banner button {
  background: transparent; border: 1px solid currentColor; color: inherit;
  border-radius: 3px; font-size: 10px; padding: 2px 8px; cursor: pointer; white-space: nowrap;
}

.waiting {
  position: absolute; inset: 0; z-index: 4; display: flex;
  align-items: center; justify-content: center; background: #0d1117;
}
.placeholder { color: #484f58; font-size: 14px; }
</style>
