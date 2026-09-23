<template>
  <div ref="container" class="viewer3d">
    <!-- 渲染失败时浮在上一幅画面之上的原因提示 -->
    <div v-if="renderError" class="overlay overlay-error">
      <span>⚠️ 重新渲染失败，仍显示上一幅可用画面：{{ renderError }}</span>
      <el-button size="small" type="warning" plain @click="retryBuild">重试</el-button>
    </div>
    <!-- 切割面拖到影像范围之外：吸附到最近边界并提示，不给空白 -->
    <div v-if="outOfRange" class="overlay overlay-warn">
      切割面已超出影像范围，已吸附到最近边界 —— 拖回 0 附近或点
      <a class="link" @click="store.slicePlane.offset = 0">归位</a>
    </div>
    <!-- 影像尚未准备好：占位提示而不是一片空白 -->
    <div v-if="!volumeReady" class="overlay overlay-loading">
      <el-icon class="spin" v-if="store.loading"><Loading /></el-icon>
      <span>{{ store.loading ? '影像准备中…' : '影像尚未就绪，请先载入影像' }}</span>
    </div>

    <!-- 呈现方式 + 配色工具条（切换不触碰相机/控制器，观察角度与缩放保持不变） -->
    <div class="toolbar" v-if="volumeReady">
      <el-radio-group v-model="store.renderMode" size="small">
        <el-radio-button value="points">点阵</el-radio-button>
        <el-radio-button value="surface">实体表面</el-radio-button>
        <el-radio-button value="slice">切割面</el-radio-button>
      </el-radio-group>

      <el-select v-model="store.colormapName" size="small" style="width:92px" title="颜色映射">
        <el-option v-for="name in colormapOrder" :key="name" :value="name" :label="colormapLabels[name]" />
      </el-select>
      <el-button size="small" :type="store.colormapInvert ? 'primary' : ''" @click="store.colormapInvert = !store.colormapInvert" title="颜色反转">反色</el-button>
      <span class="ctl-label">透明度 {{ Math.round(store.colormapOpacity * 100) }}%</span>
      <input class="ctl-slider" type="range" min="0.15" max="1" step="0.05" v-model.number="store.colormapOpacity" />

      <template v-if="store.renderMode === 'surface'">
        <span class="ctl-label">等值面 {{ Math.round(store.surfaceThreshold * 100) }}</span>
        <input class="ctl-slider" type="range" min="0.05" max="0.95" step="0.01" v-model.number="store.surfaceThreshold" />
      </template>

      <template v-if="store.renderMode === 'slice'">
        <el-button-group>
          <el-button size="small" @click="setOrientation(0, 0)">轴位</el-button>
          <el-button size="small" @click="setOrientation(0, 90)">冠状</el-button>
          <el-button size="small" @click="setOrientation(90, 0)">矢状</el-button>
        </el-button-group>
        <span class="ctl-label">方位 {{ Math.round(store.slicePlane.azimuth) }}°</span>
        <input class="ctl-slider" type="range" min="-180" max="180" step="1" v-model.number="store.slicePlane.azimuth" />
        <span class="ctl-label">俯仰 {{ Math.round(store.slicePlane.elevation) }}°</span>
        <input class="ctl-slider" type="range" min="-90" max="90" step="1" v-model.number="store.slicePlane.elevation" />
        <span class="ctl-label">层位 {{ store.slicePlane.offset.toFixed(2) }}</span>
        <input class="ctl-slider ctl-slider-wide" type="range" min="-1.3" max="1.3" step="0.01" v-model.number="store.slicePlane.offset" />
        <el-button size="small" :type="dragMode ? 'primary' : ''" @click="dragMode = !dragMode">✋ 拖动切面</el-button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Loading } from '@element-plus/icons-vue'
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js'
import { useImagingStore } from '../store/imaging'
import { buildLUT, sampleLUT, COLORMAP_ORDER, COLORMAP_PRESETS, type ColormapName } from '../lib/colormap'
import type { VolumeData } from '../types'

