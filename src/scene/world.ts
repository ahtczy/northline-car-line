import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { LinePlan } from '../sim/line.ts'
import { prepareLoadedModel } from './budget.ts'

const PLANT = `${import.meta.env.BASE_URL}models/plant`
const STATION_X = [-58, -43.2, -28.4, -13.6, 1.2, 16, 30.8]
/** Visual ride height. Fill and Test list a floor table (0); the shell still sits on the AMR. */
const RIDE = [0.55, 0.62, 0.62, 1.05, 0.95, 0.48, 0.42]

export interface CarView {
  root: THREE.Group
  lift: THREE.Object3D
  dash: THREE.Object3D
  seats: THREE.Object3D
  power: THREE.Object3D
  wheels: THREE.Object3D
  shellMat: THREE.MeshPhysicalMaterial | null
}

export interface CobotRig {
  yaw: THREE.Object3D
  elbow: THREE.Object3D
  wrist: THREE.Object3D
  station: number
  phase: number
}

export interface WorkerRig {
  root: THREE.Group
  legL: THREE.Object3D
  legR: THREE.Object3D
  armL: THREE.Object3D
  armR: THREE.Object3D
  station: number
  phase: number
  baseX: number
  baseZ: number
  walk: boolean
}

export interface ForkliftRig {
  root: THREE.Group
  z: number
  x0: number
  x1: number
  speed: number
  offset: number
  yaw: number
}

export interface Beacon {
  red: THREE.MeshStandardMaterial
  amber: THREE.MeshStandardMaterial
  green: THREE.MeshStandardMaterial
}

export interface Hall {
  cars: CarView[]
  tags: HTMLElement[]
  pickables: THREE.Mesh[]
  cobots: CobotRig[]
  workers: WorkerRig[]
  forklifts: ForkliftRig[]
  beacons: Beacon[]
  relayoutCrew: (plan: LinePlan) => void
}

export function applyCarStage(view: CarView, stage: number): void {
  view.dash.visible = stage >= 1
  view.seats.visible = stage >= 2
  view.power.visible = stage >= 3
  view.wheels.visible = stage >= 4
  const mat = view.shellMat
  if (!mat) return
  const painted = stage < 4
  mat.color.set(painted ? 0x2c3238 : 0xe4e0d8)
  mat.metalness = painted ? 0.64 : 0.42
  mat.roughness = painted ? 0.2 : 0.38
}

export function setRide(view: CarView, station: number): void {
  view.lift.position.y = RIDE[Math.max(0, Math.min(6, station))] ?? 0.5
}

