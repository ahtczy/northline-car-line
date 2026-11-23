// Download NVIDIA SimReady GLBs (CC BY 4.0) and write runtime LODs.
// Heavy meshes are simplified so a full assembly line can render in a browser.
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeIO } from '@gltf-transform/core'
import { dedup, prune, simplify, weld } from '@gltf-transform/functions'
import {
  EXTMeshoptCompression,
  EXTTextureWebP,
  KHRMaterialsIOR,
  KHRMaterialsTransmission,
  KHRMeshQuantization,
  KHRTextureTransform,
} from '@gltf-transform/extensions'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rawDir = path.join(root, '.cache/simready')
const outDir = path.join(root, 'public/models')
const base = 'https://huggingface.co/datasets/codepawl/simready-glb/resolve/main/glb'

/** @type {{ name: string, ratio: number, error: number }[]} */
// ratio is applied to the index buffer. Targets keep a full line of cars,
// two forklifts, and the hall props inside a budget a software renderer can draw.
const heavy = [
  { name: 'wheelAssembly_tire_c01', ratio: 0.007, error: 0.035 },
  { name: 'wheelAssembly_wheel_rim_a01', ratio: 0.01, error: 0.03 },
  { name: 'vehicle_forklift_orange_a01', ratio: 0.012, error: 0.035 },
  { name: 'vehicle_forklift_blue_a01', ratio: 0.012, error: 0.035 },
  { name: 'engineAssembly_v8_engine_a01', ratio: 0.004, error: 0.04 },
  { name: 'palletJack_lowProfile_a01', ratio: 0.015, error: 0.035 },
  { name: 'ladder_rolling_yellow_a02', ratio: 0.01, error: 0.035 },
  { name: 'interiorPart_dashboard_a01', ratio: 0.02, error: 0.03 },
  { name: 'rack_h3m_s02', ratio: 0.01, error: 0.035 },
  { name: 'crate_blue_a02', ratio: 0.025, error: 0.03 },
  { name: 'crate_yellow_a01', ratio: 0.025, error: 0.03 },
  { name: 'rack_large_empty_a01', ratio: 0.05, error: 0.03 },
  { name: 'rack_large_empty_a02', ratio: 0.05, error: 0.03 },
]

const light = [
  'box_cardboard_a01',
  'box_cardboard_b01',
  'box_cardboard_c01',
  'barrier_fence_metal_a02',
  'structure_wall_column_a01',
  'pallet_a01',
  'vehicleSupport_jack_stand_b01',
  'storage_tire_rack_b01',
  'sign_warning_a04',
  'fireProtection_extinguisher_portable_b01',
  'wire_machineGuard_a02',
  'drum_plastic_blue_a01',
  'pail_plastic_yellow_a02',
  'handTool_torque_wrench_b01',
]

async function exists(file) {
  try {
    const s = await stat(file)
    return s.size > 500
  } catch {
    return false
  }
}

async function download(name, dest) {
  if (await exists(dest)) return
  const url = `${base}/${name}.glb`
  process.stdout.write(`download ${name}\n`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url} -> ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

async function main() {
  await mkdir(rawDir, { recursive: true })
  await mkdir(outDir, { recursive: true })
  await MeshoptDecoder.ready
  await MeshoptEncoder.ready
  await MeshoptSimplifier.ready

  const io = new NodeIO()
    .registerExtensions([
      EXTMeshoptCompression,
      EXTTextureWebP,
      KHRMeshQuantization,
      KHRMaterialsIOR,
      KHRMaterialsTransmission,
      KHRTextureTransform,
    ])
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    })

  for (const name of light) {
    const dest = path.join(outDir, `${name}.glb`)
    if (!(await exists(dest))) await download(name, dest)
  }

  for (const item of heavy) {
    const dest = path.join(outDir, `${item.name}.glb`)
    if (await exists(dest) && process.env.FORCE_LOD !== '1') {
      // Already prepared. Re-run with FORCE_LOD=1 to regenerate.
      continue
    }
    const raw = path.join(rawDir, `${item.name}.glb`)
    await download(item.name, raw)
    process.stdout.write(`simplify ${item.name} ratio ${item.ratio}\n`)
    const doc = await io.read(raw)
    let before = 0
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) before += prim.getIndices()?.getCount() ?? 0
    }
    await doc.transform(
      dedup(),
      weld({ tolerance: 0.0001 }),
      simplify({ simplifier: MeshoptSimplifier, ratio: item.ratio, error: item.error, lockBorder: false }),
      prune(),
    )
    // Drop physics extras; keep the visual mesh.
    doc.getRoot().listExtensionsUsed().forEach((ext) => {
      if (ext.extensionName === 'KHR_physics_rigid_bodies') ext.dispose()
    })
    const glb = await io.writeBinary(doc)
    await writeFile(dest, glb)
    let after = 0
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) after += prim.getIndices()?.getCount() ?? 0
    }
    process.stdout.write(`  tris ${Math.round(before / 3)} -> ${Math.round(after / 3)}  bytes ${glb.byteLength}\n`)
  }
  process.stdout.write('models ready\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
