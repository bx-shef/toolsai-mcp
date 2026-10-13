// Живое наблюдение: как MCP-сервер ведёт себя на настоящем портале.
// Собранный сервер (.output) ходит в «портал-посредник»: OAuth подставной, а /rest/* уходит
// на ТЕСТОВЫЙ портал через входящий вебхук из .env.b24test (в git не попадает).
// Засевает данные с меткой прогона, проходит вход как MCP-клиент, зовёт каждый инструмент
// и пишет протокол в smoke/out/. Запуск: npm run build && node smoke/observe.mjs
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const env = Object.fromEntries(readFileSync('.env.b24test', 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const HOOK = env.B24TEST_WEBHOOK
// Страж: только облачный тестовый портал по вебхуку, не боевой stuttgart
if (!/^https:\/\/b24-[a-z0-9]+\.bitrix24\.[a-z]+\/rest\/\d+\/[a-z0-9]+\/$/.test(HOOK || '')) throw new Error('B24TEST_WEBHOOK is not a test-portal webhook')
const hide = s => String(s).replaceAll(HOOK, '<webhook>/')
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.error(hide(e?.stack ?? e)); process.exit(1) })
const RUN = `mcp-smoke-${Date.now().toString(36)}`
const PORT = 3921, BASE = `http://127.0.0.1:${PORT}`, REDIRECT = 'http://localhost:6274/callback'
const log = []
const note = (...a) => { const s = hide(a.join(' ')); log.push(s); console.log(s) }

// Ошибки fetch несут адрес (с секретом вебхука) в cause — наружу отдаём без него.
async function post(method, params) {
  try { return await fetch(HOOK + method + '.json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }) }
  catch { throw new Error(`${method}: network error`) }
}
async function hook(method, params = {}) {
  const r = await post(method, params)
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error} ${j.error_description || ''}`)
  return j
}

// --- портал-посредник ---
const portalCalls = []
let expireNext = false
let n = 0
const tokens = new Set()
const proxy = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let raw = ''
  for await (const c of req) raw += c
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (url.pathname === '/oauth/token/') {
    const at = `at${++n}`; tokens.add(at)
    portalCalls.push({ kind: 'oauth', grant: url.searchParams.get('grant_type') })
    return send(200, { access_token: at, refresh_token: `rt${n}`, expires_in: 3600, member_id: 'smoke', user_id: 1 })
  }
  if (url.pathname.startsWith('/rest/')) {
    const ct = req.headers['content-type'] || ''
    const p = ct.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw))
    const auth = p.auth ?? url.searchParams.get('auth')
    delete p.auth
    const method = url.pathname.slice(6).replace(/\.json$/, '')
    const rec = { kind: 'rest', method, contentType: ct.split(';')[0], params: p, t0: Date.now() }
    portalCalls.push(rec)
    if (!tokens.has(auth)) { rec.status = 401; return send(401, { error: 'invalid_token' }) }
    if (expireNext) { expireNext = false; tokens.delete(auth); rec.status = 401; rec.note = 'смоделирован expired_token'; return send(401, { error: 'expired_token', error_description: 'The access token provided has expired.' }) }
    let r
    try { r = await post(method, p) }
    catch { rec.status = 502; return send(502, { error: 'proxy_error' }) }
    const text = await r.text()
    rec.status = r.status; rec.ms = Date.now() - rec.t0
    res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(text)
  }
  send(404, {})
})
await new Promise(r => proxy.listen(0, '127.0.0.1', r))
const FAKE = `http://127.0.0.1:${proxy.address().port}`

// --- засев ---
note(`# Живой прогон ${RUN}`)
note(`\n> Last reviewed: ${new Date().toISOString().slice(0, 10)}\n`)
let company, contact, lead, deal, task, activity

// --- сервер ---
let srvLog = ''
const app = spawn(process.execPath, ['.output/server/index.mjs'], { env: {
  PATH: process.env.PATH, PORT: String(PORT), HOST: '127.0.0.1', PUBLIC_URL: BASE,
  B24_PORTAL_URL: FAKE, B24_OAUTH_SERVERS: FAKE, B24_CLIENT_ID: 'local.smoke', B24_CLIENT_SECRET: 'sec',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), ALLOWED_USERS: '*',
} })
app.stdout.on('data', d => { srvLog += d }); app.stderr.on('data', d => { srvLog += d })
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break } catch {} await new Promise(r => setTimeout(r, 100)) }

