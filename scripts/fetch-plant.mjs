// Vendor the SimReady hall, car, AGV, cobot, and station props.
// The packaged names (body.glb, amr.glb, cobot.glb, hall_*.glb, …) are not in
// huggingface.co/datasets/codepawl/simready-glb (those URLs 404). They are the
// public static mirror of the same CC BY NVIDIA SimReady assets.
import { mkdir, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'public/models/plant')
const base = 'https://www.airsup.ai/plm/rocket-engine'

const files = [
  'srfactory/m/hall_corner.glb',
  'srfactory/m/hall_straight.glb',
  'srfactory/m/hall_center.glb',
  'srfactory/env/empty_warehouse_01_1k.hdr',
  'srfactory/m/cobot.glb',
  'srfactory/m/amr.glb',
  'srfactory/m/fork_red.glb',
  'srfactory/m/cart_tier.glb',
  'srfactory/m/diagcart.glb',
  'srfactory/m/toolcab.glb',
  'srfactory/m/ibc.glb',
  'srfactory/m/drum.glb',
  'srfactory/m/stillage.glb',
  'srfactory/m/floorsign.glb',
  'srfactory/m/extinguisher.glb',
  'srfactory/m/rack_pallet.glb',
  'carplant/m/body.glb',
  'carplant/m/dash.glb',
  'carplant/m/steer.glb',
  'carplant/m/seat.glb',
  'carplant/m/rear.glb',
  'carplant/m/v6.glb',
  'carplant/m/trans.glb',
  'carplant/m/exhaust.glb',
  'carplant/m/tire.glb',
  'carplant/m/rim.glb',
  'carplant/m/crane.glb',
  'carplant/m/changer.glb',
  'fcenter/m/load_brown.glb',
  'fcenter/m/load_white.glb',
  'guessbn/m/rack_far.glb',
  'jetplant/crew/crew_0.glb',
  'jetplant/crew/crew_1.glb',
  'jetplant/crew/crew_2.glb',
  'jetplant/crew/crew_3.glb',
]

async function has(file) {
  try {
    const s = await stat(file)
    return s.size > 1000
  } catch {
    return false
  }
}

async function download(rel) {
  const dest = path.join(outDir, path.basename(rel))
  if (await has(dest)) return
  const url = `${base}/${rel}`
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url} -> ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  process.stdout.write(`fetched ${rel}\n`)
}

await mkdir(outDir, { recursive: true })
await Promise.all(files.map(download))
process.stdout.write('plant models ready\n')
