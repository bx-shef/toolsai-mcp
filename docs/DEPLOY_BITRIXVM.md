# Разворот на VM с BitrixVM

> Last reviewed: 2026-10-16

Сервер ставится на ту же VM, что и портал, рядом с `toolsai-mp3-txt`, и слушает только
`127.0.0.1:3100`. Наружу его открывает nginx портала по пути `/mcp-ai/`. Обновление образа —
как у mp3-txt: cron раз в 5 минут спрашивает у GitHub последний коммит `main`, тянет образ ровно
этого коммита из GHCR, перезапускает, проверяет `/health` и при неудаче откатывается.

```
GitHub main ──CI──► ghcr.io/bx-shef/toolsai-mcp:sha-<коммит>
                                   │ docker pull (cron bitrix, ~/mcp/bin/mcp-deploy)
┌──────────────────────────────────▼──────────────────── VM портала ─┐
│ claude.ai ─► nginx :443 ─/mcp-ai/─► 127.0.0.1:3100 mcp ─► redis    │
│                                          │                         │
│                                          └─► https://портал/rest/ (токен сотрудника)
└────────────────────────────────────────────────────────────────────┘
```

Развёрнуто на `b24.stuttgart.by` 2026-10-16 по этой инструкции: вход сотрудника, задачи и дела CRM
в Claude работают. Расхождения на других VM — правкой этого файла.

## Граница безопасности

Как у mp3-txt: всё от **`bitrix`**, группа `docker` по силе равна root, поэтому **защита `main`
обязательна до первой установки** ([`REPO_SETUP_CHECKLIST.md`](REPO_SETUP_CHECKLIST.md)).
Автоматически меняется только образ; `docker-compose.yml` и nginx меняет человек.

Новое против mp3-txt — **сервер виден из интернета**. Что его держит: TLS портала, `limit_req`
в nginx, вход только через портал, `ALLOWED_USERS`, только чтение, журнал.

## Раскладка на сервере

Всё — в `/home/bitrix/mcp`, владелец `bitrix`.

| Путь | Что | Права |
|---|---|---|
| `./` | каталог сервиса | 700 |
| `Makefile` | команды обслуживания (`make` — список); копия из `src/` | 644 |
| `docker-compose.yml` | копия из `src/`, меняется только руками | 644 |
| `.env` | секрет приложения, ключ шифрования, пароль Redis, `ALLOWED_USERS` | **600** |
| `deploy.env` | настройки автообновления | 600 |
| `bin/mcp-deploy` | копия `deploy/bitrixvm/mcp-deploy.sh` (`make install`) | 755 |
| `src/` | клон репозитория на развёрнутом коммите | |
| `branding/` | своя иконка коннектора `icon.png` (шаг 5а), необязательно | 755 |
| `state/` | `deployed_sha`, `previous_sha`, `failed_sha`, `paused`, `deploy.lock`, `crontab.bak` | 700 |
| `deploy.log` | журнал выката | 600 |
| том Docker `mcp_redis` | сессии клиентов и токены сотрудников | Docker |

## Ресурсы

Порядок величин — замер на песочнице (2026-10-13, Debian, Docker 29): образ 334 МБ, контейнер
сервера ограничен `MCP_MEM_LIMIT=512m`, Redis — 128 МБ. На VM портала не мерили; после
разворота — `docker stats --no-stream mcp mcp-redis` в эту таблицу.

## 0. Перед началом (владелец)

- Шаг 1 пройден: [`OAUTH_CHECK.md`](OAUTH_CHECK.md) — `client_id`, `client_secret` на руках.
- Защита `main`, пакет GHCR публичный ([`REPO_SETUP_CHECKLIST.md`](REPO_SETUP_CHECKLIST.md)),
  в `main` есть коммит с зелёным «Build & Push to GHCR».
- Docker на VM уже стоит (mp3-txt): `docker compose version`; есть `curl` и `jq` (ими пользуются `make status` и `make audit`).
- Памяти хватает: `free -h`, столбец `available` — нужно ~0,7 ГБ сверх того, что уже занято порталом и mp3-txt.

## 0а. `.gitignore` портала (владелец)

Git-деплой портала и его страж дерева смотрят на весь `/home/bitrix`. Строка в `.gitignore`
репозитория портала (`stuttgart-git/b24`) — через PR портала, не правкой на сервере:

```gitignore
/mcp/
```

