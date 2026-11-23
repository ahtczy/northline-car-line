import './style.css'
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import {
  appearanceStage,
  buildPlan,
  carCode,
  demoScore,
  faultActive,
  faultLabel,
  formatClock,
  leaderIndex,
  LineSim,
  round1,
  STATIONS,
  targetX,
  type LinePlan,
  type SimCar,
} from './sim/line.ts'
import { applyCarStage, createHall, setRide, type Hall } from './scene/world.ts'

const HOME = { target: new THREE.Vector3(-14, 0.4, -1), distance: 108, azimuth: 0.22, elevation: 0.52 }

type Phase = 'pick' | 'run' | 'reveal'

const viewCanvas = document.querySelector<HTMLCanvasElement>('#view')
if (!viewCanvas) throw new Error('missing canvas')
const canvas: HTMLCanvasElement = viewCanvas

const ui = buildUi()
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

let plan: LinePlan = buildPlan('NORTH')
let sim = new LineSim(plan, true)
let phase: Phase = 'pick'
let pick: number | null = null
let inspect = 0
let speed = 0
let held = 1
let runMark = 0
let stableLeader: number | null = null
let stableFor = 0
let hall: Hall | null = null

const scene = new THREE.Scene()
scene.background = new THREE.Color(0xb7c3ce)
scene.fog = new THREE.Fog(0xb7c3ce, 150, 280)

const camera = new THREE.PerspectiveCamera(35, 1, 0.25, 420)
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true
controls.dampingFactor = 0.08
controls.maxPolarAngle = Math.PI / 2 - 0.05
controls.minDistance = 6
controls.maxDistance = 210
controls.target.copy(HOME.target)
camera.position.copy(pose(HOME.target, HOME.distance, HOME.azimuth, HOME.elevation))
controls.update()

const labelRenderer = new CSS2DRenderer()
labelRenderer.domElement.className = 'labels'
document.getElementById('app')?.append(labelRenderer.domElement)

let fly: { fromP: THREE.Vector3, toP: THREE.Vector3, fromT: THREE.Vector3, toT: THREE.Vector3, u: number } | null = null
controls.addEventListener('start', () => {
  fly = null
})

void boot()

async function boot() {
  const bootEl = document.getElementById('boot')
  const bar = document.getElementById('bootbar')
  const label = document.getElementById('bootlabel')
  try {
    const renderer = new WebGPURenderer({ canvas, antialias: true })
    await renderer.init()
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.64
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))

    scene.add(new THREE.HemisphereLight(0xddd6c8, 0x6f6a60, 0.11))
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.35)
    sun.position.set(-22, 34, 16)
    sun.castShadow = true
    sun.shadow.mapSize.set(4096, 4096)
    const cam = sun.shadow.camera
    cam.left = -78
    cam.right = 58
    cam.top = 18
    cam.bottom = -16
    cam.near = 4
    cam.far = 110
    sun.shadow.bias = -0.00025
    sun.shadow.normalBias = 0.02
    sun.shadow.radius = 1.6
    sun.target.position.set(-12, 0, 0)
    scene.add(sun, sun.target)
    const fill = new THREE.DirectionalLight(0xd7e6f6, 0.06)
    fill.position.set(48, 24, -36)
    scene.add(fill)

    hall = await createHall(scene, (frac, text) => {
      if (bar) bar.style.width = `${Math.round(frac * 100)}%`
      if (label) label.textContent = text
    })

    const query = readQuery()
    applySeed(query.seed, false)
    if (query.pick !== null) lockPick(query.pick)
    resize()
    window.addEventListener('resize', resize)
    if (label) label.textContent = 'Compiling shaders'
    await renderer.compileAsync(scene, camera)
    if (bootEl) bootEl.hidden = true

    let last = performance.now()
    renderer.setAnimationLoop((now: number) => {
      const raw = (now - last) / 1000
      const dt = Math.min(0.25, raw)
      last = now
      stepSim(dt)
      if (hall) {
        syncCars(dt)
        syncActors(now / 1000)
        syncBeacons()
        syncTags()
      }
      stepFly(Math.min(1.2, raw))
      controls.update()
      paint()
      labelRenderer.render(scene, camera)
      renderer.render(scene, camera)
    })
  } catch (err) {
    console.error(err)
    if (label) label.textContent = err instanceof Error ? err.message : 'The 3D view failed to start'
  }
}