const store = useImagingStore()
const container = ref<HTMLDivElement>()

const colormapOrder = COLORMAP_ORDER
const colormapLabels = Object.fromEntries(
  COLORMAP_ORDER.map(n => [n, COLORMAP_PRESETS[n].label])
) as Record<ColormapName, string>

const volumeReady = computed(() => validateVolume(store.volumeData) === null)
const renderError = ref('')
const outOfRange = ref(false)
const dragMode = ref(false)

let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let renderer: THREE.WebGLRenderer
let controls: OrbitControls
let animId = 0
let resizeObs: ResizeObserver | null = null

// rootGroup 装"当前已生效"的整幅画面（体对象 + 包围盒）。
// 重新渲染先在暂存组里构建，全部成功后才整体替换；失败时保持原状 —— 上一幅可用画面。
let rootGroup: THREE.Group | null = null
let disposables: { dispose(): void }[] = []
let buildScheduled = false

// 当前影像派生的 GPU 资源（跟随影像，不随呈现方式/配色切换而重建）
let volumeTexture: THREE.Data3DTexture | null = null
let volumeTextureKey = ''
let lutTexture: THREE.DataTexture | null = null
let half = new THREE.Vector3(1.5, 1.5, 1.5)

// 切割面对象（仅 slice 模式存在）
let sliceMesh: THREE.Mesh | null = null
let sliceNormalWorld = new THREE.Vector3(0, 0, 1)

function validateVolume(vd: VolumeData | null): string | null {
  if (!vd) return '体数据为空'
  const [d, h, w] = vd.dimensions
  if (!Number.isInteger(d) || !Number.isInteger(h) || !Number.isInteger(w) || d < 2 || h < 2 || w < 2)
    return '影像尺寸无效'
  if (!Array.isArray(vd.volume) || vd.volume.length !== d) return '影像数据不完整'
  return null
}

function initScene() {
  const c = container.value!
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0d1117)
  camera = new THREE.PerspectiveCamera(45, c.clientWidth / c.clientHeight, 0.1, 100)
  camera.position.set(3, 2, 4)
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setSize(c.clientWidth, c.clientHeight)
  c.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.target.set(0, 0, 0)

  scene.add(new THREE.AmbientLight(0xffffff, 0.55))
  const dir = new THREE.DirectionalLight(0xffffff, 0.9)
  dir.position.set(4, 6, 5)
  scene.add(dir)

  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)

  resizeObs = new ResizeObserver(() => {
    const w = c.clientWidth, h = c.clientHeight
    if (w === 0 || h === 0) return
    // 只改投影与画布尺寸，相机位置/target 不动 —— 观察角度与缩放不变
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  })
  resizeObs.observe(c)

  renderer.domElement.addEventListener('webglcontextlost', onContextLost)
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)
}

function onContextLost(e: Event) {
  e.preventDefault()
  renderError.value = 'WebGL 上下文丢失，已保留最后画面'
}
function onContextRestored() {
  renderError.value = ''
  volumeTexture?.dispose(); volumeTexture = null
  volumeTextureKey = ''
  lutTexture?.dispose(); lutTexture = null
  scheduleBuild()
}

function animate() {
  animId = requestAnimationFrame(animate)
  controls.update()
  renderer.render(scene, camera)
}

// ---------- 体数据 -> GPU 资源 ----------

function ensureVolumeTexture(vd: VolumeData): THREE.Data3DTexture {
  const [d, h, w] = vd.dimensions
  // 不同预设尺寸相同（都是 64³），必须同时校验预设标识，否则会错误复用旧影像纹理
  const key = `${vd.preset}:${d}x${h}x${w}`
  if (volumeTexture && volumeTextureKey === key) return volumeTexture
  volumeTexture?.dispose()
  volumeTextureKey = key
  const data = new Float32Array(new ArrayBuffer(d * h * w * 4))
  const vol = vd.volume
  for (let z = 0; z < d; z++)
    for (let y = 0; y < h; y++) {
      const plane = vol[z][y]
      for (let x = 0; x < w; x++) data[z * h * w + y * w + x] = plane[x]
    }
  const tex = new THREE.Data3DTexture(data, w, h, d)
  tex.format = THREE.RedFormat
  tex.type = THREE.FloatType
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  volumeTexture = tex
  return tex
}

