import type { H3Event } from 'h3'
import type { PortalSettings } from '../lib/access'
import { ADMIN_COOKIE, type AdminSession } from '../lib/admin'
import { OAuthError } from '../lib/oauth'

// Страница настроек администратора портала: cookie, заголовки, HTML. Логика — lib/admin.ts, lib/access.ts.

/** Cookie начатого входа администратора: на пути /oauth, как и у входа сотрудника — её читает возврат с портала. */
export const ADMIN_LOGIN_COOKIE = 'mcp_admin_login'

const prefix = () => new URL(useServices().cfg.publicUrl).pathname.replace(/\/$/, '')
const secure = () => new URL(useServices().cfg.publicUrl).protocol === 'https:'

export function setAdminLoginCookie(event: H3Event, state: string) {
  setCookie(event, ADMIN_LOGIN_COOKIE, state, { httpOnly: true, secure: secure(), sameSite: 'lax', path: `${prefix()}/oauth`, maxAge: 600 })
}

export function setAdminCookie(event: H3Event, token: string) {
  // Lax, а не Strict: сессия ставится в ответ на возврат с портала (межсайтовая цепочка), и Strict
  // не отдал бы её на /admin сразу после входа. От подделки формы — csrf в сессии.
  setCookie(event, ADMIN_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: 'lax', path: `${prefix()}/admin`, maxAge: 3600 })
}

export function clearAdminCookie(event: H3Event) {
  deleteCookie(event, ADMIN_COOKIE, { path: `${prefix()}/admin` })
}

export async function adminSession(event: H3Event): Promise<AdminSession | null> {
  return useServices().admin.session(getCookie(event, ADMIN_COOKIE))
}

export function adminHeaders(event: H3Event) {
  setResponseHeaders(event, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`,
  })
}

export async function adminCallback(event: H3Event, q: Record<string, unknown>) {
  try {
    const token = await useServices().admin.finish(q, getCookie(event, ADMIN_LOGIN_COOKIE))
    deleteCookie(event, ADMIN_LOGIN_COOKIE, { path: `${prefix()}/oauth` })
    setAdminCookie(event, token)
    return sendRedirect(event, `${useServices().cfg.publicUrl}/admin`, 302)
  }
  catch (e) {
    adminHeaders(event)
    const msg = e instanceof OAuthError ? e.description : 'Не удалось войти через Битрикс24 — попробуйте ещё раз'
    if (!(e instanceof OAuthError)) console.error('[admin]', e instanceof Error ? e.message : e)
    setResponseStatus(event, e instanceof OAuthError ? e.status : 500)
    return page('Настройки MCP', `<p class="err">${esc(msg)}</p><p><a href="${esc(useServices().cfg.publicUrl)}/admin">Открыть настройки заново</a></p>`)
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!))

function page(title: string, body: string) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#222}
.b{display:inline-block;padding:.6rem 1.2rem;margin:.3rem .5rem 0 0;border:1px solid #888;border-radius:.4rem;background:#fff;font-size:1rem;cursor:pointer}
.ok{background:#2fc6f6;border-color:#2fc6f6;color:#fff}code{background:#f2f2f2;padding:0 .2rem}.err{color:#b00}.done{color:#080}
.i{width:100%;box-sizing:border-box;padding:.5rem;margin-top:.3rem;font:1rem ui-monospace,monospace;border:1px solid #888;border-radius:.4rem}
small{color:#666}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`
}

export function adminLoginPage(portal: string, error = '') {
  const base = useServices().cfg.publicUrl
  return page('Настройки MCP', `${error ? `<p class="err">${esc(error)}</p>` : ''}
<p>Здесь администратор Битрикс24 решает, кто из сотрудников пользуется ИИ через этот сервер и кто может менять данные.</p>
<form method="post" action="${esc(base)}/admin/login">
<p><label>Адрес вашего Битрикс24<br><input class="i" name="portal" value="${esc(portal)}" placeholder="mycompany.bitrix24.by" required></label></p>
<button class="b ok">Войти через Битрикс24</button></form>`)
}

export function adminSettingsPage(s: AdminSession, st: PortalSettings, envNote: string, msg = '', error = '', draft?: Record<string, string>) {
  const base = useServices().cfg.publicUrl
  const v = (k: 'use' | 'write' | 'manifests') => esc(draft?.[k] ?? st[k].join('\n'))
  return page('Настройки MCP', `<p>Портал <b>${esc(s.host)}</b>, вы — <b>${esc(s.name || `сотрудник ${s.userId}`)}</b> (администратор).</p>
${msg ? `<p class="done">${esc(msg)}</p>` : ''}${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="${esc(base)}/admin/save"><input type="hidden" name="csrf" value="${esc(s.csrf)}">
<h2>Кто пользуется MCP</h2>
<p><small>Коды доступа Битрикс24, через запятую или с новой строки: <code>AU</code> — все сотрудники,
<code>U7</code> — сотрудник 7, <code>D3</code> — отдел 3, <code>DR3</code> — отдел 3 с подотделами, <code>G2</code> — группа пользователей.
Пусто — только администраторы портала. Администраторы проходят всегда. Сотрудник работает только в рамках своих прав в Битрикс24.</small></p>
<textarea class="i" name="use" rows="4">${v('use')}</textarea>
<h2>Кто может менять данные</h2>
<p><small>Те же коды. Действует на инструменты модулей с записью и удалением. Пусто — только администраторы.</small></p>
<textarea class="i" name="write" rows="3">${v('write')}</textarea>
<h2>Модули портала</h2>
<p><small>Методы-манифесты модулей (<code>vendor.mcp.tools</code>), по одному в строке. Как модулю описать свои инструменты — docs/MODULE_TOOLS.md.</small></p>
<textarea class="i" name="manifests" rows="2">${v('manifests')}</textarea>
${envNote ? `<p><small>${esc(envNote)}</small></p>` : ''}
<p><button class="b ok">Сохранить</button></p></form>
<form method="post" action="${esc(base)}/admin/logout"><button class="b">Выйти</button></form>
<p><small>Изменения применяются в течение 5 минут.${st.updatedAt ? ` Последнее сохранение: ${esc(new Date(st.updatedAt).toISOString().slice(0, 16).replace('T', ' '))} UTC, сотрудник ${st.updatedBy}.` : ''}</small></p>`)
}

/** Что дополнительно открыто из .env — показать администратору, чтобы не удивлялся. */
export function envNote(): string {
  const parts: string[] = []
  if (process.env.ALLOWED_USERS?.trim()) parts.push(`вход: ALLOWED_USERS=${process.env.ALLOWED_USERS.trim()}`)
  if (process.env.WRITE_USERS?.trim()) parts.push(`запись: WRITE_USERS=${process.env.WRITE_USERS.trim()}`)
  if (process.env.MODULE_MANIFESTS?.trim()) parts.push(`модули: MODULE_MANIFESTS=${process.env.MODULE_MANIFESTS.trim()}`)
  return parts.length ? `Сервер дополнительно открывает из своего .env — ${parts.join('; ')}.` : ''
}