export async function createHall(
  scene: THREE.Scene,
  onProgress: (frac: number, label: string) => void,
): Promise<Hall> {
  scene.background = new THREE.Color(0xd4d7d4)
  onProgress(0.04, 'Warehouse lighting')
  await loadEnvironment(scene)

  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  const cache = new Map<string, THREE.Group>()
  const failed: string[] = []

  async function model(file: string): Promise<THREE.Group> {
    const hit = cache.get(file)
    if (hit) return hit
    const url = `${PLANT}/${file}`
    try {
      const gltf = await loader.loadAsync(url)
      gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = false
        mesh.receiveShadow = true
        const mat = mesh.material
        if (Array.isArray(mat)) return
        if (mat && 'envMapIntensity' in mat) (mat as THREE.MeshStandardMaterial).envMapIntensity = 0.62
      })
      await prepareLoadedModel(gltf.scene, file)
      cache.set(file, gltf.scene)
      return gltf.scene
    } catch (err) {
      const hf = `https://huggingface.co/datasets/codepawl/simready-glb/resolve/main/glb/${file}`
      failed.push(`${file}: Hugging Face 404 (${hf}); mirror ${url} also failed (${err instanceof Error ? err.message : err})`)
      throw new Error(failed.join('\n'))
    }
  }

  onProgress(0.12, 'Hall')
  await buildHall(scene, model)
  buildMarkings(scene)

  onProgress(0.4, 'Car body, AMR, cobots')
  const body = await model('body.glb')
  const amr = await model('amr.glb')
  const dash = await model('dash.glb')
  const steer = await model('steer.glb')
  const seat = await model('seat.glb')
  const rear = await model('rear.glb')
  const v6 = await model('v6.glb')
  const trans = await model('trans.glb')
  const exhaust = await model('exhaust.glb')
  const tire = await model('tire.glb')
  const rim = await model('rim.glb')
  const cobot = await model('cobot.glb')
  const crane = await model('crane.glb')
  const changer = await model('changer.glb')
  const fork = await model('fork_red.glb')

  const bodyBox = new THREE.Box3().setFromObject(body)
  const bodySize = bodyBox.getSize(new THREE.Vector3())
  const cars = buildFleet({ body, amr, dash, steer, seat, rear, v6, trans, exhaust, tire, rim, bodyBox, bodySize })
  const fleet = new THREE.Group()
  cars.forEach((car) => fleet.add(car.root))
  scene.add(fleet)

  const cobots: CobotRig[] = []
  placeEquipment(scene, { cobot, crane, changer }, cobots)
  const forklifts = placeForklifts(scene, fork)

  onProgress(0.72, 'Racks and crew')
  await placeProps(scene, model)
  const crewProtos = await Promise.all([0, 1, 2, 3].map((i) => model(`crew_${i}.glb`)))
  const workerRoot = new THREE.Group()
  scene.add(workerRoot)
  const workers: WorkerRig[] = []

  const tags: HTMLElement[] = []
  const pickables: THREE.Mesh[] = []
  const beacons: Beacon[] = []
  const names = ['Body in', 'Cockpit', 'Seats', 'Marriage', 'Wheels', 'Fill', 'Test']
  const invisible = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
  for (let i = 0; i < 7; i++) {
    const el = document.createElement('div')
    el.className = 'stag'
    el.innerHTML = `<span>${String(i + 1).padStart(2, '0')}</span> ${names[i]}`
    const label = new CSS2DObject(el)
    label.position.set(STATION_X[i] ?? 0, 4.4, 0)
    scene.add(label)
    tags.push(el)
    const pick = new THREE.Mesh(new THREE.BoxGeometry(8.2, 3.4, 6.5), invisible)
    pick.position.set(STATION_X[i] ?? 0, 1.5, 0)
    pick.userData.station = i
    scene.add(pick)
    pickables.push(pick)
    beacons.push(addBeacon(scene, (STATION_X[i] ?? 0) + 3.2, 2.5))
  }

  const hall: Hall = {
    cars,
    tags,
    pickables,
    cobots,
    workers,
    forklifts,
    beacons,
    relayoutCrew: () => {},
  }
  hall.relayoutCrew = (plan) => layoutCrew(workerRoot, workers, crewProtos, plan)
  onProgress(1, 'Line ready')
  return hall
}

async function loadEnvironment(scene: THREE.Scene) {
  const url = `${PLANT}/empty_warehouse_01_1k.hdr`
  try {
    const tex = await new RGBELoader().loadAsync(url)
    tex.mapping = THREE.EquirectangularReflectionMapping
    scene.environment = tex
    scene.environmentIntensity = 0.2
  } catch (err) {
    console.warn(`HDR failed ${url}`, err)
  }
}

type Loader = (file: string) => Promise<THREE.Group>

async function buildHall(scene: THREE.Scene, model: Loader) {
  const straight = await model('hall_straight.glb')
  const corner = await model('hall_corner.glb')
  const center = await model('hall_center.glb')
  for (const src of [straight, corner, center]) recolorHall(src)
  const measured = new THREE.Box3().setFromObject(straight).getSize(new THREE.Vector3())
  const span = Math.max(measured.x, measured.z, 0.5)
  const fitXZ = 14 / span
  // Keep the native height. Stretching the bays to clear a 55 m camera made
  // the near columns a solid white frame across the aisle.
  const fitY = fitXZ
  const cell = 14
  const x0 = -78
  const group = new THREE.Group()
  group.name = 'hall'
  // One instanced draw per hall material instead of a deep clone per bay.
  // fitY matches fitXZ, so the instance scale stays uniform.
  const straightSlots: TileSlot[] = []
  const centerSlots: TileSlot[] = []
  for (let i = 0; i < 9; i++) {
    const x = x0 + (i + 0.5) * cell
    ;(i % 3 === 0 ? centerSlots : straightSlots).push({ x, z: -20, yaw: 0 })
    if (i % 2 === 0) centerSlots.push({ x, z: 18, yaw: Math.PI })
  }
  instanceCopies(group, straight, straightSlots, fitXZ)
  instanceCopies(group, center, centerSlots, fitY)
  instanceCopies(group, corner, [
    { x: x0 + 0.4 * cell, z: -20, yaw: 0 },
    { x: x0 + 8.4 * cell, z: -20, yaw: Math.PI / 2 },
  ], fitXZ)
  scene.add(group)
  roofBeams(scene)
  columnBases(scene)
}

type TileSlot = { x: number, z: number, yaw: number }