function ensureLUT(): THREE.DataTexture {
  const lut = buildLUT(store.colormapName, store.colormapInvert)
  // r162 已移除 RGBFormat：用 RGBA32F，alpha 补 1，shader 只读 rgb
  if (!lutTexture) {
    const rgba = new Float32Array(new ArrayBuffer(256 * 4 * 4))
    for (let i = 0; i < 256; i++) {
      rgba[i * 4] = lut[i * 3]
      rgba[i * 4 + 1] = lut[i * 3 + 1]
      rgba[i * 4 + 2] = lut[i * 3 + 2]
      rgba[i * 4 + 3] = 1
    }
    lutTexture = new THREE.DataTexture(rgba, 256, 1, THREE.RGBAFormat, THREE.FloatType)
    lutTexture.minFilter = THREE.LinearFilter
    lutTexture.magFilter = THREE.LinearFilter
    lutTexture.needsUpdate = true
  } else {
    const data = lutTexture.image.data as unknown as Float32Array
    for (let i = 0; i < 256; i++) {
      data[i * 4] = lut[i * 3]
      data[i * 4 + 1] = lut[i * 3 + 1]
      data[i * 4 + 2] = lut[i * 3 + 2]
      data[i * 4 + 3] = 1
    }
    lutTexture.needsUpdate = true
  }
  return lutTexture
}

function windowRange() {
  const wl = store.windowVal, ww = store.levelVal
  return { lower: wl - ww / 2, invSpan: 1 / Math.max(1e-6, ww) }
}

function addBounds(group: THREE.Group, vd: VolumeData) {
  const [d, h, w] = vd.dimensions
  // 与原有点阵一致的尺度：各方向最大跨度 3
  half.set(1.5, 1.5 * h / w, 1.5 * d / w)

  const box = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2)
  const edges = new THREE.EdgesGeometry(box)
  box.dispose()
  group.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x30363d })))
  disposables.push(edges)

  const ax = new THREE.BufferGeometry()
  ax.setAttribute('position', new THREE.Float32BufferAttribute([
    -half.x, 0, 0, half.x, 0, 0,
    0, -half.y, 0, 0, half.y, 0,
    0, 0, -half.z, 0, 0, half.z,
  ], 3))
  group.add(new THREE.Line(ax, new THREE.LineBasicMaterial({ color: 0x21262d })))
  disposables.push(ax)
}

// ---------- 呈现方式一：点阵 ----------

function buildPoints(group: THREE.Group, vd: VolumeData) {
  const vol = vd.volume
  const [d, h, w] = vd.dimensions
  const step = 2
  const { lower, invSpan } = windowRange()
  const lut = buildLUT(store.colormapName, store.colormapInvert)
  const tint = { r: 0, g: 0, b: 0 }

  const positions: number[] = [], colors: number[] = []
  for (let z = 0; z < d; z += step)
    for (let y = 0; y < h; y += step)
      for (let x = 0; x < w; x += step) {
        const val = vol[z][y][x]
        let t = (val - lower) * invSpan
        if (val <= lower) t = 0 // 背景空气：窗下界及以下归零
        else if (t > 1) t = 1
        if (t <= 0.05) continue
        positions.push(
          (x - w / 2) * (half.x * 2 / w),
          (y - h / 2) * (half.y * 2 / h),
          (z - d / 2) * (half.z * 2 / d),
        )
        sampleLUT(lut, t, tint)
        // 低值压暗，避免背景噪声成片
        colors.push(tint.r * (0.25 + 0.75 * t), tint.g * (0.25 + 0.75 * t), tint.b * (0.25 + 0.75 * t))
      }

  if (!positions.length) throw new Error('当前窗宽窗位下没有可见体素，请调宽窗宽或改变配色')

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const mat = new THREE.PointsMaterial({
    size: 0.04, vertexColors: true, blending: THREE.AdditiveBlending,
    depthWrite: true, transparent: true, opacity: store.colormapOpacity,
  })
  group.add(new THREE.Points(geom, mat))
  disposables.push(geom, mat)
}

