const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { startHealthServer } = require('./health-server.js');

const PORT = 8002;

// ============================================================================
// Media Provider Abstraction
// ============================================================================

class IMediaProvider {
    async startStream(streamId, rtspUrl) { throw new Error("Not implemented"); }
    async stopStream(streamId) { throw new Error("Not implemented"); }
    async handleRequest(req, res, urlPath) { return false; }
    async shutdown() { throw new Error("Not implemented"); }
}

class HlsLocalProvider extends IMediaProvider {
    constructor() {
        super();
        this.hlsDir = path.join(os.tmpdir(), 'vision-ai-hls');
        if (!fs.existsSync(this.hlsDir)) fs.mkdirSync(this.hlsDir, { recursive: true });
        this.activeStreams = new Map(); // streamId -> { process, dir, lastUsed }

        // Cleanup stale streams
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [id, stream] of this.activeStreams.entries()) {
                if ((stream.viewers || 0) <= 0 && now - stream.lastUsed > 30000) {
                    console.log(`[MediaServer:HLS] Cleaning up stale stream: ${id}`);
                    this.forceStopStream(id);
                } else if (now - stream.lastUsed > 120000) {
                    // Absolute fallback for zombie streams
                    console.log(`[MediaServer:HLS] Cleaning up zombie stream: ${id}`);
                    this.forceStopStream(id);
                }
            }
        }, 15000);
    }

    async startStream(streamId, rtspUrl) {
        if (this.activeStreams.has(streamId)) {
            const stream = this.activeStreams.get(streamId);
            stream.viewers = (stream.viewers || 0) + 1;
            stream.lastUsed = Date.now();
            console.log(`[MediaServer:HLS] Reusing stream ${streamId} for new viewer. Total viewers: ${stream.viewers}`);
            return `/api/hls/${streamId}/stream.m3u8`;
        }

        const streamDir = path.join(this.hlsDir, streamId);
        fs.mkdirSync(streamDir, { recursive: true });
        const m3u8Path = path.join(streamDir, 'stream.m3u8');

        const ffmpegArgs = [
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-crf', '28',
            '-sc_threshold', '0',
            '-g', '30',
            '-hls_time', '2',
            '-hls_list_size', '5',
            '-hls_flags', 'delete_segments+append_list+independent_segments',
            '-hls_segment_filename', path.join(streamDir, 'seg%03d.ts'),
            '-f', 'hls',
            '-an',
            m3u8Path
        ];

        console.log(`[MediaServer:HLS] Starting stream ${streamId} for: ${rtspUrl}`);
        const ffProc = spawn(ffmpegPath, ffmpegArgs);

        ffProc.on('error', (err) => {
            console.error(`[MediaServer:HLS] FFmpeg spawn error for stream ${streamId}:`, err.message);
        });

        ffProc.stderr.on('data', (data) => {
            const line = data.toString().trim();
            if (line.includes('frame=') || line.includes('Error') || line.includes('error') || true) { // Also print all logs to debug
                console.log(`[HLS:${streamId}] ${line.substring(0, 120)}`);
            }
        });

        ffProc.on('exit', (code) => {
            console.log(`[MediaServer:HLS] Stream ${streamId} exited with code ${code}`);
            this.activeStreams.delete(streamId);
            try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch(e) {}
        });

        this.activeStreams.set(streamId, { process: ffProc, dir: streamDir, lastUsed: Date.now(), viewers: 1 });

        // Wait for first segment
        return new Promise((resolve, reject) => {
            let waited = 0;
            const waitInterval = setInterval(() => {
                waited += 200;
                if (fs.existsSync(m3u8Path) && fs.statSync(m3u8Path).size > 0) {
                    clearInterval(waitInterval);
                    resolve(`/api/hls/${streamId}/stream.m3u8`);
                } else if (waited >= 10000) {
                    clearInterval(waitInterval);
                    this.stopStream(streamId);
                    reject(new Error('Stream did not start within 10 seconds. Check RTSP URL.'));
                }
            }, 200);
        });
    }

    async stopStream(streamId) {
        if (this.activeStreams.has(streamId)) {
            const stream = this.activeStreams.get(streamId);
            if (stream.viewers > 0) stream.viewers--;
            stream.lastUsed = Date.now(); // Reset idle timer on disconnect
            console.log(`[MediaServer:HLS] Viewer disconnected from ${streamId}. Viewers remaining: ${stream.viewers}`);
        }
    }

    async forceStopStream(streamId) {
        if (this.activeStreams.has(streamId)) {
            const stream = this.activeStreams.get(streamId);
            try { stream.process.kill('SIGKILL'); } catch(e) {}
            try { fs.rmSync(stream.dir, { recursive: true, force: true }); } catch(e) {}
            this.activeStreams.delete(streamId);
            console.log(`[MediaServer:HLS] Force stopped stream: ${streamId}`);
        }
    }

    async handleRequest(req, res, urlPath) {
        if (req.method === 'GET' && urlPath.startsWith('/api/hls/')) {
            const parts = urlPath.split('/'); // ['', 'api', 'hls', streamId, filename]
            const streamId = parts[3];
            const filename = parts[4];

            if (!streamId || !filename) return false;

            if (this.activeStreams.has(streamId)) {
                this.activeStreams.get(streamId).lastUsed = Date.now();
            }

            const filePath = path.join(this.hlsDir, streamId, filename);
            const ext = path.extname(filename);
            const contentType = ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t';

            try {
                const data = fs.readFileSync(filePath);
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache, no-store',
                });
                res.end(data);
                return true;
            } catch (err) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Segment not found', file: filename }));
                return true;
            }
        }
        return false;
    }

    async shutdown() {
        clearInterval(this.cleanupInterval);
        for (const [id] of this.activeStreams.entries()) {
            await this.forceStopStream(id);
        }
    }
}

// ============================================================================
// Media Server Implementation
// ============================================================================

// Easy to swap this out later for a WebRTC provider
const mediaProvider = new HlsLocalProvider();

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const urlPath = parsedUrl.pathname;

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    try {
        if (req.method === 'POST' && urlPath === '/api/hls/start') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const { rtspUrl, streamId } = JSON.parse(body);
                    if (!rtspUrl || !streamId) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'rtspUrl and streamId required' }));
                        return;
                    }

                    const streamUrl = await mediaProvider.startStream(streamId, rtspUrl);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ ok: true, streamUrl, streamId }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && urlPath === '/api/hls/stop') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const { streamId } = JSON.parse(body);
                    await mediaProvider.stopStream(streamId);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        const handled = await mediaProvider.handleRequest(req, res, urlPath);
        if (handled) return;

        res.writeHead(404);
        res.end('Not Found');

    } catch (err) {
        res.writeHead(500);
        res.end('Internal Server Error');
    }
});

server.listen(PORT, () => {
    console.log(`[MediaServer] Running at http://localhost:${PORT}`);
});

// Start Health Check Server
const healthServer = startHealthServer(8017, 'MediaServer', () => ({
    activeStreams: mediaProvider.activeStreams ? mediaProvider.activeStreams.size : 0
}));

// Graceful Shutdown
const shutdown = async () => {
    console.log('[MediaServer] Shutting down gracefully...');
    await mediaProvider.shutdown();
    server.close();
    healthServer.close();
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
