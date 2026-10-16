// Подставной Битрикс24 стенда — тот же, что в тестах (tests/fake-b24.mjs), но на постоянном порту
// и с ручкой /_state: сменить вошедшего сотрудника (POST {"user": 1}).
import { startFakeB24 } from './fake-b24.mjs'

const port = Number(process.env.FAKE_PORT || 8090)
const fake = await startFakeB24({ port, host: '0.0.0.0' })
console.log(`fake Битрикс24: ${fake.url}`)
