use tauri::{WebviewUrl, WebviewWindowBuilder};
use std::path::PathBuf;

/// Настройка cookie-политики webkit2gtk на "принимать всё".
/// Без этого ITP блокирует кросс-доменные куки x.com ↔ chat.x.com,
/// и логин X падает с "Something went wrong".
#[cfg(target_os = "linux")]
fn fix_cookie_policy(window: &tauri::WebviewWindow) {
    use webkit2gtk::{CookieAcceptPolicy, CookieManagerExt, WebContextExt, WebViewExt};

    let _ = window.with_webview(move |webview| {
        let wv = webview.inner();
        if let Some(context) = wv.context() {
            if let Some(cookie_manager) = context.cookie_manager() {
                cookie_manager.set_accept_policy(CookieAcceptPolicy::Always);
            }
        }
    });
}

/// JS-спуфинг navigator-свойств для консистентности с Chrome UA.
/// X проверяет не только UA-строку, но и navigator.vendor, plugins,
/// наличие window.chrome и т.д. Без этого антибот режет логин.
const CHROME_SPOOF_JS: &str = r#"
(function() {
    'use strict';
    try {
        // navigator.vendor — у webkit "Apple Computer, Inc.", у Chrome "Google Inc."
        Object.defineProperty(navigator, 'vendor', {
            get: () => 'Google Inc.',
            configurable: true
        });

        // navigator.webdriver — убираем флаг автоматизации
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true
        });

        // navigator.plugins — webkit отдаёт пустой, Chrome имеет PDF Viewer
        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const arr = [
                    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
                    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '' }
                ];
                arr.item = (i) => arr[i] || null;
                arr.namedItem = (name) => arr.find(p => p.name === name) || null;
                arr.refresh = () => {};
                return arr;
            },
            configurable: true
        });

        // navigator.mimeTypes — Chrome имеет application/pdf
        Object.defineProperty(navigator, 'mimeTypes', {
            get: () => {
                const arr = [
                    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
                ];
                arr.item = (i) => arr[i] || null;
                arr.namedItem = (name) => arr.find(m => m.type === name) || null;
                return arr;
            },
            configurable: true
        });

        // window.chrome — объект, который есть только в Chrome/Chromium
        if (!window.chrome) {
            window.chrome = {
                runtime: {
                    connect: function() {},
                    sendMessage: function() {}
                },
                loadTimes: function() { return {}; },
                csi: function() { return {}; }
            };
        }

        // navigator.languages
        Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
            configurable: true
        });

        // Permissions API — Chrome returns 'prompt' for notifications
        if (navigator.permissions) {
            const origQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = function(params) {
                if (params.name === 'notifications') {
                    return Promise.resolve({ state: 'prompt', onchange: null });
                }
                return origQuery(params);
            };
        }
    } catch(e) { /* fail-soft */ }
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Путь для персистентного хранения кук/localStorage
    let data_dir: PathBuf = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("pigeon")
        .join("webview");

    tauri::Builder::default()
        .setup(|app| {
            // Грузим логин X напрямую, чтобы не было кросс-доменного редиректа chat.x.com → x.com
            // После логина пользователь попадёт на x.com, оттуда можно навигировать на chat.x.com
            let url = WebviewUrl::External("https://x.com/i/flow/login".parse().unwrap());

            let window = WebviewWindowBuilder::new(app, "main", url)
                .title("Pigeon")
                .inner_size(1200.0, 800.0)
                .min_inner_size(900.0, 600.0)
                // Chrome на Linux — webkit2gtk UA содержит "WebKitGTK", антибот X его режет
                .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
                .data_directory(data_dir)
                // Спуфинг navigator для консистентности с Chrome UA
                .initialization_script(CHROME_SPOOF_JS)
                .build()?;

            // Разрешить кросс-доменные куки для логина X
            #[cfg(target_os = "linux")]
            fix_cookie_policy(&window);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running pigeon");
}