// ---------- 呈现方式二：实体表面（Marching Cubes 等值面） ----------

const MC_RESOLUTION = 48

function buildSurface(group: THREE.Group, vd: VolumeData) {
  const vol = vd.volume
  const [d, h, w] = vd.dimensions
  const { lower, invSpan } = windowRange()
  const lut = buildLUT(store.colormapName, store.colormapInvert)
  const tint = { r: 0, g: 0, b: 0 }

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0.05,
    side: THREE.DoubleSide, transparent: true, opacity: store.colormapOpacity,
  })
  const mc = new MarchingCubes(MC_RESOLUTION, mat, false, true, 120000)
  mc.isolation = store.surfaceThreshold * 100
  mc.frustumCulled = false // 插件包围球为单位球，非均匀缩放后需绕过视锥剔除
  // MarchingCubes 几何位于 -1..1，域 -0.5..0.5；scale 到影像半边长即贴合包围盒
  mc.scale.set(half.x, half.y, half.z)
  mc.reset()

  const n = MC_RESOLUTION
  // 先把归一化后的场存到本地数组
  const fieldT = new Float32Array(n * n * n)
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const vx = Math.min(w - 1, Math.round((i / (n - 1)) * (w - 1)))
        const vy = Math.min(h - 1, Math.round((j / (n - 1)) * (h - 1)))
        const vz = Math.min(d - 1, Math.round((k / (n - 1)) * (d - 1)))
        let t = (vol[vz][vy][vx] - lower) * invSpan
        // 背景空气（窗下界及以下）一律映射为 0：宽窗时空气 HU 虽在线性映射下
        // 得到小的正 t，但语义上是"无组织"，否则阈值低于该值时全场超阈、零表面。
        const raw = vol[vz][vy][vx]
        if (raw <= lower) t = 0
        else if (t > 1) t = 1
        fieldT[n * n * k + n * j + i] = t
      }

  for (let q = 0; q < n * n * n; q++) {
    const t = fieldT[q]
    mc.field[q] = t * 100
    sampleLUT(lut, t, tint)
    mc.palette[q * 3] = tint.r
    mc.palette[q * 3 + 1] = tint.g
    mc.palette[q * 3 + 2] = tint.b
  }
  mc.update()

  if (mc.count === 0) {
    mc.geometry.dispose()
    mat.dispose()
    throw new Error(`等值面阈值 ${Math.round(store.surfaceThreshold * 100)} 处未提取到表面，请降低阈值或调整窗宽窗位`)
  }
  group.add(mc)
  disposables.push({ dispose: () => { mc.geometry.dispose(); mat.dispose() } })
}

// ---------- 呈现方式三：任意角度切割面（3D 纹理 + 着色器） ----------

const sliceVertexShader = /* glsl */ `
  attribute vec3 aUvw;
  varying vec3 vUvw;
  void main() {
    vUvw = aUvw;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const sliceFragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vUvw;
  uniform sampler3D uVolume;
  uniform sampler2D uLUT;
  uniform float uOpacity;
  uniform float uWindowLower;
  uniform float uWindowInvSpan;
  void main() {
    if (any(lessThan(vUvw, vec3(0.0))) || any(greaterThan(vUvw, vec3(1.0)))) discard;
    float raw = texture(uVolume, vUvw).r;
    // 与点阵 / 实体表面 / MPR 一致的窗宽窗位归一化
    float v = clamp((raw - uWindowLower) * uWindowInvSpan, 0.0, 1.0);
    vec3 col = texture2D(uLUT, vec2(v, 0.5)).rgb;
    // 背景近黑处降低不透明度，不挡包围盒参照
    float a = uOpacity * smoothstep(0.02, 0.18, max(max(col.r, col.g), col.b));
    gl_FragColor = vec4(col, max(a, 0.06));
  }
`

