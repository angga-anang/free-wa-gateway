function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  localStorage.setItem("freegw_theme", theme);
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.querySelector(".material-symbols-outlined").textContent =
      theme === "dark" ? "light_mode" : "dark_mode";
    btn.querySelector("span:last-child").textContent =
      theme === "dark" ? "Mode Terang" : "Mode Gelap";
  });
}

function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
}

function renderSidebar(active) {
  const links = [
    { href: "index.html", icon: "monitoring", label: "Dashboard", key: "dashboard" },
    { href: "devices.html", icon: "smartphone", label: "Perangkat", key: "devices" },
    { href: "logs.html", icon: "history", label: "Riwayat Pesan", key: "logs" },
    { href: "settings.html", icon: "settings", label: "API & Webhook", key: "settings" },
    { href: "docs.html", icon: "menu_book", label: "Dokumentasi", key: "docs" },
  ];

  document.querySelectorAll(".app-shell").forEach((shell) => {
    const hamburger = document.createElement("div");
    hamburger.className = "hamburger";
    hamburger.innerHTML = '<span class="material-symbols-outlined">menu</span>';

    const backdrop = document.createElement("div");
    backdrop.className = "sidebar__backdrop";

    const sidebar = document.createElement("aside");
    sidebar.className = "sidebar";
    sidebar.innerHTML = `
      <div class="sidebar__brand"><span class="dot"></span> FREE GW</div>
      <nav class="sidebar__nav">
        ${links
          .map(
            (l) => `
          <a class="sidebar__link ${l.key === active ? "active" : ""}" href="${l.href}">
            <span class="material-symbols-outlined">${l.icon}</span> ${l.label}
          </a>`
          )
          .join("")}
      </nav>
      <button class="theme-toggle sidebar-action" type="button">
        <span class="material-symbols-outlined">dark_mode</span>
        <span>Mode Gelap</span>
      </button>
      <button class="sidebar-action" type="button" id="btn-logout">
        <span class="material-symbols-outlined">logout</span>
        <span>Keluar</span>
      </button>
    `;

    shell.prepend(sidebar);
    shell.prepend(backdrop);
    shell.prepend(hamburger);

    sidebar.querySelector(".theme-toggle").addEventListener("click", toggleTheme);
    applyTheme(currentTheme());

    sidebar.querySelector("#btn-logout").addEventListener("click", async () => {
      if (!confirm("Keluar dari dashboard?")) return;
      await FreeGwAPI.logout();
      FreeGwAPI.setSessionToken(null);
      window.location.href = "login.html";
    });

    hamburger.addEventListener("click", () => {
      sidebar.classList.toggle("open");
      backdrop.classList.toggle("open");
    });
    backdrop.addEventListener("click", () => {
      sidebar.classList.remove("open");
      backdrop.classList.remove("open");
    });
  });
}

function getTimezonePref() {
  return localStorage.getItem("freegw_timezone_pref") || "auto";
}
function setTimezonePref(tz) {
  localStorage.setItem("freegw_timezone_pref", tz);
}

// Safely parses a timestamp value into a Date, always treating strings
// with no explicit UTC/offset marker (no trailing "Z" or "+HH:MM") as
// UTC — instead of letting the browser's default Date parsing silently
// assume they're already local time. That assumption is what causes a
// backend timestamp to be displayed as raw, unconverted UTC digits
// (e.g. showing 00.15 instead of the correct 07.15 in a UTC+7 browser):
// a naive string like "2026-07-25 00:15:33" parses as *local* 00:15:33
// with no shift applied, whereas the same instant written unambiguously
// as "2026-07-25T00:15:33Z" correctly converts to 07:15:33 local. This
// is a defensive backstop — the backend should always send unambiguous
// timestamps — but keeps the dashboard correct even if some value ever
// doesn't.
function toSafeDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const hasZoneMarker = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value.trim());
    if (!hasZoneMarker) {
      return new Date(value.trim().replace(" ", "T") + "Z");
    }
  }
  return new Date(value);
}

// Shared timestamp formatter used across Dashboard/Riwayat Pesan. "auto"
// (default) lets the browser use its own local timezone — no explicit
// timeZone option needed, Intl/Date already do this automatically. If the
// person picks "Ikuti Server" in Settings, we pin rendering to the
// server's IANA timezone name instead, so everyone viewing the dashboard
// sees the same wall-clock time regardless of where their browser is.
function formatDateTime(isoString) {
  if (!isoString) return "-";
  const pref = getTimezonePref();
  const opts = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" };
  if (pref !== "auto") opts.timeZone = pref;
  try {
    return new Intl.DateTimeFormat("id-ID", opts).format(toSafeDate(isoString));
  } catch {
    return toSafeDate(isoString).toLocaleString("id-ID");
  }
}

function renderConnStatus() {
  document.querySelectorAll("[data-conn-status]").forEach(async (el) => {
    const ok = await FreeGwAPI.health().catch(() => false);
    el.classList.toggle("online", !!ok);
    el.querySelector("span:last-child").textContent = ok
      ? `Terhubung — ${FreeGwAPI.getBaseUrl()}`
      : `Tidak terhubung — periksa Settings`;
  });
}

// Shared clipboard helper. navigator.clipboard.writeText only works on
// secure contexts (HTTPS or localhost) in most browsers — dashboards served
// over plain HTTP on a LAN IP (e.g. http://192.168.x.x:8090) silently fail
// with the modern API, so we fall back to a hidden-textarea + execCommand
// approach, which still works over HTTP.
async function copyToClipboard(text, buttonEl) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }

  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      ok = false;
    }
  }

  if (buttonEl) {
    const original = buttonEl.textContent;
    buttonEl.textContent = ok ? "✓ Disalin!" : "Gagal menyalin";
    buttonEl.disabled = true;
    setTimeout(() => {
      buttonEl.textContent = original;
      buttonEl.disabled = false;
    }, 1500);
  } else if (!ok) {
    alert("Gagal menyalin otomatis. Silakan salin manual teks berikut:\n\n" + text);
  }

  return ok;
}

async function enforceDashboardSession() {
  // The synchronous inline check in <head> already redirects if there's no
  // token at all; this catches the case where a token exists locally but
  // has expired or been revoked server-side (e.g. after a password change).
  if (!FreeGwAPI.isLoggedIn()) {
    window.location.replace("login.html");
    return;
  }
  try {
    const res = await FreeGwAPI.verifySession();
    if (!res.data.valid) {
      FreeGwAPI.setSessionToken(null);
      window.location.replace("login.html");
    }
  } catch {
    // Network/connectivity error — leave it to the page's own error
    // handling rather than forcing a logout while the backend is down.
  }
}

document.addEventListener("DOMContentLoaded", () => {
  enforceDashboardSession();
  renderConnStatus();
});
