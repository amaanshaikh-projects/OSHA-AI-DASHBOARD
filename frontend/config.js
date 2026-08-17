// Frontend Configuration
window.API_BASE_URL = "http://localhost:8000"; // Update this in production, e.g., "https://api.vision-ai.com"
window.API_SECRET_KEY = "v1s1on_a1_s3cr3t_k3y_2026";
window.SUPABASE_URL = "https://jqluibubfumycdbwjuyl.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxbHVpYnViZnVteWNkYndqdXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5Nzk2NDcsImV4cCI6MjA5ODU1NTY0N30.ei8K0LDF88vmJF3NuQMnNF3x27yziOHEHmepXQLOpU8";

window.isSupabaseConfigured = () => {
    return window.SUPABASE_URL && window.SUPABASE_ANON_KEY;
};

// Global Fetch Interceptor to attach x-api-key automatically
const originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
    if (typeof url === 'string' && url.startsWith(window.API_BASE_URL)) {
        options.headers = options.headers || {};
        if (options.headers instanceof Headers) {
            if (!options.headers.has('x-api-key')) {
                options.headers.append('x-api-key', window.API_SECRET_KEY);
            }
        } else {
            // Check for case-insensitive header keys just in case
            const hasKey = Object.keys(options.headers).some(k => k.toLowerCase() === 'x-api-key');
            if (!hasKey) {
                options.headers['x-api-key'] = window.API_SECRET_KEY;
            }
        }
    }
    return originalFetch(url, options);
};