function sliceLocalNormal(): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(store.slicePlane.azimuth)
  const el = THREE.MathUtils.degToRad(store.slicePlane.elevation)
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    -Math.sin(el),
    Math.cos(az) * Math.cos(el),
  ).normalize()
}

/** 平面（单位空间 n·p = o）与立方体 [-1,1]^3 的相交多边形，绕中心极角排序 */
function intersectPlaneBox(n: THREE.Vector3, o: number): THREE.Vector3[] {
  const verts: THREE.Vector3[] = []
  const eps = 1e-6
  const add = (p: THREE.Vector3) => {
    if (!verts.some(q => q.distanceToSquared(p) < 1e-10)) verts.push(p.clone())
  }
  for (let axis = 0; axis < 3; axis++) {
    for (const fixed of [-1, 1]) {
      const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3
      if (Math.abs(n.getComponent(a2)) < eps) continue
      for (const sa of [-1, 1]) {
        // 棱：axis 固定、a1 固定 sa，a2 轴坐标 u 在 [-1,1] 上解平面方程
        const u = (o - n.getComponent(axis) * fixed - n.getComponent(a1) * sa) / n.getComponent(a2)
        if (u < -1 - eps || u > 1 + eps) continue
        const p = new THREE.Vector3()
        p.setComponent(axis, fixed)
        p.setComponent(a1, sa)
        p.setComponent(a2, THREE.MathUtils.clamp(u, -1, 1))
        add(p)
      }
    }
  }
  const center = n.clone().multiplyScalar(o)
  const ref = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const e1 = new THREE.Vector3().crossVectors(n, ref).normalize()
  const e2 = new THREE.Vector3().crossVectors(n, e1).normalize()
  verts.sort((p, q) => {
    const dp = p.clone().sub(center), dq = q.clone().sub(center)
    return Math.atan2(dp.dot(e2), dp.dot(e1)) - Math.atan2(dq.dot(e2), dq.dot(e1))
  })
  return verts
}

function buildSlice(group: THREE.Group, vd: VolumeData) {
  const volTex = ensureVolumeTexture(vd)
  const lutTex = ensureLUT()

  // 滑块允许拖到 ±1.3 以覆盖"影像范围之外"；实际平面夹到包围盒表面（留极小余量保证仍有像素）
  const requested = store.slicePlane.offset
  const clamped = THREE.MathUtils.clamp(requested, -1 + 1e-4, 1 - 1e-4)
  outOfRange.value = Math.abs(requested - clamped) > 1e-3

  const nLocal = sliceLocalNormal()
  // 世界空间法向（局部轴 i 缩放了 half_i）
  sliceNormalWorld = new THREE.Vector3(nLocal.x / half.x, nLocal.y / half.y, nLocal.z / half.z).normalize()
  const localPts = intersectPlaneBox(nLocal, clamped)
  if (localPts.length < 3) throw new Error('切割面与影像没有交集')

  const positions: number[] = []
  const uvws: number[] = []
  for (const p of localPts) {
    positions.push(p.x * half.x, p.y * half.y, p.z * half.z)
    uvws.push(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, p.z * 0.5 + 0.5)
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('aUvw', new THREE.Float32BufferAttribute(uvws, 3)) // 自定义属性承载三维纹理坐标
  const idx: number[] = []
  for (let i = 1; i < localPts.length - 1; i++) idx.push(0, i, i + 1)
  geom.setIndex(idx)

  const { lower, invSpan } = windowRange()
  const mat = new THREE.ShaderMaterial({
    vertexShader: sliceVertexShader,
    fragmentShader: sliceFragmentShader,
    uniforms: {
      uVolume: { value: volTex },
      uLUT: { value: lutTex },
      uOpacity: { value: store.colormapOpacity },
      uWindowLower: { value: lower },
      uWindowInvSpan: { value: invSpan },
    },
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  })
  sliceMesh = new THREE.Mesh(geom, mat)
  sliceMesh.renderOrder = 1
  group.add(sliceMesh)
  disposables.push(geom, mat)

  // 切面轮廓线：贴边时也能看清切割范围
  const borderGeom = new THREE.BufferGeometry()
  borderGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const borderMat = new THREE.LineBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.9 })
  const border = new THREE.LineLoop(borderGeom, borderMat)
  border.renderOrder = 2
  group.add(border)
  disposables.push(borderGeom, borderMat)
}

