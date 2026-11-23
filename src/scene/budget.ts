import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshoptSimplifier } from 'meshoptimizer/simplifier'

/**
 * Plant GLBs are CAD tessellations. On the WebGL fallback that work, plus a
 * shadow pass, is enough to stall the GPU process until Chrome kills the
 * context. These budgets drop triangles the camera cannot use. The car's outer
 * skin is exempt: simplifying it opens the panels. PreserveFolds keeps creases.
 */
type Budget = { ratio: number, error: number, floor: number }

const FILE_BUDGET: Record<string, Budget> = {
  'v6.glb': { ratio: 0.08, error: 0.012, floor: 5000 },
  'hall_straight.glb': { ratio: 0.16, error: 0.0035, floor: 8000 },
  'hall_corner.glb': { ratio: 0.14, error: 0.0035, floor: 8000 },
  'hall_center.glb': { ratio: 0.22, error: 0.0035, floor: 6000 },
  'cobot.glb': { ratio: 0.1, error: 0.01, floor: 4000 },
  'fork_red.glb': { ratio: 0.1, error: 0.012, floor: 4000 },
  'seat.glb': { ratio: 0.12, error: 0.01, floor: 4000 },
  'stillage.glb': { ratio: 0.16, error: 0.012, floor: 3000 },
  'diagcart.glb': { ratio: 0.16, error: 0.012, floor: 3000 },
  'changer.glb': { ratio: 0.16, error: 0.01, floor: 3000 },
  'crane.glb': { ratio: 0.16, error: 0.01, floor: 3000 },
  'amr.glb': { ratio: 0.2, error: 0.012, floor: 2500 },
  'tire.glb': { ratio: 0.14, error: 0.008, floor: 1800 },
  'rim.glb': { ratio: 0.14, error: 0.008, floor: 1800 },
  'dash.glb': { ratio: 0.18, error: 0.01, floor: 2000 },
  'trans.glb': { ratio: 0.16, error: 0.012, floor: 2000 },
  'rear.glb': { ratio: 0.16, error: 0.01, floor: 2000 },
  'exhaust.glb': { ratio: 0.18, error: 0.015, floor: 1500 },
  'toolcab.glb': { ratio: 0.2, error: 0.015, floor: 2000 },
  'cart_tier.glb': { ratio: 0.2, error: 0.015, floor: 2000 },
}

const DEFAULT_BUDGET: Budget = { ratio: 0.28, error: 0.018, floor: 2500 }

/** Cobots are posed by rotating named joints, so their hierarchy has to stay. */
const KEEP_HIERARCHY = new Set(['cobot.glb', 'crew_0.glb', 'crew_1.glb', 'crew_2.glb', 'crew_3.glb'])

export async function prepareLoadedModel(root: THREE.Object3D, file: string): Promise<void> {
  if (!MeshoptSimplifier.supported) return
  await MeshoptSimplifier.ready
  const meshes: THREE.Mesh[] = []
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && mesh.geometry) meshes.push(mesh)
  })
  let n = 0
  for (const mesh of meshes) {
    simplifyGeometry(mesh.geometry, budgetFor(file, mesh))
    if (++n % 6 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (!KEEP_HIERARCHY.has(file)) mergeStaticMeshes(root)
}

function budgetFor(file: string, mesh: THREE.Mesh): Budget {
  if (file !== 'body.glb') return FILE_BUDGET[file] ?? DEFAULT_BUDGET
  // The outer skin and the panels sealed over it are what the camera sees.
  // Decimating them opens the shell. The inner frame stays hidden, so it can drop.
  if (mesh.userData.seal || mesh.geometry.userData.noSimplify || !/inside/i.test(mesh.name)) {
    return { ratio: 1, error: 0, floor: Number.POSITIVE_INFINITY }
  }
  return { ratio: 0.08, error: 0.012, floor: 4000 }
}

function simplifyGeometry(geom: THREE.BufferGeometry, budget: Budget): void {
  if (geom.userData.budgeted) return
  geom.userData.budgeted = true
  const index = geom.getIndex()
  const pos = geom.getAttribute('position')
  if (!index || !pos || pos.itemSize !== 3) return
  if (geom.getAttribute('skinIndex') || geom.getAttribute('skinWeight')) return
  if (Object.keys(geom.morphAttributes).length > 0) return
  if (geom.groups.length > 1) return
  const tris = index.count / 3
  const targetTris = Math.max(budget.floor, Math.floor(tris * budget.ratio))
  if (tris < budget.floor || targetTris >= tris * 0.9) return
  const indices = index.array instanceof Uint32Array ? index.array : new Uint32Array(index.array)
  const positions = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    positions[i * 3] = pos.getX(i)
    positions[i * 3 + 1] = pos.getY(i)
    positions[i * 3 + 2] = pos.getZ(i)
  }
  try {
    const [dst] = MeshoptSimplifier.simplify(indices, positions, 3, targetTris * 3, budget.error, ['PreserveFolds'])
    if (dst.length < 3 || dst.length >= index.count) return
    geom.setIndex(new THREE.BufferAttribute(dst, 1))
    geom.clearGroups()
  } catch {
    // Keep the original index if the simplifier rejects this primitive.
  }
}

function mergeStaticMeshes(root: THREE.Object3D): void {
  root.updateWorldMatrix(true, true)
  const meshes: THREE.Mesh[] = []
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return
    if (Array.isArray(mesh.material)) return
    const geom = mesh.geometry
    if (!geom.getIndex()) return
    if (Object.keys(geom.morphAttributes).length > 0) return
    meshes.push(mesh)
  })
  const buckets = new Map<string, THREE.Mesh[]>()
  for (const mesh of meshes) {
    const geom = mesh.geometry
    const material = mesh.material as THREE.Material
    const key = [
      material.uuid,
      geom.getIndex() ? 'i' : 'n',
      Object.keys(geom.attributes).sort().join(','),
    ].join('|')
    const list = buckets.get(key)
    if (list) list.push(mesh)
    else buckets.set(key, [mesh])
  }
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const bakedMatrix = new THREE.Matrix4()
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    const baked: THREE.BufferGeometry[] = []
    for (const mesh of list) {
      const geom = mesh.geometry.clone()
      bakedMatrix.multiplyMatrices(rootInv, mesh.matrixWorld)
      geom.applyMatrix4(bakedMatrix)
      baked.push(geom)
    }
    const merged = mergeGeometries(baked, false)
    for (const geom of baked) geom.dispose()
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, list[0].material)
    mesh.name = list[0].name
    mesh.userData = { ...list[0].userData }
    mesh.receiveShadow = true
    mesh.castShadow = list.some((item) => item.castShadow)
    root.add(mesh)
    for (const item of list) item.removeFromParent()
  }
}
