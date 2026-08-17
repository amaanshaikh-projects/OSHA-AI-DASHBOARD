const fs = require('fs');
const path = require('path');
const net = require('net');
const url = require('url');
const http = require('http');
const nodemailer = require('nodemailer');
const { spawn, exec, execFile } = require('child_process');
const cryptoUtils = require('./utils/crypto');
const { startHealthServer } = require('./health-server.js');
const { GMAIL_USER, GMAIL_APP_PASS, getAppConfig, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('./config.js');
const healthController = require('./engine/health-controller.js');
const { pipeline } = require('@xenova/transformers');
const { createClient } = require('@supabase/supabase-js');
const { redisConnection } = require('./engine/queue-manager.js');
const { getWeekKey } = require('./utils/shared-utils.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Cache for Gemini enhance API calls
const enhanceCache = new Map();

let embedder = null;
async function getEmbedder() {
    if (!embedder) {
        embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    return embedder;
}

// Web Server Configuration
const PORT = 8000;

// Gmail SMTP Transporter (real email delivery)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASS
    }
});

transporter.verify((err) => {
    if (err) {
        console.error('[API Server] Gmail SMTP connection failed:', err.message);
    } else {
        console.log(`[API Server] ✅ Gmail SMTP ready — sending as ${GMAIL_USER}`);
    }
});


const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
};

const frameRateLimits = new Map();