// ---------- 构建调度：成功才替换，失败保留上一幅 ----------

function scheduleBuild() {
  if (buildScheduled) return
  buildScheduled = true
  requestAnimationFrame(() => {
    buildScheduled = false
    rebuild()
  })
}

function rebuild() {
  const vd = store.volumeData
  if (validateVolume(vd) || !vd) {
    // 影像未准备好 —— 不动现有画面（若有），占位提示负责"不是空白"
    return
  }

  const stage = new THREE.Group()
  const stageDisposables: { dispose(): void }[] = []
  const savedDisposables = disposables
  const savedSliceMesh = sliceMesh
  const savedOutOfRange = outOfRange.value
  disposables = stageDisposables
  sliceMesh = null
  if (store.renderMode !== 'slice') outOfRange.value = false

  try {
    addBounds(stage, vd)
    if (store.renderMode === 'points') buildPoints(stage, vd)
    else if (store.renderMode === 'surface') buildSurface(stage, vd)
    else buildSlice(stage, vd)
  } catch (err) {
    // 回滚暂存：上一幅可用画面原封不动，只给出原因
    disposables = savedDisposables
    sliceMesh = savedSliceMesh
    outOfRange.value = savedOutOfRange
    for (const d of stageDisposables) {
      try { d.dispose() } catch { /* ignore */ }
    }
    renderError.value = err instanceof Error ? err.message : String(err)
    return
  }

  // 全部构建成功 —— 原子提交：下一帧再移除旧画面，避免任何一帧闪成空白
  const oldRoot = rootGroup
  const oldDisposables = oldRoot ? savedDisposables : []
  rootGroup = stage
  disposables = stageDisposables
  scene.add(stage)
  if (oldRoot) {
    requestAnimationFrame(() => {
      scene.remove(oldRoot)
      for (const d of oldDisposables) {
        try { d.dispose() } catch { /* ignore */ }
      }
    })
  }
  renderError.value = ''
}

function retryBuild() {
  renderError.value = ''
  scheduleBuild()
}

// ---------- 切割面拖动（不改变观察角度/缩放） ----------

let dragging = false
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let dragStartOffset = 0
let dragStartPoint = new THREE.Vector3()

function setPointer(e: PointerEvent) {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
}

function onPointerDown(e: PointerEvent) {
  if (!dragMode.value || store.renderMode !== 'slice' || !sliceMesh) return
  setPointer(e)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObject(sliceMesh, false)[0]
  if (!hit) return
  dragging = true
  controls.enabled = false // 拖动期间禁用旋转/平移，视角保持不动
  dragStartOffset = store.slicePlane.offset
  dragStartPoint = hit.point.clone()
  renderer.domElement.style.cursor = 'grabbing'
}

function onPointerMove(e: PointerEvent) {
  if (!dragging || !sliceMesh) return
  setPointer(e)
  raycaster.setFromCamera(pointer, camera)
  // 与"过初始交点、平行于当前切面"的辅助平面求交，位移投影到法向上
  const refPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(sliceNormalWorld, dragStartPoint)
  const p = new THREE.Vector3()
  if (!raycaster.ray.intersectPlane(refPlane, p)) return
  const deltaWorld = p.sub(dragStartPoint).dot(sliceNormalWorld)
  // 单位空间 offset 与世界位移换算：沿法向走 denom 长度对应 offset 变化 1
  const denom = Math.hypot(
    sliceNormalWorld.x * half.x,
    sliceNormalWorld.y * half.y,
    sliceNormalWorld.z * half.z,
  )
  store.slicePlane.offset = THREE.MathUtils.clamp(dragStartOffset + deltaWorld / denom, -1.3, 1.3)
}

