// Thin REST client. The session token lives in sessionStorage so two tabs can be
// signed in as two different people (handy for trying the app on one machine).
const TOKEN = 'relay.session';

export const session = {
  get() { try { return JSON.parse(sessionStorage.getItem(TOKEN) || 'null'); } catch { return null; } },
  set(s) { try { sessionStorage.setItem(TOKEN, JSON.stringify(s)); } catch { /* ignore */ } },
  clear() { try { sessionStorage.removeItem(TOKEN); } catch { /* ignore */ } },
};

export class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, path, body) {
  const s = session.get();
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(s?.token ? { Authorization: `Bearer ${s.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && s?.token) onUnauthorized(data.message);
    throw new ApiError(res.status, data.error, data.message || `Request failed (${res.status})`);
  }
  return data;
}
