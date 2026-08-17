process.on('uncaughtException',  (err)    => { console.error('START.JS UNCAUGHT:', err); });
process.on('unhandledRejection', (reason) => { console.error('START.JS UNHANDLED REJECTION:', reason); });

/* ==========================================================================
   VISION AI — Bulletproof Unified Launcher
   ─ Uses Redis CLOUD (no local Redis server needed).
   ─ Auto-restarts any crashed Node service with exponential backoff.
   ─ Redis Cloud health watchdog: TCP-pings every 15 s.
   ─ Crash-loop guard: stops restarting after 5 crashes in 60 s.
   Usage: node start.js
   ========================================================================== */

const { spawn }  = require('child_process');
const path       = require('path');
const net        = require('net');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── ANSI colours ──────────────────────────────────────────────────────────────
const R  = '\x1b[0m';   // reset
const B  = '\x1b[1m';   // bold
const DM = '\x1b[2m';   // dim
const GR = '\x1b[32m';  // green
const RD = '\x1b[31m';  // red
const YL = '\x1b[33m';  // yellow
const CY = '\x1b[36m';  // cyan
const MG = '\x1b[35m';  // magenta

// ── Redis Cloud connection details (for watchdog only) ───────────────────────
const REDIS_CLOUD_HOST = 'milk-chivalrous-bee-83197.db.redis.io';
const REDIS_CLOUD_PORT = 17529;

const NODE_SERVICES = [
    { name: 'Frontend Server', script: '../frontend/frontend-server.js', color: GR },
    { name: 'API Server',       script: 'api-server.js',   color: CY },
    { name: 'Media Server',     script: 'media-server.js', color: YL },
    { name: 'Detection Engine', script: 'engine/index.js', color: MG },
];

// ── State ─────────────────────────────────────────────────────────────────────
let isShuttingDown  = false;
let watchdogTimer   = null;

