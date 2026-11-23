// Seeded final-assembly line.
//
// The public inventory file was not in the workspace, so the generator follows
// the rules that were stated with it: one missing operator, one cyclic robot
// fault, station kinds op | fault | plain, a 7200s measurement window, SPC as
// the mean departure interval over the last 600s, and an 8-hour car count of
// floor(8*3600/spc). Standard work (planned seconds, crew, robots, labor
// share) is the fixed balance for this straight line. The seed only chooses
// who is short, which robot faults, and the fault clock.

export const PITCH = 14.8
export const BODY_X = -58
export const WINDOW_SEC = 7200
export const SPC_SEC = 600
export const SHIFT_SEC = 8 * 3600
export const SHIFT_START = 6 * 3600
export const BUFFER = 2
export const TRAVEL_SEC = 6.5

export type Kind = 'op' | 'fault' | 'plain'
export type CarMode = 'working' | 'blocked' | 'traveling' | 'queued' | 'done'

export interface FaultClock {
  stopSec: number
  periodSec: number
  /** Added to sim time before the modulo. Chosen so the first stop falls in the watched minute. */
  phaseSec: number
}

export interface StationDef {
  id: string
  name: string
  nameZh: string
  blurb: string
  plannedSec: number
  crewNominal: number
  robots: number
  /** Share of the planned cycle that is operator work and scales as nominal/present. */
  laborFrac: number
}

export interface StationPlan extends StationDef {
  index: number
  x: number
  kind: Kind
  crewPresent: number
  fault: FaultClock | null
  /** Crew-adjusted process time, faults not included. */
  processSec: number
  /** processSec / availability. This is the station's seconds per car. */
  effectiveSec: number
}

export interface LinePlan {
  seed: string
  stations: StationPlan[]
  planSec: number
  planPerHour: number
  planCars: number
  bottleneck: number
  spc: number
  linePerHour: number
  shiftCars: number
  departuresInWindow: number
}

export const STATIONS: StationDef[] = [
  { id: 'body', name: 'Body in', nameZh: '车身进入', blurb: 'Painted shell arrives from the paint shop and is set on an AGV.', plannedSec: 49, crewNominal: 2, robots: 0, laborFrac: 0.62 },
  { id: 'cockpit', name: 'Cockpit', nameZh: '驾驶舱', blurb: 'Dash, column, pedals and the cabin harness go in.', plannedSec: 58, crewNominal: 2, robots: 2, laborFrac: 0.34 },
  { id: 'seats', name: 'Seats', nameZh: '座椅', blurb: 'Front and rear seats are set into the shell.', plannedSec: 52, crewNominal: 2, robots: 1, laborFrac: 0.48 },
  { id: 'marriage', name: 'Marriage', nameZh: '合装', blurb: 'Engine, gearbox and exhaust rise into the body.', plannedSec: 55, crewNominal: 3, robots: 1, laborFrac: 0.58 },
  { id: 'wheels', name: 'Wheels', nameZh: '车轮', blurb: 'Four wheels on, nuts to torque.', plannedSec: 62, crewNominal: 2, robots: 4, laborFrac: 0.22 },
  { id: 'fill', name: 'Fill', nameZh: '加注', blurb: 'Coolant, brake fluid, washer fluid and fuel.', plannedSec: 57, crewNominal: 2, robots: 0, laborFrac: 0.66 },
  { id: 'test', name: 'Test', nameZh: '检测', blurb: 'Roll, lights and end-of-line checks.', plannedSec: 47, crewNominal: 2, robots: 0, laborFrac: 0.28 },
]

const ROBOT_INDEXES = STATIONS.map((s, i) => (s.robots > 0 ? i : -1)).filter((i) => i >= 0)

export function stationX(index: number): number {
  return BODY_X + index * PITCH
}

export function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function crewProcess(plannedSec: number, laborFrac: number, nominal: number, present: number): number {
  const crew = Math.max(1, present)
  return plannedSec * (1 - laborFrac + laborFrac * (nominal / crew))
}