function stepSim(dt: number) {
  if (speed <= 0) return
  const before = sim.t
  sim.step(dt * speed)
  const advanced = sim.t - before
  if (phase !== 'run' || pick === null) return
  const leader = leaderIndex(sim)
  if (leader !== null && leader === stableLeader) stableFor += advanced
  else {
    stableLeader = leader
    stableFor = 0
  }
  const watched = sim.t - runMark
  if ((watched > 100 && leader === plan.bottleneck && stableFor > 32) || watched > 190) reveal()
}

function syncCars(dt: number) {
  if (!hall) return
  const active = sim.cars.filter((car) => car.mode !== 'done')
  const k = 1 - Math.exp(-dt * 7)
  hall.cars.forEach((view, index) => {
    const car = active[index]
    if (!car) {
      view.root.visible = false
      return
    }
    view.root.visible = true
    const goal = targetX(car, plan)
    car.displayX += (goal - car.displayX) * k
    const riding = car.mode === 'working' || car.mode === 'blocked' ? car.station : Math.max(0, car.station - 1)
    view.root.position.set(car.displayX, 0, 0)
    setRide(view, riding)
    applyCarStage(view, appearanceStage(car))
  })
}

function syncActors(time: number) {
  if (!hall) return
  for (const cobot of hall.cobots) {
    const down = faultActive(plan.stations[cobot.station].fault, sim.t)
    const car = sim.carWorkingAt(cobot.station)
    const working = !!car && car.mode === 'working' && !down
    const amp = working ? 1 : 0.15
    const tighten = working && cobot.station === 4 ? 1.4 : 1
    swingJoint(cobot.yaw, 'y', Math.sin(time * 1.4 + cobot.phase) * 0.45 * amp)
    swingJoint(cobot.elbow, 'z', Math.sin(time * 2.2 + cobot.phase) * 0.35 * amp)
    swingJoint(cobot.wrist, 'x', Math.sin(time * (working ? 7 : 0.8) * tighten + cobot.phase) * 0.4 * amp)
  }
  for (const worker of hall.workers) {
    const swing = worker.walk && speed > 0 ? Math.sin(time * 2.4 + worker.phase) * 0.35 : Math.sin(time * 0.7 + worker.phase) * 0.03
    swingJoint(worker.legL, 'x', swing)
    swingJoint(worker.legR, 'x', -swing)
    swingJoint(worker.armL, 'x', -swing * 0.6)
    swingJoint(worker.armR, 'x', swing * 0.6)
    if (worker.walk && speed > 0) worker.root.position.x = worker.baseX + Math.sin(time * 0.4 + worker.phase) * 0.65
  }
  for (const truck of hall.forklifts) {
    const span = truck.x1 - truck.x0
    const travel = (time * truck.speed + truck.offset) % (span * 2)
    const forward = travel < span
    truck.root.position.x = forward ? truck.x0 + travel : truck.x1 - (travel - span)
    truck.root.position.z = truck.z
    truck.root.rotation.y = (forward ? 0 : Math.PI) + truck.yaw
  }
}

function swingJoint(obj: THREE.Object3D, axis: 'x' | 'y' | 'z', delta: number) {
  const rest = obj.userData.rest as THREE.Euler | undefined
  if (rest) obj.rotation.copy(rest)
  obj.rotation[axis] += delta
}

function syncBeacons() {
  if (!hall) return
  hall.beacons.forEach((beacon, index) => {
    const down = faultActive(plan.stations[index].fault, sim.t)
    const car = sim.carWorkingAt(index)
    const working = !!car && car.mode === 'working' && !down
    beacon.green.emissiveIntensity = working ? 1.5 : 0.04
    beacon.amber.emissiveIntensity = car && car.mode === 'blocked' ? 1.2 : 0.04
    beacon.red.emissiveIntensity = down ? 1.7 : 0.04
  })
}

function syncTags() {
  if (!hall) return
  hall.tags.forEach((el, index) => {
    el.classList.toggle('is-pick', pick === index)
    el.classList.toggle('is-bn', phase === 'reveal' && plan.bottleneck === index)
    el.classList.toggle('is-down', faultActive(plan.stations[index].fault, sim.t))
  })
}

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  camera.aspect = width / Math.max(1, height)
  camera.updateProjectionMatrix()
  labelRenderer.setSize(width, height)
}

