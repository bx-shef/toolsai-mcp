import { loadIcon } from '../lib/icon'

// Иконка коннектора: поле icons в initialize (serverInfo). Адрес — полный, от PUBLIC_URL (за nginx
// портала сервер живёт под префиксом /mcp-ai). Тип — по найденному файлу (server/lib/icon.ts).
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('mcp:config:resolved', async ({ config }) => {
    const { cfg } = useServices()
    const icon = await loadIcon(process.env.BRANDING_DIR || '/branding')
    config.icons = [{ src: `${cfg.publicUrl}/icon`, mimeType: icon.type, sizes: ['any'] }]
  })
})