export function faultActive(fault: FaultClock | null, t: number): boolean {
  if (!fault) return false
  const into = (t + fault.phaseSec) % fault.periodSec
  return into < fault.stopSec
}

export function buildPlan(seed: string, measure = true): LinePlan {
  const rng = mulberry32(hashSeed(seed))
  const opIndex = Math.floor(rng() * STATIONS.length)
  let faultIndex = ROBOT_INDEXES[Math.floor(rng() * ROBOT_INDEXES.length)]
  if (faultIndex === opIndex) {
    const choices = ROBOT_INDEXES.filter((i) => i !== opIndex)
    faultIndex = choices[Math.floor(rng() * choices.length)]
  }
  const stopSec = 22 + rng() * 28
  const periodSec = 150 + rng() * 120
  const firstStop = 48 + rng() * 50
  const phaseSec = (periodSec - (firstStop % periodSec)) % periodSec
  // Drain the rest of this draw so prime fractions below stay independent of unused rolls.
  const prime = STATIONS.map(() => 0.28 + rng() * 0.55)

  const stations: StationPlan[] = STATIONS.map((def, index) => {
    const kind: Kind = index === opIndex ? 'op' : index === faultIndex ? 'fault' : 'plain'
    const crewPresent = kind === 'op' ? def.crewNominal - 1 : def.crewNominal
    const fault: FaultClock | null = kind === 'fault' ? { stopSec, periodSec, phaseSec } : null
    const processSec = crewProcess(def.plannedSec, def.laborFrac, def.crewNominal, crewPresent)
    const availability = fault ? 1 - fault.stopSec / fault.periodSec : 1
    const effectiveSec = processSec / availability
    return { ...def, index, x: stationX(index), kind, crewPresent, fault, processSec, effectiveSec }
  })

  let bottleneck = 0
  for (let i = 1; i < stations.length; i++) {
    if (stations[i].effectiveSec > stations[bottleneck].effectiveSec) bottleneck = i
  }
  const planSec = Math.max(...stations.map((s) => s.plannedSec))
  const measured = measure ? measureSteady(stations) : { spc: stations[bottleneck].effectiveSec, count: 0 }
  return {
    seed,
    stations,
    planSec,
    planPerHour: 3600 / planSec,
    planCars: Math.floor(SHIFT_SEC / planSec),
    bottleneck,
    spc: measured.spc,
    linePerHour: 3600 / measured.spc,
    shiftCars: Math.floor(SHIFT_SEC / measured.spc),
    departuresInWindow: measured.count,
    ...trackPrime(prime),
  }
}

function trackPrime(prime: number[]): { primeFrac: number[] } {
  return { primeFrac: prime }
}

// buildPlan's return spread needs primeFrac on the type.
export interface LinePlan {
  primeFrac: number[]
}

interface Measured {
  spc: number
  count: number
}

/** Empty-line run. SPC is the mean test-exit interval inside the last 600s. */
function measureSteady(stations: StationPlan[]): Measured {
  const sim = new LineSim({ stations } as LinePlan, false)
  sim.run(WINDOW_SEC)
  const times = sim.completions.filter((t) => t > WINDOW_SEC - SPC_SEC && t <= WINDOW_SEC)
  if (times.length < 2) {
    const fallback = Math.max(...stations.map((s) => s.effectiveSec))
    return { spc: fallback, count: times.length }
  }
  const spc = (times[times.length - 1] - times[0]) / (times.length - 1)
  return { spc, count: times.length }
}

export interface SimCar {
  id: number
  mode: CarMode
  station: number
  remaining: number
  cycle: number
  slot: number
  startedAt: number
  /** Smoothed world X, owned by the view. */
  displayX: number
}

export interface LineEvent {
  t: number
  kind: 'start' | 'fault' | 'clear' | 'exit' | 'note'
  text: string
}

export class LineSim {
  t = 0
  cars: SimCar[] = []
  queues: number[][]
  completions: number[] = []
  events: LineEvent[] = []
  intervals: number[][]
  finished: number[]
  plan: LinePlan
  private nextId = 10041
  private acc = 0
  private faultDown: boolean[]
  private sampleAcc = 0
  busySamples: number[][]