function pose(target: THREE.Vector3, distance: number, azimuth: number, elevation: number) {
  const horiz = distance * Math.cos(elevation)
  return new THREE.Vector3(
    target.x + horiz * Math.sin(azimuth),
    target.y + distance * Math.sin(elevation),
    target.z + horiz * Math.cos(azimuth),
  )
}

function flyTo(target: THREE.Vector3, distance: number, azimuth: number, elevation: number) {
  fly = {
    fromP: camera.position.clone(),
    toP: pose(target, distance, azimuth, elevation),
    fromT: controls.target.clone(),
    toT: target.clone(),
    u: 0,
  }
}

function stepFly(dt: number) {
  if (!fly) return
  fly.u = Math.min(1, fly.u + dt / 1.15)
  const k = fly.u * fly.u * (3 - 2 * fly.u)
  camera.position.lerpVectors(fly.fromP, fly.toP, k)
  controls.target.lerpVectors(fly.fromT, fly.toT, k)
  if (fly.u >= 1) fly = null
}

function stationShot(index: number, close: boolean) {
  const x = plan.stations[index].x
  return {
    target: new THREE.Vector3(x + (close ? 0.4 : 0), close ? 1.05 : 1.1, close ? 0.2 : 0),
    distance: close ? 9.4 : 32,
    azimuth: close ? 0.62 : 0.28,
    elevation: close ? 0.34 : 0.4,
  }
}

function readQuery() {
  const q = new URLSearchParams(location.search)
  const seed = (q.get('seed') || randomSeed()).slice(0, 24)
  const id = q.get('pick')
  const found = STATIONS.findIndex((st) => st.id === id)
  return { seed, pick: found >= 0 ? found : null }
}

function writeUrl() {
  const q = new URLSearchParams()
  q.set('seed', plan.seed)
  if (pick !== null) q.set('pick', plan.stations[pick].id)
  history.replaceState(null, '', `${location.pathname}?${q}`)
}

function randomSeed() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return s
}

function applySeed(seed: string, flyHome = true) {
  plan = buildPlan(seed.slice(0, 24) || randomSeed())
  sim = new LineSim(plan, true)
  phase = 'pick'
  pick = null
  speed = 0
  runMark = 0
  stableLeader = null
  stableFor = 0
  inspect = 0
  hall?.relayoutCrew(plan)
  ui.verdict.hidden = true
  ui.banner.hidden = false
  writeUrl()
  ui.seed.value = plan.seed
  if (flyHome) flyTo(HOME.target, HOME.distance, HOME.azimuth, HOME.elevation)
}

function lockPick(index: number) {
  pick = index
  inspect = index
  phase = 'run'
  speed = 10
  held = 10
  runMark = sim.t
  stableLeader = null
  stableFor = 0
  ui.verdict.hidden = true
  ui.banner.hidden = false
  writeUrl()
  const shot = stationShot(index, true)
  flyTo(shot.target, shot.distance, shot.azimuth, shot.elevation)
}

function onStation(index: number) {
  inspect = index
  ui.inspect.hidden = false
  if (phase === 'pick') lockPick(index)
  else {
    const shot = stationShot(index, true)
    flyTo(shot.target, shot.distance, shot.azimuth, shot.elevation)
  }
}

function reveal() {
  if (phase === 'reveal' || pick === null) return
  phase = 'reveal'
  const shot = stationShot(plan.bottleneck, false)
  flyTo(shot.target, shot.distance, shot.azimuth, shot.elevation)
  ui.banner.hidden = true
  fillVerdict()
  ui.verdict.hidden = false
}

function fillVerdict() {
  if (pick === null) return
  const bn = plan.stations[plan.bottleneck]
  const chosen = plan.stations[pick]
  const hit = pick === plan.bottleneck
  ui.vSeed.textContent = `SHIFT RESULT · ${plan.seed}`
  ui.vTitle.textContent = hit ? `You picked ${chosen.name}.` : `You picked ${chosen.name}.`
  ui.vTitle.className = hit ? 'hit' : 'miss'
  ui.vSub.textContent = hit
    ? `That is the bottleneck: ${Math.round(bn.effectiveSec)} s per car.`
    : `The bottleneck was ${bn.name}: ${Math.round(bn.effectiveSec)} s per car.`
  ui.vWhy.textContent = reason(bn)
  const fault = plan.stations.find((st) => st.kind === 'fault')
  ui.vFault.textContent = fault ? `${fault.name} robot: ${faultLabel(fault) ?? ''}.` : ''
  ui.vRate.textContent = `${round1(plan.linePerHour)} /h`
  ui.vRateNote.textContent = `line rate · plan ${Math.round(plan.planPerHour)}`
  ui.vCars.textContent = String(plan.shiftCars)
  ui.vCarsNote.textContent = `cars in 8 h · plan ${plan.planCars}`
  ui.vPick.textContent = `${Math.round(chosen.effectiveSec)} s`
  ui.vPickNote.textContent = `at ${chosen.name}, your pick`
  ui.vScore.textContent = String(demoScore(plan, pick))
  ui.verdict.hidden = false
}

