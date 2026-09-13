const { webFrame, ipcRenderer } = require('electron');

console.log('[Pigeon Preload] Preload active');

// Невидимая метка запуска: нужна, чтобы при обновлениях XChat можно было
// отличить отсутствие preload от сбоя более поздней интеграции.
try {
  document.documentElement?.setAttribute('data-pigeon-preload', 'booted');
} catch (e) {}

// Защита от белого фона на раннем этапе парсинга
if (window.location.protocol === 'file:') {
  // Для splash.html ничего лишнего не делаем
  return;
}

try {
  if (document.documentElement) {
    document.documentElement.style.backgroundColor = '#000000';
  }
} catch (e) {}

// Подключаем до гидрации XChat, чтобы нативный ползунок ленты диалогов не
// успевал мелькнуть при старте приложения.
try {
  // В Electron 41 insertCSS в sandboxed preload возвращает ключ вставки,
  // а не Promise. Не вызываем .catch() у результата, иначе весь preload
  // прекращает выполнение и исчезают все функции Pigeon.
  webFrame.insertCSS(`
    #x-chat-conversation-list {
      scrollbar-width: none !important;
    }
    #x-chat-conversation-list::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
  `);
} catch (e) {}

// 1. Passkey fallback
const passkeyFallbackScript = `
  (() => {
    try {
      if (window.PublicKeyCredential) {
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
        if (window.PublicKeyCredential.isConditionalMediationAvailable) {
          window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
        }
      }
      if (navigator.credentials && navigator.credentials.get) {
        const origGet = navigator.credentials.get.bind(navigator.credentials);
        navigator.credentials.get = function(options) {
          if (options && options.publicKey) {
            // Возвращаем null вместо reject, чтобы предотвратить сбой React ErrorBoundary при логине
            return Promise.resolve(null);
          }
          return origGet(options);
        };
      }
    } catch (e) {}
  })();
`;
webFrame.executeJavaScript(passkeyFallbackScript).catch(() => {});

// 1.5. Двусторонний мост для перехвата нативных уведомлений XChat (Web Notification API)
// + Перехват fetch/XHR DM API для обнаружения входящих сообщений из сетевого трафика
const notificationBridgeScript = `
  (() => {
    try {
      if (window.__pigeon_bridge_active) return;
      window.__pigeon_bridge_active = true;

      function sendToPigeon(title, options) {
        try {
          // В открытом окне XChat не нужны ни системное уведомление, ни наш
          // IPC-мост. Это исключает лишнюю работу ровно в момент входящего
          // сообщения в активном диалоге.
          if (document.hasFocus() && !document.hidden) return;
          const body = (options && options.body) || '';
          const icon = (options && (options.icon || options.image)) || '';
          const tag = (options && options.tag) || '';
          console.log('[Pigeon Bridge] 🔔 Входящее нативное уведомление от движка XChat:', title, body);
          window.postMessage({
            type: 'pigeon-incoming-native-notification',
            title: title || '',
            body: body,
            icon: icon,
            tag: tag
          }, '*');
        } catch (err) {
          console.error('[Pigeon Bridge] Ошибка передачи уведомления:', err);
        }
      }

      // Полноценный класс Notification со стандартом EventTarget, чтобы XChat React не крашился при addEventListener
      const OrigNotification = window.Notification;
      class PigeonNotification extends EventTarget {
        constructor(title, options = {}) {
          super();
          sendToPigeon(title, options);
          this.title = title;
          this.body = (options && options.body) || '';
          this.icon = (options && (options.icon || options.image)) || '';
          this.tag = (options && options.tag) || '';
          this.data = (options && options.data) || null;
          this.onclick = null;
          this.onclose = null;
          this.onerror = null;
          this.onshow = null;

          setTimeout(() => {
            try {
              const ev = new Event('show');
              this.dispatchEvent(ev);
              if (typeof this.onshow === 'function') this.onshow(ev);
            } catch (e) {}
          }, 20);
        }

        close() {
          try {
            const ev = new Event('close');
            this.dispatchEvent(ev);
            if (typeof this.onclose === 'function') this.onclose(ev);
          } catch (e) {}
        }
      }

      if (OrigNotification) {
        try { Object.setPrototypeOf(PigeonNotification, OrigNotification); } catch (e) {}
        try { Object.setPrototypeOf(PigeonNotification.prototype, OrigNotification.prototype); } catch (e) {}
      }
      PigeonNotification.permission = 'granted';
      PigeonNotification.requestPermission = () => Promise.resolve('granted');
      PigeonNotification.maxActions = 2;
      window.Notification = PigeonNotification;

      // Перехват ServiceWorker showNotification
      function patchSWR() {
        try {
          if (typeof ServiceWorkerRegistration !== 'undefined' && ServiceWorkerRegistration.prototype) {
            const orig = ServiceWorkerRegistration.prototype.showNotification;
            if (!orig || !orig.__pigeon_patched) {
              ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
                sendToPigeon(title, options);
                return Promise.resolve();
              };
              ServiceWorkerRegistration.prototype.showNotification.__pigeon_patched = true;
            }
          }
        } catch (e) {}
      }
      patchSWR();
      setTimeout(patchSWR, 2000);
      setTimeout(patchSWR, 5000);

      // Функция проверки запросов отметки о прочтении (URL + POST body)
      function isReadReceipt(url = '', bodyStr = '') {
        const lowUrl = String(url || '').toLowerCase();
        const lowBody = String(bodyStr || '').toLowerCase();
        const patterns = [
          'last_seen', 'lastseen', 'updatelastseen', 'update_last_seen',
          'last_read', 'lastread', 'updatelastread', 'update_last_read',
          'read_event', 'readevent', 'lastreadeventid', 'last_read_event_id',
          'lastseeneventid', 'last_seen_event_id', 'updatelastseeneventid', 'updatelastreadeventid',
          'mark_read', 'markread', 'markasread', 'mark_as_read',
          'read_receipt', 'readreceipt', 'readreceipts', 'read_receipts',
          'dm_seen', 'dmseen', 'seen_event', 'dm_read', 'dmread',
          'conversationlastseen', 'conversation_last_seen',
          'updatereceipt', 'update_receipt'
        ];
        for (const p of patterns) {
          if (lowUrl.includes(p) || lowBody.includes(p)) return true;
        }
        return false;
      }

      // В активном окне XChat сам обновляет чат. Pigeon нужны сетевые
      // сигналы только в фоне — иначе они запускают лишние обходы DOM.
      function shouldNotifyPigeonInBackground() {
        return document.hidden || !document.hasFocus();
      }

      // Сетевой транспорт XChat не подменяем. Любая обёртка WebSocket/fetch/XHR
      // может нарушить внутренние GraphQL-состояния отдельного диалога.
      try {
        const OrigWebSocket = window.WebSocket;
        if (false && OrigWebSocket && !OrigWebSocket.__pigeon_patched) {
          const PatchedWebSocket = function(...args) {
            const ws = new OrigWebSocket(...args);
            console.log('[Pigeon WS] 🔌 WebSocket подключен:', args[0]);
            const origWsSend = ws.send.bind(ws);
            ws.send = function(data) {
              if (window.__pigeon_ghost_mode) {
                let textData = '';
                if (typeof data === 'string') {
                  textData = data;
                } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                  try { textData = new TextDecoder().decode(data); } catch (e) {}
                }
                if (textData && isReadReceipt('', textData)) {
                  console.log('[Pigeon Ghost] 👻 Заблокирован WebSocket запрос отметки о прочтении:', textData.slice(0, 100));
                  return;
                }
              }
              return origWsSend(data);
            };
            ws.addEventListener('message', (event) => {
              try {
                if (shouldNotifyPigeonInBackground()) {
                  window.postMessage({ type: 'pigeon-realtime-event' }, '*');
                }
              } catch (e) {}
            });
            return ws;
          };
          PatchedWebSocket.prototype = OrigWebSocket.prototype;
          try { Object.setPrototypeOf(PatchedWebSocket, OrigWebSocket); } catch (e) {}
          PatchedWebSocket.CONNECTING = 0;
          PatchedWebSocket.OPEN = 1;
          PatchedWebSocket.CLOSING = 2;
          PatchedWebSocket.CLOSED = 3;
          PatchedWebSocket.__pigeon_patched = true;
          window.WebSocket = PatchedWebSocket;
        }
      } catch (e) {}

      // Не перехватываем console: XChat использует его в собственных диагностических потоках.
      try {
        const origConsoleLog = console.log;
        if (false) console.log = function(...args) {
          origConsoleLog.apply(console, args);
          try {
            if (shouldNotifyPigeonInBackground()) {
              const first = typeof args[0] === 'string' ? args[0] : '';
              if (first && (first.includes('NotificationBatchingDriver') || first.includes('notif_batch'))) {
                window.postMessage({ type: 'pigeon-realtime-event' }, '*');
              }
            }
          } catch (e) {}
        };
      } catch (e) {}

      // 2.1. Фильтр телеметрии Twitter: глушим scribe, jot, ces и метрики.
      // Twitter отправляет десятки фоновых запросов на каждое нажатие клавиши и получение сообщения,
      // что забивает сетевую очередь GraphQL и приводит к многосекундным задержкам отправки сообщений!
      function isTelemetryOrTracking(url = '') {
        const u = String(url || '').toLowerCase();
        return u.includes('/i/api/1.1/jot/') ||
               u.includes('/jot/client_event') ||
               u.includes('ces.twitter.com') ||
               u.includes('/i/api/1.1/branch/') ||
               u.includes('fps_meter') ||
               u.includes('scribe');
      }

      // 2.5. Сетевой Ghost Mode отключён: XChat объединяет last-seen и
      // отправку сообщений в одной GraphQL-мутации, поэтому блокировка таких
      // запросов приводила к ретраям и заметным зависаниям.
      try {
        window.__pigeon_ghost_mode = false;
        localStorage.setItem('pigeon_ghost_mode', 'false');
      } catch (e) {
        window.__pigeon_ghost_mode = false;
      }
      window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'pigeon-set-ghost-mode') {
          window.__pigeon_ghost_mode = false;
          try { localStorage.setItem('pigeon_ghost_mode', 'false'); } catch (e) {}
        }
      });

      // Не подменяем fetch: XChat сам управляет очередью своих запросов.
      const origFetch = window.fetch;
      if (false && origFetch && !origFetch.__pigeon_patched) {
        const PatchedFetch = function(...args) {
          const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';

          // Мгновенный ответ для телеметрии Twitter без выхода в сеть
          if (isTelemetryOrTracking(url)) {
            return Promise.resolve(new Response('{"status":"ok"}', {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }));
          }

          const promise = origFetch.apply(this, args);

          if (shouldNotifyPigeonInBackground() && (url.includes('/dm/') || url.includes('inbox') || url.includes('conversation') || url.includes('XChat') || url.includes('timeline'))) {
            promise.then(response => {
              if (!response || !response.ok) return;
              window.postMessage({ type: 'pigeon-dm-api-response', url: url }, '*');
            }).catch(() => {});
          }
          return promise;
        };
        PatchedFetch.__pigeon_patched = true;
        window.fetch = PatchedFetch;
      }

      // Не подменяем XMLHttpRequest.
      try {
      } catch (e) {}

      // Не подменяем sendBeacon.
      try {
        if (false && navigator.sendBeacon) {
          const origBeacon = navigator.sendBeacon.bind(navigator);
          navigator.sendBeacon = function(url, data) {
            if (isTelemetryOrTracking(url)) {
              return true;
            }
            return origBeacon(url, data);
          };
        }
      } catch (e) {}

      console.log('[Pigeon Bridge] 🚀 Мост уведомлений + WebSocket + fetch + Telemetry Killer успешно активен');
    } catch (e) {
      console.error('[Pigeon Bridge] Ошибка установки моста:', e);
    }
  })();
`;
webFrame.executeJavaScript(notificationBridgeScript).catch(() => {});

// Константы таймингов и дедупликации
// Не запускаем тяжёлый обход чатов на каждую мелкую перерисовку React.
// Во время набора сообщения XChat создаёт много DOM-узлов, не связанных с
// непрочитанными сообщениями; более спокойный debounce не мешает уведомлениям.
const SCAN_THROTTLE_MS = 650;
const NOTIFICATION_COOLDOWN_MS = 300;

// Хранилище уведомлений по ID диалога (convKey -> { text, time })
const lastNotifiedByConv = new Map();
let currentUnreadCount = -1;
let consecutiveZeroCount = 0;
let isInitialScan = true;
setTimeout(() => {
  isInitialScan = false;
  console.log('[Pigeon Preload] 🏁 Начальный прогрев завершен (isInitialScan = false)');
}, 5000);

// Очистка устаревших записей каждые 10 минут (защита от утечки памяти)
setInterval(() => {
  const cutoff = Date.now() - 3600000; // 1 час
  for (const [key, val] of lastNotifiedByConv) {
    if (val.time < cutoff) lastNotifiedByConv.delete(key);
  }
}, 600000);

let scheduledScanTimer = null;
let scheduledUnreadScan = false;
let scheduledActiveMessageScan = false;
let composerBusyUntil = 0;
let composerResumeTimer = null;
const ENABLE_RENDERER_PROFILING = false;

function isComposerTarget(target) {
  return Boolean(target && target.closest && target.closest(
    '[data-testid="dmComposer"], textarea, [contenteditable="true"]'
  ));
}

function isComposerBusy() {
  return Date.now() < composerBusyUntil;
}

function noteComposerActivity(event) {
  if (!isComposerTarget(event.target)) return;
  // Один короткий профиль захватывает именно период «печать → отправка».
  // Он нужен для поиска долгой задачи и не читает содержимое поля.
  if (ENABLE_RENDERER_PROFILING && isPigeonWindowActive()) {
    ipcRenderer.send('renderer-performance-trace-start');
  }
  // Помечаем, что пользователь активен в композере: подавляем любые фоновые обходы DOM
  composerBusyUntil = Date.now() + 1200;
  if (composerResumeTimer) clearTimeout(composerResumeTimer);
  composerResumeTimer = setTimeout(() => {
    composerResumeTimer = null;
    if (!isPigeonWindowActive()) {
      requestChatScan({ delay: 0 });
    }
  }, 1250);
}

window.addEventListener('keydown', noteComposerActivity, true);
window.addEventListener('input', noteComposerActivity, true);

// Короткий локальный профиль для сравнения тяжёлого и обычного диалога.
// Никаких текстов, имён или адресов переписки сюда не попадает.
let longTaskCount = 0;
let longestTaskMs = 0;
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTaskCount += 1;
      longestTaskMs = Math.max(longestTaskMs, Math.round(entry.duration));
    }
  }).observe({ type: 'longtask', buffered: true });
} catch (e) {}

function recordRendererProfile(kind) {
  if (!ENABLE_RENDERER_PROFILING) return;
  if (!isPigeonWindowActive()) return;
  const payload = {
    kind,
    at: Date.now(),
    domNodes: document.getElementsByTagName('*').length,
    longTaskCount,
    longestTaskMs,
    heapBytes: performance.memory ? performance.memory.usedJSHeapSize : null
  };
  longTaskCount = 0;
  longestTaskMs = 0;
  ipcRenderer.send('renderer-performance-sample', payload);
}

function isPigeonWindowActive() {
  return document.hasFocus() && !document.hidden;
}

// =========================================================================
// PIGEON INSTANT OPTIMISTIC UI ENGINE
// Моментальное (0 мс) отображение отправленного сообщения в интерфейсе чата.
// Устраняет нативный 5-секундный лаг веб-версии XChat при отправке.
// =========================================================================
// XChat already adds an optimistic bubble itself. A second Pigeon bubble made
// slow conversations worse by forcing repeated full-DOM reconciliation.
const ENABLE_PIGEON_OPTIMISTIC_MESSAGES = false;
const pendingOptimisticMessages = new Map(); // retained only for old-session cleanup

function getActiveMessageScroller() {
  const direct = document.querySelector(
    '[data-testid="DmScroller"], [data-testid="dm-conversation"], [data-testid="message-list"], main, [role="main"]'
  );
  if (direct) return direct;
  return null;
}

function getComposerInputEl() {
  return document.querySelector(
    '[data-testid="dmComposer"] [contenteditable="true"], [data-testid="dmComposer"] textarea, div[contenteditable="true"][role="textbox"]'
  );
}

function getComposerText() {
  const el = getComposerInputEl();
  if (!el) return '';
  return (el.innerText || el.textContent || el.value || '').trim();
}

function createOptimisticMessageElement(text) {
  const optId = 'pigeon-opt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const wrapper = document.createElement('div');
  wrapper.id = optId;
  wrapper.className = 'pigeon-optimistic-entry justify-end';
  wrapper.setAttribute('data-pigeon-optimistic', 'true');
  wrapper.setAttribute('data-pigeon-text', text);
  wrapper.style.cssText = `
    display: flex !important;
    justify-content: flex-end !important;
    width: 100% !important;
    padding: 3px 12px !important;
    box-sizing: border-box !important;
    animation: pigeonOptAppear 110ms cubic-bezier(0.16, 1, 0.3, 1) both !important;
    will-change: transform, opacity !important;
  `;

  const bubble = document.createElement('div');
  bubble.style.cssText = `
    max-width: min(540px, 82%) !important;
    background-color: #1d9bf0 !important;
    color: #ffffff !important;
    padding: 9px 14px !important;
    border-radius: 18px 18px 4px 18px !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    font-size: 15px !important;
    line-height: 20px !important;
    word-break: break-word !important;
    white-space: pre-wrap !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25) !important;
    position: relative !important;
  `;

  const contentSpan = document.createElement('span');
  contentSpan.textContent = text;
  bubble.appendChild(contentSpan);

  const footer = document.createElement('div');
  footer.style.cssText = `
    display: flex !important;
    align-items: center !important;
    justify-content: flex-end !important;
    gap: 4px !important;
    font-size: 11px !important;
    color: rgba(255, 255, 255, 0.72) !important;
    margin-top: 3px !important;
    user-select: none !important;
  `;

  const timeEl = document.createElement('span');
  timeEl.textContent = timeStr;
  footer.appendChild(timeEl);

  const spinner = document.createElement('span');
  spinner.className = 'pigeon-opt-spinner';
  spinner.style.cssText = `
    display: inline-block !important;
    width: 9px !important;
    height: 9px !important;
    border: 1.5px solid rgba(255, 255, 255, 0.85) !important;
    border-top-color: transparent !important;
    border-radius: 50% !important;
    animation: pigeonOptSpin 0.7s linear infinite !important;
  `;
  footer.appendChild(spinner);
  bubble.appendChild(footer);
  wrapper.appendChild(bubble);

  return { id: optId, wrapper, text };
}

function triggerInstantOptimisticSend(text) {
  if (!ENABLE_PIGEON_OPTIMISTIC_MESSAGES) return;
  if (!text || !text.trim()) return;
  const clean = text.trim();
  const scroller = getActiveMessageScroller();
  if (!scroller) return;

  const messageList = scroller.querySelector(
    '[data-testid="cellInnerDiv"]'
  )?.parentElement || scroller.querySelector('div[style*="min-height"]') || scroller;

  const opt = createOptimisticMessageElement(clean);
  messageList.appendChild(opt.wrapper);
  pendingOptimisticMessages.set(opt.id, { text: clean, node: opt.wrapper, time: Date.now() });

  try {
    scroller.scrollTo({ top: scroller.scrollHeight + 400, behavior: 'smooth' });
  } catch (e) {}

  setTimeout(() => {
    if (pendingOptimisticMessages.has(opt.id)) {
      pendingOptimisticMessages.delete(opt.id);
      if (opt.wrapper && opt.wrapper.isConnected) {
        const sp = opt.wrapper.querySelector('.pigeon-opt-spinner');
        if (sp) {
          sp.style.border = 'none';
          sp.style.animation = 'none';
          sp.textContent = '✓';
        }
      }
    }
  }, 25000);
}

function reconcileOptimisticWithNative() {
  if (!ENABLE_PIGEON_OPTIMISTIC_MESSAGES) return;
  if (pendingOptimisticMessages.size === 0) return;
  const nativeElements = document.querySelectorAll(
    '[data-testid^="dm-message-"]:not([data-pigeon-optimistic]), [data-testid="messageEntry"]:not([data-pigeon-optimistic])'
  );
  if (!nativeElements || nativeElements.length === 0) return;

  for (const [id, item] of pendingOptimisticMessages.entries()) {
    for (let i = nativeElements.length - 1; i >= Math.max(0, nativeElements.length - 8); i--) {
      const el = nativeElements[i];
      const textEl = el.querySelector('[data-testid^="message-text-"], [data-testid="tweetText"]') || el;
      const nativeText = (textEl.textContent || '').trim();
      if (nativeText === item.text) {
        pendingOptimisticMessages.delete(id);
        if (item.node && item.node.isConnected) {
          item.node.style.transition = 'opacity 80ms ease';
          item.node.style.opacity = '0';
          setTimeout(() => {
            if (item.node && item.node.isConnected) item.node.remove();
          }, 80);
        }
        break;
      }
    }
  }
}

function isSendAction(target) {
  return Boolean(target && target.closest && target.closest(
    '[data-testid="dmComposerSendButton"], button[data-testid*="send" i], [aria-label*="Send" i], [aria-label*="Отправить" i]'
  ));
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && isComposerTarget(event.target)) {
    setTimeout(() => recordRendererProfile('send'), 1200);
  }
}, true);
window.addEventListener('click', (event) => {
  if (isSendAction(event.target)) setTimeout(() => recordRendererProfile('send'), 1200);
}, true);

// Перехват отправки с клавиатуры (Enter без Shift)
window.addEventListener('keydown', (event) => {
  if (!ENABLE_PIGEON_OPTIMISTIC_MESSAGES) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    if (isComposerTarget(event.target)) {
      const text = getComposerText();
      if (text) {
        setTimeout(() => triggerInstantOptimisticSend(text), 1);
      }
    }
  }
}, true);