  constructor(plan: LinePlan, prime = true) {
    this.plan = plan
    const n = plan.stations.length
    this.queues = Array.from({ length: n }, () => [])
    this.intervals = Array.from({ length: n }, () => [])
    this.finished = Array.from({ length: n }, () => 0)
    this.busySamples = Array.from({ length: n }, () => [])
    this.faultDown = plan.stations.map((s) => faultActive(s.fault, 0))
    if (prime) {
      plan.stations.forEach((st, i) => {
        const cycle = st.processSec
        const car = this.makeCar(i, 'working', cycle * (plan.primeFrac[i] ?? 0.5), cycle)
        car.displayX = st.x
        this.cars.push(car)
      })
      this.events.push({
        t: 0,
        kind: 'start',
        text: '06:00 shift start, line already loaded',
      })
      const short = plan.stations.find((s) => s.kind === 'op')
      if (short) {
        this.events.push({
          t: 0,
          kind: 'note',
          text: `${short.name}: operator out, ${short.crewPresent} of ${short.crewNominal}`,
        })
      }
    }
  }

  run(seconds: number): void {
    const h = 0.25
    const steps = Math.round(seconds / h)
    for (let i = 0; i < steps; i++) this.tick(h)
  }

  step(dt: number): void {
    this.acc += dt
    const h = 0.1
    let guard = 0
    while (this.acc >= h && guard < 240) {
      this.tick(h)
      this.acc -= h
      guard++
    }
  }

  carById(id: number): SimCar | undefined {
    return this.cars.find((c) => c.id === id)
  }

  carWorkingAt(index: number): SimCar | undefined {
    return this.cars.find((c) => (c.mode === 'working' || c.mode === 'blocked') && c.station === index)
  }

  busyFraction(index: number): number {
    const samples = this.busySamples[index]
    if (!samples.length) return 0
    let s = 0
    for (const v of samples) s += v
    return s / samples.length
  }

  carsWaiting(): number {
    return this.cars.filter((c) => c.mode === 'blocked').length
  }

  exits(): number {
    return this.completions.length
  }

  private makeCar(station: number, mode: CarMode, remaining: number, cycle: number): SimCar {
    const id = this.nextId++
    return {
      id,
      mode,
      station,
      remaining,
      cycle,
      slot: 0,
      startedAt: this.t,
      displayX: this.plan.stations[Math.min(station, this.plan.stations.length - 1)].x,
    }
  }

