#!/usr/bin/env bash
# Автообновление MCP-сервера на VM с BitrixVM — опросом git.
#
# Схема та же, что в эталоне client-bank-alfa-by (deploy/bitrixvm/git-poll-deploy.sh), но на один
# сервис: раз в 5 минут cron спрашивает у GitHub последний коммит `main`; новый — тянет образ
# ровно этого коммита (`ghcr.io/...:sha-<7 знаков>`), перезапускает контейнер, проверяет /health и при неудаче откатывается на прежний образ.
# Порядок установки — docs/DEPLOY_BITRIXVM.md.
#
# ⚠ Автоматически меняется ТОЛЬКО образ. docker-compose.yml на сервере ставит человек (шаг
# «Обновить docker-compose.yml» в DEPLOY_BITRIXVM.md): compose решает, с какими правами запускается
# контейнер (privileged, тома, сеть), и брать его из репозитория автоматически значило бы, что запись
# в main = root на VM портала. Образ же работает от uid 10001 без capabilities. Если compose в
# новом коммите отличается от установленного, скрипт пишет об этом в журнал.
#
# ⚠ Скрипт запускается из УСТАНОВЛЕННОЙ копии (~/mcp/bin/mcp-deploy, make install), а не из src/:
# bash читает скрипт по ходу выполнения, и `git checkout` посреди прогона подменил бы ему текст.
# Новая версия скрипта ставится руками: make self-update (DEPLOY_BITRIXVM.md).

set -Eeuo pipefail
umask 077      # журнал и состояние — только владельцу (bitrix)

CONFIG="${MCP_DEPLOY_CONFIG:-/home/bitrix/mcp/deploy.env}"