Проверка после выката портала: `sudo -u bitrix git -C /home/bitrix check-ignore -v mcp/`.

## 1. Каталог и клон (bitrix)

```bash
su - bitrix
mkdir -m 700 ~/mcp && cd ~/mcp
git clone --depth 1 https://github.com/bx-shef/toolsai-mcp src
cp src/deploy/bitrixvm/Makefile src/docker-compose.yml .
install -m 600 src/.env.example .env
mkdir -m 700 state
```

## 2. `.env`

```bash
nano .env
```

- `PUBLIC_URL=https://b24.stuttgart.by/mcp-ai`; `B24_PORTAL_URL=https://b24.stuttgart.by` — необязательно,
  портал по умолчанию: подставится в поле входа, голые ID в `ALLOWED_USERS` относятся к нему;
- `B24_CLIENT_ID`, `B24_CLIENT_SECRET` — из локального приложения;
- `ENCRYPTION_KEY` — `openssl rand -base64 32` (сменить потом = все входят заново);
- `ALLOWED_USERS=1` (или `b24.stuttgart.by:1`) — пилот на одном сотруднике (шаг 6 плана). Обязательно: пусто — сервер не стартует, всем — `*`;
- `REDIS_PASSWORD` — `openssl rand -hex 24`.

## 3. Первый запуск (bitrix)

```bash
make pull && make up
make status          # ready: true
make check
```

## 4. nginx (root, владелец)

На bitrix-env конфиг сайта генерируется, `/etc/nginx/conf.d/` не подключается. Проверено на
`b24.stuttgart.by` (2026-10-16): в `http { }` подключается `bx/settings/*.conf`, внутри HTTPS-сервера
портала — `bx/site_settings/default/*.conf`. Сверить на своей VM:

```bash
nginx -T 2>/dev/null | grep -nE 'server_name|listen .*443|include'
```

```bash
cat > /etc/nginx/bx/settings/mcp-ai.conf <<'EOF'
# toolsai-mcp: ограничения для /mcp-ai/ (подключается в http {})
limit_req_zone  $binary_remote_addr zone=mcp_ai:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=mcp_ai_conn:10m;
EOF
cp /home/bitrix/mcp/src/deploy/bitrixvm/nginx-mcp.conf /etc/nginx/bx/site_settings/default/mcp-ai.conf
nginx -t && systemctl reload nginx
```

`nginx -t` ругается — не перезагружать: портал работает на старом конфиге. В вставке —
`location ^~ /mcp-ai/`: без `^~` правила по маскам из `bx/conf/bitrix.conf` могли бы перехватить
наши адреса.

Проверка снаружи (с любой машины):

```bash
curl -s https://b24.stuttgart.by/mcp-ai/health                                   # {"status":"ok",...}
curl -s https://b24.stuttgart.by/.well-known/oauth-authorization-server/mcp-ai | jq .issuer
curl -si -X POST https://b24.stuttgart.by/mcp-ai/mcp | grep -i www-authenticate  # 401 и resource_metadata
```

## 5. Подключить Claude (сотрудник из `ALLOWED_USERS`)

claude.ai → Настройки → Коннекторы → «Добавить свой коннектор» → `https://b24.stuttgart.by/mcp-ai/mcp`.
Откроется экран согласия сервера (кто просит доступ и куда уйдёт ответ) → «Разрешить» → портал,
вход, возврат в Claude. Проверка — попросить «кто я в Битрикс24?» (`user_current`),
на сервере — `make audit`.

Claude Code: `claude mcp add --transport http b24 https://b24.stuttgart.by/mcp-ai/mcp`, затем `/mcp` — войти.

## 5а. Своя иконка коннектора (необязательно)

Claude показывает иконку сервера рядом с коннектором. Своя — файл в `~/mcp/branding/`:
`icon.png` (квадрат, 256×256, до 512 КБ), `icon.svg` или `icon.jpg`. Нет файла — встроенный синий
квадрат с «24».

```bash
mkdir -p ~/mcp/branding && cp /путь/к/icon.png ~/mcp/branding/icon.png
curl -s -o /dev/null -w '%{content_type}\n' https://<портал>/mcp-ai/icon   # image/png
```

Перезапуск не нужен. Claude запоминает иконку при подключении — переподключить коннектор.
Каталог монтирует `docker-compose.yml` (с 2026-10-16): на сервере, поставленном раньше, —
`make compose-diff`, `make compose-apply`.