  private tick(h: number): void {
    this.t += h
    const stations = this.plan.stations

    for (let i = 0; i < stations.length; i++) {
      const down = faultActive(stations[i].fault, this.t)
      if (down !== this.faultDown[i]) {
        this.events.push({
          t: this.t,
          kind: down ? 'fault' : 'clear',
          text: down ? `${stations[i].name}: robot fault, stopped` : `${stations[i].name}: fault cleared, running`,
        })
        this.faultDown[i] = down
      }
    }
    if (this.events.length > 14) this.events.splice(0, this.events.length - 14)

    for (const car of this.cars) {
      if (car.mode === 'traveling') {
        car.remaining -= h
        if (car.remaining <= 0) {
          car.mode = 'queued'
          car.remaining = 0
          car.slot = this.queues[car.station].length
          this.queues[car.station].push(car.id)
        }
      } else if (car.mode === 'working') {
        if (!this.faultDown[car.station]) {
          car.remaining -= h
          if (car.remaining <= 0) {
            const interval = this.t - car.startedAt
            this.intervals[car.station].push(interval)
            this.finished[car.station]++
            if (this.intervals[car.station].length > 6) this.intervals[car.station].shift()
            car.remaining = 0
            car.mode = 'blocked'
          }
        }
      }
    }

    for (let i = stations.length - 1; i >= 0; i--) {
      const car = this.carWorkingAt(i)
      if (!car || car.mode !== 'blocked') continue
      if (i === stations.length - 1) {
        car.mode = 'done'
        car.station = i
        this.completions.push(this.t)
        const code = carCode(car.id, i)
        this.events.push({ t: this.t, kind: 'exit', text: `${code} passed test, to the yard` })
        if (this.events.length > 14) this.events.splice(0, this.events.length - 14)
        continue
      }
      const dest = i + 1
      if (this.queues[dest].length >= BUFFER) continue
      car.mode = 'traveling'
      car.station = dest
      car.remaining = TRAVEL_SEC
      car.cycle = TRAVEL_SEC
    }

    for (let i = 0; i < stations.length; i++) {
      if (this.carWorkingAt(i)) continue
      if (this.queues[i].length > 0) {
        const id = this.queues[i].shift()
        if (id === undefined) continue
        this.queues[i].forEach((qid, slot) => {
          const queued = this.carById(qid)
          if (queued) queued.slot = slot
        })
        const car = this.carById(id)
        if (!car) continue
        const cycle = stations[i].processSec
        car.mode = 'working'
        car.station = i
        car.remaining = cycle
        car.cycle = cycle
        car.startedAt = this.t
        car.slot = 0
        continue
      }
      if (i === 0) {
        const cycle = stations[0].processSec
        const car = this.makeCar(0, 'working', cycle, cycle)
        car.displayX = stations[0].x - 6
        this.cars.push(car)
      }
    }

    // Drop cars that have left the hall so the list stays small.
    if (this.cars.length > 40) {
      this.cars = this.cars.filter((c) => c.mode !== 'done')
    }

    this.sampleAcc += h
    if (this.sampleAcc >= 0.5) {
      this.sampleAcc = 0
      for (let i = 0; i < stations.length; i++) {
        const occupied = this.carWorkingAt(i) ? 1 : 0
        const bucket = this.busySamples[i]
        bucket.push(occupied)
        if (bucket.length > 120) bucket.shift()
      }
    }
  }
}

export function carCode(id: number, stationIndex: number): string {
  return `S${String(stationIndex + 1).padStart(2, '0')}-${String(id).padStart(5, '0')}`
}

export function formatClock(simSeconds: number): string {
  const total = SHIFT_START + Math.max(0, Math.floor(simSeconds))
  const h = Math.floor(total / 3600) % 24
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(s)}`
}

export function appearanceStage(car: SimCar): number {
  if (car.mode === 'working' || car.mode === 'blocked') return car.station
  if (car.mode === 'done') return 6
  return Math.max(0, car.station - 1)
}

export function targetX(car: SimCar, plan: LinePlan): number {
  const xs = plan.stations.map((s) => s.x)
  if (car.mode === 'working' || car.mode === 'blocked') return xs[car.station]
  if (car.mode === 'done') return xs[xs.length - 1] + 12
  const dest = xs[car.station]
  if (car.mode === 'queued') return dest - 4.6 - car.slot * 3.6
  const prev = xs[Math.max(0, car.station - 1)]
  const end = dest - 4.6
  const u = car.cycle > 0 ? 1 - car.remaining / car.cycle : 1
  return prev + (end - prev) * Math.min(1, Math.max(0, u))
}

/** Demo closeness of a pick to the constraint. 100 when the pick is the slowest station. */
export function demoScore(plan: LinePlan, pick: number): number {
  const best = plan.stations[plan.bottleneck].effectiveSec
  const yours = plan.stations[pick].effectiveSec
  if (best <= 0) return 0
  if (Math.abs(yours - best) < 0.05) return 100
  return Math.max(0, Math.min(100, Math.round((100 * yours) / best)))
}

export function leaderIndex(sim: LineSim): number | null {
  let best = -1
  let bestMean = -1
  sim.intervals.forEach((list, i) => {
    if (list.length < 2) return
    const mean = list.reduce((a, b) => a + b, 0) / list.length
    if (mean > bestMean) {
      bestMean = mean
      best = i
    }
  })
  return best < 0 ? null : best
}

export function round1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1)
}

export function faultLabel(st: StationPlan): string | null {
  if (!st.fault) return null
  const minutes = st.fault.periodSec / 60
  return `stops ~${Math.round(st.fault.stopSec)} s every ${minutes.toFixed(1)} min`
}