try {
  company = (await hook('crm.company.add', { fields: { TITLE: `${RUN} Компания` } })).result
  contact = (await hook('crm.contact.add', { fields: { NAME: 'Иван', LAST_NAME: RUN, COMPANY_ID: company } })).result
  lead = (await hook('crm.lead.add', { fields: { TITLE: `${RUN} Лид` } })).result
  deal = (await hook('crm.deal.add', { fields: { TITLE: `${RUN} Сделка`, OPPORTUNITY: 1500, CURRENCY_ID: 'BYN', COMPANY_ID: company, CONTACT_ID: contact } })).result
  task = (await hook('tasks.task.add', { fields: { TITLE: `${RUN} Задача`, RESPONSIBLE_ID: 1, UF_CRM_TASK: [`D_${deal}`] } })).result.task.id
  activity = (await hook('crm.activity.todo.add', { ownerTypeId: 2, ownerId: deal, title: `${RUN} Дело`, deadline: new Date(Date.now() + 864e5).toISOString() })).result?.id
  note(`Засеяно: компания ${company}, контакт ${contact}, лид ${lead}, сделка ${deal}, задача ${task}, дело ${activity}`)
  // --- вход как MCP-клиент ---
  const reg = await (await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'smoke', redirect_uris: [REDIRECT] }) })).json()
  const verifier = randomBytes(32).toString('base64url')
  const au = new URL(`${BASE}/oauth/authorize`)
  Object.entries({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's' }).forEach(([k, v]) => au.searchParams.set(k, v))
  const r0 = await fetch(au, { redirect: 'manual' })
  const cookie = r0.headers.get('set-cookie').split(';')[0]
  const txn = /name="txn" value="([^"]+)"/.exec(await r0.text())[1]
  const r1 = await fetch(`${BASE}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ txn, decision: 'allow' }) })
  const st = new URL(r1.headers.get('location')).searchParams.get('state')
  const cb = new URL(`${BASE}/oauth/callback`); cb.searchParams.set('code', 'b24code-x'); cb.searchParams.set('state', st); cb.searchParams.set('server_domain', new URL(FAKE).host)
  const r2 = await fetch(cb, { redirect: 'manual', headers: { cookie } })
  const code = new URL(r2.headers.get('location')).searchParams.get('code')
  const tok = await (await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) })).json()
  note(`Вход: согласие ${r1.status}, возврат ${r2.status}, токен ${tok.access_token ? 'выдан' : 'НЕТ'} (живёт ${tok.expires_in} с)`)

  let id = 0
  const mcp = async (method, params = {}) => {
    const t0 = Date.now()
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    const text = await r.text(); const d = text.split('\n').find(l => l.startsWith('data: '))
    return { status: r.status, ms: Date.now() - t0, body: d ? JSON.parse(d.slice(6)) : JSON.parse(text) }
  }
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  note(`\n## initialize → ${init.status}, сервер ${JSON.stringify(init.body.result?.serverInfo)}, протокол ${init.body.result?.protocolVersion}`)
  const list = await mcp('tools/list')
  note(`\n## tools/list → ${list.status}, ${list.body.result.tools.length} инструментов`)
  for (const t of list.body.result.tools) note(`- ${t.name}: ${t.description} | вход: ${Object.keys(t.inputSchema.properties || {}).join(', ') || '—'} | readOnly=${t.annotations?.readOnlyHint}`)

  const cases = [
    ['user_current', {}],
    ['crm_deal_get', { id: deal }],
    ['crm_deal_list', { filter: { '%TITLE': RUN } }],
    ['crm_lead_get', { id: lead }],
    ['crm_contact_get', { id: contact }],
    ['crm_company_get', { id: company }],
    ['crm_activity_list', { ownerType: 'deal', ownerId: deal }],
    ['task_list', { filter: { '%TITLE': RUN } }],
    ['task_get', { id: task }, 'ID строкой, как его отдаёт task_list'],
    ['task_get', { id: 999999 }, 'нет такой задачи'],
    ['crm_deal_get', { id: 999999999 }, 'нет такой сделки'],
    ['crm_deal_get', { id: -1 }, 'неверный аргумент'],
    ['crm_deal_get', { id: deal }, 'access истёк на портале', () => { expireNext = true }],
  ]
  for (const [name, args, why, before] of cases) {
    before?.()
    const from = portalCalls.length
    const r = await mcp('tools/call', { name, arguments: args })
    const res = r.body.result, text = res?.content?.[0]?.text ?? JSON.stringify(r.body.error)
    note(`\n## ${name} ${JSON.stringify(args)}${why ? ` — ${why}` : ''}`)
    note(`HTTP ${r.status}, ${r.ms} мс, isError=${!!res?.isError}, ответ ${text.length} символов`)
    for (const c of portalCalls.slice(from)) note(`  портал: ${c.kind === 'oauth' ? `oauth ${c.grant}` : `${c.method} [${c.contentType}] ${JSON.stringify(c.params)} → ${c.status}${c.ms != null ? ` за ${c.ms} мс` : ''}${c.note ? ` (${c.note})` : ''}`}`)
    note('```\n' + (text.length > 1200 ? text.slice(0, 1200) + '\n… (обрезано)' : text) + '\n```')
  }
  note('\n## Журнал сервера (audit)')
  for (const l of srvLog.split('\n').filter(l => l.includes('"audit"'))) note('    ' + l)
} finally {
  app.kill(); proxy.close()
  for (const [m, p] of [['crm.activity.delete', { id: activity }], ['tasks.task.delete', { taskId: task }], ['crm.deal.delete', { id: deal }], ['crm.lead.delete', { id: lead }], ['crm.contact.delete', { id: contact }], ['crm.company.delete', { id: company }]]) {
    if (p.id ?? p.taskId) await hook(m, p).catch(e => note(`уборка ${m}: ${e.message}`))
  }
  note(`\nУборка: засеянное удалено.`)
  mkdirSync('smoke/out', { recursive: true })
  writeFileSync(`smoke/out/${RUN}.md`, log.join('\n') + '\n')
}
