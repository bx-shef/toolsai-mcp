import { parseCodes, parseGroupsOff, parseManifests } from '../../lib/access'
import { ADMIN_COOKIE } from '../../lib/admin'

// Сохранить права портала. Администратор ли — заново спрашиваем у портала: права могли отобрать.
export default defineEventHandler(async (event) => {
  adminHeaders(event)
  const s = await adminSession(event)
  if (!s) return sendRedirect(event, `${useServices().cfg.publicUrl}/admin`, 303)
  const { access } = useServices()
  const body = await readParams(event)
  const draft = { use: String(body.use ?? ''), write: String(body.write ?? ''), manifests: String(body.manifests ?? '') }
  const current = await access.settings(s.memberId)
  if (body.csrf !== s.csrf) {
    setResponseStatus(event, 403)
    return adminSettingsPage(s, current, envNote(), '', 'Форма устарела — откройте настройки заново', draft, await licenseSection(s))
  }
  // Токены Битрикс24 администратора могли сгореть (отказ входа в MCP их забывает) — это не «не администратор»
  if (!await useServices().b24.hasTokens(s)) {
    await useServices().admin.logout(getCookie(event, ADMIN_COOKIE))
    clearAdminCookie(event)
    setResponseStatus(event, 401)
    return adminLoginPage(s.host, 'Вход устарел — войдите заново, изменения не сохранены')
  }
  if (!await access.isAdmin(s)) {
    await useServices().admin.logout(getCookie(event, ADMIN_COOKIE))
    clearAdminCookie(event)
    setResponseStatus(event, 403)
    return adminLoginPage(s.host, 'Вы больше не администратор этого Битрикс24')
  }
  try {
    const saved = await access.save(s.memberId, { disabled: Boolean(body.disabled), groupsOff: parseGroupsOff(body), use: parseCodes(draft.use), write: parseCodes(draft.write), manifests: parseManifests(draft.manifests) }, s.userId)
    console.log(JSON.stringify({ kind: 'admin', portal: s.host, member: s.memberId, user: s.userId, action: 'settings', disabled: saved.disabled, groupsOff: saved.groupsOff, use: saved.use.length, write: saved.write.length, manifests: saved.manifests.length }))
    return adminSettingsPage(s, saved, envNote(), 'Сохранено', '', undefined, await licenseSection(s))
  }
  catch (e) {
    setResponseStatus(event, 400)
    return adminSettingsPage(s, current, envNote(), '', e instanceof Error ? e.message : 'Ошибка', draft, await licenseSection(s))
  }
})
