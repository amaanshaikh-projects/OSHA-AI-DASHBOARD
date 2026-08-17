const { getAppConfig } = require('../config.js');

class AdaptiveReverificationEngine {
    get config() {
        return getAppConfig().reverification || {
            enabled: true,
            minIntervalMs: 10000,
            stabilityWindowMs: 60000,
            movementChangeThreshold: 0.15,
            sceneChangeThreshold: 0.60,
            roiDiffThreshold: 0.25,
            highChangeThreshold: 0.60,
            lowChangeThreshold: 0.20
        };
    }

    /**
     * Determines if an object has changed meaningfully enough to warrant a Gemini reverification.
     * @param {Object} state - The current object state (includes baselineBox, lastVerificationTime, event_stability_score, etc)
     * @param {Object} currentBox - The tracker box at the current frame {x1, y1, x2, y2, label}
     * @param {Object} baselineBox - The tracker box when the object was last verified {x1, y1, x2, y2, label}
     * @param {Object} zoneEngine - The camera's ZoneEngine instance
     * @param {Object} rule - The compiled rule checking this object
     * @returns {Object} { hasMeaningfulChange: boolean, score: number, reasons: string[] }
     */
    evaluateChange(state, currentBox, baselineBox, zoneEngine, rule) {
        if (!this.config.enabled) return { hasMeaningfulChange: false, score: 0, reasons: [] };
        if (!baselineBox || !currentBox) return { hasMeaningfulChange: true, score: 1.0, reasons: ['missing_box'] };

        const now = Date.now();
        const timeSinceVerification = now - (state.lastVerificationTime || 0);

        // 1. Enforce minimum interval
        if (timeSinceVerification < this.config.minIntervalMs) {
            return { hasMeaningfulChange: false, score: 0, reasons: [] };
        }

        let score = 0;
        const reasons = [];

        // 2. Class Change (Local Tracker Flip)
        if (baselineBox.label !== (currentBox.label || baselineBox.label)) {
            reasons.push('class_label_changed');
            score += 0.8;
        }

        // 3. Movement / Velocity Change
        const diag = Math.sqrt(Math.pow(320, 2) + Math.pow(180, 2)); // Native YOLO dimensions
        
        const bCx = (baselineBox.x1 + baselineBox.x2) / 2;
        const bCy = (baselineBox.y1 + baselineBox.y2) / 2;
        const cCx = (currentBox.x1 + currentBox.x2) / 2;
        const cCy = (currentBox.y1 + currentBox.y2) / 2;

        const distance = Math.sqrt(Math.pow(cCx - bCx, 2) + Math.pow(cCy - bCy, 2));
        const movementScore = distance / diag;

        if (movementScore > this.config.movementChangeThreshold) {
            reasons.push('significant_movement');
            score += movementScore * 2; // Weight movement heavily
        }

        // 4. Bounding Box Scaling (Z-axis / Distance change)
        const bArea = (baselineBox.x2 - baselineBox.x1) * (baselineBox.y2 - baselineBox.y1);
        const cArea = (currentBox.x2 - currentBox.x1) * (currentBox.y2 - currentBox.y1);
        if (bArea > 0 && cArea > 0) {
            const scaleChange = Math.abs(cArea - bArea) / bArea;
            // YOLO boxes jitter significantly. Require at least 50% area change and reduce its score weight.
            if (scaleChange > 0.5) { 
                reasons.push('scale_change');
                score += (scaleChange * 0.5);
            }
        }

        // 5. Zone Transitions (Rule-Aware)
        // If the rule cares about zones, check if we crossed a zone boundary since the baseline
        if (rule.local_conditions.zones && rule.local_conditions.zones.length > 0) {
            const trackId = state.id;
            let transitioned = false;
            for (const zoneId of rule.local_conditions.zones) {
                const lastEvent = zoneEngine.getLastEvent(trackId, zoneId);
                // If it recently entered or exited, and that event happened AFTER our last verification
                // We use lastTriggerTime to check if the spatial event is fresh
                const zoneState = zoneEngine.trackerStates.get(`${trackId}_${zoneId}`);
                if (zoneState && zoneState.lastTriggerTime > state.lastVerificationTime) {
                    transitioned = true;
                    reasons.push(`zone_transition_${zoneState.lastEvent}`);
                    break;
                }
            }
            if (transitioned) {
                score += 0.9;
            }
        }

        // 6. Object Interaction (Rule-Aware)
        // If the rule has semantic conditions, new objects entering the object's vicinity matter.
        // For simplicity, this requires global state awareness, but we can assume movement/scale catches
        // most of the visual changes for interactions. To do true proximity, we'd need all tracked objects.
        
        // 7. Adaptive Threshold based on Stability
        let threshold = this.config.highChangeThreshold;
        
        // If object has been stationary/stable for a long time, we decrease sensitivity (increase threshold)
        const stabilityDuration = now - state.firstVerifiedTime; 
        if (stabilityDuration > this.config.stabilityWindowMs) {
            threshold = threshold * 1.5; // Requires 50% more change to trigger
        }
        
        // If it's a Rejected state, we want to be more sensitive to changes (lower threshold)
        if (state.status === 'Rejected') {
            threshold = this.config.lowChangeThreshold;
        }

        const hasMeaningfulChange = score >= threshold;

        return { hasMeaningfulChange, score, reasons };
    }
}

module.exports = new AdaptiveReverificationEngine();
