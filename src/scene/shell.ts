import * as THREE from 'three'

/**
 * The vendored body is a real unibody with open roof, hood, glass, and ends.
 * The sculpted panels stay. These caps cover only the cells a ray can pass
 * through, flush with the surrounding sheet, so the silhouette remains the
 * SimReady car. Paint is applied later, one clearcoat per car.
 */

const GLASS = new THREE.MeshPhysicalMaterial({
  name: 'shellGlass',
  color: 0x1a242c,
  metalness: 0.12,
  roughness: 0.04,
  clearcoat: 1,
  clearcoatRoughness: 0.03,
  envMapIntensity: 1.65,
  side: THREE.DoubleSide,
})

interface Grid {
  tris: Float32Array
  cell: number
  map: Map<string, number[]>
}

export function sealCarShell(root: THREE.Object3D): void {
  if (root.userData.sealed) return
  const tris = collectOuter(root)
  if (tris.length < 9 * 500) return
  const down = grid(tris, 0, 2, 0.08)
  const side = grid(tris, 0, 1, 0.06)
  const profile = measure(tris, down, side)
  const shellMat = new THREE.MeshStandardMaterial({
    name: 'bodyShell',
    color: 0xc5ced6,
    metalness: 0.9,
    roughness: 0.24,
    envMapIntensity: 1.1,
    side: THREE.DoubleSide,
  })
  const metal = new Builder()
  const glass = new Builder()
  // Caps are added only over measured openings. The SimReady panels stay.
  addOpeningCaps(metal, glass, profile)
  finish(root, metal, 'shell_seal', shellMat, true)
  finish(root, glass, 'shell_glass', GLASS, false)
  root.userData.axles = profile.arches.map((arch) => ({
    x: arch.x,
    y: 0.34,
    z: Math.max(profile.sideZ, 0.78),
  }))
  hideInside(root)
  root.userData.sealed = true
  root.userData.sealNote = profile.note
}

function hideInside(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || mesh.userData.seal) return
    const mat = mesh.material as THREE.Material
    const label = `${mesh.name} ${mat && !Array.isArray(mat) ? mat.name : ''}`
    if (/inside|steel/i.test(label)) {
      mesh.visible = false
      mesh.castShadow = false
    }
  })
}


function addOpeningCaps(metal: Builder, glass: Builder, p: Profile): void {
  // Openings measured on the outer sheet: rear quarter and front fender are
  // already skinned. The doors, greenhouse, roof center, hood bay, and ends are not.
  const belt = Math.min(p.belt, 0.8)
  const glassZ = (y: number) => 0.86 + (0.7 - 0.86) * ((y - belt) / Math.max(0.2, p.railY - belt))
  const rearDoor: [number, number] = [p.roofX0 + 0.02, -0.18]
  const frontDoor: [number, number] = [-0.12, 0.86]
  sideSheet(metal, rearDoor[0], rearDoor[1], 0.22, belt, () => 0.875)
  sideSheet(metal, frontDoor[0], frontDoor[1], 0.22, belt, () => 0.875)
  sideSheet(metal, p.tailX + 0.08, p.roofX0 + 0.06, 0.82, p.railY + 0.02, () => 0.8)
  sideSheet(glass, rearDoor[0], rearDoor[1], belt - 0.02, p.railY + 0.02, glassZ)
  sideSheet(glass, frontDoor[0], frontDoor[1], belt - 0.02, p.railY + 0.02, glassZ)
  addRoofSkin(metal, p)
  addHoodSkin(metal, p)
  addWindshield(glass, p)
  addBumper(metal, p.noseX + 0.005, 1, 0.1, 0.82, 0.78)
  addBumper(metal, p.tailX - 0.005, -1, 0.14, 1.02, 0.8)
}

