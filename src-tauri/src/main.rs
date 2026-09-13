// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Wayland/Hyprland: без этого webkit2gtk даёт белый/чёрный экран
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    // Доп. фикс: более стабильный рендеринг для сложных страниц (логин X)
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

    pigeon_lib::run();
}