function instanceCopies(parent: THREE.Object3D, src: THREE.Object3D, slots: TileSlot[], scale: number) {
  if (!slots.length) return
  src.updateWorldMatrix(true, true)
  const up = new THREE.Vector3(0, 1, 0)
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3(scale, scale, scale)
  const placement = new THREE.Matrix4()
  const local = new THREE.Matrix4()
  const m = new THREE.Matrix4()
  const meshes: THREE.Mesh[] = []
  src.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && mesh.geometry) meshes.push(mesh)
  })
  for (const mesh of meshes) {
    // Keep the source geometry. Hall positions are mesh-quantized, so baking
    // mesh.matrixWorld into the vertex buffer drops the node scale and the
    // bays collapse to a couple of metres. The instance matrix carries it.
    const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, slots.length)
    inst.castShadow = false
    inst.receiveShadow = true
    inst.frustumCulled = false
    local.copy(mesh.matrixWorld)
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]
      if (!slot) continue
      p.set(slot.x, 0, slot.z)
      q.setFromAxisAngle(up, slot.yaw)
      placement.compose(p, q, s)
      m.multiplyMatrices(placement, local)
      inst.setMatrixAt(i, m)
    }
    inst.instanceMatrix.needsUpdate = true
    parent.add(inst)
  }
}

function recolorHall(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      const named = mat as THREE.MeshStandardMaterial
      const name = named.name ?? ''
      if (!/painted/i.test(name)) continue
      named.color = new THREE.Color(0xecebe6)
      named.metalness = 0
      named.roughness = 0.75
      named.emissive = new THREE.Color(0x000000)
      named.emissiveIntensity = 0
    }
  })
}

function roofBeams(scene: THREE.Scene) {
  const steel = new THREE.MeshStandardMaterial({ color: 0xc5c8cc, metalness: 0.45, roughness: 0.4 })
  for (let x = -70; x <= 46; x += 14) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 30), steel)
    beam.position.set(x, 11.5, 0)
    scene.add(beam)
  }
  const long = new THREE.Mesh(new THREE.BoxGeometry(130, 0.18, 0.22), steel)
  long.position.set(-12, 11.6, 0)
  scene.add(long)
}

function columnBases(scene: THREE.Scene) {
  const hazard = hazardMaterial()
  for (let x = -70; x <= 46; x += 16) {
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.55), hazard)
    plinth.position.set(x, 0.45, -12)
    plinth.castShadow = true
    scene.add(plinth)
  }
}

function hazardMaterial() {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 32
  const g = c.getContext('2d')
  const tex = new THREE.CanvasTexture(c)
  if (g) {
    g.fillStyle = '#f2c200'
    g.fillRect(0, 0, 128, 32)
    g.strokeStyle = '#151515'
    g.lineWidth = 10
    for (let i = -2; i < 8; i++) {
      g.beginPath()
      g.moveTo(i * 22, 32)
      g.lineTo(i * 22 + 22, 0)
      g.stroke()
    }
    tex.wrapS = THREE.RepeatWrapping
    tex.repeat.x = 2
    tex.colorSpace = THREE.SRGBColorSpace
  }
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 })
}

function gantry(scene: THREE.Scene, x: number, span = 6.2, height = 4.6) {
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf0b400, metalness: 0.35, roughness: 0.4 })
  const hazard = hazardMaterial()
  for (const z of [-span / 2, span / 2]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.28, height, 0.28), yellow)
    post.position.set(x, height / 2, z)
    post.castShadow = true
    scene.add(post)
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.05, 0.42), hazard)
    base.position.set(x, 0.52, z)
    scene.add(base)
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, span + 0.3), yellow)
  beam.position.set(x, height - 0.1, 0)
  beam.castShadow = true
  scene.add(beam)
}

function cone(scene: THREE.Scene, x: number, z: number) {
  const mesh = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.55, 10),
    new THREE.MeshStandardMaterial({ color: 0xe25b1a, roughness: 0.55 }),
  )
  mesh.position.set(x, 0.28, z)
  mesh.castShadow = true
  scene.add(mesh)
}