function reason(st: LinePlan['stations'][number]) {
  if (st.kind === 'op') {
    return `${st.name} plans ${Math.round(st.plannedSec)} s a car, but one of its ${st.crewNominal} operators is out: ${Math.round(st.effectiveSec)} s a car.`
  }
  if (st.kind === 'fault') {
    return `${st.name} plans ${Math.round(st.plannedSec)} s a car, and its robot ${faultLabel(st)}: about ${Math.round(st.effectiveSec)} s a car.`
  }
  return `${st.name} holds its plan of ${Math.round(st.plannedSec)} s a car.`
}

function paint() {
  ui.clock.textContent = formatClock(sim.t)
  ui.speedButtons.forEach((button) => {
    button.classList.toggle('on', Number(button.dataset.speed) === speed)
  })
  ui.carsNow.textContent = `${sim.exits()} of ${plan.planCars}`
  ui.rate.textContent = phase === 'reveal' ? `${round1(plan.linePerHour)}` : String(Math.round(plan.planPerHour))
  ui.rateNote.textContent = phase === 'reveal' ? `simulated · plan ${Math.round(plan.planPerHour)}` : 'plan /h · measuring'
  ui.waiting.textContent = String(sim.carsWaiting())
  const bn = plan.stations[plan.bottleneck]
  ui.bnName.textContent = phase === 'reveal' ? bn.name : '?'
  ui.bnNote.textContent = phase === 'reveal' ? `${Math.round(bn.effectiveSec)} s a car · simulated` : phase === 'run' ? 'line is running' : 'make your pick'
  ui.bnCard.classList.toggle('is-alert', phase === 'reveal')

  ui.bannerTitle.textContent = phase === 'run' ? `Running the shift at ${speed}×` : 'Which station will be the bottleneck?'
  ui.bannerZh.textContent = phase === 'run' ? '寻找一直忙不完的工位。' : '哪一工位会成为瓶颈？'
  ui.bannerBody.textContent = phase === 'run'
    ? 'Look for the station that keeps the upstream cars waiting.'
    : 'Click one of the 7 stations, then watch the shift at 10×.'

  plan.stations.forEach((st, index) => {
    const card = ui.cards[index]
    const car = sim.carWorkingAt(index)
    const down = faultActive(st.fault, sim.t)
    card.root.classList.toggle('is-pick', pick === index)
    card.root.classList.toggle('is-bn', phase === 'reveal' && plan.bottleneck === index)
    card.root.classList.toggle('is-down', down)
    card.status.textContent = down ? 'ROBOT DOWN' : !car ? 'WAITING' : car.mode === 'blocked' ? 'BLOCKED' : 'WORKING'
    card.crew.textContent = st.kind === 'op' ? `${st.crewPresent} of ${st.crewNominal} operators` : `${st.crewPresent} operators`
    card.robots.textContent = st.robots ? `${st.robots} robot${st.robots > 1 ? 's' : ''}` : 'no robots'
    card.fault.textContent = st.kind === 'fault' ? (faultLabel(st) ?? '') : pick === index ? 'your pick' : ''
    const busy = Math.round(sim.busyFraction(index) * 100)
    card.bar.style.width = `${busy}%`
  })
  paintInspect()
}

