/**
 * Base Adapter Interface for Universal Camera Connection System.
 * Every specific camera integration must extend this base class.
 */
class BaseAdapter {
    constructor(cameraConfig) {
        this.id = cameraConfig.id;
        this.name = cameraConfig.name;
        this.location = cameraConfig.location || 'Unknown';
        this.config = cameraConfig;
        
        this.status = 'Idle'; // Idle, Connecting, Online, Offline, Error
        this.lastFrameTime = 0;
        this.resolution = 'Unknown';
        this.fps = 0;
    }

    /**
     * Initializes the connection to the camera.
     * @returns {Promise<boolean>} True if successful.
     */
    async connect() {
        throw new Error("Method 'connect()' must be implemented by subclass");
    }

    /**
     * Gracefully disconnects the camera stream.
     * @returns {Promise<void>}
     */
    async disconnect() {
        throw new Error("Method 'disconnect()' must be implemented by subclass");
    }

    /**
     * Retrieves the current health and metadata of the stream.
     * @returns {Object} Health metrics (latency, status, etc)
     */
    getHealth() {
        return {
            id: this.id,
            status: this.status,
            lastFrameTime: this.lastFrameTime,
            resolution: this.resolution,
            fps: this.fps
        };
    }

    /**
     * Called by the adapter internally when a new frame is received.
     * Passes the frame up to the Camera Manager.
     */
    onFrameReceived(frameBuffer) {
        this.lastFrameTime = Date.now();
        if (this.onFrameCallback) {
            this.onFrameCallback(this.id, frameBuffer);
        }
    }

    /**
     * Registers a callback to receive frames.
     */
    setFrameCallback(callback) {
        this.onFrameCallback = callback;
    }
}

module.exports = BaseAdapter;
