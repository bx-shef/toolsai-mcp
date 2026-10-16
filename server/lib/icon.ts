import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Иконка коннектора в Claude и других клиентах. Своя — файл в каталоге branding на сервере
// (docker-compose.yml монтирует ./branding в /branding): icon.png, icon.svg или icon.jpg — первый
// найденный. Нет файла — встроенный синий квадрат.

export interface Icon { body: Buffer, type: string }

const FILES: [string, string][] = [['icon.png', 'image/png'], ['icon.svg', 'image/svg+xml'], ['icon.jpg', 'image/jpeg']]
/** Больше — не иконка, а ошибка загрузки: не отдаём. */
const MAX_BYTES = 512 * 1024

/** Встроенная: синий квадрат с облачком чата и «24» (свой рисунок, не логотип Битрикс24). */
export const DEFAULT_ICON: Icon = {
  type: 'image/svg+xml',
  body: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<rect width="64" height="64" rx="14" fill="#2fc6f6"/>
<path d="M14 18h36a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H30l-9 7v-7h-7a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z" fill="#fff"/>
<text x="32" y="38" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" fill="#2fc6f6">24</text>
</svg>`),
}

export async function loadIcon(dir: string): Promise<Icon> {
  for (const [name, type] of FILES) {
    try {
      const body = await readFile(join(dir, name))
      if (body.length > 0 && body.length <= MAX_BYTES) return { body, type }
    }
    catch {
      // нет файла — следующий
    }
  }
  return DEFAULT_ICON
}