function buildMarkings(scene: THREE.Scene) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(168, 48),
    new THREE.MeshStandardMaterial({ color: 0xa7aba3, roughness: 0.92, metalness: 0.02 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = 0.004
  floor.receiveShadow = true
  scene.add(floor)

  const yellow = new THREE.MeshStandardMaterial({ color: 0xf6be00, roughness: 0.55 })
  const white = new THREE.MeshStandardMaterial({ color: 0xfafaf7, roughness: 0.5 })
  const aisle = new THREE.Mesh(
    new THREE.PlaneGeometry(150, 5.2),
    new THREE.MeshStandardMaterial({ color: 0xc2c6bf, roughness: 0.86, metalness: 0.02 }),
  )
  aisle.rotation.x = -Math.PI / 2
  aisle.position.set(-14, 0.008, 0)
  aisle.receiveShadow = true
  scene.add(aisle)
  const dash = new THREE.BoxGeometry(1.7, 0.025, 0.16)
  const marks: { x: number, z: number }[] = []
  for (const z of [-2.15, 2.15]) {
    for (let x = -78; x <= 48; x += 2.3) marks.push({ x, z })
  }
  const markMesh = new THREE.InstancedMesh(dash, yellow, marks.length)
  markMesh.receiveShadow = true
  const markMatrix = new THREE.Matrix4()
  marks.forEach((mark, index) => {
    markMatrix.makeTranslation(mark.x, 0.03, mark.z)
    markMesh.setMatrixAt(index, markMatrix)
  })
  markMesh.instanceMatrix.needsUpdate = true
  markMesh.computeBoundingSphere()
  scene.add(markMesh)
  for (let i = 0; i < 7; i++) {
    const x = STATION_X[i] ?? 0
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(6.8, 4.2),
      new THREE.MeshBasicMaterial({ color: 0xf7f7f4, transparent: true, opacity: 0.55, depthWrite: false }),
    )
    pad.rotation.x = -Math.PI / 2
    pad.position.set(x, 0.02, 0)
    scene.add(pad)
    const frame = new THREE.Mesh(
      new THREE.RingGeometry(3.15, 3.28, 4),
      white,
    )
    frame.rotation.x = -Math.PI / 2
    frame.position.set(x, 0.032, 0)
    scene.add(frame)
    gantry(scene, x, i === 4 ? 7.4 : 6.4, i === 4 ? 5.2 : 4.5)
    cone(scene, x + 2.6, 2.55)
    cone(scene, x - 2.4, -2.45)
  }
  hazardPit(scene, STATION_X[3] ?? -13.6)
  paintWord(scene, 'FROM PAINT', -74, 5.2, 12)
  paintWord(scene, 'TO TRANSPORTERS', 46, 5.2, 16)
  paintWord(scene, 'POWERTRAIN', STATION_X[3] ?? -13.6, -5.4, 10)
  paintWord(scene, 'TIRES', STATION_X[4] ?? 1.2, 5.6, 6)
  paintWord(scene, 'SUPERMARKET', STATION_X[1] ?? -43.2, -8.5, 11)
  paintWord(scene, 'YARD', 60, 0, 8)
  paintWord(scene, 'CAR PLANT 01', -20, -12, 14)
  for (let i = 0; i < 6; i++) {
    const x = ((STATION_X[i] ?? 0) + (STATION_X[i + 1] ?? 0)) / 2
    paintWord(scene, 'BUFFER', x, -3.6, 4.4)
  }
}

function hazardPit(scene: THREE.Scene, x: number) {
  const pit = new THREE.Mesh(
    new THREE.BoxGeometry(6.6, 0.08, 3.6),
    new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.92 }),
  )
  pit.position.set(x, 0.02, 0)
  scene.add(pit)
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 32
  const g = c.getContext('2d')
  if (!g) return
  g.fillStyle = '#f2c200'
  g.fillRect(0, 0, 128, 32)
  g.strokeStyle = '#151515'
  g.lineWidth = 10
  for (let i = -2; i < 8; i++) {
    g.beginPath()
    g.moveTo(i * 22, 32)
    g.lineTo(i * 22 + 22, 0)
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.repeat.x = 8
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 })
  const bars: [number, number, number, number][] = [
    [7.1, 0.28, 0, 1.9],
    [7.1, 0.28, 0, -1.9],
    [0.28, 3.8, 3.4, 0],
    [0.28, 3.8, -3.4, 0],
  ]
  for (const [w, d, ox, oz] of bars) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), mat)
    bar.position.set(x + ox, 0.04, oz)
    scene.add(bar)
  }
}

function paintWord(scene: THREE.Scene, text: string, x: number, z: number, width: number) {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 256
  const g = c.getContext('2d')
  if (!g) return
  g.clearRect(0, 0, 1024, 256)
  g.fillStyle = 'rgba(25,25,25,0.75)'
  g.font = '700 150px sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 512, 136)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width * 0.25),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(x, 0.045, z)
  scene.add(mesh)
}

interface Kit {
  body: THREE.Object3D
  amr: THREE.Object3D
  dash: THREE.Object3D
  steer: THREE.Object3D
  seat: THREE.Object3D
  rear: THREE.Object3D
  v6: THREE.Object3D
  trans: THREE.Object3D
  exhaust: THREE.Object3D
  tire: THREE.Object3D
  rim: THREE.Object3D
  bodyBox: THREE.Box3
  bodySize: THREE.Vector3
}

