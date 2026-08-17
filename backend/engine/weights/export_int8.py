from ultralytics import YOLO
import sys

try:
    print("Loading YOLOv8n model...")
    model = YOLO("yolov8n.pt")
    print("Exporting to ONNX INT8 with imgsz=480, dynamic=True...")
    # INT8 export automatically uses coco128 or coco8 for calibration if data is not provided
    model.export(format="onnx", int8=True, imgsz=480, dynamic=True)
    print("Export successful!")
except Exception as e:
    print(f"Export failed: {e}")
    sys.exit(1)
