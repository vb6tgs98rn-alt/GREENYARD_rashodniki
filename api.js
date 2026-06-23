const API_BASE_URL = '';

function buildHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...extra
  };
}

async function request(path, options = {}) {
  if (!API_BASE_URL) {
    return { ok: true, offline: true, data: null };
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: buildHeaders(options.headers)
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.message || `API error: ${response.status}`);
  }
  return { ok: true, offline: false, data };
}

export const api = {
  async loadAppState() {
    return request('/app-state', { method: 'GET' });
  },
  async saveAppState(payload) {
    return request('/app-state', { method: 'POST', body: JSON.stringify(payload) });
  },
  async loadPurchaseRequests() {
    return request('/purchase-requests', { method: 'GET' });
  },
  async createPurchaseRequest(payload) {
    return request('/purchase-requests', { method: 'POST', body: JSON.stringify(payload) });
  },
  async syncHistory(payload) {
    return request('/history', { method: 'POST', body: JSON.stringify(payload) });
  }
};
