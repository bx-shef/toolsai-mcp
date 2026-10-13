// Только MCP-сервер: страниц нет. Устройство — docs/ARCHITECTURE.md
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  modules: ['@nuxtjs/mcp-toolkit'],
  devtools: { enabled: false },
  ssr: false,
  mcp: {
    name: 'toolsai-mcp',
    description: 'Битрикс24 портала: CRM, задачи, звонки — от имени подключённого сотрудника',
    instructions: 'Все инструменты работают от имени сотрудника, подключившего коннектор, и в рамках его прав в Битрикс24. Сейчас только чтение.',
    // Клиенты ходят из интернета (claude.ai), Origin сравнивать не с чем — защищает токен.
    security: { allowedOrigins: '*' },
  },
  nitro: {
    preset: 'node-server',
    // useEvent() в инструментах — кто вызывает.
    experimental: { asyncContext: true },
  },
})
