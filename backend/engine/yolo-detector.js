const ort = require('onnxruntime-node');
const sharp = require('sharp');
sharp.cache(false); // Disable sharp cache to prevent memory leaks from unique frames
const path = require('path');
const os = require('os');

// Common COCO classes (for YOLOv8 trained on COCO)
const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed',
  'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven',
  'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
];

class YoloDetector {
    constructor(modelPath, poolSize = 3) {
        this.modelPath = modelPath || path.join(__dirname, 'weights', 'yolov8n_int8.onnx');
        this.poolSize = poolSize;
        this.sessions = [];
        this.nextSessionIdx = 0;
        this.initializing = false;
    }

    async init() {
        if (this.sessions.length > 0 || this.initializing) return;
        this.initializing = true;
        try {
            console.log(`[YOLO] Loading model pool (size: ${this.poolSize}) from ${this.modelPath}`);
            // Node.js is asynchronous, and multiple YOLO sessions across all cores causes massive context switching.
            // For CPU inference, keeping threads restricted (e.g., 2) per session is faster and more stable under load.
            const threadsPerSession = 2;

            // Force CPU execution as requested
            const providers = ['cpu'];

            for (let i = 0; i < this.poolSize; i++) {
                const session = await ort.InferenceSession.create(this.modelPath, {
                    executionProviders: providers,
                    graphOptimizationLevel: 'all',
                    intraOpNumThreads: threadsPerSession,
                    interOpNumThreads: 1, // Usually 1 is best for sequential models like YOLO
                    enableCpuMemArena: true,
                    enableMemPattern: true
                });
                const floatBuffer = new Float32Array(3 * 640 * 640);
                this.sessions.push({ session, floatBuffer });
            }
            console.log(`[YOLO] Model pool loaded successfully. ${this.poolSize} sessions initialized.`);
        } catch (e) {
            console.error('[YOLO] Failed to load model pool:', e.message);
        }
        this.initializing = false;
    }

    async detect(imageBuffer) {
        if (this.sessions.length === 0) await this.init();
        if (this.sessions.length === 0) {
            console.warn('[YOLO] Running in mocked mode (no valid model pool loaded). Returning simulated box.');
            // Return a dummy box to test the Gemini pipeline without a valid model
            return [{
                x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9,
                confidence: 0.85,
                classId: 16, // 'dog'
                label: 'dog'
            }];
        }

        try {
            const image = sharp(imageBuffer);
            const metadata = await image.metadata();
            const origW = metadata.width || 640;
            const origH = metadata.height || 640;


            const targetSize = 640;
            const scale = Math.min(targetSize / origW, targetSize / origH);
            const newW = origW * scale;
            const newH = origH * scale;
            const padX = (targetSize - newW) / 2;
            const padY = (targetSize - newH) / 2;

            // Resize image to 480x480 with letterbox padding (YOLO default gray)
            const { data, info } = await image
                .resize(targetSize, targetSize, { 
                    fit: 'contain',
                    background: { r: 114, g: 114, b: 114, alpha: 1 } 
                })
                .removeAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });

            // Select session via round-robin early to reuse its float buffer
            const sessionObj = this.sessions[this.nextSessionIdx];
            const session = sessionObj.session || sessionObj;
            this.nextSessionIdx = (this.nextSessionIdx + 1) % this.poolSize;

            // Normalize pixels [0, 255] -> [0, 1] and HWC -> CHW
            const float32Data = sessionObj.floatBuffer || new Float32Array(3 * targetSize * targetSize);
            for (let i = 0; i < targetSize * targetSize; i++) {
                float32Data[i] = data[i * 3] / 255.0;           // R
                float32Data[i + targetSize * targetSize] = data[i * 3 + 1] / 255.0;   // G
                float32Data[i + 2 * targetSize * targetSize] = data[i * 3 + 2] / 255.0; // B
            }

            const tensor = new ort.Tensor('float32', float32Data, [1, 3, targetSize, targetSize]);
            
            // Run inference
            const results = await session.run({ images: tensor });
            const output = results.output0.data; // Output shape is [1, 84, 8400] for YOLOv8
            
            // Parse results and map boxes back from letterboxed space
            return this.parseOutput(output, targetSize, targetSize, padX, padY, newW, newH);
        } catch (e) {
            console.error('[YOLO] Detection error:', e.message);
            return [];
        }
    }

    parseOutput(output, width, height, padX = 0, padY = 0, newW = width, newH = height) {
        const boxes = [];
        const numClasses = 80; // COCO
        // Dynamically compute YOLOv8 anchors based on input size
        const numAnchors = Math.pow(width / 8, 2) + Math.pow(width / 16, 2) + Math.pow(width / 32, 2);

        // The output array is flat: 84 rows * 8400 columns
        for (let col = 0; col < numAnchors; col++) {
            let maxScore = 0;
            let classId = -1;

            // Find class with highest score for this anchor
            for (let c = 0; c < numClasses; c++) {
                const score = output[(c + 4) * numAnchors + col];
                if (score > maxScore) {
                    maxScore = score;
                    classId = c;
                }
            }

            // Threshold - filter out low-confidence noise/clutter
            if (maxScore > 0.35) { // Confidence threshold tuned for precise detection
                // xywh
                const xc = output[0 * numAnchors + col];
                const yc = output[1 * numAnchors + col];
                const w = output[2 * numAnchors + col];
                const h = output[3 * numAnchors + col];

                const x1 = xc - w / 2;
                const y1 = yc - h / 2;
                const x2 = xc + w / 2;
                const y2 = yc + h / 2;

                // Remove letterbox padding and normalize relative to original image
                const normX1 = Math.max(0, Math.min(1, (x1 - padX) / newW));
                const normY1 = Math.max(0, Math.min(1, (y1 - padY) / newH));
                const normX2 = Math.max(0, Math.min(1, (x2 - padX) / newW));
                const normY2 = Math.max(0, Math.min(1, (y2 - padY) / newH));

                boxes.push({
                    x1: normX1,
                    y1: normY1,
                    x2: normX2,
                    y2: normY2,
                    confidence: maxScore,
                    classId,
                    label: COCO_CLASSES[classId]
                });
            }
        }

        // Apply Non-Maximum Suppression (NMS) - 0.35 IoU to collapse overlapping duplicate boxes
        return this.nms(boxes, 0.35);
    }

    nms(boxes, iouThreshold) {
        boxes.sort((a, b) => b.confidence - a.confidence);
        const result = [];
        const removed = new Set();

        for (let i = 0; i < boxes.length; i++) {
            if (removed.has(i)) continue;
            const box1 = boxes[i];
            result.push(box1);

            for (let j = i + 1; j < boxes.length; j++) {
                if (removed.has(j)) continue;
                const box2 = boxes[j];
                
                // If IoU is high between same class or overlapping candidate boxes, suppress lower confidence box
                const xx1 = Math.max(box1.x1, box2.x1);
                const yy1 = Math.max(box1.y1, box2.y1);
                const xx2 = Math.min(box1.x2, box2.x2);
                const yy2 = Math.min(box1.y2, box2.y2);

                const w = Math.max(0, xx2 - xx1);
                const h = Math.max(0, yy2 - yy1);
                const intersection = w * h;
                
                const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
                const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
                
                const iou = intersection / (area1 + area2 - intersection);
                
                // Suppress overlapping boxes for same class or heavy IoU overlap (>0.70) across different classes
                if ((box1.classId === box2.classId && iou > iouThreshold) || (iou > 0.70)) {
                    removed.add(j);
                }
            }
        }

        return result;
    }
}

module.exports = { YoloDetector, COCO_CLASSES };
