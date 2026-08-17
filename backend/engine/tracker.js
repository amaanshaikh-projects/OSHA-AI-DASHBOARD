/**
 * A lightweight SORT (Simple Online and Realtime Tracking) implementation.
 * Uses an Alpha-Beta filter (simplified Kalman) to predict object motion
 * and maintain IDs through occlusions.
 */
class AlphaBetaFilter {
    constructor(box) {
        this.w = box.x2 - box.x1;
        this.h = box.y2 - box.y1;
        this.cx = box.x1 + this.w / 2;
        this.cy = box.y1 + this.h / 2;
        
        this.vw = 0;
        this.vh = 0;
        this.vcx = 0;
        this.vcy = 0;
        
        this.alpha = 0.7; // Trust measurement
        this.beta = 0.3;  // Trust velocity change
    }
    
    predict() {
        this.cx += this.vcx;
        this.cy += this.vcy;
        this.w += this.vw;
        this.h += this.vh;
        
        if (this.w < 0.001) this.w = 0.001;
        if (this.h < 0.001) this.h = 0.001;
        
        return {
            x1: this.cx - this.w / 2,
            y1: this.cy - this.h / 2,
            x2: this.cx + this.w / 2,
            y2: this.cy + this.h / 2
        };
    }
    
    update(box) {
        const mw = box.x2 - box.x1;
        const mh = box.y2 - box.y1;
        const mcx = box.x1 + mw / 2;
        const mcy = box.y1 + mh / 2;
        
        const err_cx = mcx - this.cx;
        const err_cy = mcy - this.cy;
        const err_w = mw - this.w;
        const err_h = mh - this.h;
        
        this.cx += this.alpha * err_cx;
        this.cy += this.alpha * err_cy;
        this.w += this.alpha * err_w;
        this.h += this.alpha * err_h;
        
        this.vcx += this.beta * err_cx;
        this.vcy += this.beta * err_cy;
        this.vw += this.beta * err_w;
        this.vh += this.beta * err_h;
        
        // Dampen velocity to prevent runaway predictions
        this.vcx *= 0.9;
        this.vcy *= 0.9;
        this.vw *= 0.9;
        this.vh *= 0.9;
    }
}

class ObjectTracker {
    constructor(cameraId = 'Unknown', confirmFrames = 3, iouThreshold = 0.20, maxDisappeared = 15, maxSpatialMemory = 100) {
        this.cameraId = cameraId;
        this.confirmFrames = confirmFrames;
        this.iouThreshold = iouThreshold;
        this.maxDisappeared = maxDisappeared; // Increased to allow surviving longer occlusions
        this.maxSpatialMemory = maxSpatialMemory;
        this.nextObjectId = 1;
        this.objects = new Map(); // id -> { box, classId, label, missedFrames, age, filter, status, hitStreak, ... }
        
        // Spatial Memory for Cooldowns: id -> { box, classId, label, timestamp }
        this.spatialMemory = new Map();
        this.spatialMemoryDurationMs = 10 * 60 * 1000; // 10 minutes — generous for re-ID while preventing memory buildup
    }

