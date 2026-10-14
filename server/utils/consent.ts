import type { H3Event } from 'h3'
import { portalHost } from '../lib/config'
import { LOGIN_COOKIE } from '../lib/oauth'

/** Последний портал, в который входили с этого браузера: только подсказка для поля, не доверие. */
export const PORTAL_COOKIE = 'mcp_portal'

export function setPortalCookie(event: H3Event, input: string) {
  const host = portalHost(input)
  if (!host) return
  const u = new URL(useServices().cfg.publicUrl)
  setCookie(event, PORTAL_COOKIE, host, {
    httpOnly: true,
    secure: u.protocol === 'https:',
    sameSite: 'lax',
    path: `${u.pathname.replace(/\/$/, '')}/oauth`,
    maxAge: 365 * 24 * 3600,
  })
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!))

/** Cookie входа: только на пути /oauth этого сервера, недоступна скриптам, живёт как вход. */
export function setLoginCookie(event: H3Event, txn: string) {
  const { cfg } = useServices()
  const u = new URL(cfg.publicUrl)
  setCookie(event, LOGIN_COOKIE, txn, {
    httpOnly: true,
    secure: u.protocol === 'https:',
    sameSite: 'lax', // возврат с портала — переход верхнего уровня GET: Lax cookie отдаёт
    path: `${u.pathname.replace(/\/$/, '')}/oauth`,
    maxAge: 600,
  })
}

/** Экран согласия: кто просит доступ и куда уйдёт код. Без внешних ресурсов и скриптов. */
export function consentPage(txn: string, clientName: string, redirectHost: string, action: string, portal = '') {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Доступ к Битрикс24</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}
.b{display:inline-block;padding:.6rem 1.2rem;margin:.3rem .5rem 0 0;border:1px solid #888;border-radius:.4rem;background:#fff;font-size:1rem;cursor:pointer}
.ok{background:#2fc6f6;border-color:#2fc6f6;color:#fff}code{background:#f2f2f2;padding:0 .2rem}
.i{width:100%;box-sizing:border-box;padding:.5rem;margin-top:.3rem;font-size:1rem;border:1px solid #888;border-radius:.4rem}</style></head><body>
<h1>Подключить ИИ к Битрикс24?</h1>
<p>Приложение <b>${esc(clientName)}</b> просит читать CRM и задачи вашего Битрикс24 <b>от вашего имени</b> и в рамках ваших прав.</p>
<p>Ответ уйдёт на адрес <code>${esc(redirectHost)}</code>. Если вы не начинали подключение сами — откажите.</p>
<form method="post" action="${esc(action)}"><input type="hidden" name="txn" value="${esc(txn)}">
<p><label>Адрес вашего Битрикс24<br><input class="i" name="portal" value="${esc(portal)}" placeholder="mycompany.bitrix24.by" autocomplete="url" inputmode="url" required></label></p>
<button class="b ok" name="decision" value="allow">Разрешить и войти в Битрикс24</button>
<button class="b" name="decision" value="deny" formnovalidate>Отказать</button></form></body></html>`
}
