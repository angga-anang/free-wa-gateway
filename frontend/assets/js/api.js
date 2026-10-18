// Shared API client for the FREE GW dashboard.
// Base URL and API key are configured once in Settings and stored in
// localStorage so every page can reuse them.

const FreeGwAPI = (() => {
  function getBaseUrl() {
    return (
      localStorage.getItem("freegw_api_base") ||
      (typeof window.FREEGW_DEFAULT_API_BASE === "string" && window.FREEGW_DEFAULT_API_BASE) ||
      // Same-origin default: works automatically whenever the dashboard is
      // served BY the backend itself (the recommended setup — see
      // FRONTEND_STATIC_DIR in app.ts), through any domain, IP, or tunnel
      // (Cloudflare Tunnel, ngrok, Nginx, ...) with zero configuration.
      window.location.origin
    );
  }
  function getApiKey() {
    return localStorage.getItem("freegw_api_key") || "";
  }
  function setConfig(baseUrl, apiKey) {
    if (baseUrl) localStorage.setItem("freegw_api_base", baseUrl.replace(/\/+$/, ""));
    if (apiKey !== undefined) localStorage.setItem("freegw_api_key", apiKey);
  }
  function resetBaseUrl() {
    localStorage.removeItem("freegw_api_base");
  }

  // Dashboard login session — separate secret from the API key. Stored in
  // sessionStorage (cleared when the browser tab/window closes) rather than
  // localStorage, since this is meant to behave like a real login session.
  function getSessionToken() {
    return sessionStorage.getItem("freegw_dashboard_session") || "";
  }
  function setSessionToken(token) {
    if (token) sessionStorage.setItem("freegw_dashboard_session", token);
    else sessionStorage.removeItem("freegw_dashboard_session");
  }

  async function request(path, options = {}) {
    const url = `${getBaseUrl()}${path}`;
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (getApiKey()) headers["Authorization"] = `Bearer ${getApiKey()}`;
    if (getSessionToken()) headers["X-Dashboard-Session"] = getSessionToken();

    let res;
    try {
      res = await fetch(url, { ...options, headers });
    } catch (err) {
      throw new Error(
        `Tidak dapat menghubungi backend di ${getBaseUrl()}. Pastikan server berjalan dan CORS_ORIGIN mengizinkan origin ini.`
      );
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      throw new Error(body?.message || `Request gagal (HTTP ${res.status})`);
    }
    return body;
  }

  return {
    getBaseUrl,
    getApiKey,
    setConfig,
    resetBaseUrl,
    // The dashboard itself is configured once either a login session exists
    // (the normal case after signing in on this origin) or an API key was
    // stashed in Settings. External apps still need the key; the UI does not.
    isConfigured: () => !!getApiKey() || !!getSessionToken(),

    health: () => fetch(`${getBaseUrl()}/health`).then((r) => r.ok),

    // ---- Dashboard login gate ----
    getSessionToken,
    setSessionToken,
    isLoggedIn: () => !!getSessionToken(),
    dashboardStatus: () => request("/api/v1/auth/dashboard-status"),
    bootstrapDashboardPassword: (password) =>
      request("/api/v1/auth/dashboard-password", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    login: (password) =>
      request("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
    logout: () => request("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined),
    verifySession: () => request("/api/v1/auth/verify-session"),
    changePassword: (old_password, new_password) =>
      request("/api/v1/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ old_password, new_password }),
      }),

    // Bootstrap / key management
    createFirstKey: (label) =>
      request("/api/v1/auth/keys", { method: "POST", body: JSON.stringify({ label }) }),
    listKeys: () => request("/api/v1/auth/keys"),
    createKey: (label, webhook_url, custom_key, format) =>
      request("/api/v1/auth/keys", {
        method: "POST",
        body: JSON.stringify({
          label,
          webhook_url: webhook_url || undefined,
          custom_key: custom_key || undefined,
          format: format || undefined,
        }),
      }),
    revokeKey: (id) => request(`/api/v1/auth/keys/${id}/revoke`, { method: "POST" }),
    rotateKey: (id) => request(`/api/v1/auth/keys/${id}/rotate`, { method: "POST" }),
    setWebhook: (id, webhook_url) =>
      request(`/api/v1/auth/keys/${id}/webhook`, {
        method: "PUT",
        body: JSON.stringify({ webhook_url: webhook_url || null }),
      }),
    setDefaultDevice: (id, device_id) =>
      request(`/api/v1/auth/keys/${id}/default-device`, {
        method: "PUT",
        body: JSON.stringify({ device_id: device_id || null }),
      }),
    webhookDeliveries: () => request("/api/v1/auth/webhook-deliveries"),

    // Devices
    listDevices: () => request("/api/v1/devices"),
    createDevice: (name, description) =>
      request("/api/v1/devices", { method: "POST", body: JSON.stringify({ name, description }) }),
    initDevice: (id) => request(`/api/v1/devices/${id}/initialize`, { method: "POST" }),
    logoutDevice: (id) => request(`/api/v1/devices/${id}/logout`, { method: "POST" }),
    restartDevice: (id) => request(`/api/v1/devices/${id}/restart`, { method: "POST" }),
    deleteDevice: (id) => request(`/api/v1/devices/${id}`, { method: "DELETE" }),
    deviceStatus: (id) => request(`/api/v1/devices/${id}/status`),

    // Messages
    sendMessage: (payload) =>
      request("/api/v1/messages/send", { method: "POST", body: JSON.stringify(payload) }),
    listLogs: (params) => request(`/api/v1/messages/logs?${new URLSearchParams(params)}`),
    resendLog: (id) => request(`/api/v1/messages/logs/${id}/resend`, { method: "POST" }),

    // Dashboard
    summary: () => request("/api/v1/dashboard/summary"),
    instancesStatus: () => request("/api/v1/dashboard/instances-status"),
    volume: (granularity) => request(`/api/v1/dashboard/volume?granularity=${granularity}`),
    recentActivity: (limit) => request(`/api/v1/dashboard/recent-activity?limit=${limit}`),

    // Gateway settings
    getDelaySettings: () => request("/api/v1/settings/delay"),
    setDelaySettings: (minSendDelayMs, maxSendDelayMs) =>
      request("/api/v1/settings/delay", {
        method: "PUT",
        body: JSON.stringify({ minSendDelayMs, maxSendDelayMs }),
      }),
    serverTimezone: () => request("/api/v1/settings/server-timezone"),

    // WebSocket URL for QR / status streaming
    deviceSocketUrl: (deviceId) => {
      const base = getBaseUrl().replace(/^http/, "ws");
      return `${base}/ws/devices?deviceId=${deviceId}`;
    },
  };
})();

// Shared HTML escape for every page that injects API data via innerHTML.
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