    // box format: { x1, y1, x2, y2, confidence, classId, label }
    update(detections) {
        const now = Date.now();
        this.cleanupSpatialMemory(now);

        // Step 1: Predict new locations for all existing tracks
        const objectIds = Array.from(this.objects.keys());
        for (const id of objectIds) {
            const obj = this.objects.get(id);
            const predictedBox = obj.filter.predict();
            // Maintain metadata like confidence and label
            obj.box = {
                ...predictedBox,
                confidence: obj.box.confidence,
                classId: obj.classId,
                label: obj.label
            };
        }

        if (detections.length === 0) {
            for (const [id, obj] of this.objects.entries()) {
                if (obj.missedFrames === 0 && obj.status === 'CONFIRMED') {
                    console.log(`[TRACK] Camera ${this.cameraId} → Track ${id} → Temporarily lost`);
                }
                obj.missedFrames++;
                obj.status = 'LOST';
                obj.hitStreak = 0;
                obj.age++;
                if (obj.missedFrames > this.maxDisappeared) {
                    console.log(`[TRACK] Camera ${this.cameraId} → Track ${id} → END (Max missed frames)`);
                    this.moveToSpatialMemory(id, obj, now);
                    this.objects.delete(id);
                }
            }
            return this.objects;
        }

        // If no existing objects, register all detections
        if (this.objects.size === 0) {
            for (const det of detections) {
                this.register(det, now);
            }
            return this.objects;
        }

        // Step 2: Match predicted existing objects to new detections using greedy IoU
        const objectBoxes = objectIds.map(id => this.objects.get(id).box);
        const objectClasses = objectIds.map(id => this.objects.get(id).classId);

        const usedDetections = new Set();
        const usedObjectIds = new Set();

        for (let i = 0; i < objectIds.length; i++) {
            const objId = objectIds[i];
            const objBox = objectBoxes[i];
            const objClass = objectClasses[i];

            let bestIou = this.iouThreshold;
            let bestDetIdx = -1;

            for (let j = 0; j < detections.length; j++) {
                if (usedDetections.has(j)) continue;
                const det = detections[j];
                
                // Only match same class
                if (det.classId !== objClass) continue;

                const iou = this.calculateIou(objBox, det);
                if (iou > bestIou) {
                    bestIou = iou;
                    bestDetIdx = j;
                }
            }

            // Fallback: If no IoU match, check center-point distance for low FPS tracking
            if (bestDetIdx === -1) {
                let bestDist = 0.15; // Max 15% screen movement distance
                for (let j = 0; j < detections.length; j++) {
                    if (usedDetections.has(j)) continue;
                    const det = detections[j];
                    if (det.classId !== objClass) continue;

                    const dist = this.calculateCenterDistance(objBox, det);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestDetIdx = j;
                    }
                }
            }

            if (bestDetIdx !== -1) {
                // Found a match! Update filter and object
                const obj = this.objects.get(objId);
                const matchedDet = detections[bestDetIdx];
                
                if (obj.status === 'LOST') {
                    console.log(`[TRACK] Camera ${this.cameraId} → Track ${objId} → Reacquired`);
                }

                obj.filter.update(matchedDet); // Correct state with actual measurement
                obj.box = matchedDet; // Use real detection box for UI and further pipeline
                obj.missedFrames = 0;
                obj.hitStreak++;
                obj.age++;
                obj.lastSeen = now;
                obj.lastUpdated = now;
                
                if (obj.status === 'TENTATIVE' && obj.hitStreak >= this.confirmFrames) {
                    obj.status = 'CONFIRMED';
                    console.log(`[TRACK] Camera ${this.cameraId} → Track ${objId} → CONFIRMED`);
                } else if (obj.status === 'LOST') {
                    obj.status = obj.hitStreak >= this.confirmFrames ? 'CONFIRMED' : 'TENTATIVE';
                }
                
                usedDetections.add(bestDetIdx);
                usedObjectIds.add(objId);
            }
        }

        // Register new detections or resurrect from Spatial Memory
        for (let j = 0; j < detections.length; j++) {
            if (!usedDetections.has(j)) {
                const det = detections[j];
                const resurrectedId = this.findInSpatialMemory(det, now);
                
                if (resurrectedId) {
                    // Resurrect old ID!
                    console.log(`[TRACK] Camera ${this.cameraId} → Track ${resurrectedId} → Reacquired from spatial memory`);
                    this.objects.set(resurrectedId, {
                        id: resurrectedId,
                        box: det,
                        classId: det.classId,
                        label: det.label,
                        missedFrames: 0,
                        hitStreak: 1,
                        status: this.confirmFrames <= 1 ? 'CONFIRMED' : 'TENTATIVE',
                        age: 1,
                        firstSeen: now,
                        lastSeen: now,
                        lastUpdated: now,
                        filter: new AlphaBetaFilter(det),
                        get velocity() { return { x: this.filter.vcx, y: this.filter.vcy }; },
                        get center() { return { x: this.filter.cx, y: this.filter.cy }; }
                    });
                    if (this.confirmFrames <= 1) {
                        console.log(`[TRACK] Camera ${this.cameraId} → Track ${resurrectedId} → CONFIRMED`);
                    }
                    this.spatialMemory.delete(resurrectedId);
                } else {
                    this.register(det, now);
                }
            }
        }

        // Increment disappeared frames for unmatched objects
        for (const objId of objectIds) {
            if (!usedObjectIds.has(objId)) {
                const obj = this.objects.get(objId);
                if (obj.missedFrames === 0 && obj.status === 'CONFIRMED') {
                    console.log(`[TRACK] Camera ${this.cameraId} → Track ${objId} → Temporarily lost`);
                }
                obj.missedFrames++;
                obj.status = 'LOST';
                obj.hitStreak = 0;
                obj.age++;
                if (obj.missedFrames > this.maxDisappeared) {
                    console.log(`[TRACK] Camera ${this.cameraId} → Track ${objId} → END (Max missed frames)`);
                    this.moveToSpatialMemory(objId, obj, now);
                    this.objects.delete(objId);
                }
            }
        }

