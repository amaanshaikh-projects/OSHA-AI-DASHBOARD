const BaseAdapter = require('./BaseAdapter');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');

class RTSPAdapter extends BaseAdapter {
    constructor(cameraConfig) {
        super(cameraConfig);
        this.rtspUrl = cameraConfig.rtsp_url;
        this.username = cameraConfig.username; 
        this.password = cameraConfig.password; 

        this.frameInterval = null;
        this.ffProc = null;
        
        const safeId = String(this.id).replace(/[^a-zA-Z0-9]/g, '_');
        this.tmpDir = path.join(os.tmpdir(), 'vision-ai-frames');
        if (!fs.existsSync(this.tmpDir)) fs.mkdirSync(this.tmpDir, { recursive: true });
        this.frameFile = path.join(this.tmpDir, `frame_${safeId}.jpg`);
    }

    async connect() {
        this.status = 'Connecting';
        console.log(`[RTSPAdapter] Connecting to ${this.rtspUrl} for ${this.name}...`);

        return new Promise((resolve, reject) => {
            const args = [
                '-rtsp_flags', 'prefer_tcp',
                '-i', this.rtspUrl,
                '-vf', 'fps=1', 
                '-update', '1', 
                '-y',           
                this.frameFile
            ];

            this.ffProc = spawn(ffmpegPath, args);

            this.ffProc.on('error', (err) => {
                console.error(`[RTSPAdapter] ffmpeg error for ${this.name}:`, err.message);
                this.status = 'Error';
                reject(err);
            });

            this.ffProc.stderr.on('data', (data) => {
                const line = data.toString();
                if (line.includes('frame=')) {
                    if (this.status !== 'Online') {
                        this.status = 'Online';
                        this.resolution = '1920x1080';
                        this.fps = 1; // Backend throttling rate
                        console.log(`[RTSPAdapter] Connected to ${this.name} successfully (Headless extraction active).`);
                        resolve(true);

                        // Start polling the frame file
                        this.startPolling();
                    }
                }
            });

            this.ffProc.on('exit', (code) => {
                console.log(`[RTSPAdapter] ffmpeg exited for ${this.name} with code ${code}`);
                this.status = 'Offline';
                this.stopPolling();
            });
            
            // Timeout after 15 seconds if stream fails to start
            setTimeout(() => {
                if (this.status !== 'Online') {
                    this.disconnect();
                    reject(new Error("Timeout waiting for RTSP stream"));
                }
            }, 15000);
        });
    }
    
    startPolling() {
        this.frameInterval = setInterval(() => {
            if (this.status === 'Online' && fs.existsSync(this.frameFile)) {
                try {
                    const buffer = fs.readFileSync(this.frameFile);
                    if (buffer.length > 0) {
                        this.onFrameReceived(buffer);
                    }
                } catch (err) {
                    // File might be currently being written by ffmpeg, ignore
                }
            }
        }, 1000); // Poll once per second
    }
    
    stopPolling() {
        if (this.frameInterval) clearInterval(this.frameInterval);
        this.frameInterval = null;
    }

    async disconnect() {
        this.status = 'Offline';
        this.stopPolling();
        if (this.ffProc) {
            try { this.ffProc.kill('SIGKILL'); } catch(e) {}
            this.ffProc = null;
        }
        if (fs.existsSync(this.frameFile)) {
            try { fs.unlinkSync(this.frameFile); } catch(e) {}
        }
        console.log(`[RTSPAdapter] Disconnected ${this.name}.`);
    }
}

module.exports = RTSPAdapter;