function buildFleet(kit: Kit): CarView[] {
  const views: CarView[] = []
  for (let i = 0; i < 8; i++) {
    const root = new THREE.Group()
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x16181c, metalness: 0.35, roughness: 0.45 })
    const deck = new THREE.Mesh(new THREE.BoxGeometry(4.7, 0.16, 2.05), deckMat)
    deck.position.y = 0.22
    deck.castShadow = true
    deck.receiveShadow = true
    root.add(deck)
    const postMat = new THREE.MeshStandardMaterial({ color: 0xf0b400, metalness: 0.3, roughness: 0.42 })
    for (const [px, pz] of [[1.55, 0.72], [1.55, -0.72], [-1.55, 0.72], [-1.55, -0.72]] as const) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.72, 0.12), postMat)
      post.position.set(px, 0.58, pz)
      post.castShadow = true
      root.add(post)
    }
    const carrier = kit.amr.clone(true)
    const amrBox = new THREE.Box3().setFromObject(carrier)
    const amrSize = amrBox.getSize(new THREE.Vector3())
    const amrLong = Math.max(amrSize.x, amrSize.z, 0.2)
    carrier.scale.multiplyScalar(1.55 / amrLong)
    carrier.position.y -= new THREE.Box3().setFromObject(carrier).min.y
    carrier.position.x = 2.15
    enableCast(carrier)
    root.add(carrier)

    const lift = new THREE.Group()
    lift.position.y = RIDE[0] ?? 0.55
    root.add(lift)

    const shell = kit.body.clone(true)
    const shellMat = paintShell(shell)
    enableCast(shell)
    lift.add(shell)

    // Interior parts sit inside the shell, so they do not change the contact shadow.
    const dash = partGroup(false, kit.dash, kit.steer)
    const seats = partGroup(false, kit.seat, kit.rear)
    const power = partGroup(false, kit.v6, kit.trans, kit.exhaust)
    const wheels = wheelSet(kit)
    placeInBody(dash, kit, 0.72, 0.62, 0)
    placeInBody(seats, kit, -0.05, 0.5, 0)
    placeInBody(power, kit, 0.55, 0.22, 0)
    lift.add(dash, seats, power, wheels)

    const view: CarView = { root, lift, dash, seats, power, wheels, shellMat }
    applyCarStage(view, 0)
    root.visible = false
    views.push(view)
  }
  return views
}

function paintShell(root: THREE.Object3D): THREE.MeshPhysicalMaterial | null {
  let painted: THREE.MeshPhysicalMaterial | null = null
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || painted) return
    const prev = mesh.material as THREE.MeshStandardMaterial
    if (Array.isArray(prev)) return
    if (!/aluminium|body|paint|clear/i.test(`${prev?.name ?? ''} ${mesh.name}`)) return
    painted = new THREE.MeshPhysicalMaterial({
      color: 0x2c3238,
      metalness: 0.64,
      roughness: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      envMapIntensity: 0.45,
    })
    mesh.material = painted
  })
  return painted
}

function partGroup(cast: boolean, ...sources: THREE.Object3D[]) {
  const g = new THREE.Group()
  for (const src of sources) {
    const clone = src.clone(true)
    if (cast) enableCast(clone)
    g.add(clone)
  }
  return g
}

function placeInBody(group: THREE.Object3D, kit: Kit, along: number, up: number, side: number) {
  const box = new THREE.Box3().setFromObject(group)
  const center = box.getCenter(new THREE.Vector3())
  const lengthAxis = kit.bodySize.x >= kit.bodySize.z ? 'x' : 'z'
  const target = new THREE.Vector3()
  if (lengthAxis === 'x') {
    target.set(
      kit.bodyBox.min.x + kit.bodySize.x * (0.5 + along * 0.42),
      kit.bodyBox.min.y + kit.bodySize.y * up,
      (kit.bodyBox.min.z + kit.bodyBox.max.z) / 2 + side,
    )
  } else {
    target.set(
      (kit.bodyBox.min.x + kit.bodyBox.max.x) / 2 + side,
      kit.bodyBox.min.y + kit.bodySize.y * up,
      kit.bodyBox.min.z + kit.bodySize.z * (0.5 + along * 0.42),
    )
  }
  group.position.add(target.sub(center))
}