function sideSheet(
  target: Builder,
  x0: number, x1: number, y0: number, y1: number,
  zAt: (y: number) => number,
): void {
  const sx = 0.07
  const sy = 0.07
  for (const sign of [1, -1]) {
    for (let x = x0; x < x1 - 0.001; x += sx) {
      const x2 = Math.min(x1, x + sx)
      for (let y = y0; y < y1 - 0.001; y += sy) {
        const y2 = Math.min(y1, y + sy)
        const ids = [
          target.at(x, y, sign * zAt(y)),
          target.at(x2, y, sign * zAt(y)),
          target.at(x2, y2, sign * zAt(y2)),
          target.at(x, y2, sign * zAt(y2)),
        ]
        if (sign > 0) target.quad(ids[0], ids[1], ids[2], ids[3])
        else target.quad(ids[0], ids[3], ids[2], ids[1])
      }
    }
  }
}

function addRoofSkin(metal: Builder, p: Profile): void {
  const x0 = p.roofX0 + 0.02
  const x1 = p.roofX1 - 0.02
  const zMax = 0.78
  const step = 0.07
  const yAt = (z: number) => {
    const u = Math.min(1, Math.abs(z) / zMax)
    const crown = Math.max(0.03, p.roofPeak - p.railY)
    return p.railY + 0.012 + crown * (1 - u * u)
  }
  for (let x = x0; x < x1 - 0.001; x += step) {
    const x2 = Math.min(x1, x + step)
    for (let z = -zMax; z < zMax - 0.001; z += step) {
      const z2 = Math.min(zMax, z + step)
      const ids = [
        metal.at(x, yAt(z), z),
        metal.at(x2, yAt(z), z),
        metal.at(x2, yAt(z2), z2),
        metal.at(x, yAt(z2), z2),
      ]
      metal.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

function addHoodSkin(metal: Builder, p: Profile): void {
  const x0 = p.roofX1 + 0.05
  const x1 = p.noseX - 0.06
  const zMax = 0.8
  const step = 0.07
  for (let x = x0; x < x1 - 0.001; x += step) {
    const x2 = Math.min(x1, x + step)
    for (let z = -zMax; z < zMax - 0.001; z += step) {
      const z2 = Math.min(zMax, z + step)
      const ids = [
        metal.at(x, hoodHeight(p, x, z), z),
        metal.at(x2, hoodHeight(p, x2, z), z),
        metal.at(x2, hoodHeight(p, x2, z2), z2),
        metal.at(x, hoodHeight(p, x, z2), z2),
      ]
      metal.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

function addWindshield(glass: Builder, p: Profile): void {
  const x0 = p.roofX1
  const x1 = p.hoodX0
  const cols = 8
  const rows = 5
  const ids: number[] = []
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const u = i / cols
      const v = j / rows
      const x = x0 + (x1 - x0) * v
      const y = p.railY - 0.02 + (p.hoodY0 - 0.06 - (p.railY - 0.02)) * v
      const half = 0.74 + (0.78 - 0.74) * v
      ids.push(glass.at(x, y, (u * 2 - 1) * half))
    }
  }
  const stride = cols + 1
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = ids[j * stride + i]
      const b = ids[j * stride + i + 1]
      const c = ids[(j + 1) * stride + i + 1]
      const d = ids[(j + 1) * stride + i]
      glass.quad(a, b, c, d)
    }
  }
}

function addBumper(metal: Builder, x: number, dir: number, y0: number, y1: number, zMax: number): void {
  const step = 0.07
  for (let y = y0; y < y1 - 0.001; y += step) {
    const y2 = Math.min(y1, y + step)
    for (let z = -zMax; z < zMax - 0.001; z += step) {
      const z2 = Math.min(zMax, z + step)
      const ids = [
        metal.at(x, y, z),
        metal.at(x, y, z2),
        metal.at(x, y2, z2),
        metal.at(x, y2, z),
      ]
      if (dir > 0) metal.quad(ids[0], ids[1], ids[2], ids[3])
      else metal.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

interface Profile {
  roofX0: number
  roofX1: number
  roofY: number
  roofPeak: number
  railY: number
  roofZ: number
  hoodX0: number
  noseX: number
  tailX: number
  hoodY0: number
  hoodY1: number
  sideZ: number
  belt: number
  widthX0: number
  widthStep: number
  width: Float32Array
  arches: { x: number, y: number, r: number }[]
  note: string
}

function measure(tris: Float32Array, down: Grid, side: Grid): Profile {
  let noseX = -Infinity
  let tailX = Infinity
  const n = tris.length / 9
  for (let t = 0; t < n; t++) {
    for (const k of [0, 3, 6]) {
      noseX = Math.max(noseX, tris[t * 9 + k])
      tailX = Math.min(tailX, tris[t * 9 + k])
    }
  }
  const columns: { x: number, width: number, y: number, z: number }[] = []
  for (let x = -2.2; x <= 1.4; x += 0.06) {
    let width = 0
    let y = 0
    let zSpan = 0
    for (let z = -0.85; z <= 0.85; z += 0.05) {
      const hit = ray(down, 0, 2, 1, x, z, 3, -1)
      if (hit != null && hit > 1.02) {
        width += 0.05
        y = Math.max(y, hit)
        zSpan = Math.max(zSpan, Math.abs(z))
      }
    }
    if (width > 0.5 && y > 1.02) columns.push({ x, width, y, z: zSpan })
  }
  const roofX0 = columns.length ? columns[0].x : -1.7
  const roofX1 = columns.length ? columns[columns.length - 1].x : 0.35
  const roofY = columns.length ? columns.reduce((s, c) => s + c.y, 0) / columns.length : 1.18
  const roofPeak = columns.length ? Math.max(...columns.map((c) => c.y)) : roofY
  const railSamples: number[] = []
  for (let x = roofX0; x <= roofX1; x += 0.08) {
    for (const z of [0.62, 0.68, -0.62, -0.68]) {
      const hit = ray(down, 0, 2, 1, x, z, 3, -1)
      if (hit != null && hit > 1.05) railSamples.push(hit)
    }
  }
  railSamples.sort((a, b) => a - b)
  const railY = railSamples.length ? railSamples[Math.floor(railSamples.length / 2)] : roofY - 0.04
  const roofZ = columns.length ? Math.max(...columns.map((c) => c.z)) - 0.04 : 0.62
  const hoodX0 = roofX1 + 0.62
  const hoodY0 = 0.9
  const hoodY1 = 0.7
  const samples: number[] = []
  for (let x = roofX0 + 0.15; x < roofX1 - 0.05; x += 0.08) {
    let top = 0.35
    for (let y = 0.4; y <= 1.12; y += 0.03) {
      const hit = ray(side, 0, 1, 2, x, y, 2, -1)
      if (hit != null && hit > 0.6) top = y
    }
    if (top > 0.5 && top < 1.05) samples.push(top)
  }
  samples.sort((a, b) => a - b)
  const belt = samples.length ? samples[Math.floor(samples.length * 0.55)] : 0.78
  const sideHits: number[] = []
  for (let x = roofX0; x < roofX1; x += 0.1) {
    const hit = ray(side, 0, 1, 2, x, Math.max(0.48, belt - 0.12), 2, -1)
    if (hit != null && hit > 0.6) sideHits.push(hit)
  }
  sideHits.sort((a, b) => a - b)
  const sideZ = sideHits.length ? sideHits[Math.floor(sideHits.length / 2)] : 0.86
  const arches = findArches(side, sideZ)
  const beltCapped = Math.min(0.84, belt)
  const widthX0 = -2.55
  const widthStep = 0.05
  const width = sampleWidth(tris, widthX0, widthStep)
  const note = `roof ${roofX0.toFixed(2)}..${roofX1.toFixed(2)} rail ${railY.toFixed(2)} belt ${beltCapped.toFixed(2)} sideZ ${sideZ.toFixed(2)} x ${tailX.toFixed(2)}..${noseX.toFixed(2)} arches ${arches.map((a) => a.x.toFixed(2)).join(',')}`
  return { roofX0, roofX1, roofY, roofPeak, railY, roofZ, hoodX0, noseX, tailX, hoodY0, hoodY1, sideZ, belt: beltCapped, arches, widthX0, widthStep, width, note }
}

function findArches(side: Grid, sideZ: number): { x: number, y: number, r: number }[] {
  const marks: number[] = []
  for (let x = -2.15; x <= 2.2; x += 0.05) {
    const hi = ray(side, 0, 1, 2, x, 0.8, 2, -1)
    const lo = ray(side, 0, 1, 2, x, 0.34, 2, -1)
    const hiSkin = hi != null && hi > sideZ - 0.2
    const loSkin = lo != null && lo > sideZ - 0.2
    if (hiSkin && !loSkin) marks.push(x)
  }
  const clusters: number[][] = []
  for (const x of marks) {
    const last = clusters[clusters.length - 1]
    if (!last || x - last[last.length - 1] > 0.18) clusters.push([x])
    else last.push(x)
  }
  const found = clusters
    .filter((c) => c.length > 3)
    .map((c) => ({ x: c[Math.floor(c.length / 2)], y: 0.34, r: 0.36 }))
  if (!found.some((a) => a.x > 0.4)) found.push({ x: 1.45, y: 0.34, r: 0.36 })
  if (!found.some((a) => a.x < -0.4)) found.push({ x: -1.55, y: 0.34, r: 0.36 })
  for (const arch of found) arch.r = 0.36
  return found
}

function hoodHeight(p: Profile, x: number, z: number): number {
  const span = Math.max(0.2, p.noseX - 0.12 - p.hoodX0)
  const t = Math.min(1, Math.max(0, (x - p.hoodX0) / span))
  const base = p.hoodY0 + (p.hoodY1 - p.hoodY0) * t
  const crown = 0.02 * (1 - Math.min(1, Math.pow(z / 0.72, 2)))
  return base + crown
}

function sampleWidth(tris: Float32Array, x0: number, step: number): Float32Array {
  const bins = 110
  const lists: number[][] = Array.from({ length: bins }, () => [])
  const n = tris.length / 9
  for (let t = 0; t < n; t++) {
    let x = 0
    let y = 0
    let z = 0
    for (let k = 0; k < 3; k++) {
      x += tris[t * 9 + k * 3]
      y += tris[t * 9 + k * 3 + 1]
      z += Math.abs(tris[t * 9 + k * 3 + 2])
    }
    x /= 3
    y /= 3
    z /= 3
    if (y < 0.28 || y > 1.18 || z < 0.4) continue
    const i = Math.floor((x - x0) / step)
    if (i >= 0 && i < bins) lists[i].push(z)
  }
  const raw = new Float32Array(bins)
  for (let i = 0; i < bins; i++) {
    const row = lists[i].sort((a, b) => a - b)
    raw[i] = row.length ? row[Math.min(row.length - 1, Math.floor(row.length * 0.97))] : 0
  }
  for (let i = 0; i < bins; i++) {
    if (raw[i] > 0) continue
    let a = i - 1
    let b = i + 1
    while (a >= 0 && raw[a] === 0) a--
    while (b < bins && raw[b] === 0) b++
    const za = a >= 0 ? raw[a] : 0
    const zb = b < bins ? raw[b] : 0
    if (za && zb) raw[i] = za + (zb - za) * ((i - a) / (b - a))
    else raw[i] = za || zb
  }
  const out = new Float32Array(bins)
  const rad = 3
  for (let i = 0; i < bins; i++) {
    let sum = 0
    let count = 0
    for (let k = -rad; k <= rad; k++) {
      const j = i + k
      if (j < 0 || j >= bins || raw[j] === 0) continue
      sum += raw[j]
      count++
    }
    out[i] = count ? sum / count : 0
  }
  return out
}

class Builder {
  private verts: number[] = []
  private idx: number[] = []
  private map = new Map<string, number>()

  at(x: number, y: number, z: number): number {
    const key = `${Math.round(x * 800)},${Math.round(y * 800)},${Math.round(z * 800)}`
    const found = this.map.get(key)
    if (found != null) return found
    const id = this.verts.length / 3
    this.verts.push(x, y, z)
    this.map.set(key, id)
    return id
  }

  quad(a: number, b: number, c: number, d: number): void {
    if (a === b || b === c || c === d || a === c) return
    this.idx.push(a, b, c, a, c, d)
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.idx.length < 3) return null
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(this.verts, 3))
    geom.setIndex(this.idx)
    geom.computeVertexNormals()
    geom.userData.noSimplify = true
    return geom
  }
}

function finish(root: THREE.Object3D, builder: Builder, name: string, material: THREE.Material, shell: boolean): void {
  const geom = builder.geometry()
  if (!geom) return
  const mesh = new THREE.Mesh(geom, material)
  mesh.name = name
  mesh.userData.seal = true
  mesh.userData.shell = shell
  mesh.userData.glass = !shell
  mesh.castShadow = shell
  mesh.receiveShadow = true
  root.add(mesh)
}

function collectOuter(root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const world = new THREE.Matrix4()
  const v = new THREE.Vector3()
  const out: number[] = []
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || mesh.userData.seal || !mesh.geometry) return
    const mat = mesh.material as THREE.Material
    const label = `${mesh.name} ${mat && !Array.isArray(mat) ? mat.name : ''}`
    if (/inside|steel|glass/i.test(label)) return
    if (!/aluminium|body_01/i.test(label)) return
    const pos = mesh.geometry.getAttribute('position')
    const index = mesh.geometry.getIndex()
    if (!pos || !index) return
    world.multiplyMatrices(inv, mesh.matrixWorld)
    for (let i = 0; i < index.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, index.getX(i + k)).applyMatrix4(world)
        out.push(v.x, v.y, v.z)
      }
    }
  })
  return new Float32Array(out)
}

