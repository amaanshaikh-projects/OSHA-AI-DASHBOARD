const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const nodemailer = require('nodemailer');

// Cache for Gemini enhance API calls
const enhanceCache = new Map();

// Web Server Configuration
const PORT = process.env.PORT || 8080;

// HLS Streaming — temp dir for segments, active stream processes
const HLS_DIR = path.join(os.tmpdir(), 'vision-ai-hls');
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });
const activeStreams = new Map(); // streamId -> { process, dir, lastUsed }

// Cleanup stale HLS streams older than 2 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, stream] of activeStreams.entries()) {
        if (now - stream.lastUsed > 120000) {
            console.log(`[HLS] Cleaning up stale stream: ${id}`);
            try { stream.process.kill('SIGKILL'); } catch (e) { }
            try { fs.rmSync(stream.dir, { recursive: true, force: true }); } catch (e) { }
            activeStreams.delete(id);
        }
    }
}, 30000);

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
    '.woff2': 'font/woff2'
};

let transporter;
nodemailer.createTestAccount((err, account) => {
    if (err) {
        console.error('Failed to create a testing account. ' + err.message);
        return;
    }
    transporter = nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth: {
            user: account.user,
            pass: account.pass
        }
    });
    console.log(`[Dev Server] Nodemailer Ethereal test account created: ${account.user}`);
});

