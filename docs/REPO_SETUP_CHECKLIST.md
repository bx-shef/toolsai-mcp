# Настройка репозитория — разово владельцу

> Last reviewed: 2026-10-13

То, что агент сделать не может (нет прав администратора репозитория). Как в `toolsai-mp3-txt`.

## 1. Защита `main` (Settings → Rules → Rulesets → New branch ruleset)

⚠ **До установки на сервер.** Скрипт выката (от `bitrix` в группе `docker`) ставит на VM портала
образ любого коммита `main`; а этот сервер ещё и держит токены сотрудников.

Имя `protect-main`, цель — ветка по умолчанию, Enforcement: Active.

- [ ] Restrict deletions, Block force pushes.
- [ ] Require a pull request before merging: одобрений **0**, Dismiss stale approvals, Require conversation resolution.
- [ ] Allowed merge methods: **Squash** только.
- [ ] Require status checks to pass: **`ci`** и **`docker-build`**, Require branches to be up to date.

## 2. Общие настройки (Settings → General)

- [ ] Pull Requests: только «Allow squash merging»; «Automatically delete head branches» — вкл.

## 3. Пакет GHCR

Первый мерж в `main` публикует `ghcr.io/bx-shef/toolsai-mcp`. Репозиторий открытый — пакет,
скорее всего, унаследует видимость (так было у mp3-txt); проверить:

- [ ] github.com/bx-shef → Packages → `toolsai-mcp` → **Public**.

Закрытый — classic PAT с `read:packages` на сервере (`REGISTRY_*` в `deploy.env`).

## 4. Безопасность (Settings → Code security)

- [ ] Dependabot alerts и security updates — вкл.
- [ ] Secret scanning, push protection — вкл.

## Проверено

| Что | Состояние | Когда |
|---|---|---|
| Ruleset `protect-main` | не проверено | — |
| Пакет GHCR публичный | не проверено | — |
