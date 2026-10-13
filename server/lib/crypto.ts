import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url')

/** PKCE S256 (RFC 7636): BASE64URL(SHA256(verifier)) == challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  const a = Buffer.from(sha256(verifier))
  const b = Buffer.from(challenge)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** AES-256-GCM; результат — iv.tag.шифротекст в base64url. */
export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), body].map(b => b.toString('base64url')).join('.')
}

export function decrypt(key: Buffer, packed: string): string {
  const [iv, tag, body] = packed.split('.').map(p => Buffer.from(p, 'base64url'))
  if (!iv || !tag || !body) throw new Error('bad ciphertext')
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(body), d.final()]).toString('utf8')
}
