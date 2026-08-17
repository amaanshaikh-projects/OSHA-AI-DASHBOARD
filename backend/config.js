// ==========================================================================
// OSHA AI - Supabase Configuration (Production Ready)
// ==========================================================================

let fs, path;
if (typeof window === 'undefined') {
    fs = require('fs');
    path = require('path');
    require('dotenv').config({ path: path.join(__dirname, '.env') });
}

// Load from environment variables
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// Service Role Key (Backend only — bypasses Row Level Security)
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Check if credentials are properly set up
const isSupabaseConfigured = () => {
    return SUPABASE_URL !== "" && SUPABASE_ANON_KEY !== "";
};

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

const isResendConfigured = () => {
    return RESEND_API_KEY !== "";
};

// Gmail SMTP — used for Enterprise Contact Sales emails
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS || "";

// Hot-reloadable Config
const env = (typeof process !== 'undefined' && process.env) ? process.env : {};

let appConfig = {
    openRouter: {
        apiKey: env.OPENROUTER_API_KEY || '',
        model: env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite',
        timeoutMs: parseInt(env.OPENROUTER_TIMEOUT_MS) || 15000,
        maxRetries: parseInt(env.OPENROUTER_MAX_RETRIES) || 3
    },
    modelRouting: {
        primaryModel: env.GEMINI_PRIMARY_MODEL || 'google/gemini-2.5-flash-lite',
        escalationModel: env.GEMINI_ESCALATION_MODEL || 'google/gemini-2.5-flash',
        escalationConfidence: parseInt(env.GEMINI_ESCALATION_CONFIDENCE) || 75,
        enableComplexityRouting: env.GEMINI_ENABLE_COMPLEXITY_ROUTING !== 'false',
        enableImageQualityGate: env.GEMINI_ENABLE_IMAGE_QUALITY_GATE !== 'false'
    },
    reverification: {
        enabled: env.REVERIFY_ENABLED !== 'false',
        minIntervalMs: parseInt(env.MIN_REVERIFY_INTERVAL_MS) || 10000,
        stabilityWindowMs: parseInt(env.STABILITY_WINDOW_MS) || 60000,
        movementChangeThreshold: parseFloat(env.MOVEMENT_CHANGE_THRESHOLD) || 0.15,
        sceneChangeThreshold: parseFloat(env.SCENE_CHANGE_THRESHOLD) || 0.60,
        roiDiffThreshold: parseFloat(env.ROI_DIFF_THRESHOLD) || 0.25,
        highChangeThreshold: parseFloat(env.HIGH_CHANGE_THRESHOLD) || 0.60,
        lowChangeThreshold: parseFloat(env.LOW_CHANGE_THRESHOLD) || 0.20
    },
    negativeMemory: {
        enabled: env.NEGATIVE_MEMORY_ENABLED !== 'false',
        ttlMs: parseInt(env.NEGATIVE_MEMORY_TTL) || 300000,
        cooldownBaseMs: parseInt(env.NEGATIVE_COOLDOWN_MS) || 30000,
        maxSuppressionMs: parseInt(env.MAX_NEGATIVE_SUPPRESSION_MS) || 600000,
        maxRejectionsPerEvent: parseInt(env.MAX_REJECTIONS_PER_EVENT) || 10
    }
};


let configPath = '';
const loadConfig = () => {
    try {
        if (typeof window === 'undefined' && fs.existsSync(configPath)) {
            const fileData = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(fileData);
            appConfig = { ...appConfig, ...parsed };
            console.log("[Config] Loaded configuration from config.json");
        }
    } catch (e) {
        console.error("[Config] Error parsing config.json:", e.message);
    }
};

if (typeof window === 'undefined') {
    // Only run file system ops in Node.js
    configPath = path.join(__dirname, 'config.json');
    loadConfig();
    try {
        fs.watch(configPath, (eventType) => {
            if (eventType === 'change') {
                console.log("[Config] config.json changed, reloading...");
                loadConfig();
            }
        });
    } catch (e) {
        console.warn("[Config] Could not watch config.json");
    }
}

if (typeof module !== 'undefined' && module.exports) {
    const isOpenRouterConfigured = () => !!appConfig.openRouter.apiKey;
    module.exports = {
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY,
        isSupabaseConfigured,
        RESEND_API_KEY,
        isResendConfigured,
        GMAIL_USER,
        GMAIL_APP_PASS,
        getAppConfig: () => appConfig,
        isOpenRouterConfigured
    };
} else if (typeof window !== 'undefined') {
    window.SUPABASE_URL = SUPABASE_URL;
    window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
    window.isSupabaseConfigured = isSupabaseConfigured;
}
