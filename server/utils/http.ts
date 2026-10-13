import type { H3Event } from 'h3'
import { OAuthError } from '../lib/oauth'

/** Ошибка OAuth в JSON (RFC 6749 5.2); прочие — 500 без подробностей наружу, подробности — в лог. */
export function oauthFail(event: H3Event, e: unknown) {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  if (e instanceof OAuthError) {
    setResponseStatus(event, e.status)
    return { error: e.error, error_description: e.description }
  }
  console.error('[oauth]', e instanceof Error ? e.message : e)
  setResponseStatus(event, 500)
  return { error: 'server_error', error_description: 'Внутренняя ошибка' }
}

/** Тело формой или JSON. */
export async function readParams(event: H3Event): Promise<Record<string, unknown>> {
  const type = getRequestHeader(event, 'content-type') ?? ''
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(await readRawBody(event) ?? ''))
  }
  return (await readBody(event).catch(() => ({}))) ?? {}
}
