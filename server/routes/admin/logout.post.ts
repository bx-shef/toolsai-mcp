import { ADMIN_COOKIE } from '../../lib/admin'

export default defineEventHandler(async (event) => {
  await useServices().admin.logout(getCookie(event, ADMIN_COOKIE))
  clearAdminCookie(event)
  return sendRedirect(event, `${useServices().cfg.publicUrl}/admin`, 303)
})