function grid(tris: Float32Array, ax: number, ay: number, cell: number): Grid {
  const map = new Map<string, number[]>()
  const n = tris.length / 9
  for (let t = 0; t < n; t++) {
    let minA = Infinity
    let maxA = -Infinity
    let minB = Infinity
    let maxB = -Infinity
    const o = t * 9
    for (let k = 0; k < 3; k++) {
      const a = tris[o + k * 3 + ax]
      const b = tris[o + k * 3 + ay]
      minA = Math.min(minA, a)
      maxA = Math.max(maxA, a)
      minB = Math.min(minB, b)
      maxB = Math.max(maxB, b)
    }
    for (let ia = Math.floor(minA / cell); ia <= Math.floor(maxA / cell); ia++) {
      for (let ib = Math.floor(minB / cell); ib <= Math.floor(maxB / cell); ib++) {
        const key = `${ia},${ib}`
        const bucket = map.get(key)
        if (bucket) bucket.push(t)
        else map.set(key, [t])
      }
    }
  }
  return { tris, cell, map }
}

function ray(index: Grid, ax: number, ay: number, ad: number, a: number, b: number, origin: number, dir: number): number | null {
  const bucket = index.map.get(`${Math.floor(a / index.cell)},${Math.floor(b / index.cell)}`)
  if (!bucket) return null
  const tris = index.tris
  let bestT = Infinity
  let best: number | null = null
  for (const tri of bucket) {
    const o = tri * 9
    const v = [
      [tris[o], tris[o + 1], tris[o + 2]],
      [tris[o + 3], tris[o + 4], tris[o + 5]],
      [tris[o + 6], tris[o + 7], tris[o + 8]],
    ]
    const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]]
    const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]]
    const direction = [0, 0, 0]
    direction[ad] = dir
    const from = [0, 0, 0]
    from[ax] = a
    from[ay] = b
    from[ad] = origin
    const px = direction[1] * e2[2] - direction[2] * e2[1]
    const py = direction[2] * e2[0] - direction[0] * e2[2]
    const pz = direction[0] * e2[1] - direction[1] * e2[0]
    const det = e1[0] * px + e1[1] * py + e1[2] * pz
    if (Math.abs(det) < 1e-12) continue
    const invDet = 1 / det
    const tx = from[0] - v[0][0]
    const ty = from[1] - v[0][1]
    const tz = from[2] - v[0][2]
    const u = (tx * px + ty * py + tz * pz) * invDet
    if (u < 0 || u > 1) continue
    const qx = ty * e1[2] - tz * e1[1]
    const qy = tz * e1[0] - tx * e1[2]
    const qz = tx * e1[1] - ty * e1[0]
    const vv = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * invDet
    if (vv < 0 || u + vv > 1) continue
    const dist = (e2[0] * qx + e2[1] * qy + e2[2] * qz) * invDet
    if (dist < 0 || dist >= bestT) continue
    bestT = dist
    best = origin + dir * dist
  }
  return best
}