        return this.objects;
    }

    register(det, now) {
        console.log(`[TRACK] Camera ${this.cameraId} → New track ${this.nextObjectId} → ${det.label} (TENTATIVE)`);
        this.objects.set(this.nextObjectId, {
            id: this.nextObjectId,
            box: det,
            classId: det.classId,
            label: det.label,
            missedFrames: 0,
            hitStreak: 1,
            status: this.confirmFrames <= 1 ? 'CONFIRMED' : 'TENTATIVE',
            age: 1,
            firstSeen: now,
            lastSeen: now,
            lastUpdated: now,
            filter: new AlphaBetaFilter(det),
            get velocity() { return { x: this.filter.vcx, y: this.filter.vcy }; },
            get center() { return { x: this.filter.cx, y: this.filter.cy }; }
        });
        if (this.confirmFrames <= 1) {
            console.log(`[TRACK] Camera ${this.cameraId} → Track ${this.nextObjectId} → CONFIRMED`);
        }
        this.nextObjectId++;
    }

    moveToSpatialMemory(id, obj, now) {
        // Delete first to preserve LRU insertion order
        if (this.spatialMemory.has(id)) {
            this.spatialMemory.delete(id);
        }
        this.spatialMemory.set(id, {
            box: obj.box,
            classId: obj.classId,
            label: obj.label,
            timestamp: now
        });
    }

    findInSpatialMemory(det, now) {
        let bestIou = 0.05; // Dramatically lowered to allow resurrecting objects that moved slightly while YOLO dropped them
        let bestId = null;

        for (const [id, mem] of this.spatialMemory.entries()) {
            if (det.classId !== mem.classId) continue;
            
            const iou = this.calculateIou(det, mem.box);
            if (iou > bestIou) {
                bestIou = iou;
                bestId = id;
            }
        }

        // Fallback to center-point distance if IoU fails (common for fast movers at 1 FPS)
        if (!bestId) {
            let bestDist = 0.15; // Max 15% distance
            for (const [id, mem] of this.spatialMemory.entries()) {
                if (det.classId !== mem.classId) continue;
                const dist = this.calculateCenterDistance(det, mem.box);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestId = id;
                }
            }
        }

        return bestId;
    }

    cleanupSpatialMemory(now) {
        // 1. Time-based cleanup
        for (const [id, mem] of this.spatialMemory.entries()) {
            if (now - mem.timestamp > this.spatialMemoryDurationMs) {
                this.spatialMemory.delete(id);
            }
        }
        
        // 2. LRU Size-based cleanup (Maps preserve insertion order, oldest first)
        if (this.spatialMemory.size > this.maxSpatialMemory) {
            const numToRemove = this.spatialMemory.size - this.maxSpatialMemory;
            const keysToRemove = Array.from(this.spatialMemory.keys()).slice(0, numToRemove);
            for (const key of keysToRemove) {
                this.spatialMemory.delete(key);
            }
        }
    }

    calculateIou(box1, box2) {
        const xx1 = Math.max(box1.x1, box2.x1);
        const yy1 = Math.max(box1.y1, box2.y1);
        const xx2 = Math.min(box1.x2, box2.x2);
        const yy2 = Math.min(box1.y2, box2.y2);

        const w = Math.max(0, xx2 - xx1);
        const h = Math.max(0, yy2 - yy1);
        const intersection = w * h;
        
        const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
        const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
        
        if (area1 + area2 - intersection === 0) return 0;
        return intersection / (area1 + area2 - intersection);
    }

    calculateCenterDistance(box1, box2) {
        // Calculate the normalized distance between the centers of two boxes
        const cx1 = box1.x1 + (box1.x2 - box1.x1) / 2;
        const cy1 = box1.y1 + (box1.y2 - box1.y1) / 2;
        const cx2 = box2.x1 + (box2.x2 - box2.x1) / 2;
        const cy2 = box2.y1 + (box2.y2 - box2.y1) / 2;
        
        const dx = cx1 - cx2;
        const dy = cy1 - cy2;
        
        return Math.sqrt(dx * dx + dy * dy);
    }
}

module.exports = { ObjectTracker };
