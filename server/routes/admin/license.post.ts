import { ADMIN_COOKIE } from '../../lib/admin'

// Действия раздела «Лицензия» на /admin. Только администратор портала (как и сохранение прав).
export default defineEventHandler(async (event) => {
  adminHeaders(event)
  const s = await adminSession(event)
  const { cfg, access, license, b24 } = useServices()
  if (!s) return sendRedirect(event, `${cfg.publicUrl}/admin`, 303)
  const body = await readParams(event)
  const show = async (msg: string, error = '') => adminSettingsPage(s, await access.settings(s.memberId), envNote(), msg, error, undefined, await licenseSection(s))
  if (body.csrf !== s.csrf) {
    setResponseStatus(event, 403)
    return show('', 'Форма устарела — откройте настройки заново')
  }
  if (!await b24.hasTokens(s) || !await access.isAdmin(s)) {
    await useServices().admin.logout(getCookie(event, ADMIN_COOKIE))
    clearAdminCookie(event)
    setResponseStatus(event, 401)
    return adminLoginPage(s.host, 'Вход устарел — войдите заново')
  }
  const by = body.eula ? `${s.name || `сотрудник ${s.userId}`} (${s.host}, id ${s.userId})` : ''
  const str = (k: string) => String(body[k] ?? '')
  let err: string | null
  switch (body.action) {
    case 'activate': err = await license.activate(s.memberId, s.host, str('key'), by); break
    case 'trial': err = await license.trial(s.memberId, s.host, { name: str('name'), unp: str('unp'), email: str('email') }, by); break
    case 'rebind': err = await license.rebind(s.memberId, s.host, str('key'), by); break
    case 'renew': err = await license.renew(s.memberId, s.host); break
    case 'accept': err = await license.accept(s.memberId, s.host, by); break
    case 'install': err = await license.install(s.memberId, str('cert')); break
    default: err = 'Неизвестное действие'
  }
  // Ключ в журнал не пишем — только действие и исход
  console.log(JSON.stringify({ kind: 'admin', portal: s.host, member: s.memberId, user: s.userId, action: `license.${String(body.action)}`, ok: !err }))
  if (err) setResponseStatus(event, 400)
  return show(err ? '' : 'Готово', err ?? '')
})
