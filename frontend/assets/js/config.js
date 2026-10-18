// Left at its default (null) on purpose: the backend now serves this
// frontend directly (same origin, same port), so the dashboard's own JS
// defaults to same-origin automatically — this works correctly whether you
// access it via LAN IP, a custom domain, or a tunnel (Cloudflare Tunnel,
// ngrok, etc.), with no Base URL to configure.
window.FREEGW_DEFAULT_API_BASE = null;
