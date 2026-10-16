import { PORTAL_COOKIE } from '../../utils/consent'

export default defineEventHandler(async (event) => {
  adminHeaders(event)
  const s = await adminSession(event)
  const { cfg, access } = useServices()
  if (!s) return adminLoginPage(getCookie(event, PORTAL_COOKIE) || cfg.defaultPortal || '')
  return adminSettingsPage(s, await access.settings(s.memberId), envNote())
})
