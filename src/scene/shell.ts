import * as THREE from 'three'

/**
 * The vendored body is an open body-in-white: roof, hood, glass, and both
 * ends are missing, and the sheets that remain are torn around the wheel
 * wells. Patching those holes left the torn metal in frame. This replaces
 * the donor skin with one closed shell in the body's meter space — roof,
 * hood, sides, rocker, nose, and tail — and glazed openings. Paint is applied
 * later so every panel of a car shares one clearcoat.
 */

const STEP = 0.05

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
  addRoof(metal, profile)
  addHood(metal, profile)
  addNose(metal, profile)
  addTail(metal, profile)
  addFloor(metal, profile)
  addSideSkins(metal, profile)
  addPillars(metal, profile)
  addArchRings(metal, profile)
  addSideGlass(glass, profile)
  addScreens(glass, profile)
  finish(root, metal, 'shell_seal', shellMat, true)
  finish(root, glass, 'shell_glass', GLASS, false)
  root.userData.axles = profile.arches.map((arch) => ({
    x: arch.x,
    y: 0.34,
    z: skinHalf(profile, arch.x, 0.34) - 0.09,
  }))
  dropDonor(root)
  root.userData.sealed = true
  root.userData.sealNote = profile.note
}

function dropDonor(root: THREE.Object3D): void {
  const drop: THREE.Mesh[] = []
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && !mesh.userData.seal) drop.push(mesh)
  })
  for (const mesh of drop) {
    mesh.geometry?.dispose()
    mesh.removeFromParent()
  }
}