function wheelSet(kit: Kit): THREE.Group {
  const g = new THREE.Group()
  const lengthAxis = kit.bodySize.x >= kit.bodySize.z ? 'x' : 'z'
  const spots: [number, number][] = [
    [0.72, 0.46],
    [0.72, -0.46],
    [0.28, 0.46],
    [0.28, -0.46],
  ]
  for (const [along, side] of spots) {
    const wheel = new THREE.Group()
    const tire = kit.tire.clone(true)
    const rim = kit.rim.clone(true)
    wheel.add(tire, rim)
    const box = new THREE.Box3().setFromObject(wheel)
    const center = box.getCenter(new THREE.Vector3())
    wheel.position.sub(center)
    const axle = new THREE.Group()
    axle.add(wheel)
    if (lengthAxis === 'x') {
      axle.position.set(
        kit.bodyBox.min.x + kit.bodySize.x * along,
        kit.bodyBox.min.y + 0.34,
        kit.bodyBox.min.z + kit.bodySize.z * (side > 0 ? 0.92 : 0.08),
      )
    } else {
      axle.position.set(
        kit.bodyBox.min.x + kit.bodySize.x * (side > 0 ? 0.92 : 0.08),
        kit.bodyBox.min.y + 0.34,
        kit.bodyBox.min.z + kit.bodySize.z * along,
      )
      axle.rotation.y = Math.PI / 2
    }
    enableCast(axle)
    g.add(axle)
  }
  return g
}

function enableCast(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) mesh.castShadow = true
  })
}

function placeEquipment(
  scene: THREE.Scene,
  models: { cobot: THREE.Object3D, crane: THREE.Object3D, changer: THREE.Object3D },
  cobots: CobotRig[],
) {
  const jobs: [number, number, number, number][] = [
    [1, -1.15, 1.85, -Math.PI / 2],
    [1, 1.15, 1.85, -Math.PI / 2],
    [2, -1.2, 1.8, -Math.PI / 2],
    [2, 0.15, 1.85, -Math.PI / 2],
    [2, 1.15, -1.8, Math.PI / 2],
    [3, -1.6, -1.9, Math.PI / 2],
    [4, 1.15, 1.72, -Math.PI / 2],
    [4, -1.05, 1.72, -Math.PI / 2],
    [4, 1.15, -1.72, Math.PI / 2],
    [4, -1.05, -1.72, Math.PI / 2],
  ]
  jobs.forEach(([station, dx, z, yaw], index) => {
    const arm = models.cobot.clone(true)
    enableCast(arm)
    const x = (STATION_X[station] ?? 0) + dx
    arm.position.set(x, 0, z)
    arm.rotation.y = yaw
    scene.add(arm)
    const yawNode = arm.getObjectByName('armBase_01_obj_00') ?? arm
    const elbow = arm.getObjectByName('armShoulder_02_obj_00') ?? arm
    const wrist = arm.getObjectByName('armShoulder_04_obj_00') ?? arm
    if (station === 4) {
      elbow.rotateZ(-0.85)
      wrist.rotateX(-0.55)
    }
    for (const joint of [yawNode, elbow, wrist]) joint.userData.rest = joint.rotation.clone()
    cobots.push({ yaw: yawNode, elbow, wrist, station, phase: index * 0.7 })
  })

  const marriage = STATION_X[3] ?? -13.6
  const gantry = models.crane.clone(true)
  enableCast(gantry)
  gantry.position.set(marriage - 3.2, 0, -3.6)
  scene.add(gantry)

  const wheels = STATION_X[4] ?? 1.2
  for (const z of [2.55, -2.55]) {
    const unit = models.changer.clone(true)
    enableCast(unit)
    unit.position.set(wheels + (z > 0 ? 0.4 : -0.2), 0, z)
    unit.rotation.y = z > 0 ? Math.PI : 0
    scene.add(unit)
  }
}

function placeForklifts(scene: THREE.Scene, src: THREE.Object3D): ForkliftRig[] {
  const paths = [
    { z: 4.7, x0: -62, x1: 36, period: 44, offset: 0 },
    { z: -4.6, x0: -48, x1: 42, period: 48, offset: 18 },
  ]
  return paths.map((path) => {
    const root = src.clone(true) as THREE.Group
    enableCast(root)
    const span = path.x1 - path.x0
    root.position.set(path.x0, 0, path.z)
    scene.add(root)
    return {
      root,
      z: path.z,
      x0: path.x0,
      x1: path.x1,
      speed: (2 * span) / path.period,
      offset: path.offset,
      yaw: 0,
    }
  })
}

