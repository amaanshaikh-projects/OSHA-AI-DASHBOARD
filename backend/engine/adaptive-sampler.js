class AdaptiveFrameController {
    constructor(cameraId, config = {}) {
        this.cameraId = cameraId;
        this.config = {
            IDLE_FPS: 1,
            MOTION_FPS: 3,
            ACTIVE_BURST_FPS: 10,
            TRACKING_FPS: 5,
            STABILIZING_FPS: 3,
            ACTIVE_BURST_DURATION_MS: 2000,
            IDLE_RETURN_DELAY_MS: 5000,
            STABILITY_WINDOW_MS: 3000,
            MOVEMENT_THRESHOLD: 0.15, // Track velocity above this triggers a burst
            ...config
        };

        this.state = 'IDLE';
        this.stateStartTime = Date.now();
        this.lastTrackIds = new Set();
        this.stableStartTime = 0;
        this.lastMotionTime = 0;
    }

    /**
     * Determine the optimal FPS based on the current scene state.
     * @param {Object} inputs - { hasMotion: boolean, activeTracks: Map, activeEvents: boolean }
     */
    getTargetFPS(inputs) {
        const now = Date.now();
        const { hasMotion, activeTracks, activeEvents } = inputs;

        if (hasMotion) {
            this.lastMotionTime = now;
        }

        // 1. Analyze tracking state
        let hasNewTrack = false;
        let hasSignificantMovement = false;
        let hasTracks = activeTracks && activeTracks.size > 0;
        
        const currentTrackIds = new Set();

        if (hasTracks) {
            for (const [id, track] of activeTracks.entries()) {
                currentTrackIds.add(id);
                // Check if it's a new track (not in our last known set)
                // Note: we only care about CONFIRMED or TENTATIVE tracks appearing.
                // The tracker registers them as tentative immediately, which is good enough to burst.
                if (!this.lastTrackIds.has(id)) {
                    hasNewTrack = true;
                }
                
                // Check velocity/movement
                if (track.velocity) {
                    const speed = Math.sqrt(track.velocity.x ** 2 + track.velocity.y ** 2);
                    if (speed > this.config.MOVEMENT_THRESHOLD) {
                        hasSignificantMovement = true;
                    }
                }
            }
        }

        this.lastTrackIds = currentTrackIds;

        // 2. State Machine Transitions
        let nextState = this.state;
        const timeInState = now - this.stateStartTime;

        // Global Overrides for high-priority events
        if (hasNewTrack || hasSignificantMovement) {
            nextState = 'ACTIVE_EVENT';
        } else {
            switch (this.state) {
                case 'IDLE':
                    if (hasMotion) {
                        nextState = 'MOTION';
                    }
                    break;

                case 'MOTION':
                    // If motion stops and delay passes, go back to IDLE
                    if (!hasMotion && now - this.lastMotionTime > this.config.IDLE_RETURN_DELAY_MS) {
                        nextState = 'IDLE';
                    }
                    // Transition to ACTIVE_EVENT is handled by global overrides if a track is found.
                    break;

                case 'ACTIVE_EVENT':
                    // Burst duration expires
                    if (timeInState > this.config.ACTIVE_BURST_DURATION_MS) {
                        if (hasTracks || activeEvents) {
                            nextState = 'TRACKING';
                        } else if (hasMotion) {
                            nextState = 'MOTION';
                        } else {
                            nextState = 'STABILIZING';
                        }
                    }
                    break;

                case 'TRACKING':
                    if (!hasTracks && !activeEvents) {
                        nextState = 'STABILIZING';
                    } else if (hasTracks || activeEvents) {
                        // Are we stable? (No new tracks, low movement -> handled by lack of global overrides)
                        if (this.stableStartTime === 0) {
                            this.stableStartTime = now;
                        } else if (now - this.stableStartTime > this.config.STABILITY_WINDOW_MS) {
                            nextState = 'STABILIZING';
                        }
                    }
                    break;

                case 'STABILIZING':
                    if (hasMotion && !hasTracks && !activeEvents) {
                        nextState = 'MOTION';
                    }
                    
                    // Allow return to IDLE if completely quiet
                    if (!hasMotion && !hasTracks && !activeEvents && (now - this.lastMotionTime > this.config.IDLE_RETURN_DELAY_MS)) {
                        nextState = 'IDLE';
                    }
                    break;
            }
        }

        // Reset stability timer if we leave TRACKING/STABILIZING or if there's significant movement
        if (hasNewTrack || hasSignificantMovement || (nextState !== 'TRACKING' && nextState !== 'STABILIZING')) {
            this.stableStartTime = 0;
        }

        // Perform Transition
        if (nextState !== this.state) {
            const fps = this.getFPSForState(nextState);
            
            // Generate user-friendly transition reason logs
            let reason = '';
            if (nextState === 'MOTION') reason = 'Motion detected';
            else if (nextState === 'ACTIVE_EVENT' && hasNewTrack) reason = 'New track detected';
            else if (nextState === 'ACTIVE_EVENT' && hasSignificantMovement) reason = 'Significant movement';
            else if (nextState === 'TRACKING') reason = 'Burst complete';
            else if (nextState === 'STABILIZING') reason = 'Scene stable';
            else if (nextState === 'IDLE') reason = 'Scene idle';

            console.log(`[SAMPLER] Camera ${this.cameraId} → ${reason || 'State changed'} (${this.state} → ${nextState}) → ${fps} FPS`);
            
            this.state = nextState;
            this.stateStartTime = now;
        }

        return this.getFPSForState(this.state);
    }

    getFPSForState(state) {
        switch (state) {
            case 'IDLE': return this.config.IDLE_FPS;
            case 'MOTION': return this.config.MOTION_FPS;
            case 'ACTIVE_EVENT': return this.config.ACTIVE_BURST_FPS;
            case 'TRACKING': return this.config.TRACKING_FPS;
            case 'STABILIZING': return this.config.STABILIZING_FPS;
            default: return this.config.IDLE_FPS;
        }
    }
}

module.exports = { AdaptiveFrameController };
