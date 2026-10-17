// Прогон стенда с хоста: весь путь MCP-клиента и страница администратора — против подставного портала.
//   node stand/try.mjs            (сервер стенда на http://localhost:3000)
import { createHash, randomBytes } from 'node:crypto'

const BASE = process.env.MCP_URL || 'http://localhost:3000'
const FAKE = process.env.FAKE_URL || 'http://localhost:8090'
const REDIRECT = 'http://localhost:6274/callback'
const b64 = b => b.toString('base64url')
const step = (s) => console.log(`\n▶ ${s}`)
const as = async user => fetch(`${FAKE}/_state`, { method: 'POST', body: JSON.stringify({ user }) })
const back = (state, cookie) => {
  const u = new URL(`${BASE}/oauth/callback`)
  u.searchParams.set('code', `b24code-${Date.now()}`)
  u.searchParams.set('state', state)
  u.searchParams.set('server_domain', new URL(FAKE).host)
  return fetch(u, { redirect: 'manual', headers: { cookie } })
}

async function adminSave(form) {
  await as(1)
  const r = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'portal=stand.bitrix24.by' })
  const state = new URL(r.headers.get('location')).searchParams.get('state')
  const r2 = await back(state, r.headers.getSetCookie().find(c => c.startsWith('mcp_admin_login=')).split(';')[0])
  const cookie = r2.headers.getSetCookie().find(c => c.startsWith('mcp_admin=')).split(';')[0]
  const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text())[1]
  const s = await fetch(`${BASE}/admin/save`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...form }) })
  console.log(`  сохранение: ${s.status}`)
}

async function login(user) {
  await as(user)
  const reg = await (await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'stand', redirect_uris: [REDIRECT] }) })).json()
  const verifier = b64(randomBytes(32))
  const a = new URL(`${BASE}/oauth/authorize`)
  for (const [k, v] of Object.entries({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: b64(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })) a.searchParams.set(k, v)
  const r = await fetch(a)
  const txn = /name="txn" value="([^"]+)"/.exec(await r.text())[1]
  const cookie = r.headers.get('set-cookie').split(';')[0]
  const c = await fetch(`${BASE}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ txn, decision: 'allow', portal: 'stand.bitrix24.by' }) })
  const to = new URL((await back(new URL(c.headers.get('location')).searchParams.get('state'), cookie)).headers.get('location'))
  if (!to.searchParams.get('code')) return console.log(`  сотрудник ${user}: ${to.searchParams.get('error')} — ${to.searchParams.get('error_description')}`)
  const t = await (await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: to.searchParams.get('code'), client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) })).json()
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  const text = await res.text()
  const line = text.split('\n').find(l => l.startsWith('data: '))
  const body = JSON.parse(line ? line.slice(6) : text)
  if (!body.result) return console.log(`  сотрудник ${user}: /mcp ответил ${res.status} ${text.slice(0, 200)}`)
  console.log(`  сотрудник ${user}: вошёл, инструменты: ${body.result.tools.map(x => x.name).join(', ')}`)
}

step('ничего не настроено: сотрудник 7 — отказ, администратор 1 — вход')
await login(7)
await login(1)
step('администратор открывает U7 и модуль shef.mcp.tools')
await adminSave({ use: 'U7', write: '', manifests: 'shef.mcp.tools', group_crm: '1', group_tasks: '1', group_calendar: '1', group_kb: '1', group_messages: '1', group_worktime: '1', group_disk: '1', group_catalog: '1', group_calls: '1', group_modules: '1' })
await login(7)
await login(8)
console.log('\nГотово. Страница настроек: ' + `${BASE}/admin`)
