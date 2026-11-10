// Free Pterodactyl panel provider (Application API, admin key).
// Creates one server per bot with a memory/disk cap. The panel's own UI
// manages these servers (restart, logs), so this site only deploys them.
const PANEL_URL = (process.env.PANEL_URL || '').replace(/\/$/, '')
const PANEL_KEY = process.env.PANEL_KEY
const NODE_ID = parseInt(process.env.PANEL_NODE_ID || '', 10)
const EGG_ID = parseInt(process.env.PANEL_EGG_ID || '', 10)
const USER_ID = parseInt(process.env.PANEL_USER_ID || '', 10)
const DOCKER_IMAGE = process.env.PANEL_DOCKER_IMAGE || ''
const STARTUP = process.env.PANEL_STARTUP || 'npm start'
const RAM_MB = parseInt(process.env.PANEL_RAM_MB || '1024', 10)
const DISK_MB = parseInt(process.env.PANEL_DISK_MB || '1024', 10)

const enabled = !!(PANEL_URL && PANEL_KEY && NODE_ID && EGG_ID && USER_ID && DOCKER_IMAGE)

async function papi(method, url, body) {
  const r = await fetch(PANEL_URL + '/api/application' + url, {
    method,
    headers: { Authorization: `Bearer ${PANEL_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  let data; try { data = text ? JSON.parse(text) : {} } catch { data = text }
  if (!r.ok) { const e = new Error(`Panel ${r.status}`); e.detail = data; throw e }
  return data
}

// Find one unassigned port on the node (the panel's allocation list).
async function freeAllocation() {
  for (let page = 1; page <= 50; page++) {
    const d = await papi('GET', `/nodes/${NODE_ID}/allocations?per_page=100&page=${page}`)
    const hit = (d.data || []).map(x => x.attributes).find(a => !a.assigned)
    if (hit) return hit.id
    const pg = d.meta?.pagination
    if (!pg || page >= pg.total_pages) break
  }
  return null
}

async function findPanelServer(name) {
  const d = await papi('GET', `/servers?filter[name]=${encodeURIComponent(name)}&per_page=50`)
  const hit = (d.data || []).map(x => x.attributes).find(s => s.name === name)
  return hit || null
}

// Create a capped server. Returns { id, url } or throws (e.g. no free port).
async function createPanelServer({ name, environment }) {
  const alloc = await freeAllocation()
  if (!alloc) throw Object.assign(new Error('no free port'), { full: true })
  const d = await papi('POST', '/servers', {
    name,
    user: USER_ID,
    egg: EGG_ID,
    docker_image: DOCKER_IMAGE,
    startup: STARTUP,
    environment,
    limits: { memory: RAM_MB, swap: 0, disk: DISK_MB, io: 500, cpu: 100, oom_disabled: false },
    feature_limits: { databases: 0, allocations: 1, backups: 0 },
    allocation: { default: alloc },
    start_on_completion: true
  })
  const s = d.attributes || d
  return { id: s.id, url: `${PANEL_URL}/server/${String(s.uuid || '').slice(0, 8)}` }
}

module.exports = { enabled, findPanelServer, createPanelServer, RAM_MB, DISK_MB }