function onPointerUp() {
  if (!dragging) return
  dragging = false
  controls.enabled = true
  renderer.domElement.style.cursor = ''
}

function setOrientation(azimuth: number, elevation: number) {
  store.slicePlane.azimuth = azimuth
  store.slicePlane.elevation = elevation
}

// ---------- 观察联动 ----------

// 影像/呈现方式/配色/窗宽窗位变化 -> 重建（相机与控制器从不参与，视角与缩放保持）
watch(() => store.volumeData, () => scheduleBuild())
watch(() => store.renderMode, () => scheduleBuild())
watch(() => store.windowVal, () => scheduleBuild())
watch(() => store.levelVal, () => scheduleBuild())
watch(() => store.colormapName, () => scheduleBuild())
watch(() => store.colormapInvert, () => scheduleBuild())
watch(() => store.surfaceThreshold, () => scheduleBuild())
watch(() => store.colormapOpacity, () => {
  // 不透明度无需重建几何：直接刷 uniform/材质
  applyOpacityLive()
})
watch(() => store.slicePlane, () => scheduleBuild(), { deep: true })

function applyOpacityLive() {
  if (!rootGroup) return
  rootGroup.traverse(obj => {
    const anyObj = obj as unknown as { material?: THREE.Material | { opacity?: number; uniforms?: Record<string, { value: unknown }> } }
    const mat = anyObj.material
    if (!mat) return
    if ('uniforms' in mat && mat.uniforms?.uOpacity) mat.uniforms.uOpacity.value = store.colormapOpacity
    else if ('opacity' in mat) (mat as { opacity: number }).opacity = store.colormapOpacity
  })
}

onMounted(() => {
  initScene()
  animate()
  if (volumeReady.value) scheduleBuild()
})

onUnmounted(() => {
  cancelAnimationFrame(animId)
  resizeObs?.disconnect()
  renderer.domElement.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
  renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
  for (const d of disposables) {
    try { d.dispose() } catch { /* ignore */ }
  }
  volumeTexture?.dispose()
  lutTexture?.dispose()
  controls?.dispose()
  renderer?.dispose()
  if (renderer.domElement.parentElement === container.value) container.value?.removeChild(renderer.domElement)
})
</script>

<style scoped>
.viewer3d {
  width: 100%;
  height: 100%;
  min-height: 400px;
  position: relative;
}
.toolbar {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
  background: rgba(22, 27, 34, 0.82);
  border: 1px solid #30363d;
  border-radius: 6px;
  z-index: 5;
  font-size: 11px;
}
.ctl-label { color: #8b949e; white-space: nowrap; }
.ctl-slider { width: 80px; accent-color: #58a6ff; height: 4px; }
.ctl-slider-wide { width: 120px; }
.overlay {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  display: flex;
  gap: 10px;
  align-items: center;
  max-width: 90%;
}
.overlay-error { bottom: 14px; background: rgba(80, 20, 20, 0.92); border: 1px solid #f85149; color: #ffd7d5; }
.overlay-warn { bottom: 14px; background: rgba(80, 60, 10, 0.92); border: 1px solid #d29922; color: #f0d68a; }
.overlay-loading {
  top: 50%; transform: translate(-50%, -50%);
  background: rgba(13, 17, 23, 0.9); border: 1px solid #30363d; color: #8b949e;
  flex-direction: column; gap: 8px; padding: 18px 24px;
}
.link { color: #58a6ff; cursor: pointer; text-decoration: underline; }
.spin { animation: spin 1.2s linear infinite; font-size: 22px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
