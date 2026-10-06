// LEGENDARY HOST backend. Needs Node 18+.
// ENV: RENDER_API_KEY, OWNER_ID (LEGENDARY HOST workspace id: tea-db2k1mnlot8c739fhisg),
//      LOADER_REPO (public loader repo url), APP_SECRET (long random string),
//      optional: PLAN=free, REGION=oregon, MAX_SERVICES=5, PORT
const express = require('express')
const crypto = require('crypto')
const path = require('path')

const { RENDER_API_KEY, OWNER_ID, LOADER_REPO, APP_SECRET } = process.env
const PLAN = process.env.PLAN || 'free'
const REGION = process.env.REGION || 'oregon'
const MAX = parseInt(process.env.MAX_SERVICES || '5', 10)
if (!RENDER_API_KEY || !OWNER_ID || !LOADER_REPO || !APP_SECRET) {
  console.error('Missing env: RENDER_API_KEY, OWNER_ID, LOADER_REPO, APP_SECRET'); process.exit(1)
}

const app = express()
app.use(express.json({ limit: '20kb' }))
app.use(express.static(path.join(__dirname, 'public')))

// ---------- Render API (always pinned to OWNER_ID) ----------
async function render(method, url, body) {
  const r = await fetch('https://api.render.com/v1' + url, {
    method,
    headers: { Authorization: `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  if (!r.ok) { const e = new Error(`Render ${r.status}`); e.detail = data; throw e }
  return data
}
const unwrap = (x) => x.service || x

async function findByName(name) {
  const list = await render('GET', `/services?name=${encodeURIComponent(name)}&ownerId=${OWNER_ID}&limit=5`)
  const hit = list.map(unwrap).find(s => s.name === name && s.ownerId === OWNER_ID)
  return hit || null
}
async function countServices() {
  const list = await render('GET', `/services?ownerId=${OWNER_ID}&limit=100`)
  return list.map(unwrap).filter(s => s.name.startsWith('lh-')).length
}

// ---------- helpers ----------
const hmac = (s) => crypto.createHmac('sha256', APP_SECRET).update(s).digest('hex')
const nameFor = (sessionId) => 'lh-' + hmac('svc:' + sessionId).slice(0, 14)

function makeToken(serviceId) {
  const p = Buffer.from(JSON.stringify({ s: serviceId, e: Date.now() + 7 * 864e5 })).toString('base64url')
  return p + '.' + hmac('tok:' + p)
}
function readToken(t) {
  const [p, sig] = String(t || '').split('.')
  if (!p || !sig || sig.length !== 64 || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac('tok:' + p)))) return null
  try { const d = JSON.parse(Buffer.from(p, 'base64url')); return d.e > Date.now() ? d.s : null } catch { return null }
}
async function auth(req, res, next) {
  const id = readToken((req.headers.authorization || '').replace('Bearer ', ''))
  if (!id) return res.status(401).json({ error: 'Login again' })
  try {
    const s = unwrap(await render('GET', `/services/${id}`))
    if (s.ownerId !== OWNER_ID || !s.name.startsWith('lh-')) return res.status(403).json({ error: 'Not allowed' })
    req.svc = s; next()
  } catch { res.status(404).json({ error: 'Bot not found' }) }
}

// simple in-memory rate limit: 10 requests / minute / IP on login+deploy
const hits = new Map()
function limit(req, res, next) {
  const k = req.ip, now = Date.now()
  const arr = (hits.get(k) || []).filter(t => now - t < 60000)
  if (arr.length >= 10) return res.status(429).json({ error: 'Too many tries. Wait small.' })
  arr.push(now); hits.set(k, arr); next()
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max)
const noBreaks = (v) => !/[\r\n=]/.test(v)

// ---------- routes ----------
app.post('/api/deploy', limit, async (req, res) => {
  try {
    const b = req.body || {}
    const SESSION_ID = clean(b.sessionId, 4000)
    const OWNER_NUMBER = clean(b.ownerNumber, 20).replace(/\D/g, '')
    const OWNER_NAME = clean(b.ownerName, 30)
    const BOT_NAME = clean(b.botName, 30) || 'LËGĒNDÃRY BØT'
    const PREFIX = clean(b.prefix, 3) || '.'
    const WORKTYPE = b.workType === 'private' ? 'private' : 'public'
    const TIMEZONE = /^[A-Za-z_]+\/[A-Za-z_\-]+$/.test(clean(b.timezone, 40)) ? clean(b.timezone, 40) : 'Africa/Lagos'

    if (!SESSION_ID || OWNER_NUMBER.length < 7 || !OWNER_NAME) return res.status(400).json({ error: 'Fill session ID, owner number and your name' })
    for (const v of [SESSION_ID, OWNER_NAME, BOT_NAME, PREFIX]) if (!noBreaks(v)) return res.status(400).json({ error: 'No new line or = sign allowed for these fields' })

    const name = nameFor(SESSION_ID)
    if (await findByName(name)) return res.status(409).json({ error: 'This session ID don already deploy. Use Login.' })
    if ((await countServices()) >= MAX) return res.status(503).json({ error: 'Slots full for now. Try again later.' })

    const envVars = Object.entries({ SESSION_ID, OWNER_NUMBER, OWNER_NAME, BOT_NAME, PREFIX, WORKTYPE, TIMEZONE })
      .map(([key, value]) => ({ key, value }))
    const out = await render('POST', '/services', {
      type: 'web_service', name, ownerId: OWNER_ID, repo: LOADER_REPO, branch: 'main', autoDeploy: 'no', envVars,
      serviceDetails: { runtime: 'node', plan: PLAN, region: REGION, envSpecificDetails: { buildCommand: 'npm install', startCommand: 'npm start' } }
    })
    const s = unwrap(out)
    res.json({ token: makeToken(s.id), url: s.serviceDetails?.url || `https://${s.slug}.onrender.com` })
  } catch (e) { console.error(e.detail || e); res.status(500).json({ error: 'Deploy fail. Check say loader repo dey public.' }) }
})

app.post('/api/login', limit, async (req, res) => {
  try {
    const sid = clean(req.body?.sessionId, 4000)
    const s = sid && await findByName(nameFor(sid))
    if (!s) return res.status(404).json({ error: 'No bot found for this session ID' })
    res.json({ token: makeToken(s.id) })
  } catch (e) { console.error(e.detail || e); res.status(500).json({ error: 'Login fail' }) }
})

app.get('/api/status', auth, async (req, res) => {
  let deploy = null
  try { const d = await render('GET', `/services/${req.svc.id}/deploys?limit=1`); deploy = (d[0]?.deploy || d[0])?.status || null } catch {}
  res.json({ url: req.svc.serviceDetails?.url, suspended: req.svc.suspended, deploy })
})

app.get('/api/logs', auth, async (req, res) => {
  try {
    const q = `ownerId=${OWNER_ID}&resource=${req.svc.id}&limit=100&direction=backward`
    const d = await render('GET', `/logs?${q}`)
    const lines = (d.logs || []).reverse().map(l => `${(l.timestamp || '').slice(11, 19)} ${l.message}`)
    res.json({ lines })
  } catch (e) { console.error(e.detail || e); res.status(500).json({ error: 'Cannot get logs now' }) }
})

app.post('/api/restart', auth, async (req, res) => {
  try { await render('POST', `/services/${req.svc.id}/restart`); res.json({ ok: true }) }
  catch (e) { console.error(e.detail || e); res.status(500).json({ error: 'Restart fail' }) }
})

app.get('/health', (_, r) => r.send('ok'))
app.listen(process.env.PORT || 3000, () => console.log('LEGENDARY HOST up'))
