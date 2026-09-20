# Pigeon 0.2.1

## Русский

### Исправления и улучшения

- Исправлен рывок строки отправки и появление горизонтальной прокрутки при открытии диалога.
- Улучшены плавные анимации входящих и исходящих сообщений; они теперь корректно подключаются после перехода между чатами.
- Восстановлено меню сообщения по правому клику и быстрый ответ по двойному клику для текста, изображений, карточек и соседних сообщений.
- Исправлен конфликт с длинными сообщениями: кнопка `Show more` больше не принимается за меню `…`, а пустая область рядом не перехватывает клики.
- Добавлены резервные обработчики жестов для случаев, когда внутренний слой XChat блокирует стандартное событие контекстного меню.

## English

### Fixes and improvements

- Fixed the composer shifting sideways and the horizontal scrollbar appearing when a conversation opens.
- Improved incoming and outgoing message animations and made them attach reliably after switching conversations.
- Restored the right-click message menu and double-click quick reply for text, images, cards, and adjacent messages.
- Fixed long-message handling: `Show more` is no longer mistaken for the `…` menu, and empty space beside a long message no longer captures clicks.
- Added gesture fallbacks for cases where an internal XChat layer suppresses the standard context-menu event.