// Перехват отправки по клику на кнопку «Отправить»
window.addEventListener('click', (event) => {
  if (!ENABLE_PIGEON_OPTIMISTIC_MESSAGES) return;
  const target = event.target;
  if (!target || !target.closest) return;
  const sendBtn = target.closest(
    '[data-testid="dmComposerSendButton"], button[data-testid*="send" i], [aria-label*="Send" i], [aria-label*="Отправить" i]'
  );
  if (sendBtn) {
    const text = getComposerText();
    if (text) {
      setTimeout(() => triggerInstantOptimisticSend(text), 1);
    }
  }
}, true);

function requestChatScan({ unread = true, activeMessage = true, delay = SCAN_THROTTLE_MS } = {}) {
  // Когда окно открыто перед пользователем, XChat сам рисует сообщения и
  // Pigeon не требуется ни уведомление, ни бейдж. Главное — не конкурировать
  // с React за главный поток после клика «Отправить».
  if (isPigeonWindowActive()) return;

  scheduledUnreadScan ||= unread;
  // Для открытого и сфокусированного диалога уведомление всё равно не нужно:
  // его состояние синхронизирует сам XChat. Не делаем полный querySelectorAll
  // сообщений на каждое нажатие клавиши.
  scheduledActiveMessageScan ||= activeMessage && !isPigeonWindowActive();

  if (isComposerBusy()) {
    if (scheduledScanTimer) {
      clearTimeout(scheduledScanTimer);
      scheduledScanTimer = null;
    }
    return;
  }

  if (scheduledScanTimer) return;
  scheduledScanTimer = setTimeout(() => {
    scheduledScanTimer = null;
    const shouldScanUnread = scheduledUnreadScan;
    const shouldScanActiveMessage = scheduledActiveMessageScan;
    scheduledUnreadScan = false;
    scheduledActiveMessageScan = false;
    if (isPigeonWindowActive()) return;
    if (shouldScanUnread) scanXChatUnread();
    if (shouldScanActiveMessage) scanActiveChatMessages();
  }, delay);
}

function triggerFullScan() {
  requestChatScan({ delay: 0 });
}

function mutationMayContainChatUpdate(records) {
  for (const record of records) {
    if (isComposerTarget(record.target)) continue;
    if (!record.addedNodes || record.addedNodes.length === 0) continue;
    for (const node of record.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node;
      if (
        element.matches?.('[data-testid^="dm-"], [data-testid="messageEntry"], [data-testid^="message-"]:not([data-testid^="message-text-"]), [role="listitem"]') ||
        element.querySelector?.('[data-testid^="dm-"], [data-testid="messageEntry"], [data-testid^="message-"]:not([data-testid^="message-text-"]), [role="listitem"]')
      ) return true;
    }
  }
  return false;
}

// Проверка: открыт ли данный диалог прямо сейчас перед пользователем в активном окне
function isCurrentConversationActive(convId, sender) {
  try {
    const isDocFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    if (!isDocFocused || document.hidden) {
      return false;
    }

    const pathname = window.location.pathname || '';
    const convMatch = pathname.match(/\/(?:i\/chat|messages)\/([0-9a-zA-Z_-]+)/);
    const currentUrlConvId = convMatch ? convMatch[1] : '';
    if (convId && currentUrlConvId) {
      if (convId === currentUrlConvId || currentUrlConvId.includes(convId) || convId.includes(currentUrlConvId)) {
        return true;
      }
    }

    if (sender) {
      const header = document.querySelector('[data-testid="dm-conversation-header"], [data-testid="conversation-header"], [data-testid="DmScroller-header"], [data-testid="TopNavBar"]');
      if (header) {
        const titleEl = header.querySelector('[data-testid="dm-conversation-username"], h2, span[dir], [role="heading"]');
        if (titleEl) {
          const headerText = (titleEl.innerText || titleEl.textContent || '').trim().toLowerCase();
          const senderText = String(sender).trim().toLowerCase();
          if (headerText && senderText) {
            const cleanHeader = headerText.replace(/[^\p{L}\p{N}]/gu, '');
            const cleanSender = senderText.replace(/[^\p{L}\p{N}]/gu, '');
            if (cleanHeader && cleanSender && (cleanHeader === cleanSender || cleanHeader.includes(cleanSender) || cleanSender.includes(cleanHeader))) {
              return true;
            }
          }
        }
      }
    }

    const activeRow = document.querySelector('[data-testid^="dm-conversation-item-"][aria-selected="true"], [role="listitem"][aria-selected="true"], [data-testid="dm-conversation-item-"].selected');
    if (activeRow) {
      const rText = (activeRow.innerText || activeRow.textContent || '').toLowerCase();
      if (sender && rText.includes(String(sender).toLowerCase())) {
        return true;
      }
    }
  } catch (e) {}

  return false;
}

// Слушаем перехваченные уведомления из главного мира страницы
window.addEventListener('message', (event) => {
  if (event.source !== window || (event.origin && event.origin !== window.location.origin)) {
    return;
  }
  if (event.data && event.data.type === 'pigeon-incoming-native-notification') {
    const { title, body, icon, tag } = event.data;
    console.log(`[Pigeon Preload] 🔔 Получено перехваченное сообщение: [${title}] "${body}"`);

    if (body && (body.startsWith('You:') || body.startsWith('Вы:') || isTypingIndicator(body))) {
      return;
    }

    const now = Date.now();
    const sender = title || 'XChat';
    let convId = null;
    if (tag) {
      const match = tag.match(/(?:conversation|chat|dm)[-_]?([0-9a-zA-Z_-]+)/i);
      if (match) convId = match[1];
    }
    const convKey = convId || sender;
    const last = lastNotifiedByConv.get(convKey);

    // Если пользователь прямо сейчас сидит в этом чате в активном окне — глушим уведомления и звук
    if (isCurrentConversationActive(convId, sender)) {
      console.log(`[Pigeon Preload] 👁️ Чат [${convKey}] сейчас открыт и активен — уведомление и звук подавлены`);
      lastNotifiedByConv.set(convKey, { text: body, time: now });
      return;
    }

    if (!last || last.text !== body) {
      lastNotifiedByConv.set(convKey, { text: body, time: now });
      ipcRenderer.send('incoming-message', {
        conversationId: convId,
        title: sender,
        body: body,
        avatarUrl: icon || null,
        mediaType: null,
        isGroup: false,
        isAppFocused: document.hasFocus() && !document.hidden
      });
    }

    // Если в трее 0, сразу инкрементируем
    if (currentUnreadCount <= 0) {
      currentUnreadCount = 1;
      ipcRenderer.send('unread-count', currentUnreadCount);
    }
    if (!isPigeonWindowActive()) setTimeout(triggerFullScan, 300);
  }

  // Перехвачен WebSocket или ответ DM API — немедленный каскадный скан
  if (event.data && (event.data.type === 'pigeon-dm-api-response' || event.data.type === 'pigeon-realtime-event')) {
    // В фоне достаточно двух объединённых проходов. Раньше четыре обхода
    // запускались и при собственной отправке сообщения в активном окне.
    if (!isPigeonWindowActive()) {
      setTimeout(triggerFullScan, 250);
      setTimeout(triggerFullScan, 1200);
    }
  }
});

// 2. Интеллектуальный детектор непрочитанных сообщений в XChat

function isColoredDot(el) {
  try {
    if (!el || el.nodeType !== 1) return false;

    // 1. Проверка data-icon и классов XChat (chat.x.com)
    const icon = el.getAttribute('data-icon') || '';
    if (icon === 'icon-circle-fill') return true;

    const className = (typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '').toLowerCase();
    if (className.includes('text-chat-accent') || className.includes('bg-chat-accent')) {
      return true;
    }

    if (el.parentElement) {
      const pIcon = el.parentElement.getAttribute('data-icon') || '';
      if (pIcon === 'icon-circle-fill') return true;
      const pClass = (typeof el.parentElement.className === 'string' ? el.parentElement.className : (el.parentElement.className && el.parentElement.className.baseVal) || '').toLowerCase();
      if (pClass.includes('text-chat-accent') || pClass.includes('bg-chat-accent')) {
        return true;
      }
    }

    // 2. Быстрая проверка атрибутов доступности и testid
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if (aria.includes('unread') || aria.includes('непрочит') || aria.includes('нове') || aria.includes('new')) {
      return true;
    }

    const testid = (el.getAttribute('data-testid') || '').toLowerCase();
    if (testid.includes('unread') || testid.includes('badge') || testid.includes('dot') || testid.includes('indicator')) {
      return true;
    }

    // 3. Проверка текста: числовой бейдж непрочитанных (например "1", "2", "3")
    const text = (el.textContent || '').trim();
    if (/^[1-9]\d{0,3}$/.test(text)) {
      const w = el.offsetWidth || el.clientWidth || 0;
      const h = el.offsetHeight || el.clientHeight || 0;
      if (w > 0 && h > 0 && w <= 44 && h <= 44) {
        return true;
      }
    }

    // 4. Проверка размеров: circle в SVG
    const tag = el.tagName.toLowerCase();
    const isCircle = tag === 'circle';

    let isDotSize = false;
    if (isCircle) {
      const r = parseFloat(el.getAttribute('r') || '0');
      isDotSize = r > 0 && r <= 20;
    } else {
      const cw = el.offsetWidth || el.clientWidth || 0;
      const ch = el.offsetHeight || el.clientHeight || 0;
      if (cw > 0 && ch > 0 && cw <= 32 && ch <= 32) {
        isDotSize = true;
      } else if (cw === 0 && (className.includes('rounded-full') || className.includes('badge') || className.includes('dot'))) {
        isDotSize = true;
      }
    }

    if (!isDotSize) {
      return false;
    }

    // 5. Цветовой анализ для кандидата подходящего размера
    const inlineBg = (el.style && el.style.backgroundColor) || '';
    const inlineFill = el.getAttribute('fill') || (el.style && el.style.fill) || '';
    let color = inlineBg || inlineFill;
    if (!color) {
      const style = window.getComputedStyle(el);
      color = (style ? style.backgroundColor : '') || (style ? style.fill : '') || '';
    }

    if (!color || color === 'none' || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') {
      return false;
    }

    // Акцентные цвета X (Twitter Blue rgb(29, 155, 240), Green rgb(0, 186, 124) и т.д.)
    if (color.includes('186, 124') || color.includes('0, 186') || 
        color.includes('29, 155') || color.includes('249, 24') || 
        color.includes('120, 86') || color.includes('255, 122') || 
        color.includes('255, 212') || color.includes('34, 197') || color.includes('22, 163')) {
      return true;
    }

    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const r = parseInt(match[1], 10);
      const g = parseInt(match[2], 10);
      const b = parseInt(match[3], 10);
      const diff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
      if (diff >= 16 && (r > 30 || g > 30 || b > 30)) {
        return true;
      }
    }

    return false;
  } catch (e) {
    return false;
  }
}

// Извлечение данных диалога из React Props (KMP previewWithMetadata)
function getReactConversationData(chatRow) {
  try {
    // 0. Извлекаем conversationId и статус mute из DOM для подстраховки
    let domConvId = null;
    const testId = chatRow.getAttribute('data-testid') || '';
    const testIdMatch = testId.match(/^dm-conversation-item-(.+)$/);
    if (testIdMatch) {
      domConvId = testIdMatch[1];
    } else {
      const link = chatRow.querySelector('a[href*="/i/chat/"], a[href*="/messages/"]');
      if (link) {
        const hrefMatch = (link.getAttribute('href') || '').match(/\/(?:i\/chat|messages)\/([0-9a-zA-Z_-]+)/);
        if (hrefMatch) domConvId = hrefMatch[1];
      }
    }

    const domMuted = Boolean(chatRow.querySelector(
      '[data-icon*="bell-slash"], [data-icon*="volume-off"], [data-icon*="mute"], [data-testid*="mute"], [aria-label*="mute" i], [aria-label*="заглуш" i], [aria-label*="без звука" i]'
    ));

    for (const key in chatRow) {
      if (key.startsWith('__reactProps$') || key.startsWith('__reactFiber$')) {
        const p = chatRow[key];
        const preview = p?.children?.props?.children?.props?.previewWithMetadata ||
                        p?.children?.props?.previewWithMetadata ||
                        p?.memoizedProps?.children?.props?.children?.props?.previewWithMetadata ||
                        p?.memoizedProps?.children?.props?.previewWithMetadata ||
                        p?.previewWithMetadata;
        if (preview) {
          const isUnread = Boolean(preview.isUnreadByMe);
          const meta = preview.metadata?.metadata;
          const convId = preview.conversationId ||
                         preview.metadata?.conversationId ||
                         meta?.conversationId ||
                         preview.id ||
                         preview.conversationKey ||
                         domConvId;

          const isMuted = Boolean(preview.isMuted || meta?.isMuted || preview.metadata?.isMuted || preview.notificationsDisabled || meta?.notificationsDisabled || domMuted);
          const isGroup = Boolean(meta?.isGroup || preview.isGroup || preview.metadata?.isGroup || meta?.conversationType === 'GROUP' || meta?.conversationType === 2 || (Array.isArray(meta?.participants) && meta.participants.length > 2));

          const sender = meta?.titleState?.title ||
                         meta?.titleState?.otherParticipant?.user?.name ||
                         meta?.titleState?.otherParticipant?.user?.screenName || '';
          const previewObj = preview.preview?.latestMessagePreview;
          let text = '';
          if (typeof previewObj?.messagePreviewText === 'string') {
            text = previewObj.messagePreviewText;
          } else if (previewObj?.messagePreviewText?.text) {
            text = previewObj.messagePreviewText.text;
          }

          let mediaType = null;
          if (previewObj?.avCallCard || previewObj?.call) {
            mediaType = 'call';
          } else if (previewObj?.attachments && Array.isArray(previewObj.attachments) && previewObj.attachments.length > 0) {
            const att = previewObj.attachments[0];
            const attType = (att.__typename || att.type || att.kind || '').toLowerCase();
            if (attType.includes('audio') || attType.includes('voice')) {
              mediaType = 'voice';
            } else if (attType.includes('video')) {
              mediaType = 'video';
            } else if (attType.includes('gif')) {
              mediaType = 'gif';
            } else if (attType.includes('image') || attType.includes('photo')) {
              mediaType = 'photo';
            } else if (attType.includes('call')) {
              mediaType = 'call';
            } else if (attType.includes('file') || attType.includes('document')) {
              mediaType = 'file';
            }
          }

          let avatarUrl = null;
          const userObj = meta?.titleState?.otherParticipant?.user;
          if (userObj?.profileImageUrlHttps) {
            avatarUrl = userObj.profileImageUrlHttps;
          } else if (userObj?.avatarUrl) {
            avatarUrl = userObj.avatarUrl;
          }
          const lastEventId = preview.lastEventId ||
                              preview.preview?.latestMessagePreview?.id ||
                              preview.metadata?.metadata?.lastEventId ||
                              meta?.lastEventId ||
                              preview.metadata?.lastEventId ||
                              null;

          if (sender || text || typeof preview.isUnreadByMe === 'boolean') {
            return {
              isUnread,
              conversationId: convId || null,
              lastEventId: lastEventId || null,
              sender: sender || 'XChat',
              text: text || '',
              avatarUrl: avatarUrl || null,
              isMuted,
              isGroup,
              mediaType,
              fromReact: true
            };
          }
        }
      }
    }
  } catch (e) {}
  return null;
}

// Получение всех строк диалогов (XChat chat.x.com + Twitter web x.com/messages)
function getAllChatRows() {
  const container = document.querySelector('[data-testid="dm-conversation-scroller"], [id="x-chat-conversation-list"], [data-testid="DmActivityFeed"], [data-testid="DMDrawer"], [data-testid="primaryColumn"], main, [role="main"]') || document.body;

  // 1. Новые строки диалогов XChat
  let rows = Array.from(container.querySelectorAll('[data-testid^="dm-conversation-item-"]'));

  // 2. Старый интерфейс сообщений Twitter (fallback)
  if (rows.length === 0) {
    rows = Array.from(container.querySelectorAll('[data-testid="conversation"]'));
  }
  if (rows.length === 0) {
    rows = Array.from(container.querySelectorAll('[data-testid="cellInnerDiv"], [data-testid="UserCell"]'));
  }
  if (rows.length === 0) {
    rows = Array.from(document.querySelectorAll('[role="row"], [role="listitem"]'));
  }

  // Исключаем вложенные дубликаты, карточку настроек Pigeon и контейнеры ввода
  rows = rows.filter(r => !rows.some(other => other !== r && other.contains(r)));
  rows = rows.filter(r => !r.closest('.pigeon-settings-card, [data-testid="dmComposer"], [data-testid="dm-composer-container"], form'));

  return rows;
}

// XChat меняет data-testid контейнера списка между релизами. Находим реальный
// прокручиваемый родитель по уже найденной строке диалога и помечаем только его.
// Это однократная операция после загрузки, а не скан при каждом сообщении.
function markConversationScrollbar() {
  try {
    const row = getAllChatRows().find(isVisibleElement);
    if (!row) return;
    let candidate = row.parentElement;
    while (candidate && candidate !== document.body) {
      const style = getComputedStyle(candidate);
      if (candidate.scrollHeight > candidate.clientHeight + 2 &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
        candidate.classList.add('pigeon-conversation-scroll-area');
        // XChat задаёт этому списку собственный 4px-серый скроллбар. Убираем
        // только этот служебный класс у ленты диалогов, чтобы наш стиль не
        // был переопределён; разметку, прокрутку и виртуализацию не трогаем.
        candidate.classList.remove('scrollbar-thin-custom');
        return;
      }
      candidate = candidate.parentElement;
    }
  } catch (e) {}
}

// Определение статуса непрочитанности для строки диалога
function isRowUnread(chatRow) {
  try {
    // 1. Прямая проверка нативных индикаторов XChat
    if (chatRow.querySelector('[data-icon="icon-circle-fill"], .text-chat-accent, .bg-chat-accent')) {
      return true;
    }

    // 2. Проверка через React Props/Fiber (KMP previewWithMetadata.isUnreadByMe)
    const rData = getReactConversationData(chatRow);
    if (rData && typeof rData.isUnread === 'boolean') {
      return rData.isUnread;
    }

    // 3. Стандартные атрибуты доступности Twitter Web
    const rowAria = (chatRow.getAttribute('aria-label') || '').toLowerCase();
    if (rowAria.includes('unread') || rowAria.includes('непрочит')) {
      return true;
    }
    if (chatRow.querySelector('[data-testid*="unread" i], [aria-label*="unread" i], [aria-label*="непрочит" i]')) {
      return true;
    }

    // 4. Поиск по дочерним элементам-кандидатам (точки, бейджи, круги)
    const candidates = chatRow.querySelectorAll('circle, svg, span, div');
    for (const el of candidates) {
      if (isColoredDot(el)) return true;
    }
  } catch (e) {}

  return false;
}

function findChatRow(el) {
  // Исключаем элементы настроек, радиокнопок, переключателей и чекбоксов
  if (el.closest('[role="radio"], [role="radiogroup"], [role="switch"], [role="checkbox"], input, [data-testid*="settings"], [aria-checked], .pigeon-settings-card')) {
    return null;
  }

  // 1. Проверяем прямые селекторы строки диалога
  const directConv = el.closest('[data-testid^="dm-conversation-item-"], [data-testid="conversation"], [data-testid="cellInnerDiv"], [role="row"], [role="listitem"]');
  if (directConv) {
    return directConv;
  }

  // 2. Ищем родительский контейнер строки диалога
  let parent = el.parentElement;
  for (let i = 0; i < 8 && parent; i++) {
    const tid = parent.getAttribute('data-testid') || '';
    if (tid.startsWith('dm-conversation-item-') || tid === 'conversation' || tid === 'cellInnerDiv' || parent.getAttribute('role') === 'row') {
      return parent;
    }
    const link = parent.querySelector && parent.querySelector('a[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      if (href && !href.includes('/settings') && !href.includes('/help') && !href.includes('/tos')) {
        return parent.closest('[data-testid^="dm-conversation-item-"], [data-testid="cellInnerDiv"], [role="row"]') || parent;
      }
    }
    parent = parent.parentElement;
  }
  return null;
}

function isTimestampText(str) {
  if (!str) return false;
  const s = str.trim().toLowerCase();
  if (!s) return false;

  // Точные слова времени
  if (['сейчас', 'только что', 'вчера', 'сегодня', 'now', 'just now', 'yesterday', 'today'].includes(s)) {
    return true;
  }
  // "вчера в 14:20", "yesterday at 2:14 pm"
  if (/^(вчера|сегодня)\s+(в\s+)?\d{1,2}:\d{2}$/i.test(s)) return true;
  if (/^yesterday(\s+at)?\s+\d{1,2}:\d{2}(\s*(am|pm))?$/i.test(s)) return true;

  // Относительное время RU: "1 мин", "26 мин", "1 ч", "2 ч", "1 д", "2 д", "1 нед.", "2 нед.", "1 мес.", "1 г."
  if (/^\d+\s*(сек|с|мин|м|ч|д|нед|мес|г)\.?$/i.test(s)) return true;

  // Относительное время EN: "1m", "26m", "1h", "2h", "1d", "1w", "1mo", "1y", "1 min", "5 mins", "1 hr", "2 hrs"
  if (/^\d+\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months|y|yr|yrs|year|years)\.?$/i.test(s)) return true;

  // Время формата "14:20", "2:14 PM", "02:14"
  if (/^\d{1,2}:\d{2}(\s*(am|pm))?$/i.test(s)) return true;

  // Даты: "7 сен", "7 сент.", "7 сен. 2026", "Sep 7", "7 Sep"
  if (/^\d{1,2}\s+(янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-я\.]*(\s+\d{4})?$/i.test(s)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(,\s*\d{4})?$/i.test(s)) return true;
  if (/^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+\d{4})?$/i.test(s)) return true;

  return false;
}

function isTypingIndicator(str) {
  if (!str) return false;
  const s = str.trim().toLowerCase();
  if (/^(печатает|typing|is typing|набирает|набирает сообщение)[\.\s…]*$/i.test(s)) return true;
  if (s.startsWith('печатает') || s.startsWith('typing') || s.includes('is typing') || s.startsWith('набирает')) return true;
  return false;
}