function paintInspect() {
  const st = plan.stations[inspect]
  const car = sim.carWorkingAt(inspect)
  const down = faultActive(st.fault, sim.t)
  ui.iKicker.textContent = `${String(inspect + 1).padStart(2, '0')} · ${st.nameZh}`
  ui.iTitle.textContent = st.name
  ui.iBlurb.textContent = st.blurb
  ui.iChip.textContent = down ? 'Robot down' : !car ? 'Waiting for a car' : car.mode === 'blocked' ? 'Waiting to move' : 'Working'
  ui.iChip.className = `chip${down ? ' down' : !car || car.mode === 'blocked' ? ' wait' : ''}`
  ui.iCar.textContent = car ? carCode(car.id, inspect) : 'No car in the station'
  const progress = progressOf(car)
  ui.iMeter.style.width = `${progress}%`
  ui.iPlan.textContent = `${Math.round(st.plannedSec)} s a car`
  ui.iCrew.textContent = st.kind === 'op' ? `${st.crewPresent} of ${st.crewNominal}, one out sick` : `${st.crewPresent} of ${st.crewNominal}`
  ui.iRobots.textContent = st.robots ? `${st.robots} on the station` : 'none'
  ui.iFault.textContent = st.kind === 'fault' ? (faultLabel(st) ?? '') : 'none here'
  ui.iBusy.textContent = `${Math.round(sim.busyFraction(inspect) * 100)}%`
  ui.iDone.textContent = String(sim.finished[inspect] ?? 0)
  ui.iEffect.textContent = phase === 'reveal' ? `${Math.round(st.effectiveSec)} s effective` : 'hidden until the reveal'
}

function progressOf(car: SimCar | undefined) {
  if (!car) return 0
  if (car.mode === 'blocked') return 100
  if (car.mode !== 'working' || car.cycle <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((1 - car.remaining / car.cycle) * 100)))
}

function dolly(factor: number) {
  fly = null
  const offset = camera.position.clone().sub(controls.target)
  const next = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance)
  offset.setLength(next)
  camera.position.copy(controls.target).add(offset)
}

