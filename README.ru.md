# dsh-plannotator

[English](README.md) | **Русский**

<div align="center">

**Ревью файла, папки или веб-страницы в браузерном интерфейсе Plannotator — аннотации возвращаются агенту обычным сообщением в диалоге.**

[![version](https://img.shields.io/badge/version-0.1.0-4176E6)](https://github.com/martyartem/dsh-plannotator/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![tests](https://img.shields.io/badge/tests-47%20passing-3c9)](#разработка)
[![CI](https://github.com/martyartem/dsh-plannotator/actions/workflows/ci.yml/badge.svg)](https://github.com/martyartem/dsh-plannotator/actions/workflows/ci.yml)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)

</div>

---

## Зачем этот плагин

Попросить агента провести ревью в DSH мешают две вещи, и каждая бьёт по-своему.

| Что мешает | Как это выглядит для вас | Что делает плагин |
|---|---|---|
| **Ревью блокирует вызов** | Сервер ревью ждёт человека минутами, а bash-вызов в DSH отваливается по таймауту куда раньше: процесс уходит в фон, и если его убить, **замечания, которые вы уже расставили, пропадут без следа**. | Запускает ревью в фоне, сразу отдаёт ссылку, а решение доставляет в диалог, когда человек его отправит. |
| **`plannotator` не находится** | Сессия DSH стартует с `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, поэтому установка в `~/.local/bin/plannotator` в него не попадает — агент видит `plannotator: command not found` и ревью просто не запускается. | Ищет CLI сам: конфиг плагина → `PLANNOTATOR_BIN` → `PATH` → известные каталоги установки. |

## Возможности

| Что | Где | Что делает |
|---|---|---|
| Кнопка **Review** | Шапка предпросмотра документа, правая панель | Запускает ревью файла на экране. Файл, который Plannotator не примет (PDF, картинка, Office, экзотическое расширение), уходит на ревью **содержащей папкой** — кнопка никогда не ведёт в тупик. |
| `/plannotator <файл\|папка\|url>` | Композер | То же ревью из строки ввода — и это неблокирующий вход для агента. |
| `/plannotator` | Композер | Ревью рабочей папки текущей сессии. |
| `/plannotate` | Композер | Алиас. |
| Доставка аннотаций | Диалог | Запись решения (`--json`) приезжает сообщением, и агент правит документ по аннотациям в том же чате. |

Это вся поверхность: **одно** место в сайдбаре, **одна** команда и **два** HTTP-маршрута, без флагов.

## Требования

- **DeepSeek Harness** `>=0.1.0-rc.5` (объявлено в `package.json`).
- **Node** `>=20` для хостовой половины. Зависимостей во время работы нет.
- Установленный **Plannotator CLI**, доступный плагину: конфиг плагина, `PLANNOTATOR_BIN`, `PATH`
  или один из каталогов `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `~/.bun/bin`,
  `~/.cargo/bin`. Без него плагин всё равно загрузится и подскажет, как указать путь к CLI.

## Установка

### Через менеджер плагинов Harness

Откройте **Plugins** в приложении и установите этот репозиторий:

```text
https://github.com/martyartem/dsh-plannotator
```

Затем перезапустите приложение. Имя npm-пакета — `plannotator-dsh`, имя репозитория —
`dsh-plannotator`.

### Из исходников

Клонируйте куда угодно **вне** `~/.dsh` и поставьте ссылкой (`link`), а не копией, — тогда правки
доедут до профиля:

```sh
git clone https://github.com/martyartem/dsh-plannotator ~/Projects/plannotator-dsh
```

Добавьте в профиль (`~/.dsh/profiles/<профиль>/package.json`) и перезапустите приложение:

```json
{
  "dependencies": { "plannotator-dsh": "link:/Users/you/Projects/plannotator-dsh" },
  "dsh": { "profile": { "bundles": ["…", "plannotator-dsh"] } }
}
```

Откатить установку: `scripts/uninstall.sh [профиль] [--purge]`.

## Конфигурация

Значения задаются в патч-слое профиля (`cordis.patch.yml`) — пользовательский патч-слой переживает
обновления DSH:

```yaml
- id: plannotator-dsh
  name: plannotator-dsh
  config:
    gate: true
    timeoutMs: 1800000
```

| Ключ | По умолчанию | Значение |
|---|---|---|
| `binary` | автопоиск | явный путь к CLI `plannotator` |
| `binaryFallbacks` | список известных | дополнительные пути-кандидаты |
| `origin` | `dsh` | значение `PLANNOTATOR_ORIGIN`, которым помечается каждое ревью |
| `gate` | `false` | добавлять кнопку Approve в каждое ревью |
| `openBrowser` | `true` | разрешить Plannotator открывать вкладку браузера |
| `port` | случайный | зафиксировать порт локального сервера ревью |
| `timeoutMs` | `900000` | сколько ревью может висеть открытым, прежде чем его остановят |
| `readyTimeoutMs` | `20000` | сколько ждать готовности локального сервера |
| `autoFollowup` | `true` | доставлять аннотации обратно в диалог |
| `debug` | `false` | дублировать лог плагина в stderr |
| `dataDir` | `~/.dsh/storages/plannotator-dsh` | где лежит `plannotator-dsh.log` |

## Как это устроено

- **Хостовая половина** — `lib/index.js`: регистрирует команду и два маршрута, находит CLI и
  рабочую папку, запускает процесс Plannotator в фоне, ждёт файл готовности, затем читает
  запись решения из его stdout и доставляет её в сессию.
- **Браузерная половина** — `lib/client.js`: написана вручную в формате модульного загрузчика хоста
  (`window.__ModuleLoader__.load`), поэтому **сборщик не нужен** — только `react` из таблицы
  платформенных модулей. Место в интерфейсе она вносит через
  `ctx.slots.inject(seat, () => ctx.slots.register(…))` — это документированный способ не зависеть
  от порядка запуска плагинов.
- **HTTP-маршруты** — браузерная половина не импортирует сервисы хоста:

  | Маршрут | Назначение |
  |---|---|
  | `GET /plannotator/review?target=<путь\|url>[&session=<id>]` | запускает ревью в фоне, отвечает `{ ok, url, label, gate }` |
  | `POST /plannotator/log` | пересылает клиентскую заметку в лог плагина |

- **Определение рабочей папки**, по порядку: папка сессии живого агента → `DSH_WORKSPACE_DIR` /
  `DSH_CWD` → `ctx.workspaceRegistry` → `cwd` из заголовка лога сессии → самая свежая сессия →
  cwd процесса хоста.
- **Контракт доставки** — сообщение, которое получает агент, это обычный `UserMessage` DSH со всеми
  обязательными полями: `id`, `role`, `content` и `source.kind` вида `plugin:plannotator-dsh`. Путь
  записи принимает сообщение без `id`, но путь восстановления после этого отклоняет **всю сессию**
  (`session event at seq N lacks an identified message`), и история перестаёт загружаться. Плагин
  штампует `id` сам, а офлайн-набор тестов проверяет его наличие.

## Совместимость

| Зависимость | Диапазон |
|---|---|
| DeepSeek Harness | `>=0.1.0-rc.5` |
| Node | `>=20`, только встроенные модули |
| Plannotator CLI | документированный контракт: argv `annotate <target> --json`, файл готовности (`PLANNOTATOR_READY_FILE`), запись решения в stdout, `PLANNOTATOR_ORIGIN`, `PLANNOTATOR_PORT` |

## Если что-то не работает

Всё пишется в `~/.dsh/storages/plannotator-dsh/plannotator-dsh.log`. После обновления DSH или
Plannotator вся проверка — одна команда:

```sh
grep -E "loaded|apply:|registered|unavailable|steering failed" \
  ~/.dsh/storages/plannotator-dsh/plannotator-dsh.log | tail -12
```

| Строка | Что означает |
|---|---|
| `loaded …; binary=…` | хост загрузил плагин и нашёл CLI |
| `registered /plannotator/review and /plannotator/log` | HTTP-маршруты на месте |
| `client[info]: document preview action registered` | место кнопки Review существует |
| `document preview action unavailable: …` | место переименовали или убрали |
| `steering failed: …` | хост отклонил доставленное сообщение |
| `session … timed out after …` | ревью превысило `timeoutMs` и было остановлено |

Если первой строки нет — плагин вообще не загрузился, обычно из-за переименованного сервиса,
объявленного в `inject`.

## Разработка

Нужен только Node: ни установки зависимостей, ни сборщика, ни запущенного профиля.

```sh
npm test                      # обе офлайн-половины
node scripts/selftest.mjs     # хостовая половина: 35 проверок — разбор ввода, поиск CLI и папки, сессии, маршруты
node scripts/client-test.mjs  # браузерная половина: 12 проверок — форма клиентского модуля, единственное место, гонка холодного старта
node scripts/live-test.mjs    # против настоящего CLI Plannotator и его HTTP API
```

```
lib/
  index.js      хостовая строка: команда, HTTP-маршруты, выбор агента
  command.js    ввод → argv для Plannotator
  review.js     ревью в фоне, готовность, решение, доставка, таймаут
  config.js     значения конфига по умолчанию, файл лога, утилиты
  binary.js     поиск CLI, не зависящий от PATH
  workspace.js  относительно какой папки разворачивается цель
  client.js     браузерная половина: место Review в предпросмотре документа
scripts/        офлайн-наборы, живой смоук-тест, скрипт удаления
```

## Замечания и ограничения

- `annotate` принимает markdown, текстовые конфиги и данные, HTML, URL и папки. `.env` Plannotator
  отклоняет сам.
- Git-диффов, pull request'ов и архива здесь **сознательно нет**: их покрывает сам Plannotator CLI,
  а слэш-команда, которая висит минутами, — ровно то, ради чего этот плагин и написан.
- Ревью, которое никто не завершил (процесс убили, машина уснула), не даёт решения. Плагин так и
  говорит вместо того, чтобы делать вид, будто замечаний не было.
- Плагин не разбирает разметку браузерного интерфейса: он использует только документированный
  контракт stdout и файл готовности CLI.

## Лицензия

[MIT](LICENSE)
