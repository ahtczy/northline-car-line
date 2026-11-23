import * as THREE from 'three'

/**
 * The vendored body is a body-in-white frame, not a closed shell. The roof
 * center and the hood are open, the side glass is empty, and the nose is only
 * rails. Some sheets are also wound inward; the paint material has to draw
 * both sides or those panels vanish. This builds the missing skin and glass
 * in the body's own meter space so the car reads as one shell.
 */

const GLASS = new THREE.MeshStandardMaterial({
  name: 'shellGlass',
  color: 0x243038,
  metalness: 0.72,
  roughness: 0.12,
  envMapIntensity: 1.05,
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
    color: 0xd7d3cb,
    metalness: 0.46,
    roughness: 0.34,
    envMapIntensity: 0.5,
    side: THREE.DoubleSide,
  })
  const metal = new Builder()
  const glass = new Builder()
  addRoof(metal, profile)
  addHood(metal, down, profile)
  addNose(metal, profile)
  addFenders(metal, side, profile)
  addSideSkins(metal, glass, side, profile)
  addScreens(glass, profile)
  finish(root, metal, 'shell_seal', shellMat, true)
  finish(root, glass, 'shell_glass', GLASS, false)
  root.userData.sealed = true
  root.userData.sealNote = profile.note
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
  hoodY0: number
  hoodY1: number
  sideZ: number
  belt: number
  arches: { x: number, y: number, r: number }[]
  note: string
}

function measure(tris: Float32Array, down: Grid, side: Grid): Profile {
  let noseX = -Infinity
  const n = tris.length / 9
  for (let t = 0; t < n; t++) noseX = Math.max(noseX, tris[t * 9], tris[t * 9 + 3], tris[t * 9 + 6])
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
  const note = `roof ${roofX0.toFixed(2)}..${roofX1.toFixed(2)} y${roofY.toFixed(2)} peak ${roofPeak.toFixed(2)} z${roofZ.toFixed(2)} belt ${beltCapped.toFixed(2)} sideZ ${sideZ.toFixed(2)} nose ${noseX.toFixed(2)} arches ${arches.map((a) => a.x.toFixed(2)).join(',')}`
  return { roofX0, roofX1, roofY, roofPeak, railY, roofZ, hoodX0, noseX, hoodY0, hoodY1, sideZ, belt: beltCapped, arches, note }
}

function onThisSide(hit: number | null, sign: number, sideZ: number): boolean {
  if (hit == null) return false
  return Math.sign(hit) === Math.sign(sign) && Math.abs(hit) > sideZ - 0.22
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
    .map((c) => ({ x: c[Math.floor(c.length / 2)], y: 0.34, r: 0.48 }))
  if (!found.some((a) => a.x > 0.4)) found.push({ x: 1.45, y: 0.36, r: 0.42 })
  for (const arch of found) arch.r = Math.min(arch.r, 0.42)
  return found
}

