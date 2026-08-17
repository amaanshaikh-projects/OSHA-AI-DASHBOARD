// API Wrapper Functions for Backend Communication

export const API = {
    // Cameras & HLS Streams
    startHlsStream: async (cameraId) => {
        return fetch(window.API_BASE_URL + '/api/hls/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cameraId })
        });
    },

    stopHlsStream: async (cameraId) => {
        return fetch(window.API_BASE_URL + '/api/hls/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cameraId })
        });
    },

    toggleCameraState: async (cameraId) => {
        return fetch(`${window.API_BASE_URL}/api/camera/${cameraId}/toggle`, { method: 'POST' });
    },

    validateRtspStream: async (url, username, password) => {
        return fetch(window.API_BASE_URL + '/api/rtsp/validate-deep', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, username, password })
        }).then(res => res.json());
    },

    // AI Prompts
    enhancePrompt: async (prompt) => {
        return fetch(window.API_BASE_URL + '/api/prompt/enhance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        }).then(res => res.json());
    },

    // Settings & Billing
    getEmailSettings: async () => {
        return fetch(window.API_BASE_URL + '/api/settings/email').then(res => res.json());
    },

    updateEmailSettings: async (settings) => {
        return fetch(window.API_BASE_URL + '/api/settings/email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
    },

    createCheckoutSession: async (priceId, promoCode, userId, customerId, returnUrl) => {
        return fetch(window.API_BASE_URL + '/api/billing/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priceId, promoCode, userId, customerId, returnUrl })
        }).then(res => res.json());
    },

    // Semantic Search
    performSemanticSearch: async (query, userId, cameraId, startDate, endDate) => {
        return fetch(window.API_BASE_URL + '/api/semantic-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, userId, cameraId, startDate, endDate })
        }).then(res => res.json());
    }
};