log() { printf '%s [mcp-deploy] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '%s [mcp-deploy] ОШИБКА: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

# От кого выкат (DEPLOY_BITRIXVM.md, «Граница безопасности»). Запуск не тем пользователем —
# отказ: от root в state/ остались бы файлы, которые bitrix потом не перезапишет, и cron молча
# падал бы на каждом тике.
want_user="${MCP_DEPLOY_USER:-bitrix}"
[ "$(id -un)" = "$want_user" ] || die "запускать от $want_user: sudo -u $want_user $0"

[ -r "$CONFIG" ] || die "нет файла настроек $CONFIG"
# shellcheck disable=SC1090
. "$CONFIG"

: "${STACK_DIR:=/home/bitrix/mcp}"
: "${GIT_BRANCH:=main}"
: "${IMAGE:=ghcr.io/bx-shef/toolsai-mcp}"
: "${MCP_PORT:=3100}"
: "${HEALTH_URL:=http://127.0.0.1:$MCP_PORT/health}"
: "${HEALTH_ATTEMPTS:=24}"         # × HEALTH_INTERVAL_SEC — Node стартует за секунды
: "${HEALTH_INTERVAL_SEC:=5}"
: "${SHA_TAG_LENGTH:=7}"
STATE_DIR="$STACK_DIR/state"
SRC="$STACK_DIR/src"

mkdir -p "$STATE_DIR"
cd "$STACK_DIR" || die "нет каталога $STACK_DIR"
[ -d "$SRC/.git" ] || die "нет клона репозитория $SRC (шаг 2 DEPLOY_BITRIXVM.md)"

# Один запуск за раз: два `compose up` одновременно перезапускают контейнер друг у друга.
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || { log "обновление уже идёт, пропускаю тик"; exit 0; }

# Пауза — файл, а не правка crontab; переживает перезагрузку. Ручной запуск с MCP_DEPLOY_FORCE=1
# паузу обходит: это явное действие человека.
if [ -e "$STATE_DIR/paused" ] && [ "${MCP_DEPLOY_FORCE:-0}" != 1 ]; then
  log "автообновление на паузе ($STATE_DIR/paused)"
  exit 0
fi

deployed_sha=""
[ -r "$STATE_DIR/deployed_sha" ] && deployed_sha="$(cat "$STATE_DIR/deployed_sha")"

git -C "$SRC" fetch --quiet --depth 1 origin "$GIT_BRANCH" || die "не удалось опросить git ($GIT_BRANCH)"
remote_sha="$(git -C "$SRC" rev-parse FETCH_HEAD)"
[ ${#remote_sha} -eq 40 ] || die "неожиданный ответ git: $remote_sha"

if [ "$remote_sha" = "$deployed_sha" ]; then
  log "изменений нет (${remote_sha:0:$SHA_TAG_LENGTH})"
  exit 0
fi

# ⚠ Откаченный коммит повторно не выкатываем: каждая попытка — перезапуск и до
# HEALTH_ATTEMPTS×HEALTH_INTERVAL_SEC простоя, и раз в 5 минут сервис перезапускался бы.
# Чинит новый коммит; повторить этот же — MCP_DEPLOY_FORCE=1.
if [ -r "$STATE_DIR/failed_sha" ] && [ "$(cat "$STATE_DIR/failed_sha")" = "$remote_sha" ] \
   && [ "${MCP_DEPLOY_FORCE:-0}" != 1 ]; then
  log "коммит ${remote_sha:0:$SHA_TAG_LENGTH} уже откатывался — жду новый (повторить: MCP_DEPLOY_FORCE=1)"
  exit 0
fi

tag="sha-${remote_sha:0:$SHA_TAG_LENGTH}"
log "новый коммит ${remote_sha:0:$SHA_TAG_LENGTH} → образ $IMAGE:$tag"

# Пакет GHCR публичный — вход не нужен. Закрыли пакет — токен read:packages в файле.
if [ -n "${REGISTRY_TOKEN_FILE:-}" ]; then
  [ -r "$REGISTRY_TOKEN_FILE" ] || die "токен реестра $REGISTRY_TOKEN_FILE недоступен"
  docker login ghcr.io -u "${REGISTRY_USER:?нужен REGISTRY_USER}" --password-stdin \
    < "$REGISTRY_TOKEN_FILE" >/dev/null || die "не удалось войти в ghcr.io"
fi

# «Образа ещё нет» — штатное ожидание CI (образ есть у каждого коммита main, но через пару минут
# после пуша). Остальные отказы pull — поломка, о ней кричим.
if ! pull_err=$(docker pull --quiet "$IMAGE:$tag" 2>&1); then
  case "$pull_err" in
    *"manifest unknown"*|*"not found"*|*"manifest for"*)
      log "образа $IMAGE:$tag ещё нет — CI собирает; попробую на следующем тике"
      exit 0 ;;
    *) die "не удалось скачать $IMAGE:$tag: $(printf '%s' "$pull_err" | tr '\n' ' ')" ;;
  esac
fi

# Откат — на ID образа, который работает сейчас (тег мог быть переписан). compose принимает
# `sha256:<id>` как image: проверено прогоном отката в песочнице (DEPLOY_BITRIXVM.md).
prev_image="$(docker inspect -f '{{.Image}}' mcp 2>/dev/null || true)"

# src/ — на коммит образа: из него человек берёт скрипт и compose для ручного обновления.
git -C "$SRC" checkout --quiet --detach "$remote_sha" || die "не удалось переключить src на $remote_sha"
if ! cmp -s "$SRC/docker-compose.yml" docker-compose.yml; then
  log "⚠ docker-compose.yml в ${remote_sha:0:$SHA_TAG_LENGTH} отличается от установленного — образ выкатываю, compose НЕ меняю; проверить и применить вручную: diff $SRC/docker-compose.yml $STACK_DIR/docker-compose.yml"
fi

apply() { MCP_IMAGE="$1" docker compose up -d --remove-orphans; }

# Готово = 200, Redis отвечает И отвечает ИМЕННО новый коммит (иначе «зелёный» мог бы дать
# ещё не перезапущенный старый контейнер).
healthy() {
  local want="$1" body
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -q '"ready":true' && printf '%s' "$body" | grep -q "\"commit\":\"$want\""; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SEC"
  done
  return 1
}

log "разворачиваю $tag"
if apply "$IMAGE:$tag" && healthy "$remote_sha"; then
  docker tag "$IMAGE:$tag" "$IMAGE:latest" || log "не удалось перетегировать :latest"
  [ -n "$deployed_sha" ] && printf '%s\n' "$deployed_sha" > "$STATE_DIR/previous_sha"
  printf '%s\n' "$remote_sha" > "$STATE_DIR/deployed_sha"
  rm -f "$STATE_DIR/failed_sha"
  log "готово: развёрнут ${remote_sha:0:$SHA_TAG_LENGTH}"
  exit 0
fi

log "новая версия не поднялась или не прошла /health — откатываюсь"
docker compose logs --tail=30 mcp 2>&1 | sed 's/^/    /' || true
[ -n "$deployed_sha" ] && git -C "$SRC" checkout --quiet --detach "$deployed_sha" 2>/dev/null || true
if [ -n "$prev_image" ] && apply "$prev_image"; then
  if [ -n "$deployed_sha" ] && healthy "$deployed_sha"; then
    log "откат выполнен: прежняя версия ${deployed_sha:0:$SHA_TAG_LENGTH} отвечает"
  else
    log "откат выполнен, но прежняя версия не прошла /health — нужен человек"
  fi
else
  log "ОТКАТ НЕ УДАЛСЯ или откатываться не на что — нужен человек"
fi
printf '%s\n' "$remote_sha" > "$STATE_DIR/failed_sha"
die "обновление до $tag откачено"