const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];

    // Handle CORS preflight for all API routes
    const allowedOrigin = process.env.FRONTEND_URL || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Health check / test endpoint
    if (urlPath === '/api/ping') {
        const { OPENROUTER_API_KEY, OPENROUTER_MODEL, isOpenRouterConfigured } = require('./config.js');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            openrouter: isOpenRouterConfigured(),
            model: OPENROUTER_MODEL,
            keyPrefix: OPENROUTER_API_KEY ? OPENROUTER_API_KEY.substring(0, 12) + '...' : 'NOT SET'
        }));
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
                        rtspUrl,
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

    if (req.method === 'POST' && urlPath === '/api/contact-sales') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (!transporter) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Mail server not ready' }));
                    return;
                }

                const mailOptions = {
                    from: '"OSHA AI Contact Form" <noreply@osha.ai>',
                    to: 'sales@osha.ai',
                    subject: `New Enterprise Inquiry from ${data.companyName}`,
                    text: `Name: ${data.fullName}\nCompany: ${data.companyName}\nEmail: ${data.businessEmail}\nPhone: ${data.phone}\nCountry: ${data.country}\nCameras: ${data.cameras}\nIndustry: ${data.industry}\n\nMessage:\n${data.message}`,
                    html: `<h3>New Enterprise Inquiry</h3>
                           <p><strong>Name:</strong> ${data.fullName}</p>
                           <p><strong>Company:</strong> ${data.companyName}</p>
                           <p><strong>Email:</strong> ${data.businessEmail}</p>
                           <p><strong>Phone:</strong> ${data.phone}</p>
                           <p><strong>Country:</strong> ${data.country}</p>
                           <p><strong>Cameras:</strong> ${data.cameras}</p>
                           <p><strong>Industry:</strong> ${data.industry}</p>
                           <p><strong>Message:</strong><br>${data.message}</p>`
                };

                const info = await transporter.sendMail(mailOptions);
                console.log('[Dev Server] Contact email sent: %s', info.messageId);
                console.log('[Dev Server] Preview URL: %s', nodemailer.getTestMessageUrl(info));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, messageId: info.messageId, previewUrl: nodemailer.getTestMessageUrl(info) }));
            } catch (err) {
                console.error('[Dev Server] Error sending email:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to send message' }));
            }
        });
        return;
    }

    // ─── HLS Streaming Endpoints ─────────────────────────────────────────────

    // POST /api/hls/start — spawn FFmpeg to transcode RTSP → HLS segments
    if (req.method === 'POST' && urlPath === '/api/hls/start') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { rtspUrl, streamId } = JSON.parse(body);
                if (!rtspUrl || !streamId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'rtspUrl and streamId required' }));
                    return;
                }

                // MOCK FOR DEMO:
                if (rtspUrl && (rtspUrl.includes('192.168.1.101') || rtspUrl.includes('192.168.1.102'))) {
                    // Return a dummy stream URL. The frontend might fail to play it, but it passes the initialization step.
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, streamUrl: '/api/hls/mock-stream.m3u8', streamId }));
                    return;
                }

                // Kill existing stream for this ID if any
                if (activeStreams.has(streamId)) {
                    const old = activeStreams.get(streamId);
                    try { old.process.kill('SIGKILL'); } catch (e) { }
                    try { fs.rmSync(old.dir, { recursive: true, force: true }); } catch (e) { }
                    activeStreams.delete(streamId);
                }

                const streamDir = path.join(HLS_DIR, streamId);
                fs.mkdirSync(streamDir, { recursive: true });

                const m3u8Path = path.join(streamDir, 'stream.m3u8');

                // FFmpeg args: low-latency HLS from RTSP
                const ffmpegArgs = [
                    '-rtsp_flags', 'prefer_tcp',           // Use TCP for RTSP (more reliable)
                    '-i', rtspUrl,                       // Input RTSP stream
                    '-c:v', 'libx264',                   // Re-encode to H.264 for browser compat
                    '-preset', 'ultrafast',              // Fastest encoding
                    '-tune', 'zerolatency',              // Minimize latency
                    '-crf', '28',                        // Quality level
                    '-sc_threshold', '0',
                    '-g', '30',                          // Keyframe every 30 frames
                    '-hls_time', '2',                    // 2s segments
                    '-hls_list_size', '5',               // Keep 5 segments in playlist
                    '-hls_flags', 'delete_segments+append_list+independent_segments',
                    '-hls_segment_filename', path.join(streamDir, 'seg%03d.ts'),
                    '-f', 'hls',
                    '-an',                               // No audio (cameras often have none)
                    m3u8Path
                ];

                console.log(`[HLS] Starting stream ${streamId} for: ${rtspUrl}`);
                const ffProc = spawn(ffmpegPath, ffmpegArgs);

                ffProc.stderr.on('data', (data) => {
                    // Log FFmpeg output (only first few lines to avoid log spam)
                    const line = data.toString().trim();
                    if (line.includes('frame=') || line.includes('Error') || line.includes('error')) {
                        console.log(`[HLS:${streamId}] ${line.substring(0, 120)}`);
                    }
                });

                ffProc.on('exit', (code) => {
                    console.log(`[HLS] Stream ${streamId} exited with code ${code}`);
                    activeStreams.delete(streamId);
                    try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch (e) { }
                });

                activeStreams.set(streamId, { process: ffProc, dir: streamDir, lastUsed: Date.now() });

                // Wait for the first .m3u8 segment to appear (up to 10s)
                let waited = 0;
                const waitInterval = setInterval(() => {
                    waited += 200;
                    if (fs.existsSync(m3u8Path) && fs.statSync(m3u8Path).size > 0) {
                        clearInterval(waitInterval);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            ok: true,
                            streamUrl: `/api/hls/${streamId}/stream.m3u8`,
                            streamId
                        }));
                    } else if (waited >= 10000) {
                        clearInterval(waitInterval);
                        // FFmpeg may have failed — check if process is still running
                        const streamInfo = activeStreams.get(streamId);
                        if (streamInfo) {
                            try { streamInfo.process.kill('SIGKILL'); } catch (e) { }
                            activeStreams.delete(streamId);
                        }
                        res.writeHead(504, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Stream did not start within 10 seconds. Check RTSP URL and credentials.' }));
                    }
                }, 200);

            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // POST /api/hls/stop — kill FFmpeg and clean up
    if (req.method === 'POST' && urlPath === '/api/hls/stop') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { streamId } = JSON.parse(body);
                if (activeStreams.has(streamId)) {
                    const stream = activeStreams.get(streamId);
                    try { stream.process.kill('SIGKILL'); } catch (e) { }
                    try { fs.rmSync(stream.dir, { recursive: true, force: true }); } catch (e) { }
                    activeStreams.delete(streamId);
                    console.log(`[HLS] Stopped stream: ${streamId}`);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // GET /api/hls/:streamId/:file — serve HLS playlist and segments
    if (req.method === 'GET' && urlPath.startsWith('/api/hls/')) {
        const parts = urlPath.split('/'); // ['', 'api', 'hls', streamId, filename]
        const streamId = parts[3];
        const filename = parts[4];

        if (!streamId || !filename) {
            res.writeHead(400); res.end('Bad request'); return;
        }

        // Update lastUsed to prevent cleanup
        if (activeStreams.has(streamId)) {
            activeStreams.get(streamId).lastUsed = Date.now();
        }

        const filePath = path.join(HLS_DIR, streamId, filename);
        const ext = path.extname(filename);
        const contentType = ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t';

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Segment not found', file: filename }));
                return;
            }
            res.writeHead(200, {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache, no-store',
            });
            res.end(data);
        });
        return;
    }

    // ─── End HLS Streaming Endpoints ─────────────────────────────────────────


    // API Gateway Proxying to Detection Engine (Scalable Microservice)
    if (urlPath === '/api/metrics') {
        const proxyReq = http.request('http://localhost:8001/api/engine/metrics', (proxyRes) => {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Detection Engine is offline." }));
        });
        proxyReq.end();
        return;
    }

    // Forward frame analysis requests to the Detection Engine (Port 8001)
    if (req.method === 'POST' && urlPath === '/api/analyze-frame') {
        const proxyReq = http.request({
            hostname: 'localhost',
            port: 8001,
            path: '/api/engine/analyze-frame',
            method: 'POST',
            headers: req.headers
        }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            console.error('[API Gateway] Proxy error for /api/analyze-frame:', e.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Detection Engine is offline." }));
        });
        req.pipe(proxyReq);
        return;
    }

    if (urlPath.startsWith('/api/camera/') && (urlPath.endsWith('/toggle') || urlPath.endsWith('/sync') || urlPath.endsWith('/state'))) {
        const parts = urlPath.split('/');
        const camId = parts[parts.length - 2];
        const action = parts[parts.length - 1];

        const proxyReq = http.request({
            hostname: 'localhost',
            port: 8001,
            path: `/api/engine/camera/${camId}/${action}`,
            method: req.method,
            headers: req.headers // Forward headers including content-type and length
        }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Detection Engine is offline." }));
        });
        req.pipe(proxyReq);
        return;
    }

    if (req.method === 'POST' && urlPath.startsWith('/api/prompt/')) {
        const { OPENROUTER_API_KEY, OPENROUTER_MODEL, isOpenRouterConfigured } = require('./config.js');
        if (!isOpenRouterConfigured()) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "OpenRouter is not configured." }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const userPrompt = data.promptText || '';
                const maxLength = data.maxLength || 100;

                if (urlPath === '/api/prompt/validate') {
                    const systemPrompt = `You are a strict security camera prompt validator. Evaluate if this prompt describes a valid VISUAL DETECTION task. If it asks for jokes, poems, code, stories, or anything non-visual, it is INVALID. Reply in pure JSON format: {"valid": boolean, "reason": "string explaining why"}`;

                    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: OPENROUTER_MODEL,
                            response_format: { type: "json_object" },
                            messages: [
                                { role: "system", content: systemPrompt },
                                { role: "user", content: `Prompt to validate: "${userPrompt}"` }
                            ]
                        })
                    });
                    const orJson = await orRes.json();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(orJson.choices[0].message.content);
                    return;
                }

                if (urlPath === '/api/prompt/enhance') {
                    if (enhanceCache.has(userPrompt)) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ enhancedPrompt: enhanceCache.get(userPrompt) }));
                        return;
                    }

                    const systemPrompt = `You are an expert security engineer. The user will provide a crude monitoring rule for a security camera. 
Your task is to fix any spelling mistakes, interpret the user's intended meaning correctly despite typos or poor grammar, and enhance it into a clear, precise, and highly descriptive instruction that is optimized for a Vision AI engine to evaluate.
Do not add conversational filler or quotes around the output. Output ONLY the enhanced prompt string. 
The final enhanced string MUST NOT exceed ${maxLength} characters in total length.`;

                    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'google/gemini-2.5-flash-lite',
                            messages: [
                                { role: "system", content: systemPrompt },
                                { role: "user", content: `Please enhance this prompt: "${userPrompt}"` }
                            ],
                            temperature: 0.3
                        })
                    });
                    const orJson = await orRes.json();
                    let enhancedText = orJson.choices[0].message.content.trim();
                    if (enhancedText.startsWith('"') && enhancedText.endsWith('"')) {
                        enhancedText = enhancedText.slice(1, -1);
                    }

                    enhanceCache.set(userPrompt, enhancedText);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ enhancedPrompt: enhancedText }));
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

    // Endpoint not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