## 6. Автообновление (bitrix)

```bash
make install         # скрипт и cron, сразу на паузе
make deploy          # выкатить текущий main руками
make resume          # включить, когда защита main стоит
```

## Свой домен вместо пути на портале

Сервер можно поставить на свой домен третьего уровня, например `mcp-bel.bx-shef.by`, — как
импорт из клиент-банка (`bx-shef/client-bank-alfa-by`, `docs/DEPLOY_BITRIXVM.md`). Так удобно,
когда на машине уже живут другие приложения со своими доменами: у каждого свой сайт, свой
сертификат и своя вставка nginx. MCP с ними не пересекается: порт `127.0.0.1:3100`, контейнеры
`mcp`/`mcp-redis`, сеть `mcp_default`, зоны nginx `mcp_ai*`; `make install` в crontab трогает только
свои строки.

Отличия от шагов выше:

1. **DNS и сайт (владелец).** A-запись домена на эту машину. Сайт и сертификат — **штатным меню**
   bitrix-env («Добавить сайт», затем выпуск сертификата): меню создаёт конфиги nginx, каталог
   `/etc/nginx/bx/site_settings/<домен>/` и docroot `/home/bitrix/ext_www/<домен>`.
2. **Приложение на портале** — путь обработчика `https://<домен>/oauth/callback` (без `/mcp-ai`).
3. **`.env`** — `PUBLIC_URL=https://<домен>`; портал по умолчанию — `B24_PORTAL_URL=https://<портал>`.
4. **nginx (root)** — вместо `site_settings/default/mcp-ai.conf`:

```bash
DOMAIN=mcp-bel.bx-shef.by        # ← свой домен
cat > /etc/nginx/bx/settings/mcp-ai.conf <<'EOF'
limit_req_zone  $binary_remote_addr zone=mcp_ai:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=mcp_ai_conn:10m;
EOF
install -m 644 /home/bitrix/mcp/src/deploy/bitrixvm/nginx-mcp-domain.conf \
  "/etc/nginx/bx/site_settings/$DOMAIN/00-mcp-proxy.conf" && nginx -t && systemctl reload nginx
```

   Файл зон `bx/settings/mcp-ai.conf` — один на машину: если MCP уже стоит на этой машине на
   пути портала, второй раз не создавать (дубль зоны — отказ `nginx -t`).

5. **Docroot (root)** — заглушка вместо битриксового `index.php`: сюда запрос попадает, только если
   сломалось проксирование, и отвечает `503`:

```bash
DOMAIN=mcp-bel.bx-shef.by        # ← свой домен
D=/home/bitrix/ext_www/$DOMAIN
cp -a "$D/index.php" "$D/index.php.orig-$(date +%F)"
install -m 644 -o bitrix -g bitrix /home/bitrix/mcp/src/deploy/bitrixvm/docroot/index.php "$D/index.php"
touch "$D/.htsecure" && chown bitrix:bitrix "$D/.htsecure"   # http → https; только когда сертификат уже есть
```

6. **Проверка снаружи:**

```bash
curl -s https://<домен>/health; echo
curl -s https://<домен>/.well-known/oauth-authorization-server | head -c 120; echo
curl -si -X POST https://<домен>/mcp | grep -iE '^HTTP|www-authenticate'
```

   Коннектор в Claude — `https://<домен>/mcp`.

После операций меню bitrix-env (перевыпуск сертификата, правка сайта) — `nginx -t` и проверка
снаружи: каталог `site_settings` меню не трогает, но проверить дешевле, чем узнать от сотрудника.

## Обслуживание

| Задача | Команда |
|---|---|
| Что развёрнуто | `make status` |
| Кто что вызывал | `make audit N=100` |
| Закрыть доступ сотруднику | убрать ID из `ALLOWED_USERS`, `make up` — действует сразу (`make up` пересоздаёт контейнер; Makefile до 2026-10-16 этого не делал — обновить `make self-update`) |
| После отката выката | `make up` поднимает `:latest` — это последний **удачный** образ: скрипт перетегирует его только при успехе |
| Выгнать всех | новый `ENCRYPTION_KEY`, `docker compose down && docker volume rm mcp_redis && make up` |
| Новый compose из репозитория | `make compose-diff`, затем `make compose-apply` |
| Обновить Makefile и скрипт | `make self-update` |