const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];

    // Handle CORS preflight for all API routes
    const allowedOrigin = process.env.FRONTEND_URL || req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Auth Middleware for sensitive administrative routes
    const sensitiveRoutes = ['/api/settings/email', '/api/hls/start', '/api/hls/stop', '/api/rtsp/validate-deep', '/api/cameras/preview-frame', '/api/cameras/encrypt'];
    if (sensitiveRoutes.some(route => urlPath.startsWith(route))) {
        const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').split(' ')[1];
        const validKey = process.env.API_SECRET_KEY;
        if (!validKey || apiKey !== validKey) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing API Key' }));
            return;
        }
    }

    // Health check / test endpoint
    if (urlPath === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            status: "Running without AI detection engine"
        }));
        return;
    }

    if (urlPath === '/api/user/usage' && req.method === 'GET') {
        try {
            const parsedUrl = url.parse(req.url, true);
            const userId = parsedUrl.query.userId;

            if (!userId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'userId is required' }));
                return;
            }

            const weekKey = getWeekKey();

            const key = `live_minutes:user:${userId}:weekly:${weekKey}`;
            const minutes = await redisConnection.get(key);

            const apiKey = `api_usage:user:${userId}:weekly:${weekKey}`;
            const apiCalls = await redisConnection.get(apiKey);

            const alertsKey = `alerts_usage:user:${userId}:weekly:${weekKey}`;
            const alertsCount = await redisConnection.get(alertsKey);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                liveMinutesUsed: parseInt(minutes || 0),
                apiCallsUsed: parseInt(apiCalls || 0),
                alertsUsed: parseInt(alertsCount || 0)
            }));
        } catch (err) {
            console.error('[API Server] Error fetching user usage:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to fetch usage' }));
        }
        return;
    }

    // ─── Enterprise Contact Sales Form ────────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/api/contact-sales') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { fullName, companyName, businessEmail, phone, country, cameras, industry, message } = JSON.parse(body);

                if (!fullName || !businessEmail) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Full name and business email are required.' }));
                    return;
                }

                const emailBody = `
New Enterprise Sales Inquiry
=============================
Full Name:     ${fullName}
Company:       ${companyName || 'N/A'}
Business Email: ${businessEmail}
Phone:         ${phone || 'N/A'}
Country:       ${country || 'N/A'}
Est. Cameras:  ${cameras || 'N/A'}
Industry:      ${industry || 'N/A'}

Message:
${message || 'No message provided.'}
=============================
Submitted at: ${new Date().toISOString()}
                `.trim();

                // 1) Notify the admin (your Gmail inbox) with the full lead details
                const adminMail = {
                    from: `"OSHA AI Sales" <${GMAIL_USER}>`,
                    to: GMAIL_USER,
                    replyTo: businessEmail,
                    subject: `🚨 New Enterprise Lead — ${companyName || fullName} (${industry || 'Unknown'})`,
                    text: `New enterprise sales inquiry received:\n\n${emailBody}`,
                    html: `
                        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:12px;overflow:hidden;">
                            <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:32px;text-align:center;border-bottom:3px solid #f59e0b;">
                                <h1 style="margin:0;color:#f59e0b;font-size:1.6rem;">🚨 New Enterprise Lead</h1>
                                <p style="margin:8px 0 0;color:#94a3b8;">via OSHA AI Contact Sales Form</p>
                            </div>
                            <div style="padding:28px;">
                                <table style="width:100%;border-collapse:collapse;">
                                    <tr><td style="padding:8px 0;color:#94a3b8;font-size:0.85rem;width:140px;">Full Name</td><td style="padding:8px 0;font-weight:600;">${fullName}</td></tr>
                                    <tr><td style="padding:8px 0;color:#94a3b8;font-size:0.85rem;">Company</td><td style="padding:8px 0;font-weight:600;">${companyName || 'N/A'}</td></tr>
                                    <tr><td style="padding:8px 0;color:#94a3b8;font-size:0.85rem;">Business Email</td><td style="padding:8px 0;"><a href="mailto:${businessEmail}" style="color:#f59e0b;">${businessEmail}</a></td></tr>
                                    <tr><td style="padding:8px 0;color:#94a3b8;font-size:0.85rem;">Phone</td><td style="padding:8px 0;">${phone || 'N/A'}</td></tr>
                                    <tr><td style="padding:8px 0;color:#94a3b8;font-size:0.85rem;">Country</td><td style="padding:8px 0;">${country || 'N/A'}</td></tr>
                                    <tr><td style="padding:8px 0;color:#94a3b8;font-size:0.85rem;">Est. Cameras</td><td style="padding:8px 0;">${cameras || 'N/A'}</td></tr>
                                    <tr><td style="padding:8px 0;color:#94a3b8;font-size:0.85rem;">Industry</td><td style="padding:8px 0;">${industry || 'N/A'}</td></tr>
                                </table>
                                ${message ? `<div style="margin-top:20px;padding:16px;background:#1e293b;border-left:4px solid #f59e0b;border-radius:4px;"><p style="margin:0 0 6px;color:#94a3b8;font-size:0.8rem;">MESSAGE</p><p style="margin:0;">${message}</p></div>` : ''}
                                <p style="margin-top:24px;font-size:0.8rem;color:#64748b;">Submitted at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
                            </div>
                        </div>
                    `
                };

                // 2) Send confirmation to the customer
                const customerMail = {
                    from: `"OSHA AI Enterprise" <${GMAIL_USER}>`,
                    to: businessEmail,
                    subject: `Thank you for contacting OSHA AI, ${fullName.split(' ')[0]}!`,
                    text: `Hi ${fullName},\n\nThank you for reaching out to OSHA AI! Our enterprise team has received your inquiry and will respond within 1–2 business days with a tailored proposal, implementation plan, and pricing.\n\nBest regards,\nThe OSHA AI Enterprise Team`,
                    html: `
                        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:12px;overflow:hidden;">
                            <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:32px;text-align:center;border-bottom:3px solid #f59e0b;">
                                <h1 style="margin:0;color:#f59e0b;font-size:1.5rem;">Thank You, ${fullName.split(' ')[0]}!</h1>
                                <p style="margin:8px 0 0;color:#94a3b8;">We've received your enterprise inquiry</p>
                            </div>
                            <div style="padding:28px;">
                                <p>Hi <strong>${fullName}</strong>,</p>
                                <p>Thank you for reaching out to <strong>OSHA AI</strong>! Our enterprise team has received your inquiry for <strong>${companyName || 'your organization'}</strong> and will respond within <strong>1–2 business days</strong> with a tailored proposal, implementation plan, and pricing.</p>
                                <div style="margin:24px 0;padding:16px;background:#1e293b;border-radius:8px;text-align:center;">
                                    <p style="margin:0 0 4px;color:#94a3b8;font-size:0.85rem;">Your inquiry reference</p>
                                    <p style="margin:0;font-weight:600;color:#f59e0b;">${companyName || fullName} — ${cameras || 'N/A'} cameras — ${industry || 'N/A'}</p>
                                </div>
                                <p style="color:#94a3b8;font-size:0.9rem;">In the meantime, feel free to reply to this email with any questions.</p>
                                <p>Best regards,<br><strong>The OSHA AI Enterprise Team</strong></p>
                            </div>
                        </div>
                    `
                };

                await transporter.sendMail(adminMail);
                await transporter.sendMail(customerMail);
                console.log(`[Contact Sales] ✅ Emails sent — Admin: ${GMAIL_USER}, Customer: ${businessEmail}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                console.error('[Contact Sales] Error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to send email: ' + e.message }));
            }
        });
        return;
    }




    // ─── Email / SMTP Settings ─────────────────────────────────────────────────
    if (req.method === 'GET' && urlPath === '/api/settings/email') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ gmailUser: transporter.options?.auth?.user || GMAIL_USER }));
        return;
    }

    if (req.method === 'POST' && urlPath === '/api/settings/email') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { gmailUser, gmailPass } = JSON.parse(body);
                if (!gmailUser || !gmailPass) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Both gmailUser and gmailPass are required.' }));
                    return;
                }

                // Rebuild and verify the transporter with new credentials
                const newTransporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: { user: gmailUser, pass: gmailPass }
                });

                await newTransporter.verify();

                // Hot-swap the global transporter
                Object.assign(transporter, newTransporter);
                // Also persist new options so GET returns the right user
                transporter.options = { ...transporter.options, auth: { user: gmailUser, pass: gmailPass } };

                console.log(`[Email Settings] ✅ Gmail SMTP updated to ${gmailUser}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                console.error('[Email Settings] Connection failed:', e.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // --- Camera Health API ---
    if (req.method === 'GET' && urlPath.startsWith('/api/health/')) {
        const camId = urlPath.split('/').pop();
        if (!camId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing camera ID' }));
            return;
        }

        try {
            // Fetch camera owner to determine plan
            const { data: camData } = await supabase.from('cameras').select('user_id').eq('id', camId).single();
            let plan = 'Free';
            if (camData?.user_id) {
                const { data: profile } = await supabase.from('profiles').select('subscription_plan').eq('id', camData.user_id).single();
                if (profile) plan = profile.subscription_plan || 'Free';
            }

            const stats = await healthController.getDashboardStats(camId, plan);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
        } catch (e) {
            console.error('[Health API] Error fetching stats:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
        }
        return;
    }

    // RTSP Connection Validator - TCP probe to check if camera is reachable
    if (req.method === 'POST' && urlPath === '/api/rtsp/validate') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { rtspUrl } = JSON.parse(body);
                if (!rtspUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ reachable: false, error: 'No RTSP URL provided' }));
                    return;
                }

                // Parse the RTSP URL
                let host, port;
                try {
                    const urlStr = rtspUrl.replace(/^rtsp:\/\//i, 'http://');
                    const parsed = new URL(urlStr);
                    host = parsed.hostname;
                    port = parseInt(parsed.port) || 554;
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ reachable: false, error: 'Invalid RTSP URL format' }));
                    return;
                }

                if (!host) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ reachable: false, error: 'Could not parse host from URL' }));
                    return;
                }

                // SSRF Protection: Block connections to localhost, 0.0.0.0, and AWS/cloud metadata IPs
                const lowerHost = host.toLowerCase();
                if (lowerHost === 'localhost' || lowerHost === '127.0.0.1' || lowerHost === '::1' || lowerHost === '0.0.0.0' || lowerHost.startsWith('169.254.')) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ reachable: false, error: 'Connections to localhost or metadata services are not allowed' }));
                    return;
                }

                const startTime = Date.now();


                const socket = new net.Socket();
                let resolved = false;

                socket.setTimeout(5000);

                socket.connect(port, host, () => {
                    if (resolved) return;
                    resolved = true;
                    const latency = Date.now() - startTime;
                    socket.destroy();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        reachable: true,
                        host,
                        port,
                        latency,
                        message: `Connected to ${host}:${port} in ${latency}ms`
                    }));
                });

                socket.on('timeout', () => {
                    if (resolved) return;
                    resolved = true;
                    socket.destroy();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        reachable: false,
                        host,
                        port,
                        rtspUrl,
                        error: `Connection timed out — ${host}:${port} did not respond within 5 seconds. Check the IP address, port, and that the camera is powered on and connected to this network.`
                    }));
                });

                socket.on('error', (err) => {
                    if (resolved) return;
                    resolved = true;
                    socket.destroy();
                    let friendlyError = err.message;
                    if (err.code === 'ECONNREFUSED') friendlyError = `Connection refused at ${host}:${port}. The camera may be offline or using a different port.`;
                    else if (err.code === 'ENOTFOUND') friendlyError = `Host "${host}" not found. Check the IP address or hostname.`;
                    else if (err.code === 'ETIMEDOUT') friendlyError = `Timed out connecting to ${host}:${port}. Camera may be unreachable.`;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        reachable: false,
                        host,
                        port,
                        rtspUrl,
                        error: friendlyError
                    }));
                });

            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reachable: false, error: e.message }));
            }
        });
        return;
    }


    // ─── Proxy HLS Streaming to Media Server (Port 8002) ─────────────────────

    if (req.method === 'POST' && urlPath === '/api/hls/start') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { rtspUrl: encryptedUrl, streamId } = JSON.parse(body);
                const rtspUrl = encryptedUrl.startsWith('webcam://') ? encryptedUrl : cryptoUtils.decrypt(encryptedUrl);
                // MOCK FOR DEMO:
                if (rtspUrl && (rtspUrl.includes('192.168.1.101') || rtspUrl.includes('192.168.1.102'))) {
                    // Return a dummy stream URL. The frontend might fail to play it, but it passes the initialization step.
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, streamUrl: '/api/hls/mock-stream.m3u8', streamId }));
                    return;
                }

                // Otherwise proxy to media server
                proxyToMediaServer(req, res, body);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (urlPath.startsWith('/api/hls/')) {
        // Just proxy GET requests directly
        proxyToMediaServer(req, res);
        return;
    }

    function proxyToMediaServer(req, res, bufferedBody = null) {
        const options = {
            hostname: 'localhost',
            port: 8002,
            path: req.url,
            method: req.method,
            headers: req.headers
        };
        const proxyReq = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res, { end: true });
        });
        proxyReq.on('error', (e) => {
            console.error(`[API Server] Media Server Proxy Error: ${e.message}`);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Media server unreachable' }));
        });
        if (bufferedBody) proxyReq.write(bufferedBody);
        req.pipe(proxyReq, { end: true });
    }

    // ─── HLS Streaming moved to external WebRTC cluster ────────────

    const handleBillingRoutes = require('./billing.js');

    if (urlPath.startsWith('/api/billing/')) {
        const handled = await handleBillingRoutes(req, res, urlPath);
        if (handled) return;
    }

    // API Gateway Proxying to Detection Engine (Scalable Microservice)
    if (urlPath === '/api/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            uptimeSeconds: process.uptime(),
            activeCameras: 0,
            detectionsLastHour: 0,
            fps: 0,
            status: "online",
            yoloQueueLength: 0,
            geminiQueueLength: 0,
            yoloSavingsCount: 0,
            geminiRequests: 0,
            sceneSavingsCount: 0,
            avgProcessingTime: 124,
            geminiSuccess: 1,
            geminiFailures: 0,
            workerHealth: "optimal"
        }));
        return;
    }

    // Forward frame analysis requests to the Detection Engine (Port 8001)
    if (req.method === 'POST' && urlPath === '/api/analyze-frame') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                // Fast regex extraction to avoid parsing large base64 JSON
                const match = body.match(/"cameraId"\s*:\s*"([^"]+)"/);
                const cameraId = match ? match[1] : 'unknown';

                const now = Date.now();
                const last = frameRateLimits.get(cameraId) || 0;

                if (now - last < 333) { // Max ~3 FPS
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Rate limit exceeded. Max 3 FPS allowed.' }));
                    return;
                }
                frameRateLimits.set(cameraId, now);
                if (frameRateLimits.size > 1000) {
                    frameRateLimits.delete(frameRateLimits.keys().next().value);
                }

                const response = await fetch('http://localhost:8001/api/engine/analyze-frame', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: body
                });
                const result = await response.json();
                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error('[API Server] Error forwarding frame to engine:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to reach detection engine' }));
            }
        });
        return;
    }

    if (req.method === 'POST' && urlPath === '/api/engine/delete') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const response = await fetch('http://localhost:8001/api/engine/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: body
                });
                const result = await response.json();
                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error('[API Server] Error forwarding delete to engine:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to reach detection engine' }));
            }
        });
        return;
    }

    // ─── Semantic Search Endpoint ────────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/api/semantic-search') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { query, userId, cameraId, startDate, endDate } = JSON.parse(body);
                if (!query || !userId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing query or userId' }));
                    return;
                }

                const embedPipeline = await getEmbedder();
                const out = await embedPipeline(query, { pooling: 'mean', normalize: true });
                const queryEmbedding = Array.from(out.data);

                const { data, error } = await supabase.rpc('match_detections', {
                    query_embedding: queryEmbedding,
                    match_threshold: 0.1, // very loose threshold for generic search
                    match_count: 20,
                    p_user_id: userId,
                    p_camera_id: cameraId || null,
                    p_start_date: startDate || null,
                    p_end_date: endDate || null
                });

                if (error) throw error;

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ results: data || [] }));
            } catch (err) {
                console.error('[API Server] Semantic Search Error:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    if (urlPath.startsWith('/api/camera/') && (urlPath.endsWith('/toggle') || urlPath.endsWith('/sync') || urlPath.endsWith('/state'))) {
        const parts = urlPath.split('/');
        const camId = parts[parts.length - 2];
        const action = parts[parts.length - 1];

        if (action === 'sync' || action === 'toggle') {
            try {
                fetch('http://localhost:8001/api/engine/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ camId })
                }).catch(e => console.error('[API Server] Error signaling engine sync:', e.message));
            } catch (err) { }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, eventState: "Inactive", message: "Engine synced" }));
        return;
    }

    if (req.method === 'POST' && urlPath === '/api/engine/interpret') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            supported: true,
            requiredModules: ['ObjectDetection', 'ObjectTracking', 'RuleEngine'],
            unsupportedReason: null
        }));
        return;
    }

    if (req.method === 'POST' && urlPath.startsWith('/api/prompt/')) {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const userPrompt = data.promptText || '';

                if (urlPath === '/api/prompt/validate') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ valid: true, reason: "Detection engine disabled, accepting all prompts." }));
                    return;
                }

                if (urlPath === '/api/prompt/enhance') {
                    if (enhanceCache.has(userPrompt)) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ enhancedPrompt: enhanceCache.get(userPrompt) }));
                        return;
                    }

                    const config = getAppConfig();
                    const orConfig = config.openRouter;
                    if (!orConfig || !orConfig.apiKey) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ enhancedPrompt: userPrompt })); // Fallback
                        return;
                    }

                    const maxLength = data.maxLength || 200;
                    const sysPrompt = `You are an expert security engineer. The user will provide a crude monitoring rule for a security camera. 
Your task is to fix any spelling mistakes, interpret the user's intended meaning correctly despite typos or poor grammar, and enhance it into a clear, precise, and highly descriptive instruction that is optimized for a Vision AI engine to evaluate.
Do not add conversational filler or quotes around the output. Output ONLY the enhanced prompt string. 
The final enhanced string MUST NOT exceed ${maxLength} characters in total length.`;

                    try {
                        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${orConfig.apiKey}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                model: 'google/gemini-2.5-flash-lite',
                                messages: [
                                    { role: 'system', content: sysPrompt },
                                    { role: 'user', content: userPrompt }
                                ],
                                temperature: 0.3
                            }),
                            signal: AbortSignal.timeout(10000)
                        });

                        if (response.ok) {
                            const result = await response.json();
                            let enhancedPrompt = result.choices[0].message.content.trim();

                            // Hard constraint truncation to guarantee max length
                            if (enhancedPrompt.length > maxLength) {
                                enhancedPrompt = enhancedPrompt.substring(0, maxLength);
                                const lastSpace = enhancedPrompt.lastIndexOf(' ');
                                if (lastSpace > 0) {
                                    enhancedPrompt = enhancedPrompt.substring(0, lastSpace);
                                }
                            }

                            enhanceCache.set(userPrompt, enhancedPrompt);
                            if (enhanceCache.size > 1000) {
                                enhanceCache.delete(enhanceCache.keys().next().value);
                            }

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ enhancedPrompt }));
                            return;
                        } else {
                            const errText = await response.text();
                            console.error('[API Server] Enhance prompt API error:', response.status, errText);
                        }
                    } catch (e) {
                        console.error('[API Server] Enhance prompt error:', e.message);
                    }

                    // Fallback on error
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ enhancedPrompt: userPrompt }));
                    return;
                }

                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Endpoint not found" }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && urlPath === '/api/rtsp/validate-deep') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                let { rtspUrl, username, password } = JSON.parse(body);
                if (!rtspUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'No RTSP URL provided' }));
                    return;
                }

                if (username && password) {
                    try {
                        const urlObj = new URL(rtspUrl.replace(/^rtsp:\/\//i, 'http://'));
                        urlObj.username = encodeURIComponent(username);
                        urlObj.password = encodeURIComponent(password);
                        rtspUrl = urlObj.toString().replace(/^http:\/\//i, 'rtsp://');
                    } catch (e) {
                        console.error('Failed to parse RTSP URL for auth injection:', e.message);
                    }
                }

                // Deep validate using ffmpeg instead of ffprobe
                const ffmpegPath = require('ffmpeg-static');
                const ffmpegArgs = ['-rtsp_flags', 'prefer_tcp', '-i', rtspUrl, '-t', '1', '-f', 'null', '-'];
                execFile(ffmpegPath, ffmpegArgs, { timeout: 20000 }, (error, stdout, stderr) => {
                    const output = stderr || '';
                    if (!output.includes('Video:')) {
                        const lines = output.split('\n').filter(l => l.trim() !== '');
                        const errMsg = lines.length > 0 ? lines.pop().trim() : (error ? error.message : 'Unknown error');
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `ffmpeg failed: ${errMsg}` }));
                        return;
                    }

                    try {
                        let resolution = 'Unknown';
                        let fps = 0;
                        let codec = 'Unknown';

                        // Parse codec and resolution
                        const videoStreamMatch = output.match(/Stream #\d+:\d+(?:\[0x\d+\])?: Video: ([a-zA-Z0-9_-]+).*?,\s*(\d{2,}x\d{2,})/);
                        if (videoStreamMatch) {
                            codec = videoStreamMatch[1];
                            resolution = videoStreamMatch[2];
                        }

                        // Parse fps
                        const fpsMatch = output.match(/(\d+(?:\.\d+)?)\s*fps/);
                        if (fpsMatch) {
                            fps = Math.round(parseFloat(fpsMatch[1]));
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            resolution: resolution,
                            fps: fps || 0,
                            codec: codec
                        }));
                    } catch (parseErr) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Failed to parse ffmpeg output' }));
                    }
                });
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && urlPath === '/api/cameras/preview-frame') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                let { rtspUrl } = JSON.parse(body);
                if (!rtspUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'No RTSP URL provided' }));
                    return;
                }
                const ffmpegPath = require('ffmpeg-static');
                const ffmpegArgs = ['-rtsp_flags', 'prefer_tcp', '-i', rtspUrl, '-vframes', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1'];

                execFile(ffmpegPath, ffmpegArgs, { encoding: 'buffer', maxBuffer: 1024 * 1024 * 10, timeout: 10000 }, (error, stdout, stderr) => {
                    if (error && (!stdout || stdout.length === 0)) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Failed to capture frame from stream' }));
                        return;
                    }

                    const base64Image = Buffer.from(stdout).toString('base64');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, frame: `data:image/jpeg;base64,${base64Image}` }));
                });
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    //  Ask My Cameras Assistant 
    if (req.method === 'POST' && urlPath === '/api/assistant/chat') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            text: "The AI detection engine and assistant features have been disabled. I am currently offline for upgrades.",
            events: []
        }));
        return;
    }

    if (req.method === 'GET' && urlPath === '/api/cameras/scan') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            cameras: [
                { ip: '192.168.1.100', name: 'Mock ONVIF Camera A' },
                { ip: '192.168.1.102', name: 'Mock ONVIF Camera B' }
            ]
        }));
        return;
    }

    if (req.method === 'POST' && urlPath === '/api/cameras/encrypt') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                const encrypted = cryptoUtils.encrypt(password);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ password_encrypted: encrypted }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Endpoint not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(PORT, () => {
    console.log(`[API Server] Running at http://localhost:${PORT}`);
});

// Start Health Check Server
const healthServer = startHealthServer(8011, 'APIServer', () => ({
    connections: 0
}));

// Graceful Shutdown
const shutdown = () => {
    console.log('[API Server] Shutting down gracefully...');
    server.close();
    healthServer.close();
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
