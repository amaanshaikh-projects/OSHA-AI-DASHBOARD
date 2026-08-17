class ZoneEngine {
    constructor() {
        this.zones = new Map(); // zoneId -> zone config
        this.trackerStates = new Map(); // trackerId_zoneId -> { state, insideFrames, outsideFrames, lastTriggerTime }
        
        // Hysteresis config
        this.ENTER_THRESHOLD = 3;
        this.EXIT_THRESHOLD = 3;
    }

    /**
     * Load zones for the current camera.
     * @param {Array} zonesList - Array of zone objects from the database
     */
    loadZones(zonesList) {
        this.zones.clear();
        for (const zone of zonesList) {
            if (zone.enabled === false) continue;
            if (zone.type !== 'polygon') continue; // Only polygon supported for now
            if (!Array.isArray(zone.coordinates) || zone.coordinates.length < 3) {
                console.warn(`[ZoneEngine] Ignoring invalid zone ${zone.id}: requires >= 3 points`);
                continue;
            }
            this.zones.set(zone.id, {
                id: zone.id,
                name: zone.name,
                version: zone.version,
                polygon: zone.coordinates // [{x, y}, {x, y}, ...] in normalized 0-1 scale
            });
        }
        console.log(`[ZoneEngine] Loaded ${this.zones.size} active zones.`);
    }

    /**
     * Calculate the anchor point for a given bounding box.
     * Default is BOTTOM_CENTER which is best for security cameras.
     * Box coordinates are assumed to be in 0-320x180 scaled YOLO space, or whatever the camera frame uses.
     */
    getNormalizedAnchor(box, nativeWidth = 320, nativeHeight = 180, anchorType = 'BOTTOM_CENTER') {
        const x1 = box.x1;
        const y1 = box.y1;
        const x2 = box.x2;
        const y2 = box.y2;
        
        let cx, cy;
        
        switch (anchorType) {
            case 'CENTER':
                cx = (x1 + x2) / 2;
                cy = (y1 + y2) / 2;
                break;
            case 'TOP_CENTER':
                cx = (x1 + x2) / 2;
                cy = y1;
                break;
            case 'BOTTOM_CENTER':
            default:
                cx = (x1 + x2) / 2;
                cy = y2;
                break;
        }

        return {
            x: Math.max(0, Math.min(1, cx / nativeWidth)),
            y: Math.max(0, Math.min(1, cy / nativeHeight))
        };
    }

    /**
     * Ray-casting algorithm for point-in-polygon.
     */
    isPointInPolygon(point, polygon) {
        let isInside = false;
        let i, j;
        for (i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;
            
            const intersect = ((yi > point.y) !== (yj > point.y))
                && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
            if (intersect) isInside = !isInside;
        }
        return isInside;
    }

    /**
     * Updates the state of all tracked objects relative to all zones.
     * Call this every frame after tracker update.
     * @param {Map} activeTracks - from tracker.objects
     * @param {Number} nativeWidth - Width of the YOLO frame (e.g. 320)
     * @param {Number} nativeHeight - Height of the YOLO frame (e.g. 180)
     */
    updateStates(activeTracks, nativeWidth = 320, nativeHeight = 180) {
        // We only care about tracking active ones. Lost tracks will simply stop updating,
        // and eventually drop out of trackerStates when we clean up.
        
        const now = Date.now();
        
        for (const [trackId, obj] of activeTracks.entries()) {
            if (!obj.box || obj.disappearedFrames > 0) continue;
            
            const anchor = this.getNormalizedAnchor(obj.box, nativeWidth, nativeHeight);
            
            for (const [zoneId, zone] of this.zones.entries()) {
                const stateKey = `${trackId}_${zoneId}`;
                let state = this.trackerStates.get(stateKey);
                
                if (!state) {
                    state = {
                        status: 'OUTSIDE', // OUTSIDE | INSIDE
                        insideFrames: 0,
                        outsideFrames: 0,
                        lastEvent: null,
                        lastTriggerTime: 0
                    };
                    this.trackerStates.set(stateKey, state);
                }
                
                const isCurrentlyInside = this.isPointInPolygon(anchor, zone.polygon);
                
                // Clear the opposite counter
                if (isCurrentlyInside) {
                    state.outsideFrames = 0;
                    state.insideFrames++;
                } else {
                    state.insideFrames = 0;
                    state.outsideFrames++;
                }
                
                // State transitions with hysteresis
                if (state.status === 'OUTSIDE' && state.insideFrames >= this.ENTER_THRESHOLD) {
                    state.status = 'INSIDE';
                    state.lastEvent = 'ENTER_ZONE';
                    state.lastTriggerTime = now;
                    // console.log(`[ZoneEngine] Track ${trackId} ENTERED zone ${zone.name}`);
                } else if (state.status === 'INSIDE' && state.outsideFrames >= this.EXIT_THRESHOLD) {
                    state.status = 'OUTSIDE';
                    state.lastEvent = 'EXIT_ZONE';
                    state.lastTriggerTime = now;
                    // console.log(`[ZoneEngine] Track ${trackId} EXITED zone ${zone.name}`);
                } else if (state.status === 'INSIDE') {
                    state.lastEvent = 'REMAINS_IN_ZONE';
                } else {
                    state.lastEvent = 'OUTSIDE_ZONE';
                }
            }
        }
    }

    /**
     * Cleans up states for objects that are no longer tracked.
     */
    cleanup(activeTrackIds) {
        const idSet = new Set(activeTrackIds);
        for (const key of this.trackerStates.keys()) {
            const trackId = key.split('_')[0];
            if (!idSet.has(trackId) && !idSet.has(parseInt(trackId, 10))) {
                this.trackerStates.delete(key);
            }
        }
    }

    /**
     * Returns whether the track is currently considered INSIDE the zone.
     */
    isInside(trackId, zoneId) {
        const state = this.trackerStates.get(`${trackId}_${zoneId}`);
        return state ? state.status === 'INSIDE' : false;
    }

    /**
     * Returns the last spatial event (ENTER_ZONE, EXIT_ZONE, etc.) for the track + zone.
     */
    getLastEvent(trackId, zoneId) {
        const state = this.trackerStates.get(`${trackId}_${zoneId}`);
        return state ? state.lastEvent : null;
    }

    getZone(zoneId) {
        return this.zones.get(zoneId);
    }
}

module.exports = ZoneEngine;