function extractChatRowInfo(chatRow) {
  // 1. Попробуем извлечь чистые структурированные данные из React Props
  const reactInfo = getReactConversationData(chatRow);
  if (reactInfo && reactInfo.sender) {
    if (!reactInfo.avatarUrl) {
      const img = chatRow.querySelector('img[src*="twimg"], img[src*="profile_images"], img');
      if (img && img.src && img.src.startsWith('http')) {
        reactInfo.avatarUrl = img.src;
      }
    }
    const isRu = (document.documentElement.lang || '').includes('ru');
    return {
      conversationId: reactInfo.conversationId || null,
      lastEventId: reactInfo.lastEventId || null,
      sender: reactInfo.sender,
      text: reactInfo.text || (reactInfo.mediaType ? '' : (reactInfo.isUnread ? (isRu ? 'Новое сообщение' : 'New message') : '')),
      avatarUrl: reactInfo.avatarUrl || null,
      isTyping: isTypingIndicator(reactInfo.text),
      isMuted: reactInfo.isMuted,
      isGroup: reactInfo.isGroup,
      mediaType: reactInfo.mediaType
    };
  }

  let sender = '';
  let text = '';
  let avatarUrl = null;
  let conversationId = null;

  const testId = chatRow.getAttribute('data-testid') || '';
  const testIdMatch = testId.match(/^dm-conversation-item-(.+)$/);
  if (testIdMatch) {
    conversationId = testIdMatch[1];
  } else {
    const link = chatRow.querySelector('a[href*="/i/chat/"], a[href*="/messages/"]');
    if (link) {
      const hrefMatch = (link.getAttribute('href') || '').match(/\/(?:i\/chat|messages)\/([0-9a-zA-Z_-]+)/);
      if (hrefMatch) conversationId = hrefMatch[1];
    }
  }

  const isMuted = Boolean(chatRow.querySelector(
    '[data-icon*="bell-slash"], [data-icon*="volume-off"], [data-icon*="mute"], [data-testid*="mute"], [aria-label*="mute" i], [aria-label*="заглуш" i], [aria-label*="без звука" i]'
  ));
  const isGroup = Boolean(chatRow.querySelector('[data-testid*="group"], [aria-label*="group" i], [aria-label*="групп" i]'));

  let mediaType = null;
  if (chatRow.querySelector('[data-icon*="phone"], [data-icon*="call"]')) {
    mediaType = 'call';
  } else if (chatRow.querySelector('[data-icon*="mic"], [data-icon*="voice"], [data-icon*="audio"]')) {
    mediaType = 'voice';
  } else if (chatRow.querySelector('[data-icon*="video"], [data-icon*="film"]')) {
    mediaType = 'video';
  } else if (chatRow.querySelector('[data-icon*="gif"]')) {
    mediaType = 'gif';
  } else if (chatRow.querySelector('[data-icon="icon-camera"], [data-icon*="image"], [data-icon*="photo"]')) {
    mediaType = 'photo';
  } else if (chatRow.querySelector('[data-icon*="attachment"], [data-icon*="paperclip"], [data-icon*="file"]')) {
    mediaType = 'file';
  }

  // 1. Аватарка
  let container = chatRow;
  for (let k = 0; k < 5 && container; k++) {
    const img = container.querySelector('img[src*="twimg"], img[src*="profile_images"], img');
    if (img && img.src && img.src.startsWith('http')) {
      avatarUrl = img.src;
      break;
    }
    const bgDiv = container.querySelector('div[style*="background-image"]');
    if (bgDiv && bgDiv.style && bgDiv.style.backgroundImage) {
      const bgMatch = bgDiv.style.backgroundImage.match(/url\(["']?(https:[^"']+)["']?\)/);
      if (bgMatch) {
        avatarUrl = bgMatch[1];
        break;
      }
    }
    container = container.parentElement;
  }

  // 2. Сбор строк текста из реального chatRow
  let lines = [];
  try {
    const rawInner = (chatRow.innerText || '').trim();
    if (rawInner.length > 0) {
      lines = rawInner.split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0 && s !== '·' && s !== '•' && s !== '-' && s !== '—');
    }
  } catch (e) {}

  // Резервный сбор строк через TreeWalker (если innerText пуст, когда окно скрыто)
  if (lines.length === 0) {
    try {
      const walker = document.createTreeWalker(chatRow, NodeFilter.SHOW_TEXT, null);
      let node;
      const tokens = [];
      while ((node = walker.nextNode())) {
        const val = (node.nodeValue || '').trim();
        if (!val) continue;
        const p = node.parentElement;
        if (p && (p.tagName === 'TIME' || p.closest('time') || p.tagName === 'SVG' || p.closest('svg'))) continue;
        if (p && p.closest('[data-testid*="unread"], [data-testid*="badge"], [data-icon="icon-circle-fill"], .text-chat-accent')) continue;
        if (val === '·' || val === '•' || val === '-' || val === '—' || val === '|') continue;
        tokens.push(val);
      }
      lines = tokens;
    } catch (e) {}
  }

  const hasTypingIndicator = lines.some(s => isTypingIndicator(s));

  // Фильтруем любые оставшиеся метки времени, служебные бейджи и индикаторы набора
  const cleanLines = lines.filter(s => {
    if (!s) return false;
    if (isTimestampText(s)) return false;
    if (isTypingIndicator(s)) return false;
    if (/^(verified|official|подлинная учетная запись)$/i.test(s)) return false;
    if (/^(unread|непрочитанн(ое|ые|ых)?)$/i.test(s)) return false;
    return true;
  });

  if (cleanLines.length >= 1) {
    // Первая строка — имя отправителя
    sender = cleanLines[0];
    cleanLines.shift();

    // Если следующая строка — это @handle, пропускаем её
    if (cleanLines.length > 0 && cleanLines[0].startsWith('@')) {
      cleanLines.shift();
    }

    // Все оставшиеся строки — это текст сообщения!
    if (cleanLines.length > 0) {
      text = cleanLines.join(' ').trim();
    }
  }

  if (!sender) {
    const img = chatRow.querySelector('img[alt]');
    if (img && img.alt) {
      sender = img.alt.replace(/avatar|picture|profile/i, '').trim();
    }
  }

  if (!sender) {
    const aria = chatRow.getAttribute('aria-label') || chatRow.getAttribute('aria-description') || '';
    if (aria) {
      sender = aria.split(',')[0].trim();
    }
  }

  if (sender) {
    sender = sender.split(/[·•|]/)[0].trim();
    sender = sender.replace(/\s*(сейчас|now|только что|just now)$/i, '').trim();
  }

  if (text) {
    text = text.replace(/^[·•|\s]+/, '').replace(/[·•|\s]+$/, '').trim();
  }

  // Определение mediaType по ключевым словам текста (если иконка не была найдена)
  if (!mediaType && text) {
    const lowerText = text.toLowerCase();
    if (lowerText === 'фото' || lowerText === 'photo' || lowerText === '📷') mediaType = 'photo';
    else if (lowerText === 'видео' || lowerText === 'video' || lowerText === '📹') mediaType = 'video';
    else if (lowerText === 'голосовое сообщение' || lowerText === 'voice message' || lowerText === '🎤') mediaType = 'voice';
    else if (lowerText === 'gif' || lowerText === '👾') mediaType = 'gif';
    else if (lowerText === 'файл' || lowerText === 'file' || lowerText === '📎') mediaType = 'file';
    else if (lowerText === 'звонок' || lowerText === 'call' || lowerText === 'входящий звонок' || lowerText === '📞') mediaType = 'call';
  }

  const timeEl = chatRow.querySelector('time');
  const domTimestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText || '') : '';

  const isRu = (document.documentElement.lang || '').includes('ru');
  return {
    conversationId: conversationId || null,
    lastEventId: domTimestamp || null,
    sender: sender || 'XChat',
    text: text || (mediaType ? '' : (hasTypingIndicator ? '' : (isRu ? 'Новое сообщение' : 'New message'))),
    avatarUrl: avatarUrl,
    isTyping: hasTypingIndicator || isTypingIndicator(text),
    isMuted,
    isGroup,
    mediaType
  };
}

function getTitleUnreadCount() {
  const match = document.title.match(/^\((\d+)\)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return 0;
}

function findRowByConvId(convId) {
  if (!convId) return null;
  try {
    const escaped = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(convId) : convId;
    const direct = document.querySelector(`[data-testid="dm-conversation-item-${escaped}"]`);
    if (direct) return direct;
  } catch (e) {}

  const allRows = getAllChatRows();
  for (const row of allRows) {
    const tid = row.getAttribute('data-testid') || '';
    if (tid.includes(convId)) return row;

    const rData = getReactConversationData(row);
    if (rData && rData.conversationId === convId) return row;

    const links = row.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (href.includes(convId)) return row;
    }
  }

  const allLinks = Array.from(document.querySelectorAll('a[href*="/chat/"], a[href*="/messages/"], a[href*="/i/chat/"]'));
  const foundLink = allLinks.find(a => {
    const href = a.getAttribute('href') || '';
    return href.includes(convId) || href.includes(encodeURIComponent(convId));
  });
  if (foundLink) {
    return findChatRow(foundLink) || foundLink;
  }

  return null;
}

function openConversation(convId) {
  if (!convId) return;
  console.log(`[Pigeon Preload] 📂 Открытие диалога: ${convId}`);

  function activateRow() {
    const row = findRowByConvId(convId);
    if (row) {
      try { row.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (e) {}

      const link = row.querySelector('a[href*="/chat/"], a[href*="/messages/"], a[href*="/i/chat/"], a');
      if (link) {
        try { link.click(); } catch (e) {}
      }

      for (const k in row) {
        if (k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$')) {
          try {
            const p = row[k];
            if (p && typeof p.onPress === 'function') p.onPress({ preventDefault: () => {} });
            if (p && typeof p.onClick === 'function') p.onClick({ preventDefault: () => {} });
          } catch (e) {}
        }
      }

      try { row.click(); } catch (e) {}
      return true;
    }
    return false;
  }

  const clicked = activateRow();

  if (!clicked || !window.location.pathname.includes(convId)) {
    try {
      const isChatHost = window.location.hostname.includes('chat.x.com');
      const targetPath = isChatHost ? `/i/chat/${convId}` : `/messages/${convId}`;
      if (!window.location.pathname.includes(convId)) {
        window.history.pushState(null, '', targetPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    } catch (e) {}
  }

  setTimeout(activateRow, 100);
  setTimeout(activateRow, 300);
}

function scanXChatUnread() {
  try {
    const titleCount = getTitleUnreadCount();

    // 1. Ищем строки диалогов в контейнере сообщений
    const chatRows = getAllChatRows();
    const unreadChats = [];

    if (chatRows.length > 0) {
      for (const row of chatRows) {
        if (isRowUnread(row)) {
          unreadChats.push(row);
        }
      }
    }

    // ВАЖНО: "Жесткая страховка" chatRows[0] полностью удалена!
    // titleCount влияет только на finalUnreadCount для трея, но не спамит ложными пушами.
    const finalUnreadCount = Math.max(unreadChats.length, titleCount);

    // Парсим каждый непрочитанный чат и шлём уведомление, если это действительно новое сообщение
    unreadChats.forEach(chatRow => {
      const info = extractChatRowInfo(chatRow);
      const convId = info.conversationId || '';
      const convKey = convId || info.sender;
      const sender = info.sender;
      const text = info.text;
      const avatarUrl = info.avatarUrl;
      const isMuted = info.isMuted;
      const isGroup = info.isGroup;
      const mediaType = info.mediaType;

      // Игнорируем собственные отправленные сообщения (You: / Вы:)
      if (sender.startsWith('You:') || sender.startsWith('Вы:') ||
          text.startsWith('You:') || text.startsWith('Вы:') ||
          text.startsWith('You :') || text.startsWith('Вы :')) {
        return;
      }

      // Игнорируем статус набора текста ("Печатает...", "Typing...")
      if (info.isTyping || isTypingIndicator(text)) {
        return;
      }

      const now = Date.now();
      const last = lastNotifiedByConv.get(convKey);

      // Формируем уникальный идентификатор конкретного сообщения (ID события, временная метка или текст)
      const msgKey = info.lastEventId ? `${info.lastEventId}` : (mediaType ? `${mediaType}|${text}` : (text || 'msg'));

      // Заглушенный чат (Muted):
      // Запоминаем состояние, но НЕ шлём всплывающее уведомление и звук
      if (isMuted) {
        lastNotifiedByConv.set(convKey, { msgKey, text, lastEventId: info.lastEventId, time: now });
        return;
      }

      if (isInitialScan) {
        lastNotifiedByConv.set(convKey, { msgKey, text, lastEventId: info.lastEventId, time: now });
        return;
      }

      // Если пользователь прямо сейчас сидит в этом чате в активном окне — глушим уведомления и звук!
      if (isCurrentConversationActive(convId, sender)) {
        lastNotifiedByConv.set(convKey, { msgKey, text, lastEventId: info.lastEventId, time: now });
        return;
      }

      // Уведомляем, если для этого диалога поступило действительно новое сообщение
      const isNewMessage = !last || (last.msgKey ? last.msgKey !== msgKey : (last.text !== text || (info.lastEventId && last.lastEventId !== info.lastEventId)));
      if (isNewMessage) {
        lastNotifiedByConv.set(convKey, { msgKey, text, lastEventId: info.lastEventId, time: now });
        console.log(`[Pigeon Preload] 🔔 Новое сообщение [${convKey}] от ${sender}: "${text}" (key: ${msgKey})`);
        ipcRenderer.send('incoming-message', {
          conversationId: convId,
          title: sender,
          body: text,
          avatarUrl: avatarUrl,
          mediaType: mediaType,
          isGroup: isGroup,
          isAppFocused: document.hasFocus() && !document.hidden
        });
      }
    });


    // Защита от дребезга (flapping) при скрытом окне:
    if (finalUnreadCount === 0 && currentUnreadCount > 0 && document.hidden) {
      consecutiveZeroCount++;
      if (consecutiveZeroCount < 3) {
        return;
      }
    } else {
      consecutiveZeroCount = 0;
    }

    // Обновляем бейдж в трее
    if (finalUnreadCount !== currentUnreadCount) {
      currentUnreadCount = finalUnreadCount;
      console.log(`[Pigeon Preload] 📊 Всего непрочитанных чатов: ${currentUnreadCount} (DOM: ${unreadChats.length}, заголовок: ${titleCount})`);
      ipcRenderer.send('unread-count', currentUnreadCount);
    }
  } catch (e) {
    console.error('[Pigeon Preload] Scan error:', e);
  }
}

function scanActiveChatMessages() {
  try {
    // Ищем сообщения в открытом активном чате (поддерживаем XChat и старый Twitter)
    let messageElements = Array.from(document.querySelectorAll(
      '[data-testid^="dm-message-"], [data-testid="messageEntry"], [data-testid^="message-"]:not([data-testid^="message-text-"])'
    ));
    if (messageElements.length === 0) {
      messageElements = Array.from(document.querySelectorAll('[data-testid^="message-text-"], [data-testid="tweetText"]'));
    }
    if (messageElements.length === 0) return;

    const lastMsgEl = messageElements[messageElements.length - 1];
    if (!lastMsgEl) return;

    // Игнорируем собственные исходящие сообщения:
    // XChat: .justify-end
    // Twitter: flex-end / outgoing
    const isOutgoing = !!lastMsgEl.closest('.justify-end, [style*="flex-end"], [data-testid*="outgoing"]');
    if (isOutgoing) return;

    const textEl = lastMsgEl.querySelector('[data-testid^="message-text-"], [data-testid="tweetText"]') || lastMsgEl;
    let text = (textEl.innerText || textEl.textContent || '').trim();

    let mediaType = null;
    if (lastMsgEl.querySelector('video, [data-testid*="video"]')) {
      mediaType = 'video';
    } else if (lastMsgEl.querySelector('audio, [data-testid*="audio"], [data-testid*="voice"]')) {
      mediaType = 'voice';
    } else if (lastMsgEl.querySelector('img[src*="media"], img[src*="blob:"], [data-testid*="image"], [data-testid*="photo"]')) {
      mediaType = 'photo';
    }

    if (!text && !mediaType) return;
    if (isTypingIndicator(text)) return;

    // Имя собеседника берем из шапки открытого диалога
    const header = document.querySelector('[data-testid="dm-conversation-header"], [data-testid="conversation-header"], [data-testid="DmScroller-header"], [data-testid="TopNavBar"]');
    let sender = '';
    let avatarUrl = '';
    if (header) {
      const img = header.querySelector('img[src*="twimg"], img[src*="profile_images"], img');
      if (img && img.src) avatarUrl = img.src;
      const titleEl = header.querySelector('[data-testid="dm-conversation-username"], h2, span[dir], [role="heading"]');
      if (titleEl) sender = (titleEl.innerText || titleEl.textContent || '').trim();
    }
    if (!sender) sender = 'XChat';

    // Извлечение conversationId из URL активного диалога
    const convMatch = (window.location.pathname.match(/\/(?:i\/chat|messages)\/([0-9a-zA-Z_-]+)/) || []);
    const convId = convMatch[1] || '';
    const key = convId || sender;

    const now = Date.now();
    const last = lastNotifiedByConv.get(key);

    const timeEl = lastMsgEl.querySelector('time');
    const msgTime = timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText || '') : '';
    const msgId = lastMsgEl.getAttribute('data-testid') || lastMsgEl.getAttribute('id') || msgTime || '';
    const payloadText = text || '';
    const stateKey = msgId ? `${msgId}|${payloadText}` : (payloadText || mediaType || 'msg');

    if (isInitialScan) {
      lastNotifiedByConv.set(key, { text: stateKey, time: now });
      return;
    }

    // Если окно открыто и сфокусировано (пользователь прямо сейчас читает этот чат),
    // просто синхронизируем состояние без отправки пушей и звуков
    const isWindowFocused = document.hasFocus() && !document.hidden;
    if (isWindowFocused) {
      lastNotifiedByConv.set(key, { text: stateKey, time: now });
      return;
    }

    // Если этот диалог только что был открыт и в кэше ещё нет сообщений,
    // запоминаем текущее состояние и не спамим старыми сообщениями
    if (!last) {
      lastNotifiedByConv.set(key, { text: stateKey, time: now });
      return;
    }

    if (last.text !== stateKey) {
      lastNotifiedByConv.set(key, { text: stateKey, time: now });
      console.log(`[Pigeon Preload] 💬 Новое сообщение в фоновом активном чате [${convId || sender}] от ${sender}: "${payloadText}" (media: ${mediaType || 'none'})`);
      ipcRenderer.send('incoming-message', {
        conversationId: convId,
        title: sender,
        body: payloadText,
        avatarUrl: avatarUrl || null,
        mediaType: mediaType,
        isGroup: false,
        isAppFocused: false
      });
    }
  } catch (e) {}
}

// Резервная проверка нужна для изменений, которые XChat не отразил в DOM,
// но раз в 3 секунды достаточно и не конкурирует с отправкой сообщений.
setInterval(() => {
  if (!isPigeonWindowActive()) requestChatScan({ delay: 0 });
}, 3000);
window.addEventListener('click', () => {
  if (!isPigeonWindowActive()) requestChatScan({ activeMessage: false, delay: 700 });
});
window.addEventListener('visibilitychange', () => requestChatScan({ delay: 100 }));

// Моментальный отклик на любые изменения DOM в окне
const bodyObserver = new MutationObserver((records) => {
  if (isPigeonWindowActive()) {
    return;
  }
  if (!mutationMayContainChatUpdate(records)) return;
  requestChatScan();
});
if (document.body) {
  bodyObserver.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  });
}

// Отслеживаем изменения заголовка вкладки (например: "(1) Chat")
const titleEl = document.querySelector('title');
if (titleEl) {
  try {
    const titleObserver = new MutationObserver(() => {
      if (!isPigeonWindowActive()) requestChatScan({ delay: 100 });
    });
    titleObserver.observe(titleEl, { subtree: true, characterData: true, childList: true });
  } catch (e) {}
}

// Поиск следующего непрочитанного диалога для открытия
function getNextUnreadTarget(excludeRows = new Set()) {
  const chatRows = getAllChatRows();

  for (const chatRow of chatRows) {
    if (excludeRows.has(chatRow)) continue;

    if (isRowUnread(chatRow)) {
      try {
        chatRow.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      } catch (e) {}

      // Ищем прямую ссылку на сообщение
      let targetLink = chatRow.querySelector('a[href*="/messages/"], a[href*="/i/chat/"], a[href*="/c/"], a[href*="/chat/"], a');

      let clickX, clickY;
      if (targetLink) {
        const lrect = targetLink.getBoundingClientRect();
        if (lrect.width > 0 && lrect.height > 0) {
          clickX = Math.round(lrect.left + lrect.width / 2);
          clickY = Math.round(lrect.top + lrect.height / 2);
        }
      }
      if (!clickX) {
        const rect = chatRow.getBoundingClientRect();
        // Кликаем правее аватарки (от 90px до 220px от левого края) по тексту сообщения
        clickX = Math.round((rect.left || 0) + Math.max(90, Math.min((rect.width || 300) * 0.55, 220)));
        clickY = Math.round((rect.top || 0) + (rect.height || 60) / 2);
      }

      // Возвращаем целевой диалог всегда, даже если окно скрыто в трее
      return {
        x: (clickX > 0 && clickX < window.innerWidth) ? clickX : 160,
        y: (clickY > 0 && clickY < window.innerHeight) ? clickY : 120,
        row: chatRow
      };
    }
  }
  return null;
}

