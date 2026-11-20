# Документация Куплено

## Предпросмотр 0.22.0

Актуальный код находится в `extension/next`. Версия: [package.json](../extension/next/package.json).

- [Запуск, данные и проверки](PREVIEW.md)
- [План разработки](../PLAN.md)
- [Правила разработки](../AGENTS.md)

## Архив 0.19.2

Документы ниже описывают прежнюю реализацию `extension`. Её упаковщик не включает предпросмотр 0.22.0. [Список файлов сборки](../scripts/package-extension.sh).

- [Контракт продукта и критерии готовности](PRODUCT.md)
- [Архитектура и границы доверия](ARCHITECTURE.md)
- [Данные, совместимость, обновление и откат](DATA_AND_COMPATIBILITY.md)
- [Проверки](TESTING.md)
- [Сопровождение и реакция на поломки](MAINTENANCE.md)
- [Выпуск релиза](../RELEASE.md)
- [Поддержка](../SUPPORT.md)
- [Безопасность](../SECURITY.md)
- [Конфиденциальность](../PRIVACY.md)
- [История изменений](../CHANGELOG.md)

Версия архивной реализации хранится в [extension/manifest.json](../extension/manifest.json). Её совпадение с корневым `package.json` и разделом CHANGELOG проверяет [тест релизного процесса](../extension/release-process.test.js).
