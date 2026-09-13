const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const card = document.getElementById("toast-card");
  const closeBtn = document.getElementById("toast-close");
  const progress = document.getElementById("toast-progress");

  if (card) {
    card.addEventListener("click", () => {
      ipcRenderer.send("toast-click");
    });
    card.addEventListener("mouseenter", () => ipcRenderer.send("toast-hover-start"));
    card.addEventListener("mouseleave", () => ipcRenderer.send("toast-hover-end"));
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      ipcRenderer.send("toast-close");
    });
  }

  ipcRenderer.on("update-toast", (_event, data) => {
    const { title, body, avatarBase64, reducedMotion } = data || {};
    const senderEl = document.getElementById("toast-sender");
    const textEl = document.getElementById("toast-text");
    const avatarImg = document.getElementById("toast-avatar-img");
    const avatarPlaceholder = document.getElementById("toast-avatar-placeholder");

    if (senderEl) senderEl.textContent = title || "Pigeon";
    if (textEl) textEl.textContent = body || "";

    if (avatarBase64 && avatarImg) {
      avatarImg.src = avatarBase64;
      avatarImg.style.display = "block";
      if (avatarPlaceholder) avatarPlaceholder.style.display = "none";
    } else if (avatarPlaceholder) {
      avatarPlaceholder.textContent = (title && title[0] ? title[0] : "X").toUpperCase();
      avatarPlaceholder.style.display = "flex";
      if (avatarImg) avatarImg.style.display = "none";
    }

    if (card) {
      card.classList.toggle("reduced-motion", Boolean(reducedMotion));
      card.classList.remove("show");
      void card.offsetWidth; // trigger reflow
      card.classList.add("show");
    }
  });

  ipcRenderer.on("set-toast-progress", (_event, data) => {
    if (!progress) return;
    const duration = Math.max(1, Number(data?.duration) || 5500);
    progress.style.setProperty("--toast-duration", `${duration}ms`);
    progress.classList.toggle("paused", Boolean(data?.paused));
    if (!data?.paused) {
      progress.classList.remove("running");
      void progress.offsetWidth;
      progress.classList.add("running");
    }
  });

  ipcRenderer.on("hide-toast", () => {
    if (card) {
      card.classList.remove("show");
    }
  });
});
