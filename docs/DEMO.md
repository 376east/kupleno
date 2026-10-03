# Запись и озвучка демо

[Итоговый ролик 0.21.0](../assets/demo/kupleno-0.21-voice.mp4) - около 57 секунд, русский синтетический голос, только вымышленные покупки. [Исходная запись без голоса](../assets/demo/kupleno-0.21-silent.mp4) - около 30 секунд. Ни одна сцена не доказывает успешность живого сбора.

## Записать интерфейс

После установки зависимостей и `npm run preview:check` подготовьте Chromium, как в [PREVIEW](PREVIEW.md#запуск). В PowerShell из корня:

```powershell
$env:KUPLENO_DESIGN_OUTPUT = Join-Path (Get-Location) 'work/demo-record'
node scripts/next-design-demo.cjs --record
```

В bash:

```sh
KUPLENO_DESIGN_OUTPUT="$PWD/work/demo-record" node scripts/next-design-demo.cjs --record
```

[Сценарий](../scripts/next-design-demo.cjs) запускает временный профиль, открывает настоящий unpacked MV3, импортирует встроенную вымышленную историю из 37 операций, показывает обзор, фильтры, темы, поиск, карточку, магазины и контроль. Рабочая база пользователя не открывается. Сетевой сбор не запускается. У магазина не нужно запрашивать доступ.

Запись сохраняется в `kupleno-demo.webm`. Нужны ffmpeg/ffprobe в PATH:

```sh
ffmpeg -i work/demo-record/kupleno-demo.webm -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart work/demo-record/silent.mp4
```

Отдельный запуск без `--record` делает снимки и проверяет мобильные страницы. Режим записи оставляет desktop-кадр 1440×1000; он не является отдельной мобильной демонстрацией.

## Добавить голос

Нужны Python 3.11+, ffmpeg/ffprobe с H.264/AAC и отдельное окружение. PowerShell:

```powershell
python -m venv work/demo-venv
work/demo-venv/Scripts/python.exe -m pip install -r scripts/demo-requirements.txt
work/demo-venv/Scripts/python.exe scripts/demo-voice.py
```

На Linux/macOS замените путь Python на `work/demo-venv/bin/python`. Результат по умолчанию: `work/demo-voice/kupleno-voice.mp4`. Скрипт использует опубликованный silent MP4 и [границы сцен/реплики](../scripts/demo-scenes.json), так что его можно выполнить без перезаписи браузера.

Голос - `ru-RU-SvetlanaNeural`, темп `+5%`. Edge TTS получает только текст сценария по сети; API-ключ в проекте не нужен. Доступность сервиса не гарантирована. Не подставляйте реальные чеки или личные сведения. Аудио кешируется по хешу текста, голоса и темпа. Повторная сборка без сети: `python scripts/demo-voice.py --offline` при наличии этого кеша. [Реализация](../scripts/demo-voice.py).

Каждая сцена начинается с паузы 0,3 секунды. Если голос длиннее исходного фрагмента, последний кадр удерживается; речь не ускоряется. Громкость нормализуется к -16 LUFS, пик ограничивается целевыми -2 dBTP; кодирование AAC может дать небольшое отклонение. Проверяются границы реплик, общая длительность и полное декодирование результата. Таймлайн лежит рядом с кешем в `timeline.json`.

**Ручной этап при новой записи:** просмотрите видео, обновите границы в `scripts/demo-scenes.json` и текст под новые экраны. Тайминги не определяются автоматически и могут немного отличаться на другом компьютере. Для новой записи передайте `--source work/demo-record/silent.mp4`. После монтажа проверьте, что реплики соответствуют кадрам; техническая проверка этого не понимает. Побайтная идентичность нового сетевого TTS не обещается.

В ролике нет музыки, чужих фото и записанного голоса человека. Рисунок чека - SVG из [components.tsx](../extension/next/ui/components.tsx), шрифты и их лицензии лежат в [extension/fonts](../extension/fonts/). Вымышленные названия товаров нужны для сценария, не являются рекламой или подтверждением покупки.