function qIndex(v: number): number {
  return Math.round(v / STEP)
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

function lat(v: number): number {
  return qIndex(v) * STEP
}

function addRoof(metal: Builder, p: Profile): void {
  const i0 = qIndex(p.roofX0 + 0.02)
  const i1 = qIndex(p.roofX1 - 0.02)
  const edgeY = lat(p.railY)
  for (let i = i0; i < i1; i++) {
    const x0 = i * STEP
    const x1 = (i + 1) * STEP
    const span = skinHalf(p, (x0 + x1) / 2, edgeY)
    const cols = Math.max(6, Math.round((span * 2) / STEP))
    for (let c = 0; c < cols; c++) {
      const za = -span + (2 * span * c) / cols
      const zb = -span + (2 * span * (c + 1)) / cols
      const ids = [
        metal.at(x0, roofHeight(p, za), za),
        metal.at(x1, roofHeight(p, za), za),
        metal.at(x1, roofHeight(p, zb), zb),
        metal.at(x0, roofHeight(p, zb), zb),
      ]
      metal.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

function roofHeight(p: Profile, z: number): number {
  const edge = lat(p.railY)
  const half = Math.max(0.25, p.sideZ)
  const u = Math.min(1, Math.abs(z) / half)
  const crown = Math.max(0.025, p.roofPeak - p.railY)
  return edge + crown * (1 - u * u)
}

function hoodHeight(p: Profile, x: number, z: number): number {
  const span = Math.max(0.2, p.noseX - 0.12 - p.hoodX0)
  const t = Math.min(1, Math.max(0, (x - p.hoodX0) / span))
  const base = p.hoodY0 + (p.hoodY1 - p.hoodY0) * t
  const crown = 0.02 * (1 - Math.min(1, Math.pow(z / 0.72, 2)))
  return base + crown
}

function addHood(metal: Builder, p: Profile): void {
  const i0 = qIndex(p.hoodX0)
  const i1 = qIndex(p.noseX + 0.012)
  for (let i = i0; i < i1; i++) {
    const x0 = i * STEP
    const x1 = (i + 1) * STEP
    const h0 = skinHalf(p, x0, sideTop(p, x0))
    const h1 = skinHalf(p, x1, sideTop(p, x1))
    const cols = Math.max(6, Math.round((h0 + h1) / STEP))
    for (let c = 0; c < cols; c++) {
      const u0 = c / cols
      const u1 = (c + 1) / cols
      const zAt = (h: number, u: number) => (u <= 0 ? -h : u >= 1 ? h : -h + 2 * h * u)
      const yAt = (x: number, z: number, outer: boolean) => (outer ? sideTop(p, x) : hoodHeight(p, x, z))
      const z00 = zAt(h0, u0)
      const z01 = zAt(h0, u1)
      const z10 = zAt(h1, u0)
      const z11 = zAt(h1, u1)
      const ids = [
        metal.at(x0, yAt(x0, z00, u0 <= 0 || u0 >= 1), z00),
        metal.at(x1, yAt(x1, z10, u0 <= 0 || u0 >= 1), z10),
        metal.at(x1, yAt(x1, z11, u1 <= 0 || u1 >= 1), z11),
        metal.at(x0, yAt(x0, z01, u1 <= 0 || u1 >= 1), z01),
      ]
      metal.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

function inWheel(p: Profile, x: number, y: number): boolean {
  for (const arch of p.arches) {
    const dx = x - arch.x
    const dy = y - 0.34
    if (dx * dx + dy * dy < 0.36 * 0.36) return true
  }
  return false
}

function windowRects(p: Profile): [number, number, number, number][] {
  const bottom = lat(Math.min(p.belt, 0.8)) + STEP
  const rail = lat(p.railY)
  return [
    [lat(p.roofX0 + 0.2), lat(p.roofX0 + 0.56), bottom, lat(rail - 0.1)],
    [lat(p.roofX0 + 0.78), lat(-0.16), bottom, lat(rail - 0.08)],
    [lat(0.12), lat(p.roofX1 - 0.04), bottom, lat(bottom + 0.3)],
  ]
}

function inWindow(p: Profile, x: number, y: number): boolean {
  for (const [x0, x1, y0, y1] of windowRects(p)) {
    if (x > x0 && x < x1 && y > y0 && y < y1) return true
  }
  return false
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

function planWidth(p: Profile, x: number): number {
  // The donor's outer vertices jump around the torn flanges. Tracing them
  // made the rocker a scalloped foil edge. The shell uses a smooth plan
  // instead: door width, a flare over each arch, a short taper at the ends.
  let flare = 0
  for (const arch of p.arches) {
    const dx = Math.abs(x - arch.x)
    if (dx < 0.62) flare = Math.max(flare, 0.05 * Math.cos((dx / 0.62) * Math.PI * 0.5))
  }
  let taper = 1
  const noseRun = 0.7
  const tailRun = 0.55
  if (x > p.noseX - noseRun) {
    const t = (x - (p.noseX - noseRun)) / noseRun
    taper = 1 - 0.14 * t * t
  } else if (x < p.tailX + tailRun) {
    const t = ((p.tailX + tailRun) - x) / tailRun
    taper = 1 - 0.08 * t * t
  }
  return (p.sideZ + flare) * taper
}

function crease(y: number, belt: number): number {
  if (y < 0.2) return -0.008
  const d = (y - belt) / 0.05
  if (d > -1.2 && d < 1.2) return 0.007 * (1 - Math.min(1, d * d))
  return 0
}

function skinHalf(p: Profile, x: number, y: number): number {
  return planWidth(p, x) + crease(y, p.belt)
}

function sideTop(p: Profile, x: number): number {
  if (x < p.roofX0) {
    const t = Math.min(1, (p.roofX0 - x) / 0.7)
    return p.railY + (0.86 - p.railY) * t
  }
  if (x <= p.roofX1) return p.railY
  if (x >= p.hoodX0) return hoodHeight(p, x, planWidth(p, x))
  const t = (x - p.roofX1) / Math.max(0.2, p.hoodX0 - p.roofX1)
  const hood = hoodHeight(p, p.hoodX0, planWidth(p, p.hoodX0))
  return p.railY + (hood - p.railY) * t
}

function addNose(metal: Builder, p: Profile): void {
  cap(metal, qIndex(p.noseX + 0.012) * STEP, 1, p)
}

function addTail(metal: Builder, p: Profile): void {
  cap(metal, qIndex(p.tailX - 0.01) * STEP, -1, p)
}

function cap(metal: Builder, x: number, dir: number, p: Profile): void {
  const j0 = qIndex(0.05)
  const top = sideTop(p, x)
  const j1 = Math.floor((top - 1e-4) / STEP)
  const rows: [number, number][] = []
  for (let j = j0; j < j1; j++) rows.push([j * STEP, (j + 1) * STEP])
  const yLast = Math.max(j0, j1) * STEP
  if (top - yLast > 0.004) rows.push([yLast, top])
  const cols = 12
  for (const [y0, y1] of rows) {
    const h0 = skinHalf(p, x, y0)
    const h1 = skinHalf(p, x, y1)
    for (let c = 0; c < cols; c++) {
      const u0 = c / cols
      const u1 = (c + 1) / cols
      const z = (h: number, u: number) => (u === 0 ? -h : u === 1 ? h : -h + 2 * h * u)
      const ids = [
        metal.at(x, y0, z(h0, u0)),
        metal.at(x, y0, z(h0, u1)),
        metal.at(x, y1, z(h1, u1)),
        metal.at(x, y1, z(h1, u0)),
      ]
      if (dir > 0) metal.quad(ids[0], ids[1], ids[2], ids[3])
      else metal.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

function addFloor(metal: Builder, p: Profile): void {
  const y = qIndex(0.05) * STEP
  const i0 = qIndex(p.tailX - 0.01)
  const i1 = qIndex(p.noseX + 0.012)
  for (let i = i0; i < i1; i++) {
    const x0 = i * STEP
    const x1 = (i + 1) * STEP
    if (p.arches.some((arch) => Math.abs((x0 + x1) / 2 - arch.x) < 0.42)) continue
    const h0 = skinHalf(p, x0, y)
    const h1 = skinHalf(p, x1, y)
    const cols = 8
    for (let c = 0; c < cols; c++) {
      const u0 = c / cols
      const u1 = (c + 1) / cols
      const z = (h: number, u: number) => (u === 0 ? -h : u === 1 ? h : -h + 2 * h * u)
      const ids = [
        metal.at(x0, y, z(h0, u0)),
        metal.at(x1, y, z(h1, u0)),
        metal.at(x1, y, z(h1, u1)),
        metal.at(x0, y, z(h0, u1)),
      ]
      metal.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

function addSideSkins(metal: Builder, p: Profile): void {
  const i0 = qIndex(p.tailX - 0.01)
  const i1 = qIndex(p.noseX + 0.012)
  const j0 = qIndex(0.05)
  for (let i = i0; i < i1; i++) {
    const x0 = i * STEP
    const x1 = (i + 1) * STEP
    const top0 = sideTop(p, x0)
    const top1 = sideTop(p, x1)
    const jTop = Math.floor((Math.min(top0, top1) - 1e-4) / STEP)
    const bands: [number, number, number, number][] = []
    for (let j = j0; j < jTop; j++) bands.push([j * STEP, (j + 1) * STEP, j * STEP, (j + 1) * STEP])
    const yBase = Math.max(j0, jTop) * STEP
    if (top0 - yBase > 0.004 || top1 - yBase > 0.004) bands.push([yBase, top0, yBase, top1])
    for (const [y00, y01, y10, y11] of bands) {
      const cy = ((y00 + y01) / 2 + (y10 + y11) / 2) / 2
      if (inWheel(p, (x0 + x1) / 2, cy)) continue
      if (inWindow(p, (x0 + x1) / 2, cy)) continue
      for (const sign of [1, -1]) {
        const ids = [
          metal.at(x0, y00, sign * skinHalf(p, x0, y00)),
          metal.at(x1, y10, sign * skinHalf(p, x1, y10)),
          metal.at(x1, y11, sign * skinHalf(p, x1, y11)),
          metal.at(x0, y01, sign * skinHalf(p, x0, y01)),
        ]
        if (sign > 0) metal.quad(ids[0], ids[1], ids[2], ids[3])
        else metal.quad(ids[0], ids[3], ids[2], ids[1])
      }
    }
  }
}

function addPillars(metal: Builder, p: Profile): void {
  const i0 = qIndex(p.roofX1 - 0.04)
  const i1 = qIndex(p.hoodX0 + 0.06)
  const glassZ = Math.min(0.7, p.sideZ - 0.12)
  for (let i = i0; i < i1; i++) {
    const x0 = i * STEP
    const x1 = (i + 1) * STEP
    const y0 = sideTop(p, x0)
    const y1 = sideTop(p, x1)
    for (const sign of [1, -1]) {
      const zo0 = sign * skinHalf(p, x0, y0)
      const zo1 = sign * skinHalf(p, x1, y1)
      const zi = sign * glassZ
      const header = [
        metal.at(x0, y0, zo0),
        metal.at(x1, y1, zo1),
        metal.at(x1, y1, zi),
        metal.at(x0, y0, zi),
      ]
      const frame = [
        metal.at(x0, y0, zi),
        metal.at(x1, y1, zi),
        metal.at(x1, y1 - 0.07, zi),
        metal.at(x0, y0 - 0.07, zi),
      ]
      if (sign > 0) {
        metal.quad(header[0], header[3], header[2], header[1])
        metal.quad(frame[0], frame[1], frame[2], frame[3])
      } else {
        metal.quad(header[0], header[1], header[2], header[3])
        metal.quad(frame[0], frame[3], frame[2], frame[1])
      }
    }
  }
}

function addArchRings(metal: Builder, p: Profile): void {
  const bands: [number, number, number][] = [[0.3, 0.4, 0.008], [0.4, 0.5, 0.018]]
  const n = 32
  for (const arch of p.arches) {
    for (const sign of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2
        const a1 = ((i + 1) / n) * Math.PI * 2
        for (const [r0, r1, push] of bands) {
          const pt = (a: number, r: number) => ({ x: arch.x + Math.cos(a) * r, y: 0.34 + Math.sin(a) * r })
          const corners = [pt(a0, r0), pt(a1, r0), pt(a1, r1), pt(a0, r1)]
          if (corners.some((corner) => corner.y < 0.1)) continue
          const at = (corner: { x: number, y: number }, extra: number) => (
            metal.at(corner.x, corner.y, sign * (skinHalf(p, corner.x, corner.y) + extra))
          )
          const ids = [at(corners[0], push), at(corners[1], push), at(corners[2], push * 0.35), at(corners[3], push * 0.35)]
          if (sign > 0) metal.quad(ids[0], ids[1], ids[2], ids[3])
          else metal.quad(ids[0], ids[3], ids[2], ids[1])
        }
      }
    }
  }
}

function addSideGlass(glass: Builder, p: Profile): void {
  for (const [x0, x1, y0, y1] of windowRects(p)) {
    if (x1 - x0 < STEP || y1 - y0 < STEP) continue
    const z = planWidth(p, (x0 + x1) / 2) - 0.008
    for (const sign of [1, -1]) {
      const ids = [
        glass.at(x0, y0, sign * z),
        glass.at(x1, y0, sign * z),
        glass.at(x1, y1, sign * z),
        glass.at(x0, y1, sign * z),
      ]
      if (sign > 0) glass.quad(ids[0], ids[1], ids[2], ids[3])
      else glass.quad(ids[0], ids[3], ids[2], ids[1])
    }
  }
}

function addScreens(glass: Builder, p: Profile): void {
  const windZ = Math.min(0.76, skinHalf(p, (p.roofX1 + p.hoodX0) / 2, 1) - 0.06)
  screen(glass, p.roofX1, lat(p.railY), windZ, p.hoodX0, lat(sideTop(p, p.hoodX0)), windZ * 0.94, 1)
  const rearZ = Math.min(0.72, skinHalf(p, p.roofX0, p.railY) - 0.08)
  screen(glass, p.roofX0, lat(p.railY), rearZ, p.roofX0 - 0.48, lat(0.9), rearZ * 0.82, -1)
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
