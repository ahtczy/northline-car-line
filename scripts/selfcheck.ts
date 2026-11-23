import { buildPlan, demoScore, faultLabel, STATIONS } from '../src/sim/line.ts'

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL', msg)
    process.exit(1)
  }
}

const a = buildPlan('GNUCR')
const b = buildPlan('GNUCR')
assert(JSON.stringify(a.stations.map((s) => [s.kind, s.effectiveSec, s.crewPresent])) === JSON.stringify(b.stations.map((s) => [s.kind, s.effectiveSec, s.crewPresent])), 'same seed differs')
assert(a.stations.filter((s) => s.kind === 'op').length === 1, 'op count')
assert(a.stations.filter((s) => s.kind === 'fault').length === 1, 'fault count')
const fault = a.stations.find((s) => s.kind === 'fault')
assert(!!fault && fault.robots > 0, 'fault on a station with robots')
const op = a.stations.find((s) => s.kind === 'op')
assert(!!op && op.crewPresent === op.crewNominal - 1, 'one operator missing')
assert(a.shiftCars === Math.floor((8 * 3600) / a.spc), 'shift cars formula')
assert(a.planCars === Math.floor((8 * 3600) / a.planSec), 'plan cars formula')
assert(a.spc > 20 && a.spc < 200, `spc out of range ${a.spc}`)
assert(Math.abs(a.linePerHour - 3600 / a.spc) < 1e-6, 'rate')
const slowest = a.stations.reduce((m, s) => (s.effectiveSec > m.effectiveSec ? s : m))
assert(slowest.index === a.bottleneck, 'bottleneck is max effective')
assert(demoScore(a, a.bottleneck) === 100, 'correct pick scores 100')

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function seedFrom(n: number) {
  let s = ''
  let x = n
  for (let i = 0; i < 5; i++) {
    s += alphabet[x % alphabet.length]
    x = Math.floor(x / alphabet.length)
  }
  return s
}

let story: ReturnType<typeof buildPlan> | null = null
const t0 = Date.now()
for (let i = 0; i < 4000 && !story; i++) {
  const seed = seedFrom(i)
  const plan = buildPlan(seed, false)
  const marriage = plan.stations[3]
  const seats = plan.stations[2]
  if (marriage.kind !== 'op' || seats.kind !== 'fault' || !seats.fault) continue
  const stop = seats.fault.stopSec
  const period = seats.fault.periodSec
  if (stop < 30 || stop > 40) continue
  if (period < 170 || period > 205) continue
  if (marriage.effectiveSec < 68 || marriage.effectiveSec > 74) continue
  story = plan
}
console.log('search ms', Date.now() - t0)
console.log('GNUCR bottleneck', a.stations[a.bottleneck].id, 'spc', a.spc.toFixed(2), 'cars', a.shiftCars, 'score if wheels', demoScore(a, 4))
console.log('GNUCR kinds', a.stations.map((s) => `${s.id}:${s.kind}${s.kind === 'fault' ? ' ' + faultLabel(s) : ''}`).join(' | '))
if (story) {
  const full = buildPlan(story.seed, true)
  const seats = full.stations[2]
  const marriage = full.stations[3]
  console.log('STORY', full.seed, 'marriage', marriage.effectiveSec.toFixed(2), 'seats', faultLabel(seats), 'spc', full.spc.toFixed(2), 'cars', full.shiftCars, 'wheels score', demoScore(full, 4), 'plan cars', full.planCars)
} else {
  console.log('no story seed in 4000')
}
console.log('stations', STATIONS.length, 'ok')