async function placeProps(scene: THREE.Scene, model: Loader) {
  const rack = await model('rack_far.glb')
  const brown = await model('load_brown.glb')
  const white = await model('load_white.glb')
  const stillage = await model('stillage.glb')
  const cart = await model('cart_tier.glb')
  const drum = await model('drum.glb')
  const ibc = await model('ibc.glb')
  const diag = await model('diagcart.glb')
  const cab = await model('toolcab.glb')
  const sign = await model('floorsign.glb')

  const rackUnit = rack.clone(true)
  fitHeight(rackUnit, 4.15)
  // The source bay is sometimes deeper than it is wide. Turn the long axis down the aisle.
  {
    const size = new THREE.Box3().setFromObject(rackUnit).getSize(new THREE.Vector3())
    if (size.z > size.x * 1.25) rackUnit.rotation.y = Math.PI / 2
  }
  sitOnFloor(rackUnit)
  const rackSize = new THREE.Box3().setFromObject(rackUnit).getSize(new THREE.Vector3())
  const bayW = Math.max(rackSize.x, 0.8)
  const loadH = 0.9
  const loadD = Math.min(Math.max(rackSize.z * 0.9, 0.9), 1.55)
  const pitch = bayW * 0.995
  const rowStep = loadD + 0.18
  const levels = [0.04, 0.98, 1.92, 2.86]
  // Foreground rows sit under the overview sightline and behind the Wheels camera.
  const nearZ = Array.from({ length: 9 }, (_, i) => 17.8 + i * rowStep)
  const farZ = Array.from({ length: 7 }, (_, i) => -6.6 - i * rowStep)
  const rackAisle: Slot[] = []
  const rackBack: Slot[] = []
  const brownSlots: Slot[] = []
  const paleSlots: Slot[] = []
  const xStart = -78
  const xEnd = 48
  const bays = Math.ceil((xEnd - xStart) / pitch)
  for (let i = 0; i < bays; i++) {
    const x = xStart + (i + 0.5) * pitch
    if (x > xEnd) break
    const placeRow = (z: number, aisle: boolean) => {
      const ry = z > 0 ? Math.PI : 0
      ;(aisle ? rackAisle : rackBack).push({ x, y: 0, z, ry })
      const across = 4
      const cell = bayW / across
      for (const level of levels) {
        for (let k = 0; k < across; k++) {
          const localX = (k + 0.5) * cell - bayW / 2
          const pale = (i * 3 + k + Math.round(level * 2) + (z > 0 ? 1 : 0)) % 9 === 0
          const slot = {
            x: x + Math.cos(ry) * localX,
            y: level,
            z: z - Math.sin(ry) * localX,
            ry,
          }
          ;(pale ? paleSlots : brownSlots).push(slot)
        }
      }
    }
    nearZ.forEach((z, index) => placeRow(z, index === 0))
    farZ.forEach((z, index) => placeRow(z, index === 0))
  }
  scatter(scene, rackUnit, rackAisle, true)
  scatter(scene, rackUnit, rackBack, false)
  const boxW = (bayW / 4) * 0.94
  const cardboard = cartonMaterial(brown, 0xd7b08a)
  const paper = cartonMaterial(white, 0xf7f4ee)
  scatterBoxes(scene, brownSlots, cardboard, boxW, loadH, loadD * 0.92, true)
  scatterBoxes(scene, paleSlots, paper, boxW, loadH, loadD * 0.92, false)

  const put = (src: THREE.Object3D, x: number, z: number, yaw = 0) => {
    const obj = src.clone(true)
    obj.position.set(x, 0, z)
    obj.rotation.y = yaw
    scene.add(obj)
  }
  put(cart, (STATION_X[0] ?? 0) + 1.4, 2.7, 0.3)
  put(stillage, (STATION_X[1] ?? 0) - 1.2, 2.6, 0.2)
  put(stillage, (STATION_X[2] ?? 0) + 0.4, 2.55, 0.4)
  put(stillage, (STATION_X[2] ?? 0) - 0.6, -2.5, 1)
  put(ibc, (STATION_X[5] ?? 0) + 1.6, 2.2)
  put(drum, (STATION_X[5] ?? 0) - 1.2, 2.15, 0.5)
  put(drum, (STATION_X[5] ?? 0) - 1.8, 2.4, 1)
  put(diag, (STATION_X[6] ?? 0) + 2.2, 2.3, 0.6)
  put(cab, (STATION_X[6] ?? 0) - 2.4, -2.2, 0.2)
  put(sign, -70, 3.2, 0.5)
  put(sign, 40, -3.4, 1.2)
}

