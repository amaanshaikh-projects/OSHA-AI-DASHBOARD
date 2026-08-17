const RTSPAdapter = require('./adapters/RTSPAdapter');
const http = require('http');
const EventEmitter = require('events');

/**
 * Camera Manager Service
 * Orchestrates camera connections, health checks, and pushes frames to the detection engine.
 */
class CameraManager extends EventEmitter {
    constructor(detectionEngineUrl) {
        super();
        this.detectionEngineUrl = detectionEngineUrl || 'http://localhost:8001/api/engine/analyze-frame';
        this.activeCameras = new Map(); // id -> adapter instance
        this.lastPushTimes = new Map(); // id -> timestamp
        this.pushInProgress = new Map(); // id -> boolean
        
        // Start health monitoring loop
        this.monitorInterval = setInterval(() => this.monitorCameras(), 10000);
    }

    /**
     * Factory method to create and connect a camera based on its config.
     */
    async addCamera(config) {
        if (this.activeCameras.has(config.id)) {
            console.warn(`[CameraManager] Camera ${config.id} is already connected.`);
            return false;
        }

        let adapter = null;
        if (config.connectionType === 'rtsp') {
            adapter = new RTSPAdapter(config);
        } else {
            throw new Error(`Unsupported connection type: ${config.connectionType}`);
        }

        // Bind frame callback to push to engine
        adapter.setFrameCallback((id, frameBuffer) => this.pushFrameToEngine(id, frameBuffer));

        try {
            await adapter.connect();
            this.activeCameras.set(config.id, adapter);
            this.lastPushTimes.set(config.id, 0);
            this.emit('cameraStateChanged', { id: config.id, status: adapter.status });
            return true;
        } catch (e) {
            console.error(`[CameraManager] Failed to connect camera ${config.id}:`, e);
            this.emit('cameraStateChanged', { id: config.id, status: 'Error' });
            return false;
        }
    }

    async removeCamera(id) {
        if (!this.activeCameras.has(id)) return;
        const adapter = this.activeCameras.get(id);
        await adapter.disconnect();
        this.activeCameras.delete(id);
        this.lastPushTimes.delete(id);
        this.pushInProgress.delete(id);
        this.emit('cameraStateChanged', { id, status: 'Offline' });
    }

    /**
     * Monitors cameras and automatically reconnects them if they drop
     */
    async monitorCameras() {
        for (const [id, adapter] of this.activeCameras.entries()) {
            if (adapter.status === 'Offline' || adapter.status === 'Error') {
                console.log(`[CameraManager] 🔄 Camera ${id} is offline. Attempting to reconnect...`);
                this.emit('cameraStateChanged', { id, status: 'Reconnecting' });
                try {
                    await adapter.connect();
                    this.emit('cameraStateChanged', { id, status: adapter.status });
                } catch (e) {
                    console.error(`[CameraManager] ❌ Reconnect failed for ${id}:`, e.message);
                }
            }
        }
    }

    getHealthReport() {
        const report = [];
        for (const [id, adapter] of this.activeCameras.entries()) {
            report.push(adapter.getHealth());
        }
        return report;
    }

    /**
     * Dispatches frames to the standalone Detection Engine with throttling
     */
    pushFrameToEngine(cameraId, frameBuffer) {
        const adapter = this.activeCameras.get(cameraId);
        if (!adapter) return;

        // 1. Throttling: Max 1 frame per second
        const now = Date.now();
        const lastPush = this.lastPushTimes.get(cameraId) || 0;
        if (now - lastPush < 1000) {
            return; // Skip this frame
        }

        // 2. Throttling: Do not send if previous HTTP request is still pending
        if (this.pushInProgress.get(cameraId)) {
            return; // Skip to avoid choking the engine
        }

        this.lastPushTimes.set(cameraId, now);
        this.pushInProgress.set(cameraId, true);

        const payload = JSON.stringify({
            cameraId: adapter.id,
            cameraName: adapter.name,
            promptText: adapter.config.prompt,
            userId: adapter.config.user_id,
            frameBase64: frameBuffer.toString('base64')
        });

        const req = http.request(this.detectionEngineUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        });

        req.on('response', (res) => {
            res.resume(); // consume response data to free up memory
            res.on('end', () => {
                this.pushInProgress.set(cameraId, false);
            });
        });

        req.on('error', (e) => {
            console.error(`[CameraManager] Failed to push frame to engine for ${cameraId}:`, e.message);
            this.pushInProgress.set(cameraId, false);
        });

        req.write(payload);
        req.end();
    }
}

module.exports = CameraManager;