// Исполнение прочтения диалога в главном мире (работает даже когда окно свёрнуто)
function triggerReadOnRow(chatRow) {
  try {
    chatRow.setAttribute('data-pigeon-mark-active', 'true');
    webFrame.executeJavaScript(`
      (() => {
        try {
          const row = document.querySelector('[data-pigeon-mark-active="true"]');
          if (!row) return;
          row.removeAttribute('data-pigeon-mark-active');

          // 1. Ищем прямую ссылку на диалог, если есть
          const directLink = row.querySelector('a[href*="/messages/"], a[href*="/i/chat/"]');
          if (directLink) {
            try { directLink.click(); } catch (e) {}
          }

          // 2. Ищем React-пропсы (onPress для react-native-web и onClick)
          const allEls = [row, ...row.querySelectorAll('*')];
          for (const el of allEls) {
            if (el.tagName === 'A') {
              const href = el.getAttribute('href') || '';
              if (href && !href.includes('/messages/') && !href.includes('/i/chat/')) {
                continue; // Не кликаем на профили пользователей!
              }
            }

            for (const k in el) {
              if (k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$')) {
                const props = el[k];
                if (props) {
                  if (typeof props.onPress === 'function') {
                    try {
                      props.onPress({
                        nativeEvent: {},
                        preventDefault: () => {},
                        stopPropagation: () => {},
                        isTrusted: true,
                        target: el,
                        currentTarget: el
                      });
                    } catch (e) {}
                  }
                  if (typeof props.onClick === 'function') {
                    try {
                      props.onClick({
                        preventDefault: () => {},
                        stopPropagation: () => {},
                        isTrusted: true,
                        target: el,
                        currentTarget: el
                      });
                    } catch (e) {}
                  }
                }
              }
            }
          }

          // 3. Эмуляция PointerEvents для responder-системы react-native-web
          try {
            const pDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 });
            const pUp = new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 });
            row.dispatchEvent(pDown);
            row.dispatchEvent(pUp);
          } catch (e) {}

          try { row.click(); } catch (e) {}
        } catch (e) {}
      })()
    `).catch(() => {});
  } catch (e) {}
}

// 3. Вызов нативной функции X "Mark all as read" из меню фильтров
async function nativeMarkAllAsRead() {
  // 1. Поиск кнопки выпадающего меню (в новом XChat data-testid="dm-inbox-dropdown-trigger")
  let filterBtn = document.querySelector('[data-testid="dm-inbox-dropdown-trigger"]');
  if (!filterBtn) {
    const allCandidates = Array.from(document.querySelectorAll('button, div[role="button"]'));
    filterBtn = allCandidates.find(el => {
      const t = (el.innerText || '').trim();
      return t.startsWith('All') || t.startsWith('Все') || t.startsWith('Unread') || t.startsWith('Непрочитанные') || t.startsWith('Direct') || t.startsWith('Личные');
    });
  }

  if (!filterBtn) return false;

  // Открываем меню
  filterBtn.click();
  for (const k in filterBtn) {
    if (k.startsWith('__reactProps$')) {
      const p = filterBtn[k];
      if (typeof p.onPress === 'function') p.onPress({ preventDefault: () => {} });
      if (typeof p.onClick === 'function') p.onClick({ preventDefault: () => {} });
    }
  }

  // Ждём появления выпадающего списка
  await new Promise(r => setTimeout(r, 120));

  // Ищем пункт "Mark all as read" (в новом XChat data-testid="dm-inbox-dropdown-mark-all-read")
  let markReadItem = document.querySelector('[data-testid="dm-inbox-dropdown-mark-all-read"]');
  if (!markReadItem) {
    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], div[role="button"], button, div, span'));
    markReadItem = menuItems.find(el => {
      const t = (el.innerText || '').trim();
      return t === 'Mark all as read' || t === 'Отметить все как прочитанные' || t === 'Прочитать все' || t.includes('Mark all as read');
    });
  }

  if (!markReadItem) {
    try { filterBtn.click(); } catch (e) {}
    return false;
  }

  const target = markReadItem.closest('[role="menuitem"], div[role="button"]') || markReadItem;
  target.click();
  for (const k in target) {
    if (k.startsWith('__reactProps$')) {
      const p = target[k];
      if (typeof p.onPress === 'function') p.onPress({ preventDefault: () => {} });
      if (typeof p.onClick === 'function') p.onClick({ preventDefault: () => {} });
    }
  }

  // Проверяем подтверждение
  await new Promise(r => setTimeout(r, 150));
  const confirmBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(el => {
    const t = (el.innerText || '').trim();
    return (t === 'Mark as read' || t === 'Confirm' || t === 'Подтвердить') && el !== target && el !== filterBtn;
  });

  if (confirmBtn) {
    confirmBtn.click();
    for (const k in confirmBtn) {
      if (k.startsWith('__reactProps$')) {
        const p = confirmBtn[k];
        if (typeof p.onPress === 'function') p.onPress({ preventDefault: () => {} });
        if (typeof p.onClick === 'function') p.onClick({ preventDefault: () => {} });
      }
    }
  }

  return true;
}

let isMarkingAllRead = false;

// Удаляем кастомную кнопку, если она была внедрена ранее
try {
  const existingBtn = document.getElementById('pigeon-mark-all-read-btn');
  if (existingBtn) existingBtn.remove();
} catch (e) {}

// Отслеживаем ручной клик пользователя по нативному пункту меню "Mark all as read"
window.addEventListener('click', (e) => {
  const target = e.target;
  if (!target) return;
  const t = (target.innerText || target.textContent || '').trim();
  if (t.includes('Mark all as read') || t.includes('Отметить все как прочитанные')) {
    console.log('[Pigeon Preload] 🖱️ Пользователь нажал нативный пункт "Mark all as read" в меню All');
    setTimeout(() => {
      ipcRenderer.send('mark-all-read-done');
      currentUnreadCount = 0;
      ipcRenderer.send('unread-count', 0);
    }, 200);
  }
}, true);

// 4. Функция открытия диалога для прочтения (по кнопке "Mark as read" в уведомлении)
function markSingleConversationAsRead(convId) {
  if (!convId) return;
  console.log(`[Pigeon Preload] 📂 Открытие диалога для прочтения: ${convId}`);
  openConversation(convId);
  ipcRenderer.send('mark-conversation-read-done', convId);
}

// 5. Функция "Прочитать все сообщения" (вызывается из трея, хоткея Ctrl+Shift+A)
async function markAllAsRead() {
  if (isMarkingAllRead) return;
  isMarkingAllRead = true;
  console.log('[Pigeon Preload] 🧹 Запуск "Mark all as read"...');

  let nativeSuccess = false;
  try {
    nativeSuccess = await nativeMarkAllAsRead();
  } catch (e) {}

  if (nativeSuccess) {
    console.log('[Pigeon Preload] 🎉 Нативный "Mark all as read" от X успешно сработал!');
    await new Promise(r => setTimeout(r, 350));
  } else {
    // Нативный клик по непрочитанным строкам
    const rows = getAllChatRows();
    for (const row of rows) {
      if (isRowUnread(row)) {
        triggerReadOnRow(row);
      }
    }
  }

  currentUnreadCount = 0;
  ipcRenderer.send('unread-count', 0);
  scanXChatUnread();
  isMarkingAllRead = false;
  ipcRenderer.send('mark-all-read-done');
}

ipcRenderer.on('trigger-mark-conversation-read', (_event, convId) => {
  markSingleConversationAsRead(convId);
});

ipcRenderer.on('trigger-mark-all-read', markAllAsRead);

ipcRenderer.on('open-conversation', (_event, convId) => {
  console.log(`[Pigeon Preload] 📂 Открытие диалога по сигналу из главного процесса: ${convId}`);
  openConversation(convId);
});