function buildUi() {
  const top = must('#top')
  top.innerHTML = `
    <div class="brand">
      <svg class="mark" viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" rx="9" fill="#102033"/><g fill="#8fd0b0"><rect x="6" y="20" width="3.2" height="8" rx="1"/><rect x="11.2" y="16" width="3.2" height="12" rx="1"/><rect x="16.4" y="18" width="3.2" height="10" rx="1"/><rect x="21.6" y="9" width="3.2" height="19" rx="1" fill="#f0a05a"/><rect x="26.8" y="15" width="3.2" height="13" rx="1"/></g></svg>
      <div><b>Northline</b><span>Final assembly lab</span></div>
    </div>
    <div class="kpi"><em>Cars this shift</em><strong data-k="cars">0 of 464</strong><small>finished test · 8 h plan</small></div>
    <div class="kpi"><em>Cars per hour</em><strong data-k="rate">58</strong><small data-k="rateNote">plan /h · measuring</small></div>
    <div class="kpi"><em>Cars waiting</em><strong data-k="wait">0</strong><small>done, waiting on the next station</small></div>
    <div class="kpi" id="bn-card"><em>Bottleneck</em><strong data-k="bn">?</strong><small data-k="bnNote">make your pick</small></div>
    <div class="spacer"></div>
    <div class="plant">
      <b>Bay A · final assembly</b>
      <span>Straight line · 7 stations · shift 06:00–14:00</span>
      <label class="seedrow">Seed <input id="seed" maxlength="24" spellcheck="false" /> <button id="apply-seed" type="button">Apply</button></label>
    </div>`

  const banner = must('#banner')
  banner.innerHTML = `<div class="sheet"><h1 data-b="title"></h1><p><span class="zh" data-b="zh"></span><span data-b="body"></span></p></div>`

  const inspectEl = must('#inspect')
  inspectEl.hidden = false
  inspectEl.innerHTML = `
    <div class="kicker" data-i="kicker"></div>
    <h2 data-i="title"></h2>
    <div class="blurb" data-i="blurb"></div>
    <div class="chip" data-i="chip"></div>
    <div class="rows">
      <span>Car</span><b data-i="car"></b>
      <span>Planned time</span><b data-i="plan"></b>
      <span>Crew</span><b data-i="crew"></b>
      <span>Robots</span><b data-i="robots"></b>
      <span>Robot fault</span><b data-i="fault"></b>
      <span>Busy this shift</span><b data-i="busy"></b>
      <span>Cars finished here</span><b data-i="done"></b>
      <span>Effective cycle</span><b data-i="effect"></b>
    </div>
    <div class="meter"><i data-i="meter"></i></div>`

  const dock = must('#dock')
  const cards = STATIONS.map((st, index) => {
    const button = document.createElement('button')
    button.className = 'card'
    button.type = 'button'
    button.innerHTML = `
      <header><span>${String(index + 1).padStart(2, '0')}</span><span data-c="status">READY</span></header>
      <b>${st.name}</b>
      <div class="zh">${st.nameZh}</div>
      <div class="stat">${Math.round(st.plannedSec)} s a car planned</div>
      <div class="stat" data-c="crew"></div>
      <div class="stat" data-c="robots"></div>
      <div class="fault" data-c="fault"></div>
      <div class="bar"><i data-c="bar"></i></div>`
    button.addEventListener('click', () => onStation(index))
    dock.append(button)
    return {
      root: button,
      status: button.querySelector<HTMLElement>('[data-c="status"]')!,
      crew: button.querySelector<HTMLElement>('[data-c="crew"]')!,
      robots: button.querySelector<HTMLElement>('[data-c="robots"]')!,
      fault: button.querySelector<HTMLElement>('[data-c="fault"]')!,
      bar: button.querySelector<HTMLElement>('[data-c="bar"]')!,
    }
  })

  const transport = must('#transport')
  transport.innerHTML = `
    <button type="button" data-speed="0" aria-label="Pause">❚❚</button>
    <button type="button" data-speed="1">1×</button>
    <button type="button" data-speed="2">2×</button>
    <button type="button" data-speed="5">5×</button>
    <button type="button" data-speed="10">10×</button>
    <span class="clock" data-k="clock">06:00:00</span>`
  const speedButtons = [...transport.querySelectorAll<HTMLButtonElement>('button')]
  speedButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const next = Number(button.dataset.speed)
      speed = next
      if (next > 0) held = next
    })
  })

  const cams = must('#camtools')
  cams.innerHTML = `
    <button type="button" id="zoom-in" aria-label="Zoom in">+</button>
    <button type="button" id="zoom-out" aria-label="Zoom out">−</button>
    <button type="button" id="home" aria-label="Home camera">⌂</button>`
  document.getElementById('zoom-in')?.addEventListener('click', () => dolly(0.78))
  document.getElementById('zoom-out')?.addEventListener('click', () => dolly(1.28))
  document.getElementById('home')?.addEventListener('click', () => {
    flyTo(HOME.target, HOME.distance, HOME.azimuth, HOME.elevation)
  })

  const credit = must('#credit')
  credit.innerHTML = `3D models: NVIDIA SimReady (CC BY 4.0), via <a href="https://huggingface.co/datasets/codepawl/simready-glb" target="_blank" rel="noreferrer">codepawl/simready-glb</a> and <a href="https://huggingface.co/datasets/nvidia/simready-assets" target="_blank" rel="noreferrer">nvidia/simready-assets</a>. Crew: MakeHuman (CC0). Coveralls: Elvaerwyn (CC BY). Independent recreation, not an Airsup product. <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a> · <button type="button" id="open-credits">Credits</button>`

  const verdict = must('#verdict')
  verdict.innerHTML = `
    <div class="sheet">
      <div class="score"><b data-v="score">0</b><span>demo score<br>for this seed</span></div>
      <div class="kicker" data-v="seed"></div>
      <h2 data-v="title"></h2>
      <p class="why" data-v="sub"></p>
      <p class="why" data-v="why"></p>
      <p class="why" data-v="fault"></p>
      <div class="stats">
        <div><b data-v="rate"></b><span data-v="rateNote"></span></div>
        <div><b data-v="cars"></b><span data-v="carsNote"></span></div>
        <div><b data-v="pick"></b><span data-v="pickNote"></span></div>
      </div>
      <p class="why">These rates are the simulated steady state for this seed (7,200 s window, mean departure interval over the last 600 s). There is no player leaderboard.</p>
      <div class="actions">
        <button class="ghost" type="button" id="copy">Copy link</button>
        <button type="button" id="next">Next line</button>
      </div>
    </div>`

  const credits = must('#credits-dialog')
  credits.innerHTML = `
    <div class="sheet">
      <h2>Credits</h2>
      <p>3D models are NVIDIA SimReady, CC BY 4.0. The packaged hall, car, AGV, cobot, and crane filenames are not in the Hugging Face GLB set (those URLs 404). They are the public static mirror of the same assets, credited to <a href="https://huggingface.co/datasets/codepawl/simready-glb">codepawl/simready-glb</a> and <a href="https://huggingface.co/datasets/nvidia/simready-assets">nvidia/simready-assets</a>. Wheels are tire plus rim. tank.glb and wheels.glb are not available.</p>
      <p>Crew bodies are MakeHuman (CC0). Coveralls are Elvaerwyn (CC BY).</p>
      <p>This is an independent recreation of the public final-assembly lab. It is not an Airsup product.</p>
      <p><a href="https://creativecommons.org/licenses/by/4.0/">creativecommons.org/licenses/by/4.0</a></p>
      <div class="actions"><button class="ghost" type="button" id="close-credits">Close</button></div>
    </div>`

  document.getElementById('open-credits')?.addEventListener('click', () => {
    credits.hidden = false
  })
  document.getElementById('close-credits')?.addEventListener('click', () => {
    credits.hidden = true
  })
  document.getElementById('copy')?.addEventListener('click', async () => {
    writeUrl()
    const url = location.href
    try {
      await navigator.clipboard.writeText(url)
      const button = document.getElementById('copy')
      if (button) button.textContent = 'Copied'
    } catch {
      window.prompt('Copy this link', url)
    }
  })
  document.getElementById('next')?.addEventListener('click', () => applySeed(randomSeed()))
  const seed = must<HTMLInputElement>('#seed')
  document.getElementById('apply-seed')?.addEventListener('click', () => applySeed(seed.value))
  seed.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applySeed(seed.value)
  })

  let downX = 0
  let downY = 0
  canvas?.addEventListener('pointerdown', (event) => {
    downX = event.clientX
    downY = event.clientY
  })
  canvas?.addEventListener('pointerup', (event) => {
    if (!hall) return
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > 6) return
    const rect = canvas.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const hits = raycaster.intersectObjects(hall.pickables, false)
    if (!hits.length) return
    const index = hits[0].object.userData.station
    if (typeof index === 'number') onStation(index)
  })

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return
    if (event.code === 'Space') {
      event.preventDefault()
      speed = speed === 0 ? held : 0
    } else if (event.key === '1') speed = held = 1
    else if (event.key === '2') speed = held = 2
    else if (event.key === '5') speed = held = 5
    else if (event.key === '0') speed = held = 10
    else if (event.key === 'h' || event.key === 'H') flyTo(HOME.target, HOME.distance, HOME.azimuth, HOME.elevation)
  })

  return {
    seed,
    banner,
    verdict,
    clock: must('[data-k="clock"]'),
    carsNow: must('[data-k="cars"]'),
    rate: must('[data-k="rate"]'),
    rateNote: must('[data-k="rateNote"]'),
    waiting: must('[data-k="wait"]'),
    bnName: must('[data-k="bn"]'),
    bnNote: must('[data-k="bnNote"]'),
    bnCard: must('#bn-card'),
    bannerTitle: must('[data-b="title"]'),
    bannerZh: must('[data-b="zh"]'),
    bannerBody: must('[data-b="body"]'),
    speedButtons,
    cards,
    inspect: inspectEl,
    iKicker: must('[data-i="kicker"]'),
    iTitle: must('[data-i="title"]'),
    iBlurb: must('[data-i="blurb"]'),
    iChip: must('[data-i="chip"]'),
    iCar: must('[data-i="car"]'),
    iPlan: must('[data-i="plan"]'),
    iCrew: must('[data-i="crew"]'),
    iRobots: must('[data-i="robots"]'),
    iFault: must('[data-i="fault"]'),
    iBusy: must('[data-i="busy"]'),
    iDone: must('[data-i="done"]'),
    iEffect: must('[data-i="effect"]'),
    iMeter: must('[data-i="meter"]'),
    vSeed: must('[data-v="seed"]'),
    vTitle: must('[data-v="title"]'),
    vSub: must('[data-v="sub"]'),
    vWhy: must('[data-v="why"]'),
    vFault: must('[data-v="fault"]'),
    vRate: must('[data-v="rate"]'),
    vRateNote: must('[data-v="rateNote"]'),
    vCars: must('[data-v="cars"]'),
    vCarsNote: must('[data-v="carsNote"]'),
    vPick: must('[data-v="pick"]'),
    vPickNote: must('[data-v="pickNote"]'),
    vScore: must('[data-v="score"]'),
  }
}

function must<T extends Element = HTMLElement>(sel: string): T {
  const node = document.querySelector<T>(sel)
  if (!node) throw new Error(`missing ${sel}`)
  return node
}
