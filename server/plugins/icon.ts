// Иконка коннектора в Claude и других клиентах: поле icons в initialize (serverInfo). Адрес — полный,
// от PUBLIC_URL (за nginx портала сервер живёт под префиксом /mcp-ai). Файл — public/icon.svg.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('mcp:config:resolved', ({ config }) => {
    const { cfg } = useServices()
    config.icons = [{ src: `${cfg.publicUrl}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }]
  })
})