// 5. Раздел настроек Pigeon (Уведомления, звуки и выбор языка)
(() => {
  let appConfig = {
    language: 'en',
    notificationsEnabled: true,
    soundEnabled: true,
    soundFile: 'come here.mp3',
    sounds: [],
    autoStart: true,
    isWindows: false,
    isLinux: false,
    ghostMode: false,
    privacyBlur: false,
    bossKeyEnabled: true,
    reducedMotion: false
  };

  const DEFAULT_SOUNDS = [
    { id: 'come here.mp3', nameEn: 'Come Here (Default)', nameRu: 'Come Here (По умолчанию)' },
    { id: 'telegram sound.mp3', nameEn: 'Telegram', nameRu: 'Telegram' },
    { id: 'vkontakte sound.mp3', nameEn: 'VKontakte', nameRu: 'ВКонтакте' },
    { id: 'chitter.mp3', nameEn: 'Chitter', nameRu: 'Chitter' },
    { id: 'ding.mp3', nameEn: 'Ding', nameRu: 'Ding' },
    { id: 'juntos.mp3', nameEn: 'Juntos', nameRu: 'Juntos' },
    { id: 'pull out.mp3', nameEn: 'Pull Out', nameRu: 'Pull Out' },
    { id: 'slick.mp3', nameEn: 'Slick', nameRu: 'Slick' },
    { id: 'sly.mp3', nameEn: 'Sly', nameRu: 'Sly' },
    { id: 'soobschenie.mp3', nameEn: 'Soobschenie', nameRu: 'Сообщение' }
  ];

  function getEyeIconSvg(isBlurred) {
    if (isBlurred) {
      return `<svg viewBox="0 0 24 24"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>`;
  }

  function ensureGlobalPrivacyStyles() {
    if (document.getElementById('pigeon-global-privacy-styles')) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'pigeon-global-privacy-styles';
    styleEl.textContent = `
      :root {
        --pigeon-motion-fast: 160ms;
        --pigeon-motion-standard: 220ms;
        --pigeon-motion-ease: cubic-bezier(0.16, 1, 0.3, 1);
      }
      html.pigeon-reduced-motion {
        --pigeon-motion-fast: 1ms;
        --pigeon-motion-standard: 1ms;
      }
      @media (prefers-reduced-motion: reduce) {
        :root:not(.pigeon-reduced-motion) {
          --pigeon-motion-fast: 1ms;
          --pigeon-motion-standard: 1ms;
        }
      }
      /* ========================================================= */
      /* Размытие сообщений, цитируемых ответов и медиа в чате     */
      /* ========================================================= */
      html.pigeon-privacy-active .pigeon-privacy-blur,
      html.pigeon-privacy-active [data-testid="cellInnerDiv"] [dir],
      html.pigeon-privacy-active [data-testid="cellInnerDiv"] span,
      html.pigeon-privacy-active [data-testid="cellInnerDiv"] p,
      html.pigeon-privacy-active [data-testid="cellInnerDiv"] a,
      html.pigeon-privacy-active [data-testid="cellInnerDiv"] img,
      html.pigeon-privacy-active [data-testid="cellInnerDiv"] video,
      html.pigeon-privacy-active [data-testid="cellInnerDiv"] [style*="background"],
      html.pigeon-privacy-active [data-testid="messageEntry"] [dir],
      html.pigeon-privacy-active [data-testid="messageEntry"] span,
      html.pigeon-privacy-active [data-testid="messageEntry"] p,
      html.pigeon-privacy-active [data-testid="messageEntry"] a,
      html.pigeon-privacy-active [data-testid="messageEntry"] img,
      html.pigeon-privacy-active [data-testid="messageEntry"] video,
      html.pigeon-privacy-active [data-testid="messageEntry"] [style*="background"],
      html.pigeon-privacy-active [data-testid^="dm-message-"] [dir],
      html.pigeon-privacy-active [data-testid^="dm-message-"] span,
      html.pigeon-privacy-active [data-testid^="dm-message-"] p,
      html.pigeon-privacy-active [data-testid^="dm-message-"] a,
      html.pigeon-privacy-active [data-testid^="dm-message-"] img,
      html.pigeon-privacy-active [data-testid^="dm-message-"] video,
      html.pigeon-privacy-active [data-testid^="dm-message-"] [style*="background"],
      html.pigeon-privacy-active [data-testid="tweetText"],
      html.pigeon-privacy-active [data-testid^="message-text-"],
      /* Селекторы для блоков с цитатами ответов внутри сообщения */
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> [data-testid="tweetText"]) > div,
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> [data-testid="tweetText"]) > span,
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> [data-testid="tweetText"]) > a,
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> [data-testid="tweetText"]) [style*="background"],
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> div > [data-testid="tweetText"]) > div,
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> div > [data-testid="tweetText"]) > span,
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> div > [data-testid="tweetText"]) > a,
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> div > [data-testid="tweetText"]) [style*="background"],
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> div > div > [data-testid="tweetText"]) > div,
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> div > div > [data-testid="tweetText"]) > span,
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> div > div > [data-testid="tweetText"]) > a,
      html.pigeon-privacy-active [data-testid="messageEntry"] div:has(> div > div > [data-testid="tweetText"]) [style*="background"],
      html.pigeon-privacy-active [data-testid^="dm-message-"] div:has([data-testid="tweetText"]) img,
      html.pigeon-privacy-active [data-testid^="dm-message-"] div:has([data-testid="tweetText"]) video,
      html.pigeon-privacy-active [data-testid="messageEntry"] [role="link"] *,
      html.pigeon-privacy-active [data-testid="messageEntry"] [role="button"] *,
      html.pigeon-privacy-active [data-testid^="dm-message-"] [role="link"] *,
      html.pigeon-privacy-active [data-testid^="dm-message-"] [role="button"] *,
      /* Размытие текста превью последнего сообщения в списке диалогов */
      html.pigeon-privacy-active .pigeon-privacy-snippet,
      html.pigeon-privacy-active .pigeon-privacy-snippet * {
        filter: blur(8px) !important;
        opacity: 0.82;
        transform: scale(0.995);
        transition: filter var(--pigeon-motion-fast) ease-in-out, opacity var(--pigeon-motion-fast) ease-in-out, transform var(--pigeon-motion-fast) ease-in-out !important;
        user-select: none !important;
      }
      html.pigeon-privacy-active .pigeon-privacy-blur {
        opacity: 0.82;
        transform: scale(0.995);
        transition: filter var(--pigeon-motion-fast) ease-in-out, opacity var(--pigeon-motion-fast) ease-in-out, transform var(--pigeon-motion-fast) ease-in-out !important;
      }

      /* ========================================================================= */
      /* СНЯТИЕ РАЗМЫТИЯ ПРИ НАВЕДЕНИИ: ТОЛЬКО НА ТО СООБЩЕНИЕ/ДИАЛОГ ПОД КУРСОРОМ */
      /* ========================================================================= */

      /* 1. В списке диалогов слева: превью открывается ТОЛЬКО у наведенной строки */
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"]:hover .pigeon-privacy-snippet,
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"]:hover .pigeon-privacy-snippet *,
      html.pigeon-privacy-active [data-testid="conversation"]:hover .pigeon-privacy-snippet,
      html.pigeon-privacy-active [data-testid="conversation"]:hover .pigeon-privacy-snippet *,
      html.pigeon-privacy-active [role="row"]:hover .pigeon-privacy-snippet,
      html.pigeon-privacy-active [role="row"]:hover .pigeon-privacy-snippet *,
      html.pigeon-privacy-active [role="listitem"]:hover .pigeon-privacy-snippet,
      html.pigeon-privacy-active [role="listitem"]:hover .pigeon-privacy-snippet *,
      html.pigeon-privacy-active .chat-item:hover .pigeon-privacy-snippet,
      html.pigeon-privacy-active .chat-item:hover .pigeon-privacy-snippet *,
      html.pigeon-privacy-active a:hover .pigeon-privacy-snippet,
      html.pigeon-privacy-active a:hover .pigeon-privacy-snippet *,
      html.pigeon-privacy-active .pigeon-privacy-snippet:hover,
      html.pigeon-privacy-active .pigeon-privacy-snippet:hover * {
        filter: none !important;
        opacity: 1;
        transform: scale(1);
        user-select: auto !important;
      }

      /* 2. В окне чата справа: открывается ТОЛЬКО то конкретное сообщение, на которое наведен курсор */
      html.pigeon-privacy-active [data-testid="messageEntry"]:hover,
      html.pigeon-privacy-active [data-testid="messageEntry"]:hover *,
      html.pigeon-privacy-active [data-testid^="dm-message-"]:hover,
      html.pigeon-privacy-active [data-testid^="dm-message-"]:hover *,
      html.pigeon-privacy-active [data-testid="cellInnerDiv"]:hover [data-testid="messageEntry"],
      html.pigeon-privacy-active [data-testid="cellInnerDiv"]:hover [data-testid="messageEntry"] *,
      html.pigeon-privacy-active [data-testid="cellInnerDiv"]:hover img,
      html.pigeon-privacy-active [data-testid="cellInnerDiv"]:hover video,
      html.pigeon-privacy-active [data-testid="tweetText"]:hover,
      html.pigeon-privacy-active [data-testid^="message-text-"]:hover,
      html.pigeon-privacy-active .pigeon-privacy-blur:hover {
        filter: none !important;
        opacity: 1;
        transform: scale(1);
        user-select: auto !important;
      }

      /* ========================================================================= */
      /* ЗАЩИТА: Никнеймы, юзернеймы, аватарки, время и бейджи НИКОГДА НЕ БЛЮРЯТСЯ */
      /* ========================================================================= */
      .pigeon-privacy-never-blur,
      .pigeon-privacy-never-blur *,
      html.pigeon-privacy-active .pigeon-privacy-never-blur,
      html.pigeon-privacy-active .pigeon-privacy-never-blur *,
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] img,
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] [data-testid*="avatar" i],
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] [data-testid*="Avatar" i],
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] [data-testid="UserAvatar-Container"],
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] [data-testid="User-Name"],
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] [data-testid="User-Name"] *,
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] [data-testid="dm-conversation-username"],
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] [data-testid="dm-conversation-username"] *,
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] [role="heading"],
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] [role="heading"] *,
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] time,
      html.pigeon-privacy-active [data-testid^="dm-conversation-item-"] svg,
      html.pigeon-privacy-active [data-testid="conversation"] img,
      html.pigeon-privacy-active [data-testid="conversation"] [data-testid*="avatar" i],
      html.pigeon-privacy-active [data-testid="conversation"] [data-testid*="Avatar" i],
      html.pigeon-privacy-active [data-testid="conversation"] [data-testid="User-Name"],
      html.pigeon-privacy-active [data-testid="conversation"] [data-testid="User-Name"] *,
      html.pigeon-privacy-active [data-testid="conversation"] [data-testid="dm-conversation-username"],
      html.pigeon-privacy-active [data-testid="conversation"] [data-testid="dm-conversation-username"] *,
      html.pigeon-privacy-active [data-testid="conversation"] [role="heading"],
      html.pigeon-privacy-active [data-testid="conversation"] [role="heading"] *,
      html.pigeon-privacy-active [data-testid="conversation"] time,
      html.pigeon-privacy-active [data-testid="conversation"] svg,
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] img,
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] [data-testid*="avatar" i],
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] [data-testid*="Avatar" i],
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] [data-testid="User-Name"],
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] [data-testid="User-Name"] *,
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] [data-testid="dm-conversation-username"],
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] [data-testid="dm-conversation-username"] *,
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] [role="heading"],
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] [role="heading"] *,
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] time,
      html.pigeon-privacy-active [data-testid="dm-conversation-scroller"] svg,
      html.pigeon-privacy-active [id="x-chat-conversation-list"] img,
      html.pigeon-privacy-active [id="x-chat-conversation-list"] [data-testid*="avatar" i],
      html.pigeon-privacy-active [id="x-chat-conversation-list"] [data-testid*="Avatar" i],
      html.pigeon-privacy-active [id="x-chat-conversation-list"] [data-testid="User-Name"],
      html.pigeon-privacy-active [id="x-chat-conversation-list"] [data-testid="User-Name"] *,
      html.pigeon-privacy-active [id="x-chat-conversation-list"] [data-testid="dm-conversation-username"],
      html.pigeon-privacy-active [id="x-chat-conversation-list"] [data-testid="dm-conversation-username"] *,
      html.pigeon-privacy-active [id="x-chat-conversation-list"] [role="heading"],
      html.pigeon-privacy-active [id="x-chat-conversation-list"] [role="heading"] *,
      html.pigeon-privacy-active [id="x-chat-conversation-list"] time,
      html.pigeon-privacy-active [id="x-chat-conversation-list"] svg,
      html.pigeon-privacy-active #left-col img,
      html.pigeon-privacy-active #left-col [data-testid*="avatar" i],
      html.pigeon-privacy-active #left-col [data-testid*="Avatar" i],
      html.pigeon-privacy-active #left-col [data-testid="User-Name"],
      html.pigeon-privacy-active #left-col [data-testid="User-Name"] *,
      html.pigeon-privacy-active #left-col [data-testid="dm-conversation-username"],
      html.pigeon-privacy-active #left-col [data-testid="dm-conversation-username"] *,
      html.pigeon-privacy-active #left-col [role="heading"],
      html.pigeon-privacy-active #left-col [role="heading"] *,
      html.pigeon-privacy-active #left-col time,
      html.pigeon-privacy-active #left-col svg {
        filter: none !important;
        user-select: auto !important;
      }

      /* Исключения: поле ввода, шапка чата и наши элементы управления */
      html.pigeon-privacy-active [data-testid="dmComposer"],
      html.pigeon-privacy-active [data-testid="dmComposer"] *,
      html.pigeon-privacy-active [data-testid="dmComposer"].pigeon-privacy-blur,
      html.pigeon-privacy-active [data-testid="dmComposer"] .pigeon-privacy-blur,
      html.pigeon-privacy-active div[contenteditable="true"],
      html.pigeon-privacy-active [data-testid="TopNavBar"],
      html.pigeon-privacy-active [data-testid="TopNavBar"] *,
      html.pigeon-privacy-active [data-testid="TopNavBar"] img,
      html.pigeon-privacy-active [data-testid="TopNavBar"].pigeon-privacy-blur,
      html.pigeon-privacy-active [data-testid="TopNavBar"] .pigeon-privacy-blur,
      html.pigeon-privacy-active [data-testid="dm-conversation-header"],
      html.pigeon-privacy-active [data-testid="dm-conversation-header"] *,
      html.pigeon-privacy-active [data-testid="dm-conversation-header"] img,
      html.pigeon-privacy-active [data-testid="dm-conversation-header"].pigeon-privacy-blur,
      html.pigeon-privacy-active [data-testid="dm-conversation-header"] .pigeon-privacy-blur,
      html.pigeon-privacy-active [data-testid="conversation-header"],
      html.pigeon-privacy-active [data-testid="conversation-header"] *,
      html.pigeon-privacy-active [data-testid="conversation-header"] img,
      html.pigeon-privacy-active [data-testid="conversation-header"].pigeon-privacy-blur,
      html.pigeon-privacy-active [data-testid="conversation-header"] .pigeon-privacy-blur,
      html.pigeon-privacy-active [data-testid="DmScroller-header"],
      html.pigeon-privacy-active [data-testid="DmScroller-header"] *,
      html.pigeon-privacy-active [data-testid="DmScroller-header"] img,
      html.pigeon-privacy-active [data-testid="DmScroller-header"].pigeon-privacy-blur,
      html.pigeon-privacy-active [data-testid="DmScroller-header"] .pigeon-privacy-blur,
      html.pigeon-privacy-active #pigeon-settings-card,
      html.pigeon-privacy-active #pigeon-settings-card *,
      html.pigeon-privacy-active #pigeon-hud-toast,
      html.pigeon-privacy-active #pigeon-hud-toast *,
      html.pigeon-privacy-active #pigeon-dropdown-privacy-blur,
      html.pigeon-privacy-active #pigeon-dropdown-privacy-blur *,
      html.pigeon-privacy-active #pigeon-dropdown-ghost-mode,
      html.pigeon-privacy-active #pigeon-dropdown-ghost-mode *,
      html.pigeon-privacy-active #pigeon-privacy-btn,
      html.pigeon-privacy-active #pigeon-privacy-btn * {
        filter: none !important;
        user-select: auto !important;
      }

      /* HUD Toast */
      #pigeon-hud-toast {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(-24px);
        background: rgba(15, 20, 25, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.2);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        color: #ffffff;
        padding: 8px 20px;
        border-radius: 9999px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
        z-index: 1000000;
        opacity: 0;
        pointer-events: none;
        transition: opacity var(--pigeon-motion-standard) var(--pigeon-motion-ease), transform var(--pigeon-motion-standard) var(--pigeon-motion-ease);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #pigeon-hud-toast.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      #pigeon-hud-toast.feedback {
        animation: pigeonHudFeedback var(--pigeon-motion-standard) var(--pigeon-motion-ease);
      }
      @keyframes pigeonHudFeedback {
        50% { box-shadow: 0 10px 34px rgba(29, 155, 240, 0.28); }
      }
      .pigeon-chat-opening {
        animation: pigeonChatOpening var(--pigeon-motion-standard) var(--pigeon-motion-ease) both;
        will-change: opacity, transform;
      }
      @keyframes pigeonChatOpening {
        from { opacity: 0.72; transform: translateX(10px) scale(0.998); }
        to { opacity: 1; transform: translateX(0) scale(1); }
      }
      #pigeon-file-drop-overlay {
        position: fixed;
        inset: 12px;
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        opacity: 0;
        border: 1px dashed rgba(56, 189, 248, 0.45);
        border-radius: 18px;
        background: rgba(2, 12, 20, 0.42);
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        transition: opacity var(--pigeon-motion-fast) ease;
      }
      #pigeon-file-drop-overlay.visible {
        opacity: 1;
      }
      #pigeon-file-drop-overlay > div {
        padding: 13px 18px;
        border: 1px solid rgba(56, 189, 248, 0.35);
        border-radius: 999px;
        background: rgba(14, 26, 36, 0.94);
        color: #e7f6ff;
        font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.38);
      }
      #pigeon-chat-top-btn {
        position: fixed;
        right: 18px;
        bottom: 92px;
        z-index: 999997;
        width: 48px;
        height: 48px;
        display: none;
        place-items: center;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 50%;
        background: rgba(29, 155, 240, .94);
        color: #f3f7fb;
        box-shadow: 0 10px 30px rgba(0,0,0,.42);
        cursor: pointer;
        font: 700 22px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        transition: transform var(--pigeon-motion-fast) var(--pigeon-motion-ease), background var(--pigeon-motion-fast) ease;
      }
      #pigeon-chat-top-btn.visible { display: grid; }
      #pigeon-chat-top-btn:hover { background: #46b7f5; transform: translateY(-2px); }
      #pigeon-chat-search {
        position: fixed;
        top: 18px;
        left: 50%;
        z-index: 1000001;
        display: none;
        align-items: center;
        gap: 8px;
        max-width: min(560px, calc(100vw - 32px));
        padding: 8px;
        transform: translateX(-50%);
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 14px;
        background: rgba(18,20,23,.97);
        box-shadow: 0 14px 40px rgba(0,0,0,.48);
        font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #pigeon-chat-search.visible { display: flex; }
      #pigeon-chat-search input { width: 210px; min-width: 0; padding: 8px 10px; border: 0; border-radius: 9px; background: #2a2d31; color: #fff; outline: none; }
      #pigeon-chat-search button { padding: 7px 9px; border: 0; border-radius: 8px; background: #30343a; color: #f4f7fa; cursor: pointer; }
      #pigeon-chat-search button:hover { background: #1d9bf0; }
      #pigeon-chat-search-status { min-width: 38px; color: #9ba5ae; text-align: center; white-space: nowrap; }
      .pigeon-search-hit { outline: 2px solid #1d9bf0 !important; outline-offset: 3px; border-radius: 10px; }
      #pigeon-menu-chat-top {
        display: flex;
        align-items: center;
        gap: 14px;
        cursor: pointer;
      }
      #pigeon-menu-chat-top .pigeon-menu-arrow { width: 18px; font-size: 22px; line-height: 1; text-align: center; }

      /* Кнопка-глаз в интерфейсе */
      #pigeon-privacy-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.15);
        background: rgba(22, 24, 28, 0.75);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        color: #71767b;
        cursor: pointer;
        transition: background var(--pigeon-motion-fast) ease, color var(--pigeon-motion-fast) ease, border-color var(--pigeon-motion-fast) ease, transform var(--pigeon-motion-fast) var(--pigeon-motion-ease);
        outline: none;
        padding: 0;
        margin: 0 6px;
        user-select: none;
        flex-shrink: 0;
      }
      #pigeon-privacy-btn:hover {
        background: rgba(29, 155, 240, 0.15);
        color: #1d9bf0;
        border-color: rgba(29, 155, 240, 0.4);
        transform: scale(1.06);
      }
      #pigeon-privacy-btn.active {
        background: #1d9bf0;
        color: #ffffff;
        border-color: #1d9bf0;
        box-shadow: 0 0 12px rgba(29, 155, 240, 0.5);
      }
      #pigeon-privacy-btn svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
      }
    `;
    const parent = document.head || document.documentElement;
    if (parent) parent.appendChild(styleEl);
  }

  function showHudToast(message, icon = '🕶️') {
    ensureGlobalPrivacyStyles();
    let hud = document.getElementById('pigeon-hud-toast');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'pigeon-hud-toast';
      (document.body || document.documentElement).appendChild(hud);
    }
    hud.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    hud.classList.remove('feedback');
    void hud.offsetWidth;
    hud.classList.add('visible');
    hud.classList.add('feedback');
    clearTimeout(hud.__timer);
    hud.__timer = setTimeout(() => {
      hud.classList.remove('visible');
    }, 1600);
  }

  function updatePrivacyButtonState() {
    const btn = document.getElementById('pigeon-privacy-btn');
    if (btn) {
      if (appConfig.privacyBlur) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
      btn.innerHTML = getEyeIconSvg(appConfig.privacyBlur);
      btn.title = appConfig.language === 'ru'
        ? (appConfig.privacyBlur ? 'Отключить приватность (Ctrl+Shift+P)' : 'Включить приватность (Ctrl+Shift+P)')
        : (appConfig.privacyBlur ? 'Disable Privacy Mode (Ctrl+Shift+P)' : 'Enable Privacy Mode (Ctrl+Shift+P)');
    }
  }

  function setPrivacyBlurState(enabled) {
    appConfig.privacyBlur = !!enabled;
    applyPrivacyState();
    ipcRenderer.send('set-privacy-blur', !!enabled);
    const isRu = appConfig.language === 'ru';
    showHudToast(
      isRu
        ? (enabled ? 'Приватность: Сообщения размыты' : 'Приватность: Отключена')
        : (enabled ? 'Privacy Blur: Enabled' : 'Privacy Blur: Disabled'),
      enabled ? '🕶️' : '👁️'
    );
  }

  function togglePrivacyBlur() {
    setPrivacyBlurState(!appConfig.privacyBlur);
  }

  let lastChatOpenAnimation = 0;
  function findActiveChatSurface() {
    const candidates = Array.from(document.querySelectorAll(
      '[data-testid="DmScroller"], [data-testid="dm-conversation"], [data-testid="message-list"], [role="main"]'
    ));
    return candidates.find(el => {
      if (!isVisibleElement(el) || isInsideConversationList(el)) return false;
      return Boolean(el.querySelector('[data-testid="messageEntry"], [data-testid^="dm-message-"], [contenteditable="true"], textarea'));
    }) || null;
  }

  function animateChatOpening() {
    const now = Date.now();
    if (now - lastChatOpenAnimation < 220) return;
    lastChatOpenAnimation = now;
    setTimeout(() => {
      const surface = findActiveChatSurface();
      if (!surface) return;
      surface.classList.remove('pigeon-chat-opening');
      void surface.offsetWidth;
      surface.classList.add('pigeon-chat-opening');
      setTimeout(() => surface.classList.remove('pigeon-chat-opening'), appConfig.reducedMotion ? 1 : 300);
    }, appConfig.reducedMotion ? 1 : 70);
  }

  window.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const conversation = target.closest(
      '[data-testid^="dm-conversation-item-"], [data-testid="conversation"], .chat-item, a[href*="/i/chat/"], a[href*="/messages/"]'
    );
    if (conversation && isInsideConversationList(conversation)) {
      animateChatOpening();
    }
  }, true);

  // Открывает штатное меню «…» XChat по правому клику на сообщении.
  // Никакие пункты меню не эмулируются: Reply/Forward/Delete остаются логикой XChat.
  function findMessageContextContainer(target) {
    if (!target || !target.closest) return null;
    const message = target.closest('[data-testid="messageEntry"], [data-testid^="dm-message-"]');
    if (message && !isInsideConversationList(message)) return message;
    const cell = target.closest('[data-testid="cellInnerDiv"]');
    return cell && !isInsideConversationList(cell) ? cell : null;
  }

  function isVisibleElement(el) {
    if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function findMessageMoreButton(container) {
    const candidates = container.querySelectorAll('button, [role="button"], [data-testid], [aria-label], [title]');
    for (const el of candidates) {
      if (!isVisibleElement(el)) continue;
      const testId = (el.getAttribute('data-testid') || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      const label = `${testId} ${aria} ${title}`;
      const text = (el.textContent || '').trim();
      const isMoreAction = /more|overflow|actions|options|menu|ещ[её]|дополн|действ/.test(label);
      if (isMoreAction || text === '...' || text === '⋯') return el;
    }
    return null;
  }

  function pressMessageMoreButton(container) {
    const reveal = () => {
      try {
        container.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
        container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window }));
      } catch (e) {}
    };

    reveal();
    setTimeout(() => {
      const button = findMessageMoreButton(container);
      if (!button) return;
      try { button.click(); } catch (e) {}
    }, appConfig.reducedMotion ? 1 : 35);
  }

  function findPreviewImage(target) {
    if (!target || !target.closest) return null;
    const image = target.closest('img');
    if (!image || !image.currentSrc && !image.src) return null;

    // В полноэкранном просмотрщике X изображение находится в модальном слое.
    // Обычная картинка внутри сообщения по-прежнему открывает меню сообщения.
    const preview = image.closest(
      '[role="dialog"], [aria-modal="true"], [data-testid*="modal" i], [data-testid*="lightbox" i], [data-testid="sheetDialog"]'
    );
    return preview && isVisibleElement(preview) ? image : null;
  }

  window.addEventListener('contextmenu', (event) => {
    const target = event.target;
    if (!target || (target.closest && target.closest('input, textarea, [contenteditable="true"], [role="menu"]'))) return;

    const previewImage = findPreviewImage(target);
    if (previewImage) {
      // Electron не показывает браузерное меню сам по себе. Просим main-процесс
      // показать нативный пункт, который кладёт пиксели изображения в буфер.
      event.preventDefault();
      event.stopPropagation();
      ipcRenderer.send('show-image-context-menu', {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY)
      });
      return;
    }

    const container = findMessageContextContainer(target);
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    pressMessageMoreButton(container);
  }, true);

  function findReplyMenuItem() {
    const items = document.querySelectorAll('[role="menuitem"], [data-testid*="reply" i], button, [role="button"]');
    for (const item of items) {
      if (!isVisibleElement(item)) continue;
      const label = `${item.getAttribute('data-testid') || ''} ${item.getAttribute('aria-label') || ''} ${item.textContent || ''}`.trim().toLowerCase();
      if (/^(reply|ответить)(\s|$)/.test(label) || /\breply\b|\bответить\b/.test(label)) return item;
    }
    return null;
  }

  function replyToMessage(container) {
    pressMessageMoreButton(container);
    setTimeout(() => {
      const replyItem = findReplyMenuItem();
      if (replyItem) {
        try { replyItem.click(); } catch (e) {}
      }
    }, appConfig.reducedMotion ? 80 : 150);
  }

  window.addEventListener('dblclick', (event) => {
    const target = event.target;
    if (!target || (target.closest && target.closest('a, button, [role="button"], input, textarea, [contenteditable="true"], [role="menu"]'))) return;
    const container = findMessageContextContainer(target);
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    replyToMessage(container);
  }, true);

  function filesFromTransfer(transfer) {
    if (!transfer) return [];
    const direct = Array.from(transfer.files || []).filter(file => file && file.size >= 0);
    if (direct.length) return direct;
    return Array.from(transfer.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean);
  }

  function findChatFileInput() {
    const surface = findActiveChatSurface();
    if (!surface) return null;
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    return inputs.find(input => surface.contains(input)) || inputs[0] || null;
  }

  function handFilesToXChat(files) {
    const input = findChatFileInput();
    if (!input || !files.length || typeof DataTransfer === 'undefined') return false;
    try {
      const transfer = new DataTransfer();
      files.forEach(file => transfer.items.add(file));
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      if (!descriptor || typeof descriptor.set !== 'function') return false;
      descriptor.set.call(input, transfer.files);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      console.warn('[Pigeon Attachments] Не удалось передать файлы XChat:', e);
      return false;
    }
  }

  function getFileDropOverlay() {
    let overlay = document.getElementById('pigeon-file-drop-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pigeon-file-drop-overlay';
      overlay.innerHTML = `<div>${appConfig.language === 'ru' ? 'Отпустите, чтобы прикрепить файлы' : 'Drop files to attach'}</div>`;
      (document.body || document.documentElement).appendChild(overlay);
    }
    return overlay;
  }

  function setFileDropOverlayVisible(visible) {
    const overlay = getFileDropOverlay();
    const label = overlay.firstElementChild;
    if (label) label.textContent = appConfig.language === 'ru' ? 'Отпустите, чтобы прикрепить файлы' : 'Drop files to attach';
    overlay.classList.toggle('visible', visible);
  }

  let fileDragDepth = 0;
  function hasFileTransfer(transfer) {
    return filesFromTransfer(transfer).length > 0 || Array.from(transfer?.types || []).includes('Files');
  }

  window.addEventListener('dragenter', (event) => {
    if (!hasFileTransfer(event.dataTransfer) || !findChatFileInput()) return;
    fileDragDepth += 1;
    event.preventDefault();
    setFileDropOverlayVisible(true);
  }, true);
  window.addEventListener('dragover', (event) => {
    if (!hasFileTransfer(event.dataTransfer) || !findChatFileInput()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, true);
  window.addEventListener('dragleave', (event) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0) setFileDropOverlayVisible(false);
  }, true);
  window.addEventListener('drop', (event) => {
    const files = filesFromTransfer(event.dataTransfer);
    fileDragDepth = 0;
    setFileDropOverlayVisible(false);
    if (handFilesToXChat(files)) event.preventDefault();
  }, true);
  window.addEventListener('paste', (event) => {
    const target = event.target;
    if (!target || !(target.closest && target.closest('textarea, input, [contenteditable="true"]'))) return;
    const files = filesFromTransfer(event.clipboardData);
    if (handFilesToXChat(files)) event.preventDefault();
  }, true);

  function getChatScrollContainer() {
    const surface = findActiveChatSurface();
    const roots = [surface, document.body].filter(Boolean);

    // Разметка XChat меняется довольно часто. Вместо привязки к одному
    // data-testid выбираем видимый вертикальный скроллер, в котором есть
    // сообщения/композер, и исключаем левый список и открытые модальные окна.
    let best = null;
    let bestScore = -Infinity;
    for (const root of roots) {
      const candidates = root.querySelectorAll('main, section, div');
      for (const candidate of candidates) {
        if (!isVisibleElement(candidate) || candidate.closest('#left-col, [data-testid="dm-conversation-scroller"], [role="dialog"], [aria-modal="true"]')) continue;
        if (candidate.scrollHeight <= candidate.clientHeight + 12) continue;
        const style = getComputedStyle(candidate);
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.width < 220 || rect.height < 160) continue;
        const hasChatContent = Boolean(candidate.querySelector('[data-testid="messageEntry"], [data-testid^="dm-message-"], [data-testid^="message-text-"], [contenteditable="true"], textarea'));
        const score = (hasChatContent ? 10000 : 0) + rect.width + rect.height;
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
    }
    return best;
  }

  function scrollChatToBeginning() {
    const scroller = getChatScrollContainer();
    if (!scroller) return;
    const behavior = appConfig.reducedMotion ? 'auto' : 'smooth';
    scroller.scrollTo({ top: 0, behavior });
    // Виртуальный список XChat подгружает старые сообщения только после
    // достижения верхней границы. Несколько коротких повторов дают ему шанс
    // запросить следующую порцию, не создавая бесконечный автоскролл.
    [350, 900, 1600].forEach(delay => setTimeout(() => {
      if (scroller.isConnected) scroller.scrollTo({ top: 0, behavior: 'auto' });
    }, delay));
  }

  let searchHits = [];
  let searchHitIndex = -1;

  function clearSearchHighlight() {
    for (const hit of searchHits) hit.classList.remove('pigeon-search-hit');
    searchHits = [];
    searchHitIndex = -1;
  }

  function findLoadedChatMessages(query) {
    clearSearchHighlight();
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    if (!needle) return [];
    const candidates = document.querySelectorAll('[data-testid="messageEntry"], [data-testid^="dm-message-"]');
    searchHits = Array.from(candidates).filter(el => {
      if (isInsideConversationList(el)) return false;
      return (el.innerText || el.textContent || '').toLocaleLowerCase('ru-RU').includes(needle);
    });
    return searchHits;
  }

  function selectSearchHit(next = 0) {
    const status = document.getElementById('pigeon-chat-search-status');
    if (!searchHits.length) {
      if (status) status.textContent = '0/0';
      return;
    }
    if (searchHitIndex >= 0) searchHits[searchHitIndex].classList.remove('pigeon-search-hit');
    searchHitIndex = (next + searchHits.length) % searchHits.length;
    const hit = searchHits[searchHitIndex];
    hit.classList.add('pigeon-search-hit');
    hit.scrollIntoView({ block: 'center', behavior: appConfig.reducedMotion ? 'auto' : 'smooth' });
    if (status) status.textContent = `${searchHitIndex + 1}/${searchHits.length}`;
  }

  function getChatSearchPanel() {
    let panel = document.getElementById('pigeon-chat-search');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'pigeon-chat-search';
    panel.innerHTML = `<input type="search" autocomplete="off"><span id="pigeon-chat-search-status">0/0</span><button type="button" data-search-nav="-1">↑</button><button type="button" data-search-nav="1">↓</button><button type="button" data-search-close="1">×</button>`;
    const input = panel.querySelector('input');
    input.placeholder = appConfig.language === 'ru' ? 'Поиск в загруженных сообщениях' : 'Search loaded messages';
    input.addEventListener('input', () => {
      findLoadedChatMessages(input.value);
      selectSearchHit(0);
    });
    panel.addEventListener('click', event => {
      const nav = event.target.closest('[data-search-nav]');
      if (nav) selectSearchHit(searchHitIndex + Number(nav.dataset.searchNav));
      if (event.target.closest('[data-search-close]')) {
        clearSearchHighlight();
        panel.classList.remove('visible');
      }
    });
    document.body.appendChild(panel);
    return panel;
  }

  function openChatSearch() {
    if (!getChatScrollContainer()) return;
    const panel = getChatSearchPanel();
    panel.classList.add('visible');
    const input = panel.querySelector('input');
    input.focus();
    input.select();
  }

  function mountChatTopButton() {
    let button = document.getElementById('pigeon-chat-top-btn');
    if (!button) {
      button = document.createElement('button');
      button.id = 'pigeon-chat-top-btn';
      button.type = 'button';
      button.textContent = '↑';
      button.title = appConfig.language === 'ru' ? 'К началу переписки' : 'Go to beginning of chat';
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', scrollChatToBeginning);
      document.body.appendChild(button);
    }
    // Не ждём, пока XChat создаст внутренний скроллер: при первом рендере
    // списка его ещё может не быть, из-за чего кнопка раньше оставалась скрыта.
    const isChatRoute = /\/(?:i\/chat|messages)(?:\/|$)/.test(window.location.pathname || '');
    button.classList.toggle('visible', isChatRoute);
  }

  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openChatSearch();
    }
    if (event.key === 'Escape') {
      const panel = document.getElementById('pigeon-chat-search');
      if (panel?.classList.contains('visible')) {
        clearSearchHighlight();
        panel.classList.remove('visible');
      }
    }
  }, true);

  function isInsideConversationList(el) {
    if (!el) return false;
    return Boolean(el.closest(
      '[data-testid="dm-conversation-scroller"], [id="x-chat-conversation-list"], [data-testid^="dm-conversation-item-"], [data-testid="conversation"], [data-testid="DmActivityFeed"], [data-testid="DMDrawer"], #left-col, nav'
    ));
  }

  function tagConversationItems() {
    try {
      const rows = getAllChatRows();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // 1. Сама строка диалога НЕ должна иметь класс размытия
        row.classList.remove('pigeon-privacy-blur', 'pigeon-privacy-snippet');

        // 2. Аватарки: НИКОГДА не размываем, гарантируем четкость
        const avatars = row.querySelectorAll('img, [data-testid*="avatar" i], [data-testid*="Avatar" i], [data-testid="UserAvatar-Container"], [style*="background-image"]');
        for (let a = 0; a < avatars.length; a++) {
          avatars[a].classList.remove('pigeon-privacy-blur', 'pigeon-privacy-snippet');
          avatars[a].classList.add('pigeon-privacy-never-blur');
        }

        // 3. Время (timestamp), SVG-иконки, бейджи: никогда не размываем
        const safeItems = row.querySelectorAll('time, svg, [data-testid*="badge" i], [data-testid*="unread" i]');
        for (let b = 0; b < safeItems.length; b++) {
          safeItems[b].classList.remove('pigeon-privacy-blur', 'pigeon-privacy-snippet');
          safeItems[b].classList.add('pigeon-privacy-never-blur');
        }

        // 4. Поиск имени и превью сообщения
        const nameContainer = row.querySelector('[data-testid="User-Name"], [data-testid="dm-conversation-username"], [role="heading"], h2, h3, h4');
        if (nameContainer) {
          nameContainer.classList.remove('pigeon-privacy-blur', 'pigeon-privacy-snippet');
          nameContainer.classList.add('pigeon-privacy-never-blur');
          const nameChildren = nameContainer.querySelectorAll('*');
          for (let c = 0; c < nameChildren.length; c++) {
            nameChildren[c].classList.remove('pigeon-privacy-blur', 'pigeon-privacy-snippet');
            nameChildren[c].classList.add('pigeon-privacy-never-blur');
          }
        }

        // Собираем все текстовые узлы внутри строки диалога
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
        let n;
        const textNodes = [];
        while ((n = walker.nextNode())) {
          const val = (n.nodeValue || '').trim();
          if (val && !['·', '•', '-', '—', '|'].includes(val)) {
            const p = n.parentElement;
            if (p && !p.closest('time, svg, img, [data-testid*="badge" i], [data-testid*="unread" i], [data-testid*="avatar" i], [data-testid*="Avatar" i]')) {
              textNodes.push({ node: n, element: p, text: val });
            }
          }
        }

        if (textNodes.length > 0) {
          // Если имя не было найдено по селектору data-testid, первый текстовый узел — это имя
          if (!nameContainer) {
            const nameEl = textNodes[0].element;
            nameEl.classList.remove('pigeon-privacy-blur', 'pigeon-privacy-snippet');
            nameEl.classList.add('pigeon-privacy-never-blur');
            const inners = nameEl.querySelectorAll('*');
            for (let c = 0; c < inners.length; c++) {
              inners[c].classList.remove('pigeon-privacy-blur', 'pigeon-privacy-snippet');
              inners[c].classList.add('pigeon-privacy-never-blur');
            }
          }

          // Все текстовые узлы, которые НЕ входят в имя, — это превью последнего сообщения (snippet)!
          for (let t = 0; t < textNodes.length; t++) {
            const item = textNodes[t];
            const el = item.element;
            if (nameContainer && (nameContainer === el || nameContainer.contains(el))) continue;
            if (!nameContainer && (t === 0 || textNodes[0].element.contains(el))) continue;

            // Навешиваем класс размытия превью
            el.classList.remove('pigeon-privacy-never-blur', 'pigeon-privacy-blur');
            el.classList.add('pigeon-privacy-snippet');

            // Также навешиваем на родительский контейнер строки превью (если он не строка диалога и не содержит имя/время/аватар)
            let cur = el;
            for (let d = 0; d < 2; d++) {
              const parent = cur.parentElement;
              if (parent && parent !== row && !parent.contains(nameContainer || textNodes[0].element) && !parent.querySelector('time, img, [data-testid*="avatar" i]')) {
                parent.classList.remove('pigeon-privacy-never-blur', 'pigeon-privacy-blur');
                parent.classList.add('pigeon-privacy-snippet');
                cur = parent;
              } else {
                break;
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  function tagQuotedMessages() {
    try {
      if (!appConfig.privacyBlur) return;

      // Разметка списка и каждого сообщения включает обход всех видимых строк.
      // Когда Privacy Blur выключен, она не нужна вовсе и не должна отнимать
      // время у React во время активной переписки.
      tagConversationItems();

      // 1. Обходим элементы сообщений ТОЛЬКО в чате (исключая сайдбар диалогов и шапку)
      const tweetTexts = document.querySelectorAll('[data-testid="tweetText"], [data-testid^="message-text-"]');
      for (let i = 0; i < tweetTexts.length; i++) {
        const tt = tweetTexts[i];
        if (isInsideConversationList(tt)) continue;

        let cur = tt.parentElement;
        for (let depth = 0; depth < 4; depth++) {
          if (!cur || cur === document.body) break;
          const isMsgBoundary = cur.matches && cur.matches('[data-testid="cellInnerDiv"], [data-testid="messageEntry"], [data-testid^="dm-message-"]');

          const parent = cur.parentElement;
          if (parent && !isInsideConversationList(parent) && !parent.closest('[data-testid*="header" i], [data-testid="TopNavBar"], [data-testid="dmComposer"]')) {
            const siblings = parent.children;
            for (let j = 0; j < siblings.length; j++) {
              const child = siblings[j];
              if (child !== cur && !child.contains(tt) && !isInsideConversationList(child)) {
                if (child.closest('[data-testid*="header" i], [data-testid="TopNavBar"], [data-testid="dmComposer"]')) continue;
                const txt = (child.innerText || child.textContent || '').trim();
                const isDate = (txt === 'Today' || txt === 'Yesterday' || txt === 'Сегодня' || txt === 'Вчера');
                if (!isDate && (txt.length > 0 || child.querySelector('img, video, svg, [style*="background"]'))) {
                  child.classList.add('pigeon-privacy-blur');
                  const inners = child.querySelectorAll('*');
                  for (let k = 0; k < inners.length; k++) {
                    if (!inners[k].classList.contains('pigeon-privacy-never-blur') && !inners[k].closest('[data-testid*="header" i], [data-testid="TopNavBar"], [data-testid="dmComposer"]')) {
                      inners[k].classList.add('pigeon-privacy-blur');
                    }
                  }
                }
              }
            }
          }

          const children = cur.children;
          for (let j = 0; j < children.length; j++) {
            const child = children[j];
            if (child !== tt && !child.contains(tt) && !isInsideConversationList(child)) {
              if (child.closest('[data-testid*="header" i], [data-testid="TopNavBar"], [data-testid="dmComposer"]')) continue;
              child.classList.add('pigeon-privacy-blur');
              const inners = child.querySelectorAll('*');
              for (let k = 0; k < inners.length; k++) {
                if (!inners[k].classList.contains('pigeon-privacy-never-blur') && !inners[k].closest('[data-testid*="header" i], [data-testid="TopNavBar"], [data-testid="dmComposer"]')) {
                  inners[k].classList.add('pigeon-privacy-blur');
                }
              }
            }
          }

          if (isMsgBoundary) break;
          cur = parent;
        }
      }

      // 2. Поиск интерактивных блоков цитат/ответов ТОЛЬКО внутри сообщений чата
      const messageContainers = document.querySelectorAll('[data-testid="messageEntry"], [data-testid^="dm-message-"], [data-testid="cellInnerDiv"]');
      for (let m = 0; m < messageContainers.length; m++) {
        const mc = messageContainers[m];
        if (isInsideConversationList(mc)) continue;

        const candidates = mc.querySelectorAll('[role="link"], [role="button"], a, div');
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i];
          if (el.hasAttribute('data-testid') && el.getAttribute('data-testid') === 'tweetText') continue;
          if (el.querySelector('[data-testid="tweetText"]')) continue;
          if (el.classList.contains('pigeon-privacy-never-blur')) continue;

          const txt = (el.innerText || el.textContent || '').trim();
          const hasReplyIndicator = txt.includes('↰') || txt.includes('↖') || txt.includes('↩') || el.querySelector('svg');
          if (hasReplyIndicator && txt.length > 0) {
            el.classList.add('pigeon-privacy-blur');
            const inners = el.querySelectorAll('*');
            for (let k = 0; k < inners.length; k++) {
              if (!inners[k].classList.contains('pigeon-privacy-never-blur')) {
                inners[k].classList.add('pigeon-privacy-blur');
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  function applyPrivacyState() {
    ensureGlobalPrivacyStyles();
    const doc = document.documentElement;
    if (doc && doc.classList) {
      doc.classList.toggle('pigeon-reduced-motion', appConfig.reducedMotion === true);
      if (appConfig.privacyBlur) {
        doc.classList.add('pigeon-privacy-active');
      } else {
        doc.classList.remove('pigeon-privacy-active');
      }
    }
    tagQuotedMessages();
    window.postMessage({ type: 'pigeon-set-ghost-mode', enabled: !!appConfig.ghostMode }, '*');
    updatePrivacyButtonState();
    updatePrivacyDropdownItem();
    const toggle = document.getElementById('pigeon-privacy-blur-toggle');
    if (toggle) toggle.checked = !!appConfig.privacyBlur;
    const bossToggle = document.getElementById('pigeon-boss-toggle');
    if (bossToggle) bossToggle.checked = appConfig.bossKeyEnabled !== false;
    const motionToggle = document.getElementById('pigeon-reduced-motion-toggle');
    if (motionToggle) motionToggle.checked = appConfig.reducedMotion === true;
  }

  function mountPrivacyButton() {
    const existing = document.getElementById('pigeon-privacy-btn');
    if (existing) existing.remove();
  }

  // --- Пункт "Ghost mode" в выпадающем меню фильтров (после "Mark all as read") ---
  function findMarkAllReadRow() {
    try {
      const menuRoot = document.querySelector('[role="menu"], [data-testid="Dropdown"]');
      if (!menuRoot) return null;
      // 1. Быстрый поиск по всем интерактивным элементам в меню
      const allCandidates = menuRoot.querySelectorAll('[role="menuitem"], [role="button"], div[tabindex="0"], a[role="link"], span, div');
      let markEl = null;

      for (const el of allCandidates) {
        // Проверяем элементы с небольшим количеством детей (не контейнеры всей страницы)
        if (el.children && el.children.length > 3) continue;
        const text = (el.textContent || '').replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim().toLowerCase();
        if (
          text === 'mark all as read' ||
          text === 'отметить все как прочитанные' ||
          text === 'отметить все прочитанными' ||
          text === 'прочитать все' ||
          text === 'пометить все как прочитанные'
        ) {
          markEl = el;
          break;
        }
      }

      // 2. Резервный поиск через TreeWalker
      if (!markEl) {
        const root = menuRoot;
        if (!root) return null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          const txt = (node.nodeValue || '').replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim().toLowerCase();
          if (
            txt === 'mark all as read' ||
            txt.includes('mark all as read') ||
            txt.includes('отметить все') ||
            txt.includes('прочитать все') ||
            txt.includes('пометить все')
          ) {
            markEl = node.parentElement;
            break;
          }
        }
      }

      if (!markEl) {
        const byTestId = document.querySelector('[data-testid="dm-inbox-dropdown-mark-all-read"], [data-testid*="mark-all-read" i]');
        if (byTestId) {
          return byTestId.closest('[role="menuitem"]') || byTestId.closest('div[role="button"]') || byTestId;
        }
        return null;
      }

      // Находим строку menuitem для "Mark all as read"
      const menuItem = markEl.closest('[role="menuitem"], [role="button"], div[tabindex="0"]') || markEl;
      return menuItem;
    } catch (e) {
      console.warn('[Pigeon Dropdown] Ошибка в findMarkAllReadRow:', e);
      return null;
    }
  }

  function updatePrivacyDropdownItem() {
    const item = document.getElementById('pigeon-dropdown-privacy-blur');
    if (!item) return;

    const isRu = appConfig.language === 'ru';
    const isEnabled = !!appConfig.privacyBlur;

    item.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: ${isEnabled ? '#1d9bf0' : '#e7e9ea'}; flex-shrink: 0;">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 500; color: #e7e9ea; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 20px;">
          ${isRu ? 'Размытие сообщений' : 'Privacy blur'}
        </span>
      </div>
      <div id="pigeon-privacy-check-indicator" style="display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; margin-left: 16px;">
        ${isEnabled ? `
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#e7e9ea" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        ` : ''}
      </div>
    `;
  }

  function createPrivacyDropdownItem(sampleItem) {
    const item = document.createElement('div');
    item.id = 'pigeon-dropdown-privacy-blur';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '0');

    if (sampleItem && typeof sampleItem.className === 'string') {
      item.className = sampleItem.className;
    }

    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.justifyContent = 'space-between';
    item.style.padding = '12px 16px';
    item.style.cursor = 'pointer';
    item.style.userSelect = 'none';
    item.style.transition = 'background-color 0.15s ease';
    item.style.boxSizing = 'border-box';
    item.style.width = '100%';
    item.style.minHeight = '44px';

    item.addEventListener('mouseenter', () => {
      item.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
    });
    item.addEventListener('mouseleave', () => {
      item.style.backgroundColor = 'transparent';
    });

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();

      const newState = !appConfig.privacyBlur;
      setPrivacyBlurState(newState);
      updatePrivacyDropdownItem();

      setTimeout(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      }, 250);
    });

    return item;
  }

  function mountDropdownPrivacyBlur() {
    try {
      const markReadRow = findMarkAllReadRow();
      if (!markReadRow) return;

      const parent = markReadRow.parentElement;
      if (!parent) return;

      // Удаляем устаревший пункт Ghost Mode из меню
      const oldGhost = document.getElementById('pigeon-dropdown-ghost-mode');
      if (oldGhost) oldGhost.remove();

      // Предотвращаем обрезку выпадающего меню по высоте и overflow
      const menuContainer = markReadRow.closest('[role="menu"], [data-testid="Dropdown"], [data-testid="sheetDialog"]') || parent;
      if (menuContainer) {
        if (menuContainer.style.overflow !== 'visible') {
          menuContainer.style.overflow = 'visible';
        }
        if (menuContainer.style.maxHeight && menuContainer.style.maxHeight !== 'none') {
          menuContainer.style.maxHeight = 'none';
        }
      }

      let privacyItem = document.getElementById('pigeon-dropdown-privacy-blur');
      if (privacyItem && privacyItem.isConnected) {
        if (markReadRow.nextElementSibling !== privacyItem) {
          markReadRow.after(privacyItem);
        }
        return;
      }

      console.log('[Pigeon Dropdown] Mounting Privacy Blur row right after "Mark all as read"');
      privacyItem = createPrivacyDropdownItem(markReadRow);
      markReadRow.after(privacyItem);
      updatePrivacyDropdownItem();
    } catch (e) {
      console.warn('[Pigeon Dropdown] Ошибка в mountDropdownPrivacyBlur:', e);
    }
  }

  function mountConversationTopMenuItem() {
    try {
      // Одновременно могут существовать меню левой ленты и карточки профиля.
      // Нельзя брать первое попавшееся: ищем именно меню, в котором есть
      // «Игнорировать» и «Поиск» из контекстного меню текущего диалога.
      const menuRoots = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"], [data-testid="Dropdown"], [data-testid="sheetDialog"]'));
      let menu = null;
      let ignoreItem = null;
      let searchItem = null;

      for (const menuRoot of menuRoots) {
        if (!isVisibleElement(menuRoot)) continue;
        const candidates = menuRoot.querySelectorAll('[role="menuitem"], button, [role="button"], [tabindex="0"]');
        let localIgnore = null;
        let localSearch = null;
        for (const candidate of candidates) {
          if (!isVisibleElement(candidate)) continue;
          const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`.trim().toLowerCase();
          if (!localIgnore && /(^|\s)(ignore|игнорировать)(\s|$)/.test(label)) localIgnore = candidate;
          if (!localSearch && /(^|\s)(search|поиск)(\s|$)/.test(label)) localSearch = candidate;
        }
        if (localIgnore && localSearch) {
          menu = menuRoot;
          ignoreItem = localIgnore;
          searchItem = localSearch;
          break;
        }
      }

      // В части сборок X строки меню не получают role="menuitem" и само меню
      // не имеет role="menu". Этот резерв работает только после клика по
      // «Ещё», поэтому не затрагивает отправку или приход сообщений.
      if (!menu || !ignoreItem || !searchItem) {
        const visibleItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"], button, [tabindex="0"]'))
          .filter(isVisibleElement);
        const labelOf = candidate => `${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`.trim().toLowerCase();
        const fallbackIgnore = visibleItems.find(candidate => /(^|\s)(ignore|игнорировать)(\s|$)/.test(labelOf(candidate)));
        if (fallbackIgnore) {
          const fallbackMenu = fallbackIgnore.closest('[role="menu"], [role="dialog"], [data-testid="Dropdown"], [data-testid="sheetDialog"]') || fallbackIgnore.parentElement;
          const fallbackSearch = visibleItems.find(candidate =>
            candidate !== fallbackIgnore &&
            (candidate.closest('[role="menu"], [role="dialog"], [data-testid="Dropdown"], [data-testid="sheetDialog"]') || candidate.parentElement) === fallbackMenu &&
            /(^|\s)(search|поиск)(\s|$)/.test(labelOf(candidate))
          );
          if (fallbackMenu && fallbackSearch) {
            menu = fallbackMenu;
            ignoreItem = fallbackIgnore;
            searchItem = fallbackSearch;
          }
        }
      }

      // Последний резерв для XChat без ARIA-ролей: находим два точных
      // текстовых узла и поднимаемся до их строк-соседей. Никаких догадок о
      // className X не требуется.
      if (!menu || !ignoreItem || !searchItem) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const ignoreLeaves = [];
        const searchLeaves = [];
        let textNode;
        while ((textNode = walker.nextNode())) {
          const value = (textNode.nodeValue || '').trim().toLowerCase();
          if (value === 'игнорировать' || value === 'ignore') ignoreLeaves.push(textNode.parentElement);
          if (value === 'поиск' || value === 'search') searchLeaves.push(textNode.parentElement);
        }
        outer:
        for (const ignoreLeaf of ignoreLeaves) {
          for (const searchLeaf of searchLeaves) {
            let left = ignoreLeaf;
            while (left && left !== document.body) {
              let right = searchLeaf;
              while (right && right !== document.body) {
                if (left.parentElement && left.parentElement === right.parentElement &&
                    left !== right && isVisibleElement(left) && isVisibleElement(right)) {
                  menu = left.parentElement;
                  ignoreItem = left;
                  searchItem = right;
                  break outer;
                }
                right = right.parentElement;
              }
              left = left.parentElement;
            }
          }
        }
      }
      if (!menu || !ignoreItem || !searchItem) return;
      let item = document.getElementById('pigeon-menu-chat-top');
      if (item && item.isConnected) {
        if (searchItem.previousElementSibling !== item) searchItem.before(item);
        return;
      }

      item = document.createElement('div');
      item.id = 'pigeon-menu-chat-top';
      // Используем тот же набор классов и фактические размеры соседней строки,
      // а не угадываем тёмный оттенок меню вручную.
      item.className = searchItem.className || ignoreItem.className;
      const nativeStyle = getComputedStyle(searchItem);
      const menuStyle = getComputedStyle(menu);
      item.style.minHeight = nativeStyle.minHeight;
      item.style.padding = nativeStyle.padding;
      item.style.color = nativeStyle.color;
      item.style.font = nativeStyle.font;
      item.style.backgroundColor = nativeStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        ? menuStyle.backgroundColor
        : nativeStyle.backgroundColor;
      item.setAttribute('role', 'menuitem');
      item.tabIndex = 0;
      item.innerHTML = `<span class="pigeon-menu-arrow">↑</span><span>${appConfig.language === 'ru' ? 'В начало переписки' : 'Go to start of chat'}</span>`;
      const activate = event => {
        event.preventDefault();
        event.stopPropagation();
        scrollChatToBeginning();
        setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })), 1);
      };
      item.addEventListener('click', activate);
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') activate(event);
      });
      searchItem.before(item);
    } catch (e) {}
  }

  // Горячие клавиши в окне (Ctrl+Shift+P для Privacy Blur, Ctrl+Alt+H для Boss Key)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'p' || e.key === 'P' || e.code === 'KeyP')) {
      e.preventDefault();
      togglePrivacyBlur();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'h' || e.key === 'H' || e.code === 'KeyH')) {
      if (appConfig.bossKeyEnabled !== false) {
        e.preventDefault();
        ipcRenderer.send('boss-key-trigger');
        return;
      }
    }
  }, true);

  // Синхронизация настроек из главного процесса
  try {
    ipcRenderer.invoke('get-settings').then(cfg => {
      console.log('[Pigeon Preload] get-settings resolved:', JSON.stringify(cfg));
      if (cfg) {
        appConfig = { ...appConfig, ...cfg };
        applyPrivacyState();
        updateCardContent();
      }
    }).catch((err) => {
      console.error('[Pigeon Preload] get-settings error:', err);
    });
  } catch (e) {
    console.error('[Pigeon Preload] invoke get-settings exception:', e);
  }

  ipcRenderer.on('settings-sync', (_event, cfg) => {
    appConfig = { ...appConfig, ...cfg };
    applyPrivacyState();
    updateCardContent();
  });

  ipcRenderer.on('language-changed', (_event, lang) => {
    appConfig.language = lang;
    applyPrivacyState();
    updateCardContent();
  });

  // Воспроизведение звука уведомления (1 уведомление = 1 звук) с защитой от сборщика мусора
  const activeAudioPool = new Set();

  ipcRenderer.on('play-sound-in-renderer', (_event, dataUri) => {
    if (!dataUri) return;
    try {
      const audio = new Audio(dataUri);
      audio.volume = 1.0;
      activeAudioPool.add(audio);
      const cleanup = () => {
        activeAudioPool.delete(audio);
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          cleanup();
          console.warn('[Pigeon Audio Preload] audio.play() error:', err);
        });
      }
    } catch (err) {
      console.error('[Pigeon Audio Preload] Audio creation error:', err);
    }
  });

  function ensureStyles() {
    const existingStyle = document.getElementById('pigeon-settings-styles');
    if (existingStyle) {
      // Do not reinsert CSS: this invalidates styles throughout the chat.
      return;
    }
    const styleEl = document.createElement('style');
    styleEl.id = 'pigeon-settings-styles';
    styleEl.textContent = `
      /* Только реальные области прокрутки. Нельзя вешать это на каждый div:
         XChat создаёт их десятками на одно сообщение. */
      [data-testid="DmScroller"],
      [data-testid="dm-conversation"],
      [data-testid="message-list"],
      [data-testid="dm-conversation-scroller"],
      [data-testid="DmActivityFeed"],
      [data-testid="DMDrawer"],
      .pigeon-conversation-scroll-area {
        scrollbar-width: thin !important;
        scrollbar-color: rgba(62, 168, 235, 0.82) rgba(255, 255, 255, 0.025) !important;
      }
      @keyframes pigeonOptAppear {
        from { opacity: 0; transform: translateY(6px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes pigeonOptSpin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      [data-testid="DmScroller"]::-webkit-scrollbar,
      [data-testid="dm-conversation"]::-webkit-scrollbar,
      [data-testid="message-list"]::-webkit-scrollbar,
      [data-testid="dm-conversation-scroller"]::-webkit-scrollbar,
      [data-testid="DmActivityFeed"]::-webkit-scrollbar,
      [data-testid="DMDrawer"]::-webkit-scrollbar,
      .pigeon-conversation-scroll-area::-webkit-scrollbar {
        width: 12px !important;
        height: 12px !important;
      }
      [data-testid="DmScroller"]::-webkit-scrollbar-track,
      [data-testid="dm-conversation"]::-webkit-scrollbar-track,
      [data-testid="message-list"]::-webkit-scrollbar-track,
      [data-testid="dm-conversation-scroller"]::-webkit-scrollbar-track,
      [data-testid="DmActivityFeed"]::-webkit-scrollbar-track,
      [data-testid="DMDrawer"]::-webkit-scrollbar-track,
      .pigeon-conversation-scroll-area::-webkit-scrollbar-track {
        margin: 6px 0;
        background: rgba(255, 255, 255, 0.025) !important;
        border-radius: 999px;
      }
      [data-testid="DmScroller"]::-webkit-scrollbar-thumb,
      [data-testid="dm-conversation"]::-webkit-scrollbar-thumb,
      [data-testid="message-list"]::-webkit-scrollbar-thumb,
      [data-testid="dm-conversation-scroller"]::-webkit-scrollbar-thumb,
      [data-testid="DmActivityFeed"]::-webkit-scrollbar-thumb,
      [data-testid="DMDrawer"]::-webkit-scrollbar-thumb,
      .pigeon-conversation-scroll-area::-webkit-scrollbar-thumb {
        min-height: 44px;
        background: linear-gradient(180deg, #55c5ff, #1685c5) !important;
        border: 3px solid transparent !important;
        border-radius: 999px;
        background-clip: padding-box !important;
        box-shadow: 0 0 8px rgba(29, 155, 240, 0.24);
        transition: filter 160ms ease, border-width 160ms ease;
      }
      [data-testid="DmScroller"]::-webkit-scrollbar-thumb:hover,
      [data-testid="dm-conversation"]::-webkit-scrollbar-thumb:hover,
      [data-testid="message-list"]::-webkit-scrollbar-thumb:hover,
      [data-testid="dm-conversation-scroller"]::-webkit-scrollbar-thumb:hover,
      [data-testid="DmActivityFeed"]::-webkit-scrollbar-thumb:hover,
      [data-testid="DMDrawer"]::-webkit-scrollbar-thumb:hover,
      .pigeon-conversation-scroll-area::-webkit-scrollbar-thumb:hover {
        background: linear-gradient(180deg, #8bdbff, #1d9bf0) !important;
        border-width: 2px !important;
        background-clip: padding-box !important;
        filter: brightness(1.08);
      }
      [data-testid="DmScroller"]::-webkit-scrollbar-corner,
      [data-testid="DmScroller"]::-webkit-scrollbar-button,
      [data-testid="dm-conversation"]::-webkit-scrollbar-corner,
      [data-testid="dm-conversation"]::-webkit-scrollbar-button,
      [data-testid="message-list"]::-webkit-scrollbar-corner,
      [data-testid="message-list"]::-webkit-scrollbar-button,
      [data-testid="dm-conversation-scroller"]::-webkit-scrollbar-corner,
      [data-testid="dm-conversation-scroller"]::-webkit-scrollbar-button {
        display: none;
      }
      /* Не используем content-visibility на сообщениях: XChat сам
         виртуализирует ленту и измеряет высоту карточек. В длинных личных
         диалогах принудительное скрытие контента может заставить React
         повторно пересчитывать всю ленту после каждой отправки. */
      /* XChat прокручивает сам документ вместе с внутренним списком сообщений.
         Внешняя полоса ничего не даёт и визуально дублирует прокрутку чата. */
      html, body {
        scrollbar-width: none !important;
      }
      html::-webkit-scrollbar,
      body::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
        display: none !important;
      }
      /* Скрываем только полосу списка диалогов. Сам список остаётся
         прокручиваемым колесом мыши/тачпадом, а полоса истории чата не
         затрагивается. */
      #x-chat-conversation-list {
        scrollbar-width: none !important;
      }
      #x-chat-conversation-list::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
        display: none !important;
      }
      #pigeon-settings-card {
        /* Карточка — сосед нативного блока max-w-2xl. Без явной ширины
           flex-контейнер XChat сжимает её до ширины содержимого. */
        width: 100%;
        max-width: 42rem;
        box-sizing: border-box;
        border-top: 1px solid rgb(47, 51, 54);
      }
      .pigeon-settings-section {
        border-bottom: 1px solid rgb(47, 51, 54);
        animation: pigeonFadeIn var(--pigeon-motion-standard) var(--pigeon-motion-ease);
      }
      @keyframes pigeonFadeIn {
        from { opacity: 0; transform: translateY(5px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .pigeon-section-title {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 15px;
        font-weight: 700;
        color: #e7e9ea;
        padding: 14px 16px 2px 16px;
        line-height: 1.3;
      }
      .pigeon-section-desc {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        color: #71767b;
        padding: 0 16px 8px 16px;
        line-height: 1.3;
      }
      .pigeon-native-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid rgb(47, 51, 54);
        gap: 16px;
        min-height: 48px;
        cursor: default;
        transition: background-color var(--pigeon-motion-fast) ease, box-shadow var(--pigeon-motion-fast) ease;
      }
      .pigeon-native-row:hover {
        background-color: rgba(255, 255, 255, 0.02);
      }
      .pigeon-native-row.setting-confirmed {
        box-shadow: inset 3px 0 0 rgba(29, 155, 240, 0.85);
        background-color: rgba(29, 155, 240, 0.06);
      }
      .pigeon-native-row:last-child {
        border-bottom: none;
      }
      .pigeon-row-left {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
      }
      .pigeon-row-title {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 15px;
        font-weight: 400;
        color: #e7e9ea;
        line-height: 1.3;
      }
      .pigeon-row-desc {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        color: #71767b;
        line-height: 1.3;
        margin-top: 2px;
      }
      .pigeon-danger-section {
        border-bottom: none;
      }
      .pigeon-danger-row {
        border-bottom: none;
      }
      .pigeon-danger-button {
        flex-shrink: 0;
        appearance: none;
        border: 1px solid rgba(244, 33, 46, 0.72);
        border-radius: 9999px;
        padding: 7px 13px;
        background: transparent;
        color: #f4212e;
        font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        cursor: pointer;
        transition: background-color var(--pigeon-motion-fast) ease, color var(--pigeon-motion-fast) ease, opacity var(--pigeon-motion-fast) ease;
      }
      .pigeon-danger-button:hover:not(:disabled) {
        background: rgba(244, 33, 46, 0.12);
      }
      .pigeon-danger-button:active:not(:disabled) {
        background: rgba(244, 33, 46, 0.2);
      }
      .pigeon-danger-button:disabled {
        cursor: wait;
        opacity: 0.64;
      }
      .pigeon-switch {
        position: relative;
        display: inline-block;
        width: 40px;
        height: 20px;
        flex-shrink: 0;
      }
      .pigeon-switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .pigeon-slider {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: rgb(83, 100, 113);
        transition: background-color var(--pigeon-motion-fast) ease;
        border-radius: 20px;
      }
      .pigeon-slider:before {
        position: absolute;
        content: "";
        height: 16px;
        width: 16px;
        left: 2px;
        bottom: 2px;
        background-color: white;
        transition: transform var(--pigeon-motion-fast) var(--pigeon-motion-ease);
        border-radius: 50%;
      }
      .pigeon-switch input:checked + .pigeon-slider {
        background-color: #1d9bf0;
      }
      .pigeon-switch input:checked + .pigeon-slider:before {
        transform: translateX(20px);
      }
      .pigeon-sound-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .pigeon-preview-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: none;
        background: rgba(29, 155, 240, 0.1);
        color: #1d9bf0;
        cursor: pointer;
        transition: all 0.15s ease;
        padding: 0;
        outline: none;
      }
      .pigeon-preview-btn:hover {
        background: rgba(29, 155, 240, 0.2);
      }
      .pigeon-preview-btn:active {
        transform: scale(0.92);
      }
      .pigeon-preview-btn svg {
        width: 15px;
        height: 15px;
        fill: currentColor;
      }
      .pigeon-sound-select {
        background: #000000;
        color: #e7e9ea;
        border: 1px solid rgb(83, 100, 113);
        border-radius: 4px;
        padding: 6px 12px;
        font-size: 14px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        outline: none;
        cursor: pointer;
        max-width: 210px;
        transition: border-color 0.15s ease;
      }
      .pigeon-sound-select:focus {
        border-color: #1d9bf0;
      }
      .pigeon-lang-group {
        display: flex;
        align-items: center;
        background: rgb(22, 24, 28);
        border: 1px solid rgb(47, 51, 54);
        border-radius: 9999px;
        padding: 3px;
        gap: 2px;
        flex-shrink: 0;
      }
      .pigeon-lang-btn {
        border: none;
        background: transparent;
        color: #71767b;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 500;
        padding: 4px 14px;
        border-radius: 9999px;
        cursor: pointer;
        transition: all 0.15s ease;
        user-select: none;
        outline: none;
      }
      .pigeon-lang-btn:hover:not(.active) {
        color: #e7e9ea;
      }
      .pigeon-lang-btn.active {
        background: #1d9bf0;
        color: #ffffff;
        font-weight: 600;
      }
    `;
    const parent = document.head || document.documentElement;
    if (parent) {
      parent.appendChild(styleEl);
    }
  }

  function flashSettingFeedback(input) {
    const row = input && input.closest ? input.closest('.pigeon-native-row') : null;
    if (!row) return;
    row.classList.remove('setting-confirmed');
    void row.offsetWidth;
    row.classList.add('setting-confirmed');
    setTimeout(() => row.classList.remove('setting-confirmed'), appConfig.reducedMotion ? 1 : 520);
  }

  function isSettingsViewActive() {
    // 1. Проверяем URL
    const url = window.location.href;
    if (url.includes('/settings') || url.includes('/i/dm_settings') || window.location.hash.includes('settings')) {
      return true;
    }

    // 2. Если на экране логина / ввода пароля аккаунта (не путать с настройками), то настройки не активны
    const isLoginScreen = document.querySelector('input[name="password"], input[autocomplete="current-password"], [data-testid="ocfEnterPasscodeHeader"]');
    if (isLoginScreen && !document.querySelector('[data-testid="primaryColumn"], [role="main"]')) {
      return false;
    }

    // 3. Проверяем наличие ключевых маркеров настроек XChat
    const panel = document.querySelector('[data-testid="settings"], [data-testid="settingsPanel"], [role="dialog"]');
    const bodyText = panel ? (panel.textContent || '').toLowerCase() : '';
    if (!bodyText) return false;

    return (
      bodyText.includes('primary color') ||
      bodyText.includes('основной цвет') ||
      bodyText.includes('local data & storage') ||
      bodyText.includes('локальные данные') ||
      bodyText.includes('allow message requests') ||
      bodyText.includes('enable audio and video') ||
      bodyText.includes('encrypted messages') ||
      bodyText.includes('change passcode')
    );
  }

  function findSettingsInsertTarget() {
    const root = document.body || document.documentElement;
    if (!root) return null;

    // Актуальная разметка XChat (сентябрь 2026) не содержит старых пунктов
    // «Primary color» / «Local data». Она держит весь экран настроек в одном
    // контейнере внутри dm-conversation-panel. Вставляем карточку сразу после
    // него — это надёжнее привязки к переведённому тексту отдельной настройки.
    const settingsPanel = document.querySelector('[data-testid="dm-conversation-panel"]');
    if (settingsPanel) {
      const settingsContent = Array.from(settingsPanel.querySelectorAll('div')).find(el =>
        el.classList.contains('flex') &&
        el.classList.contains('w-full') &&
        el.classList.contains('max-w-2xl') &&
        el.classList.contains('flex-col')
      );
      if (settingsContent) return { row: settingsContent };
    }

    // Запасной путь для старой разметки XChat.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    let colorEl = null;
    let encryptedEl = null;
    let localDataEl = null;
    let otherEl = null;

    while ((node = walker.nextNode())) {
      const txt = (node.nodeValue || '').replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim().toLowerCase();
      if (!txt) continue;
      if (!colorEl && (txt === 'primary color' || txt === 'основной цвет' || txt.includes('accent color') || txt.includes('цветовую тему'))) {
        colorEl = node.parentElement;
      }
      if (!encryptedEl && (txt === 'encrypted messages' || txt === 'зашифрованные сообщения' || txt.includes('change passcode') || txt.includes('пароль доступа'))) {
        encryptedEl = node.parentElement;
      }
      if (!localDataEl && (txt === 'local data & storage' || txt === 'локальные данные и память' || txt.includes('total cached media') || txt.includes('cached media') || txt.includes('кэшированных'))) {
        localDataEl = node.parentElement;
      }
      if (!otherEl && (txt.includes('audio and video') || txt.includes('аудио- и видеозвонки') || txt.includes('message requests') || txt.includes('запросы на переписку') || txt.includes('relay calls'))) {
        otherEl = node.parentElement;
      }
    }

    // Приоритет вставки: сразу после «Primary color» (видна сразу без прокрутки), затем «Encrypted messages», затем «Local data & storage»
    const targetAnchor = colorEl || encryptedEl || localDataEl;
    if (!targetAnchor) return null;

    const refAnchor = otherEl || (targetAnchor === colorEl ? (encryptedEl || localDataEl) : colorEl);

    // Ищем общий контейнер (список секций) для targetAnchor и refAnchor
    if (refAnchor && refAnchor !== targetAnchor) {
      const targetParents = [];
      let t = targetAnchor;
      while (t && t !== document.body) {
        targetParents.push(t);
        t = t.parentElement;
      }

      let lca = null;
      let r = refAnchor;
      while (r && r !== document.body) {
        if (targetParents.includes(r)) {
          lca = r;
          break;
        }
        r = r.parentElement;
      }

      if (lca) {
        let cur = targetAnchor;
        while (cur && cur.parentElement && cur.parentElement !== lca) {
          cur = cur.parentElement;
        }
        if (cur && cur.parentElement === lca) {
          return { row: cur };
        }
      }
    }

    // Запасной вариант: поднимаемся от targetAnchor до подходящего блочного контейнера секции
    let cur = targetAnchor;
    while (cur && cur.parentElement && cur.parentElement !== document.body) {
      const p = cur.parentElement;
      if (p.children && p.children.length >= 2 && (p.scrollHeight > 100 || p.clientHeight > 100)) {
        return { row: cur };
      }
      cur = p;
    }

    return null;
  }

  function updateCardContent() {
    const card = document.getElementById('pigeon-settings-card');
    if (!card) return;

    const isRu = appConfig.language === 'ru';
    const sounds = (appConfig.sounds && appConfig.sounds.length > 0) ? appConfig.sounds : DEFAULT_SOUNDS;

    // Секция уведомлений
    const s1Title = card.querySelector('#pigeon-s1-title');
    const s1Desc = card.querySelector('#pigeon-s1-desc');
    if (s1Title) s1Title.textContent = isRu ? 'Уведомления' : 'Notifications';
    if (s1Desc) s1Desc.textContent = isRu ? 'Звуковые оповещения о входящих сообщениях.' : 'Sound alerts for incoming messages.';

    const row0Title = card.querySelector('#pigeon-row0-title');
    const row0Desc = card.querySelector('#pigeon-row0-desc');
    if (row0Title) row0Title.textContent = isRu ? 'Уведомления' : 'Notifications';
    if (row0Desc) row0Desc.textContent = isRu ? 'Всплывающие окна и звуковые сигналы' : 'Pop-up alerts and sound notifications';

    const notifToggle = card.querySelector('#pigeon-notif-toggle');
    if (notifToggle) notifToggle.checked = appConfig.notificationsEnabled !== false;

    const row1Title = card.querySelector('#pigeon-row1-title');
    const row1Desc = card.querySelector('#pigeon-row1-desc');
    if (row1Title) row1Title.textContent = isRu ? 'Звуковой сигнал' : 'Sound alert';
    if (row1Desc) row1Desc.textContent = isRu ? 'Воспроизводить звук при входящем сообщении' : 'Play sound when receiving a new message';

    const toggle = card.querySelector('#pigeon-sound-toggle');
    if (toggle) toggle.checked = appConfig.soundEnabled !== false;

    const soundRow = card.querySelector('#pigeon-sound-select-row');
    if (soundRow) {
      soundRow.style.display = appConfig.soundEnabled !== false ? 'flex' : 'none';
    }
    const row2Title = card.querySelector('#pigeon-row2-title');
    const row2Desc = card.querySelector('#pigeon-row2-desc');
    if (row2Title) row2Title.textContent = isRu ? 'Мелодия уведомления' : 'Notification sound';
    if (row2Desc) row2Desc.textContent = isRu ? 'Выберите звук для сообщений' : 'Select sound for new messages';

    const previewBtn = card.querySelector('#pigeon-preview-btn');
    if (previewBtn) previewBtn.title = isRu ? 'Прослушать звук' : 'Play preview';

    const select = card.querySelector('#pigeon-sound-dropdown');
    if (select) {
      select.innerHTML = sounds.map(s => `
        <option value="${s.id}" ${s.id === appConfig.soundFile ? 'selected' : ''}>
          ${isRu ? (s.nameRu || s.nameEn || s.id) : (s.nameEn || s.id)}
        </option>
      `).join('');
    }

    // Секция языка
    const s2Title = card.querySelector('#pigeon-s2-title');
    const s2Desc = card.querySelector('#pigeon-s2-desc');
    if (s2Title) s2Title.textContent = isRu ? 'Язык' : 'Language';
    if (s2Desc) s2Desc.textContent = isRu ? 'Язык интерфейса приложения.' : 'Application interface language.';

    const row3Title = card.querySelector('#pigeon-row3-title');
    const row3Desc = card.querySelector('#pigeon-row3-desc');
    if (row3Title) row3Title.textContent = isRu ? 'Язык интерфейса' : 'Interface language';
    if (row3Desc) row3Desc.textContent = isRu ? 'Английский (по умолчанию) или русский' : 'English (default) or Russian';

    const langBtns = card.querySelectorAll('.pigeon-lang-btn');
    langBtns.forEach(btn => {
      const l = btn.getAttribute('data-lang');
      if (l === appConfig.language) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Секция приватности (Privacy & Stealth)
    const sPrivTitle = card.querySelector('#pigeon-s-privacy-title');
    const sPrivDesc = card.querySelector('#pigeon-s-privacy-desc');
    if (sPrivTitle) sPrivTitle.textContent = isRu ? 'Приватность' : 'Privacy & Stealth';
    if (sPrivDesc) sPrivDesc.textContent = isRu ? 'Функции защиты приватности и скрытности.' : 'Privacy protection and stealth browsing features.';


    const rowBlurTitle = card.querySelector('#pigeon-privacy-blur-title');
    const rowBlurDesc = card.querySelector('#pigeon-privacy-blur-desc');
    if (rowBlurTitle) rowBlurTitle.textContent = isRu ? 'Размытие сообщений (Privacy Blur)' : 'Privacy Blur';
    if (rowBlurDesc) rowBlurDesc.textContent = isRu ? 'Скрывать текст сообщений до наведения курсора (Ctrl+Shift+P)' : 'Blur chat messages and previews until mouse hover (Ctrl+Shift+P)';
    const blurToggle = card.querySelector('#pigeon-privacy-blur-toggle');
    if (blurToggle) blurToggle.checked = appConfig.privacyBlur === true;

    const rowBossTitle = card.querySelector('#pigeon-boss-title');
    const rowBossDesc = card.querySelector('#pigeon-boss-desc');
    if (rowBossTitle) rowBossTitle.textContent = isRu ? 'Кнопка паники (Boss Key)' : 'Boss Key';
    if (rowBossDesc) rowBossDesc.textContent = isRu ? 'Мгновенно спрятать окно в трей по комбинации клавиш Ctrl+Alt+H' : 'Instantly hide window to tray with Ctrl+Alt+H';
    const bossToggle = card.querySelector('#pigeon-boss-toggle');
    if (bossToggle) bossToggle.checked = appConfig.bossKeyEnabled !== false;

    const rowMotionTitle = card.querySelector('#pigeon-reduced-motion-title');
    const rowMotionDesc = card.querySelector('#pigeon-reduced-motion-desc');
    if (rowMotionTitle) rowMotionTitle.textContent = isRu ? 'Уменьшить анимации' : 'Reduce animations';
    if (rowMotionDesc) rowMotionDesc.textContent = isRu ? 'Убрать плавные переходы и эффекты движения' : 'Use near-instant transitions and motion effects';
    const motionToggle = card.querySelector('#pigeon-reduced-motion-toggle');
    if (motionToggle) motionToggle.checked = appConfig.reducedMotion === true;

    // Секция автозапуска (Windows и Linux)
    const autostartSec = card.querySelector('#pigeon-autostart-section');
    if (autostartSec) {
      autostartSec.style.display = (appConfig.isWindows || appConfig.isLinux) ? 'block' : 'none';
      const s3Title = card.querySelector('#pigeon-s3-title');
      const s3Desc = card.querySelector('#pigeon-s3-desc');
      if (s3Title) s3Title.textContent = isRu ? 'Система' : 'System';
      if (s3Desc) s3Desc.textContent = isRu ? 'Параметры запуска приложения вместе с операционной системой.' : 'Application startup settings with operating system.';

      const rowAutoTitle = card.querySelector('#pigeon-row-autostart-title');
      const rowAutoDesc = card.querySelector('#pigeon-row-autostart-desc');
      if (rowAutoTitle) rowAutoTitle.textContent = isRu
        ? `Запуск программы с ${appConfig.isLinux ? 'Linux' : 'Windows'}`
        : `Launch on ${appConfig.isLinux ? 'Linux' : 'Windows'} startup`;
      if (rowAutoDesc) rowAutoDesc.textContent = isRu ? 'Запускать в фоне в трее при включении компьютера' : 'Start minimized to system tray when computer turns on';

      const autostartToggle = card.querySelector('#pigeon-autostart-toggle');
      if (autostartToggle) autostartToggle.checked = appConfig.autoStart !== false;
    }

    // Секция выхода и очистки данных всегда расположена последней.
    const dataTitle = card.querySelector('#pigeon-data-title');
    const dataDesc = card.querySelector('#pigeon-data-desc');
    const clearTitle = card.querySelector('#pigeon-clear-session-title');
    const clearDesc = card.querySelector('#pigeon-clear-session-desc');
    const clearButton = card.querySelector('#pigeon-clear-session-btn');
    if (dataTitle) dataTitle.textContent = isRu ? 'Данные и сессия' : 'Data and session';
    if (dataDesc) dataDesc.textContent = isRu ? 'Выход из X и очистка данных этого приложения.' : 'Sign out of X and clear this app\'s data.';
    if (clearTitle) clearTitle.textContent = isRu ? 'Выйти и удалить кэш' : 'Sign out and clear cache';
    if (clearDesc) clearDesc.textContent = isRu ? 'Удалить cookies, сессию, локальные данные и кэшированные медиа' : 'Remove cookies, session, local data, and cached media';
    if (clearButton && !clearButton.disabled) clearButton.textContent = isRu ? 'Выйти' : 'Sign out';
  }

  function mountPigeonSettings() {
    try {
      const active = isSettingsViewActive();
      console.log('[Pigeon Settings] mountPigeonSettings called, active =', active);
      if (!active) {
        const existing = document.getElementById('pigeon-settings-card');
        if (existing) existing.remove();
        return;
      }

      ensureStyles();

      const target = findSettingsInsertTarget();
      console.log('[Pigeon Settings] findSettingsInsertTarget =', !!target, target ? (target.row ? target.row.tagName : null) : null);
      if (!target || !target.row) {
        return;
      }

      let card = document.getElementById('pigeon-settings-card');
      if (!card) {
        card = document.createElement('div');
        card.id = 'pigeon-settings-card';

        const isRu = appConfig.language === 'ru';
        const sounds = (appConfig.sounds && appConfig.sounds.length > 0) ? appConfig.sounds : DEFAULT_SOUNDS;

        card.innerHTML = `
          <!-- Секция 1: Уведомления -->
          <div class="pigeon-settings-section">
            <div class="pigeon-section-title" id="pigeon-s1-title">${isRu ? 'Уведомления' : 'Notifications'}</div>
            <div class="pigeon-section-desc" id="pigeon-s1-desc">${isRu ? 'Звуковые оповещения о входящих сообщениях.' : 'Sound alerts for incoming messages.'}</div>

            <div class="pigeon-native-row">
              <div class="pigeon-row-left">
                <div class="pigeon-row-title" id="pigeon-row0-title">${isRu ? 'Уведомления' : 'Notifications'}</div>
                <div class="pigeon-row-desc" id="pigeon-row0-desc">${isRu ? 'Всплывающие окна и звуковые сигналы' : 'Pop-up alerts and sound notifications'}</div>
              </div>
              <label class="pigeon-switch">
                <input type="checkbox" id="pigeon-notif-toggle" ${appConfig.notificationsEnabled !== false ? 'checked' : ''}>
                <span class="pigeon-slider"></span>
              </label>
            </div>

            <div class="pigeon-native-row">
              <div class="pigeon-row-left">
                <div class="pigeon-row-title" id="pigeon-row1-title">${isRu ? 'Звуковой сигнал' : 'Sound alert'}</div>
                <div class="pigeon-row-desc" id="pigeon-row1-desc">${isRu ? 'Воспроизводить звук при входящем сообщении' : 'Play sound when receiving a new message'}</div>
              </div>
              <label class="pigeon-switch">
                <input type="checkbox" id="pigeon-sound-toggle" ${appConfig.soundEnabled !== false ? 'checked' : ''}>
                <span class="pigeon-slider"></span>
              </label>
            </div>

            <div class="pigeon-native-row" id="pigeon-sound-select-row" style="display: ${appConfig.soundEnabled !== false ? 'flex' : 'none'};">
              <div class="pigeon-row-left">
                <div class="pigeon-row-title" id="pigeon-row2-title">${isRu ? 'Мелодия уведомления' : 'Notification sound'}</div>
                <div class="pigeon-row-desc" id="pigeon-row2-desc">${isRu ? 'Выберите звук для сообщений' : 'Select sound for new messages'}</div>
              </div>
              <div class="pigeon-sound-controls">
                <button type="button" class="pigeon-preview-btn" id="pigeon-preview-btn" title="${isRu ? 'Прослушать звук' : 'Play preview'}">
                  <svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                </button>
                <select id="pigeon-sound-dropdown" class="pigeon-sound-select">
                  ${sounds.map(s => `
                    <option value="${s.id}" ${s.id === appConfig.soundFile ? 'selected' : ''}>
                      ${isRu ? (s.nameRu || s.nameEn || s.id) : (s.nameEn || s.id)}
                    </option>
                  `).join('')}
                </select>
              </div>
            </div>
          </div>

          <!-- Секция 2: Язык -->
          <div class="pigeon-settings-section">
            <div class="pigeon-section-title" id="pigeon-s2-title">${isRu ? 'Язык' : 'Language'}</div>
            <div class="pigeon-section-desc" id="pigeon-s2-desc">${isRu ? 'Язык интерфейса приложения.' : 'Application interface language.'}</div>

            <div class="pigeon-native-row">
              <div class="pigeon-row-left">
                <div class="pigeon-row-title" id="pigeon-row3-title">${isRu ? 'Язык интерфейса' : 'Interface language'}</div>
                <div class="pigeon-row-desc" id="pigeon-row3-desc">${isRu ? 'Английский (по умолчанию) или русский' : 'English (default) or Russian'}</div>
              </div>
              <div class="pigeon-lang-group">
                <button type="button" class="pigeon-lang-btn ${appConfig.language === 'en' ? 'active' : ''}" data-lang="en">English</button>
                <button type="button" class="pigeon-lang-btn ${appConfig.language === 'ru' ? 'active' : ''}" data-lang="ru">Русский</button>
              </div>
            </div>
          </div>

          <!-- Секция: Приватность -->
          <div class="pigeon-settings-section" id="pigeon-privacy-section">
            <div class="pigeon-section-title" id="pigeon-s-privacy-title">${isRu ? 'Приватность' : 'Privacy & Stealth'}</div>
            <div class="pigeon-section-desc" id="pigeon-s-privacy-desc">${isRu ? 'Функции защиты приватности и скрытности.' : 'Privacy protection and stealth browsing features.'}</div>


            <div class="pigeon-native-row">
              <div class="pigeon-row-left">
                <div class="pigeon-row-title" id="pigeon-privacy-blur-title">${isRu ? 'Размытие сообщений (Privacy Blur)' : 'Privacy Blur'}</div>
                <div class="pigeon-row-desc" id="pigeon-privacy-blur-desc">${isRu ? 'Скрывать текст сообщений до наведения курсора (Ctrl+Shift+P)' : 'Blur chat messages and previews until mouse hover (Ctrl+Shift+P)'}</div>
              </div>
              <label class="pigeon-switch">
                <input type="checkbox" id="pigeon-privacy-blur-toggle" ${appConfig.privacyBlur ? 'checked' : ''}>
                <span class="pigeon-slider"></span>
              </label>
            </div>

            <div class="pigeon-native-row">
              <div class="pigeon-row-left">
                <div class="pigeon-row-title" id="pigeon-boss-title">${isRu ? 'Кнопка паники (Boss Key)' : 'Boss Key'}</div>
                <div class="pigeon-row-desc" id="pigeon-boss-desc">${isRu ? 'Мгновенно спрятать окно в трей по комбинации клавиш Ctrl+Alt+H' : 'Instantly hide window to tray with Ctrl+Alt+H'}</div>
              </div>
              <label class="pigeon-switch">
                <input type="checkbox" id="pigeon-boss-toggle" ${appConfig.bossKeyEnabled !== false ? 'checked' : ''}>
                <span class="pigeon-slider"></span>
              </label>
            </div>

            <div class="pigeon-native-row">
              <div class="pigeon-row-left">
                <div class="pigeon-row-title" id="pigeon-reduced-motion-title">${isRu ? 'Уменьшить анимации' : 'Reduce animations'}</div>
                <div class="pigeon-row-desc" id="pigeon-reduced-motion-desc">${isRu ? 'Убрать плавные переходы и эффекты движения' : 'Use near-instant transitions and motion effects'}</div>
              </div>
              <label class="pigeon-switch">
                <input type="checkbox" id="pigeon-reduced-motion-toggle" ${appConfig.reducedMotion ? 'checked' : ''}>
                <span class="pigeon-slider"></span>
              </label>
            </div>
          </div>

          <!-- Секция 3: Система -->
          <div class="pigeon-settings-section" id="pigeon-autostart-section" style="display: ${(appConfig.isWindows || appConfig.isLinux) ? 'block' : 'none'};">
            <div class="pigeon-section-title" id="pigeon-s3-title">${isRu ? 'Система' : 'System'}</div>
            <div class="pigeon-section-desc" id="pigeon-s3-desc">${isRu ? 'Параметры запуска приложения вместе с операционной системой.' : 'Application startup settings with operating system.'}</div>

            <div class="pigeon-native-row">
              <div class="pigeon-row-left">
                <div class="pigeon-row-title" id="pigeon-row-autostart-title">${isRu ? `Запуск программы с ${appConfig.isLinux ? 'Linux' : 'Windows'}` : `Launch on ${appConfig.isLinux ? 'Linux' : 'Windows'} startup`}</div>
                <div class="pigeon-row-desc" id="pigeon-row-autostart-desc">${isRu ? 'Запускать в фоне в трее при включении компьютера' : 'Start minimized to system tray when computer turns on'}</div>
              </div>
              <label class="pigeon-switch">
                <input type="checkbox" id="pigeon-autostart-toggle" ${appConfig.autoStart !== false ? 'checked' : ''}>
                <span class="pigeon-slider"></span>
              </label>
            </div>
          </div>

          <!-- Последняя секция: опасные действия с данными приложения -->
          <div class="pigeon-settings-section pigeon-danger-section">
            <div class="pigeon-section-title" id="pigeon-data-title">${isRu ? 'Данные и сессия' : 'Data and session'}</div>
            <div class="pigeon-section-desc" id="pigeon-data-desc">${isRu ? 'Выход из X и очистка данных этого приложения.' : 'Sign out of X and clear this app\'s data.'}</div>
            <div class="pigeon-native-row pigeon-danger-row">
              <div class="pigeon-row-left">
                <div class="pigeon-row-title" id="pigeon-clear-session-title">${isRu ? 'Выйти и удалить кэш' : 'Sign out and clear cache'}</div>
                <div class="pigeon-row-desc" id="pigeon-clear-session-desc">${isRu ? 'Удалить cookies, сессию, локальные данные и кэшированные медиа' : 'Remove cookies, session, local data, and cached media'}</div>
              </div>
              <button type="button" class="pigeon-danger-button" id="pigeon-clear-session-btn">${isRu ? 'Выйти' : 'Sign out'}</button>
            </div>
          </div>
        `;

        // Обработчики событий
        card.addEventListener('change', (e) => {
          flashSettingFeedback(e.target);
          if (e.target && e.target.id === 'pigeon-notif-toggle') {
            const enabled = e.target.checked;
            appConfig.notificationsEnabled = enabled;
            if (enabled) {
              appConfig.soundEnabled = true;
              const soundToggle = card.querySelector('#pigeon-sound-toggle');
              if (soundToggle) soundToggle.checked = true;
            }
            ipcRenderer.send('set-notifications-enabled', enabled);
            if (enabled) {
              ipcRenderer.send('play-sound-preview', appConfig.soundFile);
            }
          } else if (e.target && e.target.id === 'pigeon-sound-toggle') {
            const enabled = e.target.checked;
            appConfig.soundEnabled = enabled;
            const soundRow = card.querySelector('#pigeon-sound-select-row');
            if (soundRow) soundRow.style.display = enabled ? 'flex' : 'none';
            ipcRenderer.send('set-sound-enabled', enabled);
            if (enabled) {
              ipcRenderer.send('play-sound-preview', appConfig.soundFile);
            }
          } else if (e.target && e.target.id === 'pigeon-sound-dropdown') {
            const chosen = e.target.value;
            appConfig.soundFile = chosen;
            ipcRenderer.send('set-sound-file', chosen);
            ipcRenderer.send('play-sound-preview', chosen);
          } else if (e.target && e.target.id === 'pigeon-privacy-blur-toggle') {
            const enabled = e.target.checked;
            setPrivacyBlurState(enabled);
          } else if (e.target && e.target.id === 'pigeon-boss-toggle') {
            const enabled = e.target.checked;
            appConfig.bossKeyEnabled = enabled;
            ipcRenderer.send('set-boss-key-enabled', enabled);
          } else if (e.target && e.target.id === 'pigeon-reduced-motion-toggle') {
            const enabled = e.target.checked;
            appConfig.reducedMotion = enabled;
            applyPrivacyState();
            ipcRenderer.send('set-reduced-motion', enabled);
          } else if (e.target && e.target.id === 'pigeon-autostart-toggle') {
            const enabled = e.target.checked;
            appConfig.autoStart = enabled;
            ipcRenderer.send('set-autostart', enabled);
          }
        });

        card.addEventListener('click', (e) => {
          const clearSessionBtn = e.target.closest('#pigeon-clear-session-btn');
          if (clearSessionBtn) {
            if (clearSessionBtn.disabled) return;
            clearSessionBtn.disabled = true;
            clearSessionBtn.textContent = appConfig.language === 'ru' ? 'Очищаем…' : 'Clearing…';
            ipcRenderer.invoke('sign-out-and-clear-data').then(result => {
              // При успешной очистке страница сразу заменяется экраном входа.
              if (!result || (!result.ok && !result.cancelled)) {
                showHudToast(appConfig.language === 'ru' ? 'Не удалось очистить данные' : 'Could not clear data', '⚠');
              }
            }).catch(() => {
              showHudToast(appConfig.language === 'ru' ? 'Не удалось очистить данные' : 'Could not clear data', '⚠');
            }).finally(() => {
              if (clearSessionBtn.isConnected) {
                clearSessionBtn.disabled = false;
                clearSessionBtn.textContent = appConfig.language === 'ru' ? 'Выйти' : 'Sign out';
              }
            });
            return;
          }

          const previewBtn = e.target.closest('#pigeon-preview-btn');
          if (previewBtn) {
            const select = card.querySelector('#pigeon-sound-dropdown');
            const file = (select && select.value) || appConfig.soundFile || 'come here.mp3';
            ipcRenderer.send('play-sound-preview', file);
            return;
          }

          const langBtn = e.target.closest('.pigeon-lang-btn');
          if (langBtn) {
            const targetLang = langBtn.getAttribute('data-lang');
            if (targetLang && (targetLang === 'en' || targetLang === 'ru') && targetLang !== appConfig.language) {
              appConfig.language = targetLang;
              updateCardContent();
              ipcRenderer.send('set-language', targetLang);
            }
          }
        });

        target.row.after(card);
      } else {
        if (target.row.nextElementSibling !== card) {
          target.row.after(card);
        }
      }
    } catch (e) {
      console.error('[Pigeon Settings Error]:', e);
    }
  }

  // Наблюдатель за появлением настроек в DOM (с троттлингом)
  let mountTimer = null;
  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      mountPigeonSettings();
    }, 0);
  }

  function triggerDropdownBurst() {
    // Меню XChat появляется асинхронно, но десять обходов DOM после каждого
    // клика создавали заметную нагрузку в чате. Трёх проверок достаточно.
    [0, 120, 360].forEach(ms => {
      setTimeout(() => {
        mountDropdownPrivacyBlur();
        mountConversationTopMenuItem();
      }, ms);
    });
  }

  let obsTimer = null;
  let conversationMenuMountTimer = null;
  function scheduleConversationMenuMount() {
    if (conversationMenuMountTimer) return;
    conversationMenuMountTimer = setTimeout(() => {
      conversationMenuMountTimer = null;
      mountConversationTopMenuItem();
    }, 0);
  }

  const observer = new MutationObserver(records => {
    // В обычном активном чате Pigeon ничего не должен дорисовывать.
    if (isPigeonWindowActive() && !appConfig.privacyBlur) {
      // Экран настроек — единственное исключение. Здесь нет потока сообщений,
      // поэтому можно монтировать карточку сразу, не ожидая общий debounce.
      if (isSettingsViewActive()) {
        scheduleMount();
        return;
      }
      // Контекстное меню профиля X рендерит в portal как role="dialog" уже
      // после click. Отслеживаем только появление такого диалога — сообщения
      // и композер по-прежнему проходят здесь без обходов DOM.
      const dialogWasAdded = records.some(record => Array.from(record.addedNodes || []).some(node =>
        node.nodeType === Node.ELEMENT_NODE &&
        (node.getAttribute('role') === 'dialog' ||
          (node.childElementCount <= 20 && node.querySelector?.('[role="dialog"]')))
      ));
      if (dialogWasAdded) scheduleConversationMenuMount();
      return;
    }
    // При включённом Privacy Blur его разметка намеренно затрагивает много
    // элементов. Не ставим даже debounce-таймер на каждый символ: дождёмся
    // паузы в наборе, а затем обновим разметку единым проходом.
    if (isComposerBusy()) return;
    if (obsTimer) return;
    const refreshDelay = isPigeonWindowActive() ? 800 : 240;
    obsTimer = setTimeout(() => {
      obsTimer = null;
      // Пока пользователь печатает, не трогаем DOM XChat даже для наших
      // декоративных проверок. Следующая мутация после паузы синхронизирует
      // Privacy Blur и интерфейс единым проходом.
      if (isComposerBusy() || (isPigeonWindowActive() && !appConfig.privacyBlur)) return;
      ensureStyles();
      if (appConfig.privacyBlur) tagQuotedMessages();
      if (isSettingsViewActive()) {
        scheduleMount();
      } else {
        const existing = document.getElementById('pigeon-settings-card');
        if (existing && !isSettingsViewActive()) {
          existing.remove();
        }
      }
    }, refreshDelay);
  });

  function initObserver() {
    ensureStyles();
    ensureGlobalPrivacyStyles();

    let observed = false;
    const startObserving = () => {
      const target = document.body || document.documentElement;
      if (target && !observed) {
        try {
          observer.observe(target, { childList: true, subtree: true });
          observed = true;
        } catch (e) {}
      }
      applyPrivacyState();
      tagQuotedMessages();
      mountPrivacyButton();
      mountDropdownPrivacyBlur();
      // Список диалогов появляется после основной разметки XChat, поэтому
      // проверяем несколько раз только на старте SPA-маршрута.
      [0, 500, 1400, 3000].forEach(delay => setTimeout(markConversationScrollbar, delay));
      if (isSettingsViewActive()) {
        mountPigeonSettings();
      }
    };

    startObserving();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving);
    }
    window.addEventListener('load', startObserving);

    // Резерв для SPA-навигации: основную работу выполняет MutationObserver.
    // Не обходим весь чат несколько раз в секунду во время печати.
    setInterval(() => {
      if (isSettingsViewActive()) {
        const card = document.getElementById('pigeon-settings-card');
        if (!card || !card.isConnected) {
          mountPigeonSettings();
        }
      }
    }, 2500);
  }
  initObserver();
  try {
    document.documentElement?.setAttribute('data-pigeon-preload', 'ready');
  } catch (e) {}

  window.addEventListener('click', event => {
    const target = event.target;
    const menuTrigger = target && target.closest && target.closest(
      '[aria-haspopup="menu"], [data-testid*="more" i], [data-testid*="overflow" i], [data-testid*="dropdown" i]'
    );
    // Проверки меню нужны только для кнопок, которые действительно могут
    // открыть меню. Раньше клик по «Отправить» запускал три лишних обхода
    // DOM с задержками 0/120/360 мс.
    if (menuTrigger) triggerDropdownBurst();

    // В чате каждый клик (включая кнопку «Отправить») раньше через 60 мс
    // полностью проверял DOM на экран настроек. Это не нужно вне маршрута
    // настроек и добавляло работу ровно в момент отправки сообщения.
    const settingsRoute = /\/(?:settings|i\/dm_settings)(?:\/|$)/.test(window.location.pathname || '') ||
      String(window.location.hash || '').includes('settings');
    if (!settingsRoute) return;
    setTimeout(() => {
      if (isSettingsViewActive()) {
        mountPigeonSettings();
      } else {
        const existing = document.getElementById('pigeon-settings-card');
        if (existing && !isSettingsViewActive()) existing.remove();
      }
    }, 60);
  }, true);

  window.addEventListener('popstate', () => {
    mountPrivacyButton();
    triggerDropdownBurst();
    if (isSettingsViewActive()) {
      scheduleMount();
    } else {
      const existing = document.getElementById('pigeon-settings-card');
      if (existing && !isSettingsViewActive()) existing.remove();
    }
  });
})();
