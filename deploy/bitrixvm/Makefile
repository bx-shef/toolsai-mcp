# Обслуживание MCP-сервера на сервере. Всё — от пользователя bitrix, из ~/mcp:
#   cd ~/mcp && make            # список команд
# Ставится копией из src/ (make self-update). Порядок установки — docs/DEPLOY_BITRIXVM.md.

SHELL := /bin/bash
STACK := $(CURDIR)
SCRIPT := $(STACK)/bin/mcp-deploy
DEPLOY_USER ?= bitrix
PORT := $(or $(shell sed -n 's/^MCP_PORT=//p' .env 2>/dev/null),3100)
HEALTH := http://127.0.0.1:$(PORT)/health
# Метка строк в crontab bitrix: ими управляет только этот Makefile, остальные строки (агенты
# портала, mp3-to-txt) не трогаются.
TAG := \# toolsai-mcp

# ⚠ Только от bitrix: от root файлы state/ и .env сменили бы владельца, и выкат по cron от bitrix
# потом падал бы на каждом тике.
ifneq ($(shell id -un),$(DEPLOY_USER))
$(error запускать от $(DEPLOY_USER): su - $(DEPLOY_USER), затем cd ~/mcp && make)
endif

.DEFAULT_GOAL := help
.PHONY: help check status pull install deploy pause resume up logs audit deploy-log compose-diff compose-apply self-update

help: ## список команд
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  make %-14s %s\n",$$1,$$2}'

check: ## проверить установку: группы, права, контейнеры, расписание
	@echo "пользователь: $$(id -un), группы: $$(id -Gn)"; id -Gn | grep -qw docker || echo "  ⚠ нет группы docker — перелогиньтесь (su - bitrix)"
	@for f in .env deploy.env state src; do [ -e $$f ] && stat -c '  %n: %U %a' $$f || echo "  ⚠ нет $$f"; done
	@out=$$(docker compose ps --format '{{.Name}} {{.Status}}' 2>/dev/null); [ -n "$$out" ] && echo "$$out" | sed 's/^/  контейнер: /' || echo "  контейнеры не запущены"
	@crontab -l 2>/dev/null | grep -q '$(TAG)' && echo "  расписание: есть" || echo "  расписание: нет (make install)"
	@[ -e state/paused ] && echo "  автообновление: на паузе" || echo "  автообновление: включено"

status: ## что развёрнуто и как отвечает сервер
	@echo "развёрнут: $$(cut -c1-7 state/deployed_sha 2>/dev/null || echo —)  откачен: $$(cut -c1-7 state/failed_sha 2>/dev/null || echo —)  $$([ -e state/paused ] && echo '(пауза)')"
	@curl -s --max-time 5 $(HEALTH) | jq -c '{status, ready, commit: (.commit[0:7])}' 2>/dev/null || echo "сервер не отвечает на $(HEALTH)"

pull: ## скачать образы (:latest и redis)
	docker compose pull

install: ## поставить скрипт выката и расписание (сразу в паузе)
	@mkdir -p bin state && install -m 755 src/deploy/bitrixvm/mcp-deploy.sh $(SCRIPT)
	@[ -e deploy.env ] || install -m 600 src/deploy/bitrixvm/deploy.env.example deploy.env
	@touch state/paused
	@# ⚠ В crontab bitrix живут агенты портала (cron_events.php). Не прочитали crontab по любой
	@# причине, кроме «его ещё нет», — стоп: иначе записали бы только свои строки и стёрли агентов.
	@cur=$$(crontab -l 2>&1) || { case "$$cur" in *"no crontab"*) cur="";; *) echo "не прочитал crontab: $$cur"; exit 1;; esac; }; \
	  printf '%s\n' "$$cur" > state/crontab.bak; \
	  { printf '%s\n' "$$cur" | grep -v '$(TAG)' | grep -v '^$$'; \
	    echo '*/5 * * * * umask 077; MCP_DEPLOY_CONFIG=$(STACK)/deploy.env $(SCRIPT) >> $(STACK)/deploy.log 2>&1 $(TAG)'; \
	    echo '9 4 * * 0 find $(STACK)/deploy.log -size +20M -delete $(TAG)'; } | crontab -
	@echo "готово: скрипт $(SCRIPT), расписание в crontab $$(id -un), автообновление на паузе (make resume)"

deploy: ## выкатить новый коммит main сейчас (и в паузе)
	@umask 077; MCP_DEPLOY_FORCE=1 MCP_DEPLOY_CONFIG=$(STACK)/deploy.env $(SCRIPT) 2>&1 | tee -a deploy.log

pause: ## остановить автообновление
	@touch state/paused && echo "автообновление на паузе"

resume: ## включить автообновление
	@rm -f state/paused && echo "автообновление включено"

up: ## применить правку .env (пересоздать контейнер mcp — иначе Docker не видит новый .env)
	docker compose up -d
	docker compose up -d --force-recreate mcp

logs: ## журнал сервера
	@docker logs --tail=30 mcp 2>&1

audit: ## журнал действий сотрудников: make audit [N=50]
	@docker logs --tail=2000 mcp 2>/dev/null | grep '"kind":"audit"' | tail -$(or $(N),50) | jq -c '{t, portal, member, user, tool, method, ok, error, ms}'

deploy-log: ## журнал выката
	@tail -30 deploy.log

compose-diff: ## чем docker-compose.yml развёрнутого коммита отличается от установленного
	@diff -u docker-compose.yml src/docker-compose.yml && echo "одинаковые"; true

compose-apply: ## поставить docker-compose.yml из src/ (сначала make compose-diff)
	cp src/docker-compose.yml docker-compose.yml && docker compose up -d

self-update: ## обновить Makefile и скрипт выката из src/ (развёрнутый коммит)
	@cp src/deploy/bitrixvm/Makefile Makefile && install -m 755 src/deploy/bitrixvm/mcp-deploy.sh $(SCRIPT) && echo "Makefile и скрипт обновлены"