function addRoof(metal: Builder, p: Profile): void {
  const step = 0.08
  const x0 = p.roofX0 + 0.02
  const x1 = p.roofX1 - 0.02
  const zMax = Math.max(p.roofZ, p.sideZ - 0.04)
  for (let x = x0; x < x1 - step; x += step) {
    for (let z = -zMax; z < zMax - step; z += step) {
      const ids = [
        metal.at(x, roofHeight(p, x, z), z),
        metal.at(x + step, roofHeight(p, x + step, z), z),
        metal.at(x + step, roofHeight(p, x + step, z + step), z + step),
        metal.at(x, roofHeight(p, x, z + step), z + step),
      ]
      metal.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

function roofHeight(p: Profile, _x: number, z: number): number {
  const half = Math.max(0.2, p.roofZ * 0.86)
  const span = 1 - Math.min(1, Math.pow(z / half, 2))
  // Edges sit on the cant rail. The crown rises just enough to cover the ribs.
  return p.railY + 0.008 + Math.max(0, p.roofPeak - p.railY) * span
}

function hoodHeight(p: Profile, x: number, z: number): number {
  const span = Math.max(0.2, p.noseX - 0.12 - p.hoodX0)
  const t = Math.min(1, Math.max(0, (x - p.hoodX0) / span))
  const base = p.hoodY0 + (p.hoodY1 - p.hoodY0) * t
  const crown = 0.02 * (1 - Math.min(1, Math.pow(z / 0.72, 2)))
  return base + crown
}

function addHood(metal: Builder, down: Grid, p: Profile): void {
  const x1 = p.noseX - 0.02
  const step = 0.07
  const zMax = p.sideZ - 0.015
  for (let x = p.hoodX0; x < x1 - step; x += step) {
    for (let z = -zMax; z < zMax - step; z += step) {
      const probe = ray(down, 0, 2, 1, x + step / 2, z + step / 2, 3, -1)
      const y = hoodHeight(p, x, z)
      if (probe != null && probe > y - 0.05) continue
      const ids = [
        metal.at(x, hoodHeight(p, x, z), z),
        metal.at(x + step, hoodHeight(p, x + step, z), z),
        metal.at(x + step, hoodHeight(p, x + step, z + step), z + step),
        metal.at(x, hoodHeight(p, x, z + step), z + step),
      ]
      metal.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

function addFenders(metal: Builder, side: Grid, p: Profile): void {
  const front = p.arches.find((arch) => arch.x > 0.4) ?? { x: 1.45, y: 0.36, r: 0.4 }
  const x0 = front.x - 0.55
  const x1 = p.noseX - 0.02
  const step = 0.055
  for (const sign of [1, -1]) {
    for (let x = x0; x < x1 - step; x += step) {
      const y1 = hoodHeight(p, x, sign * 0.7) - 0.005
      for (let y = 0.4; y < y1 - step; y += step) {
        const dx = x + step / 2 - front.x
        const dy = y + step / 2 - 0.36
        if (dx * dx + dy * dy < 0.36 * 0.36) continue
        const hit = ray(side, 0, 1, 2, x + step / 2, y + step / 2, sign * 2, -sign)
        if (onThisSide(hit, sign, p.sideZ)) continue
        const zAt = (xx: number) => {
          const t = Math.max(0, (xx - front.x) / Math.max(0.2, x1 - front.x))
          return sign * (p.sideZ - 0.008 - t * 0.1)
        }
        const ids = [
          metal.at(x, y, zAt(x)),
          metal.at(x + step, y, zAt(x + step)),
          metal.at(x + step, y + step, zAt(x + step)),
          metal.at(x, y + step, zAt(x)),
        ]
        if (sign > 0) metal.quad(ids[0], ids[1], ids[2], ids[3])
        else metal.quad(ids[0], ids[3], ids[2], ids[1])
      }
    }
  }
}

function archTop(p: Profile, x: number): number {
  let y = 0.38
  for (const arch of p.arches) {
    const dx = x - arch.x
    if (Math.abs(dx) >= arch.r) continue
    y = Math.max(y, arch.y + Math.sqrt(arch.r * arch.r - dx * dx))
  }
  return y
}

function addNose(metal: Builder, p: Profile): void {
  const step = 0.08
  const xNose = p.noseX + 0.018
  const yTop = 0.72
  for (let z = -0.74; z < 0.74 - step; z += step) {
    for (let y = 0.1; y < yTop - step; y += step) {
      const ids = [z, z + step].flatMap((zz) => [y, y + step].map((yy) => metal.at(xAt(xNose, zz, yy), yy, zz)))
      metal.quad(ids[0], ids[1], ids[3], ids[2])
    }
  }
}

function xAt(nose: number, z: number, y: number): number {
  return nose - 0.05 * Math.pow(z / 0.9, 2) - Math.max(0, 0.42 - y) * 0.03
}

function outerAt(side: Grid, p: Profile, sign: number, x: number): number {
  let best = 0
  for (const dx of [0, -0.1, 0.1, -0.2, 0.2]) {
    for (const y of [0.7, 0.55, 0.96, 0.46]) {
      const hit = ray(side, 0, 1, 2, x + dx, y, sign * 2, -sign)
      if (hit != null && onThisSide(hit, sign, p.sideZ * 0.65)) best = Math.max(best, Math.abs(hit))
    }
  }
  return best > 0.45 ? best : p.sideZ
}

function addSideSkins(metal: Builder, glass: Builder, side: Grid, p: Profile): void {
  const step = 0.04
  const doorX1 = (p.arches.find((arch) => arch.x > 0)?.x ?? p.roofX1 + 0.7) - 0.08
  const pad = 0.08
  for (const sign of [1, -1]) {
    for (let x = p.roofX0 - 0.05; x < doorX1 - step; x += step) {
      const yTop = x < p.roofX1 - 0.05 ? p.roofY - 0.06 : p.belt + 0.26
      for (let y = 0.42; y < yTop - step; y += step) {
        if (y < archTop(p, x) + 0.02) continue
        const hit = ray(side, 0, 1, 2, x + step / 2, y + step / 2, sign * 2, -sign)
        if (onThisSide(hit, sign, p.sideZ)) continue
        const z = sign * (outerAt(side, p, sign, x) + 0.008)
        const target = y + step * 0.5 > p.belt ? glass : metal
        const ids = [
          target.at(x - pad, y - pad, z),
          target.at(x + step + pad, y - pad, z),
          target.at(x + step + pad, y + step + pad, z),
          target.at(x - pad, y + step + pad, z),
        ]
        if (sign > 0) target.quad(ids[0], ids[1], ids[2], ids[3])
        else target.quad(ids[0], ids[3], ids[2], ids[1])
      }
    }
  }
}

function addScreens(glass: Builder, p: Profile): void {
  const windX = p.roofX1
  screen(glass, windX, p.railY - 0.01, p.roofZ * 0.9, p.hoodX0 - 0.02, p.hoodY0 - 0.02, Math.min(0.78, p.sideZ - 0.04), 1)
  const rearRun = 0.42
  screen(glass, p.roofX0 + 0.04, p.railY - 0.01, p.roofZ * 0.84, p.roofX0 - rearRun, Math.min(p.railY - 0.12, 1.02), p.roofZ * 0.74, -1)
}

function screen(
  glass: Builder,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  dir: number,
): void {
  const cols = 8
  const rows = 4
  const ids: number[] = []
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const u = i / cols
      const v = j / rows
      const x = x0 + (x1 - x0) * v
      const y = y0 + (y1 - y0) * v
      const half = z0 + (z1 - z0) * v
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
      if (dir > 0) glass.quad(a, b, c, d)
      else glass.quad(a, d, c, b)
    }
  }
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