function layoutCrew(root: THREE.Group, list: WorkerRig[], protos: THREE.Object3D[], plan: LinePlan) {
  while (root.children.length) root.remove(root.children[0])
  list.length = 0
  const spots = [
    { x: -0.85, z: 1.7 },
    { x: 0.95, z: 1.75 },
    { x: 0.15, z: -1.85 },
  ]
  plan.stations.forEach((st, i) => {
    for (let c = 0; c < st.crewNominal; c++) {
      const spot = i === 4 && c === 0 ? { x: 1.7, z: 2.45 } : (spots[c] ?? spots[0])
      if (!spot) continue
      if (c >= st.crewPresent) {
        const el = document.createElement('div')
        el.className = 'out-tag'
        el.textContent = 'Operator out'
        const tag = new CSS2DObject(el)
        tag.position.set(st.x + spot.x, 2.05, spot.z)
        root.add(tag)
        continue
      }
      const proto = protos[(i + c) % protos.length]
      if (!proto) continue
      const person = proto.clone(true) as THREE.Group
      person.position.set(st.x + spot.x, 0, spot.z)
      person.rotation.y = spot.z > 0 ? Math.PI : 0
      root.add(person)
      const legL = boneOrDummy(person, 'thigh_l')
      const legR = boneOrDummy(person, 'thigh_r')
      const armL = boneOrDummy(person, 'upperarm_l')
      const armR = boneOrDummy(person, 'upperarm_r')
      for (const bone of [legL, legR, armL, armR]) bone.userData.rest = bone.rotation.clone()
      list.push({
        root: person,
        legL,
        legR,
        armL,
        armR,
        station: i,
        phase: i + c * 1.4,
        baseX: st.x + spot.x,
        baseZ: spot.z,
        walk: c === 0,
      })
    }
  })
}

type Slot = { x: number; y: number; z: number; ry: number }

function scatter(scene: THREE.Scene, proto: THREE.Object3D, slots: Slot[], cast: boolean) {
  if (!slots.length) return
  proto.updateMatrixWorld(true)
  const basis = new THREE.Matrix4()
  proto.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geom = mesh.geometry.clone()
    geom.applyMatrix4(mesh.matrixWorld)
    const inst = new THREE.InstancedMesh(geom, mesh.material, slots.length)
    inst.castShadow = cast
    inst.receiveShadow = true
    inst.frustumCulled = false
    slots.forEach((slot, index) => {
      basis.makeRotationY(slot.ry)
      basis.setPosition(slot.x, slot.y, slot.z)
      inst.setMatrixAt(index, basis)
    })
    inst.instanceMatrix.needsUpdate = true
    scene.add(inst)
  })
}

function cartonMaterial(root: THREE.Object3D, hex: number) {
  const maps: THREE.Texture[] = []
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || maps.length) return
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
    if (mat?.map) maps.push(mat.map)
  })
  const map = maps[0] ?? null
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace
    map.wrapS = THREE.RepeatWrapping
    map.wrapT = THREE.RepeatWrapping
  }
  return new THREE.MeshStandardMaterial({
    color: hex,
    map,
    roughness: 0.9,
    metalness: 0.02,
  })
}

function scatterBoxes(
  scene: THREE.Scene,
  slots: Slot[],
  material: THREE.Material,
  width: number,
  height: number,
  depth: number,
  cast: boolean,
) {
  if (!slots.length) return
  const geom = new THREE.BoxGeometry(width, height, depth)
  geom.translate(0, height / 2, 0)
  const inst = new THREE.InstancedMesh(geom, material, slots.length)
  inst.castShadow = cast
  inst.receiveShadow = true
  const basis = new THREE.Matrix4()
  slots.forEach((slot, index) => {
    basis.makeRotationY(slot.ry)
    basis.setPosition(slot.x, slot.y, slot.z)
    inst.setMatrixAt(index, basis)
  })
  inst.instanceMatrix.needsUpdate = true
  scene.add(inst)
}

function sitOnFloor(obj: THREE.Object3D) {
  obj.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(obj)
  const center = box.getCenter(new THREE.Vector3())
  obj.position.x -= center.x
  obj.position.z -= center.z
  obj.position.y -= box.min.y
  obj.updateMatrixWorld(true)
}

function fitHeight(obj: THREE.Object3D, height: number) {
  const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3())
  if (size.y > 0.02) obj.scale.multiplyScalar(height / size.y)
  obj.position.y -= new THREE.Box3().setFromObject(obj).min.y
}

function boneOrDummy(root: THREE.Object3D, name: string) {
  return root.getObjectByName(name) ?? root
}

function addBeacon(scene: THREE.Scene, x: number, z: number): Beacon {
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.045, 1.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x22262b, metalness: 0.4, roughness: 0.45 }),
  )
  pole.position.set(x, 0.6, z)
  scene.add(pole)
  const make = (color: number, y: number) => {
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.08, roughness: 0.4 })
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), mat)
    bulb.position.set(x, y, z)
    scene.add(bulb)
    return mat
  }
  return { green: make(0x1f9d4a, 1.08), amber: make(0xe0a020, 1.24), red: make(0xd0453a, 1.4) }
}