// crash history per service name  { [name]: number[] }  — timestamps
const crashHistory  = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
const tag  = (name, color) => `${color}${B}[${name}]${R}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

function log(name, color, msg) {
    console.log(`${tag(name, color)} ${msg}`);
}

/** Poll a TCP port until it accepts connections or times out. */
function waitForPort(port, host = '127.0.0.1', timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const attempt  = () => {
            if (Date.now() > deadline) return reject(new Error(`Timeout waiting for ${host}:${port}`));
            const sock = new net.Socket();
            sock.setTimeout(600);
            const fail = () => { sock.destroy(); setTimeout(attempt, 350); };
            sock.on('connect',  () => { sock.destroy(); resolve(); });
            sock.on('error',    fail);
            sock.on('timeout',  fail);
            sock.connect(port, host);
        };
        attempt();
    });
}

/**
 * Crash-loop guard.
 * Returns true if the service has crashed too many times recently.
 */
function isCrashLooping(name, maxCrashes = 5, windowMs = 60_000) {
    const now  = Date.now();
    const hist = (crashHistory[name] || []).filter(t => now - t < windowMs);
    crashHistory[name] = hist;
    return hist.length >= maxCrashes;
}

function recordCrash(name) {
    if (!crashHistory[name]) crashHistory[name] = [];
    crashHistory[name].push(Date.now());
}

// ── Generic process launcher with auto-restart ────────────────────────────────
/**
 * @param {object} def   - { name, cmd, args, color, cwd }
 * @param {object} opts  - { onExit?, noAutoRestart? }
 * Returns the spawned ChildProcess.
 */
function launchService(def, opts = {}) {
    if (isShuttingDown) return null;

    const { name, cmd, args, color, cwd = __dirname } = def;
    const t = tag(name, color);

    const child = spawn(cmd, args, {
        cwd,
        env:    process.env,
        stdio:  ['ignore', 'pipe', 'pipe'],
        detached: false,
    });

    child.stdout.on('data', d =>
        d.toString().trim().split('\n').forEach(l => l.trim() && console.log(`${t} ${l}`))
    );
    child.stderr.on('data', d =>
        d.toString().trim().split('\n').forEach(l => l.trim() && console.log(`${t} ${RD}${l}${R}`))
    );

    child.on('exit', (code, signal) => {
        if (isShuttingDown) return;

        const exitMsg = signal ? `signal ${signal}` : `code ${code}`;
        console.log(`${t} ${RD}⚠  Process exited (${exitMsg})${R}`);

        if (opts.noAutoRestart) {
            if (opts.onExit) opts.onExit(code, signal);
            return;
        }

        recordCrash(name);
        if (isCrashLooping(name)) {
            console.log(`${t} ${RD}🛑 Crash loop detected (≥5 crashes/60 s). Stopping auto-restart for ${name}.${R}`);
            console.log(`${t} ${YL}   Fix the issue and restart start.js to recover.${R}`);
            return;
        }

        const delay = Math.min(2 ** (crashHistory[name].length) * 1000, 30_000);
        console.log(`${t} ${YL}↻  Restarting in ${delay / 1000}s...${R}`);

        if (opts.onExit) {
            setTimeout(() => opts.onExit(code, signal), delay);
        } else {
            setTimeout(() => launchService(def, opts), delay);
        }
    });

    log(name, color, `${GR}✓ Started (PID ${child.pid})${R}`);
    return child;
}

// ── Redis Cloud connectivity check ───────────────────────────────────────────
function checkRedisCloud() {
    return waitForPort(REDIS_CLOUD_PORT, REDIS_CLOUD_HOST, 10_000);
}

// ── Per-service child process registry ───────────────────────────────────────
const serviceRegistry = {}; // name -> ChildProcess

function stopService(name) {
    const child = serviceRegistry[name];
    if (child && !child.killed) {
        try { child.kill('SIGTERM'); } catch (_) {}
        console.log(`${DM}  ↓ Stopped ${name}${R}`);
    }
    delete serviceRegistry[name];
}

function launchNodeService({ name, script, color }) {
    if (isShuttingDown) return;
    const filePath = path.join(__dirname, script);
    // FIX: Increase Node.js heap limit to 4GB to prevent Out of Memory crashes
    const def = { name, cmd: 'node', args: ['--max-old-space-size=4096', filePath], color };
    const child = launchService(def, {
        onExit: async () => {
            delete serviceRegistry[name];
            if (isShuttingDown) return;
            // If it's the Detection Engine, make sure Redis is alive first
            if (name === 'Detection Engine') {
                restartDetectionEngine();
            }
        }
    });
    if (child) serviceRegistry[name] = child;
}

async function restartDetectionEngine() {
    if (isShuttingDown) return;
    const dTag = tag('Detection Engine', MG);
    console.log(`${dTag} ${YL}Waiting for Redis Cloud before restarting...${R}`);
    try {
        await checkRedisCloud();
        await wait(500);
        console.log(`${dTag} ${GR}Redis Cloud reachable. Restarting Detection Engine.${R}`);
        launchNodeService({ name: 'Detection Engine', script: 'engine/index.js', color: MG });
    } catch (_) {
        console.log(`${dTag} ${RD}Redis Cloud not reachable. Detection Engine will not restart.${R}`);
    }
}

// ── Redis Cloud health watchdog ───────────────────────────────────────────────
function startRedisWatchdog() {
    const INTERVAL = 15_000; // ping every 15 seconds
    const rTag     = tag('Redis Watchdog', YL);

    watchdogTimer = setInterval(async () => {
        if (isShuttingDown) return;
        const alive = await new Promise(resolve => {
            const sock = new net.Socket();
            sock.setTimeout(3000);
            sock.on('connect',  () => { sock.destroy(); resolve(true);  });
            sock.on('error',    () => { sock.destroy(); resolve(false); });
            sock.on('timeout',  () => { sock.destroy(); resolve(false); });
            sock.connect(REDIS_CLOUD_PORT, REDIS_CLOUD_HOST);
        });

        if (!alive) {
            console.log(`${rTag} ${RD}⚠  Redis Cloud not reachable at ${REDIS_CLOUD_HOST}:${REDIS_CLOUD_PORT}!${R}`);
            console.log(`${rTag} ${YL}   Check your internet connection. Node services will auto-reconnect when it comes back.${R}`);
        }
    }, INTERVAL);

    console.log(`${rTag} ${DM}Watchdog active — pinging ${REDIS_CLOUD_HOST}:${REDIS_CLOUD_PORT} every ${INTERVAL / 1000}s${R}`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (watchdogTimer) clearInterval(watchdogTimer);

    console.log(`\n${YL}${B}⏹  Shutting down all services...${R}`);

    for (const [name, child] of Object.entries(serviceRegistry)) {
        try { child.kill('SIGTERM'); } catch (_) {}
        console.log(`${DM}  ✓ ${name} stopped${R}`);
    }
    setTimeout(() => process.exit(0), 1000);
};

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
    for (const child of Object.values(serviceRegistry)) {
        try { child.kill('SIGKILL'); } catch (_) {}
    }
});

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`
${B}╔════════════════════════════════════════════════════╗
║    🚀  VISION AI  ─  Bulletproof Launcher         ║
║    API Server • Media Server • Detection Engine   ║
║    Redis: Cloud ☁  (milk-chivalrous-bee-83197)    ║
╚════════════════════════════════════════════════════╝${R}
`);

    // 1. Verify Redis Cloud is reachable before starting Node services
    const rTag = tag('Redis Cloud', RD);
    console.log(`${rTag} ${DM}Checking Redis Cloud connectivity...${R}`);
    try {
        await checkRedisCloud();
        console.log(`${rTag} ${GR}✅ Redis Cloud is reachable!${R}`);
    } catch (e) {
        console.log(`${rTag} ${YL}⚠  Redis Cloud not reachable yet (${e.message}). Starting services anyway — ioredis will retry automatically.${R}`);
    }

    // 2. Start Node services in sequence with a small stagger
    for (const svc of NODE_SERVICES) {
        launchNodeService(svc);
        await wait(400);
    }

    // 3. Start Redis Cloud health watchdog
    startRedisWatchdog();

    // 4. Start weekly free trial reset scheduler
    startWeeklyTrialReset();

    console.log(`\n${DM}All services launched. Press Ctrl+C to stop everything.${R}\n`);
}

// ── Weekly Free Trial Reset ───────────────────────────────────────────────────
// Runs once on startup (in case server was off on Monday), and then every
// Monday at 00:01 UTC. Re-activates any free-plan users whose Supabase
// subscription_status was set to 'Trial Expired'. The Redis weekly counters
// reset automatically via their 8-day TTL — this just cleans up Supabase rows.
function startWeeklyTrialReset() {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const rTag = tag('Weekly Reset', CY);

    async function runReset() {
        try {
            const { data, error } = await supabase
                .from('profiles')
                .update({ subscription_status: 'Active' })
                .eq('subscription_plan', 'Free')
                .eq('subscription_status', 'Trial Expired');

            if (error) {
                console.log(`${rTag} ${RD}Error resetting free trials: ${error.message}${R}`);
            } else {
                const count = data ? data.length : 0;
                console.log(`${rTag} ${GR}✅ Weekly reset complete. ${count} free trial user(s) reactivated.${R}`);
            }
        } catch (e) {
            console.log(`${rTag} ${RD}Reset exception: ${e.message}${R}`);
        }
    }

    // Run immediately on startup to catch missed resets
    runReset();

    // Then schedule to run every Monday at 00:01 UTC (check every hour)
    setInterval(() => {
        const now = new Date();
        if (now.getUTCDay() === 1 && now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
            console.log(`${rTag} ${CY}Monday detected — running weekly free trial reset...${R}`);
            runReset();
        }
    }, 60 * 60 * 1000); // Check every hour

    console.log(`${rTag} ${DM}Weekly trial reset scheduler active (runs every Monday 00:01 UTC)${R}`);
}

main().catch(err => {
    console.error(`${RD}${B}Startup failed:${R}`, err.message);
    process.exit(1);
});
