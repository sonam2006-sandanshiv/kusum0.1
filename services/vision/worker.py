#!/usr/bin/env python3
"""
Kusum vision worker (prototype).

Pulls one camera's RTSP feed and, per frame:
  1. Detects ALL beds in the ward with a YOLO model (every box above threshold is
     kept -- not just the top one, which is what causes the "only one bed" bug).
  2. Classifies each frame with GantMan/nsfw_model; likely explicit frames are
     blurred server-side before any staff or guardian stream is published.
  3. Publishes the safe stream (`<camera>_blurred`) and one strict cropped
     sub-stream per approved patient (`patient_<id>`) -- guardians only ever
     receive pixels from inside their own bed's bounding box.

Fail-closed: if a detector is unavailable or errors, the ENTIRE frame is blurred
for a cooldown period instead of passing video through unblurred.

Also serves a tiny HTTP API on :5600:
  GET /beds?camera=room_1  -> {beds:[{x,y,w,h,conf}]}   (normalized, from the
                            latest raw frame; used by the dashboard as
                            click-to-assign suggestions for staff)

Usage:
  python worker.py --camera room_1 --mock          # empty-scene demo, no classifier
  python worker.py --camera room_1 --model         # GantMan NSFW classifier
Env: MEDIA_SECRET (publish secret, default devmedia), BED_MODEL (path to .pt)
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import cv2
import numpy as np

DET_EVERY = 5          # run detectors every N frames
HOLD_FRAMES = 25       # keep blur active for N frames after last detection (~1s)
FAIL_COOLDOWN = 150    # seconds of full-frame blur after a detector error
CROP_W, CROP_H = 640, 360
BED_CONF = 0.10        # lower threshold keeps the smaller beds in the supplied still image
MEDIA_HOST = os.environ.get("MEDIA_HOST", "127.0.0.1")


def http_json(url, secret=None, timeout=4):
    req = urllib.request.Request(url)
    if secret:
        req.add_header("X-Internal-Secret", secret)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


class FFmpegOut:
    """Pipes raw BGR frames into ffmpeg and publishes to an RTSP path."""

    def __init__(self, url, width, height, fps, secret):
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
            "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
            "-g", str(fps * 2), "-pix_fmt", "yuv420p",
            "-f", "rtsp", "-rtsp_transport", "tcp", url,
        ]
        env = dict(os.environ, SOURCE_PASSWORD=secret)
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, env=env)
        self.size = (width, height)

    def write(self, frame):
        if frame.shape[1] != self.size[0] or frame.shape[0] != self.size[1]:
            frame = cv2.resize(frame, self.size)
        try:
            self.p.stdin.write(frame.tobytes())
        except (BrokenPipeError, OSError):
            pass

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=3)
        except Exception:
            self.p.kill()


def make_nudity_detector(mode, model_path):
    if mode == "mock":
        # Demo-only passthrough: never invent a blur box over empty scene areas.
        return lambda frame: []
    try:
        # GantMan's H5 model uses TF Hub KerasLayer; TF 2.16 needs legacy Keras.
        os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")
        import tensorflow as tf
        import tensorflow_hub as hub
        model = tf.keras.models.load_model(
            model_path, custom_objects={"KerasLayer": hub.KerasLayer}, compile=False)
    except Exception as e:
        print(f"[vision] GantMan NSFW model unavailable ({e}) -> FAIL-CLOSED full blur", file=sys.stderr)
        return "fail"
    labels = ("drawings", "hentai", "neutral", "porn", "sexy")

    def detect(frame):
        # The linked model is an image classifier, not an object detector. It
        # returns scene-level class scores, so blur the entire frame on a hit
        # instead of painting an unrelated rectangle over a guessed location.
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = cv2.resize(rgb, (224, 224), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
        scores = model.predict(np.expand_dims(image, axis=0), verbose=0)[0]
        probs = dict(zip(labels, [float(v) for v in scores]))
        if probs["porn"] >= 0.55 or probs["hentai"] >= 0.55 or probs["sexy"] >= 0.85:
            h, w = frame.shape[:2]
            return [[0, 0, w, h]]
        return []
    return detect


class BedDetector:
    """YOLO bed detection. Keeps EVERY box above BED_CONF (fixes the
    single-bed issue: never take only the top-scoring detection)."""

    def __init__(self, model_path, imgsz=1280):
        self.ok = False
        self.imgsz = imgsz
        try:
            from ultralytics import YOLO
        except Exception as e:
            print(f"[vision] ultralytics unavailable ({e}); bed suggestions disabled", file=sys.stderr)
            return
        self.model = YOLO(model_path)
        self.ok = True
        print(f"[vision] bed model loaded: {model_path}")

    def detect(self, frame):
        """Detect whole frame and overlapping tiles to recover smaller beds."""
        if not self.ok:
            return []
        h, w = frame.shape[:2]
        try:
            fh, fw = frame.shape[:2]
            sx, sy = max(1, int(fw * 0.60)), max(1, int(fh * 0.65))
            xs = sorted(set([0, max(0, fw - sx)]))
            ys = sorted(set([0, max(0, fh - sy)]))
            regions = [(0, 0, frame)]
            regions.extend((x, y, frame[y:min(fh, y + sy), x:min(fw, x + sx)]) for y in ys for x in xs)
            candidates = []
            for ox, oy, crop in regions:
                res = self.model.predict(crop, conf=BED_CONF, imgsz=self.imgsz, iou=0.45, verbose=False)[0]
                for b in res.boxes:
                    x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
                    candidates.append((max(0, x1 + ox), max(0, y1 + oy), min(fw, x2 + ox), min(fh, y2 + oy), float(b.conf[0])))
        except Exception as e:
            print(f"[vision] bed model error: {e}", file=sys.stderr)
            return []
        if not candidates:
            return []
        indices = cv2.dnn.NMSBoxes([[int(x1), int(y1), max(1, int(x2-x1)), max(1, int(y2-y1))]
                                    for x1, y1, x2, y2, _ in candidates],
                                   [c[4] for c in candidates], BED_CONF, 0.45)
        if indices is None or len(indices) == 0:
            return []
        out = []
        for i in [int(i) for i in np.array(indices).reshape(-1)]:
            x1, y1, x2, y2, conf = candidates[i]
            out.append({
                "x": max(0.0, x1 / w), "y": max(0.0, y1 / h),
                "w": min(1.0, (x2 - x1) / w), "h": min(1.0, (y2 - y1) / h),
                "conf": conf,
            })
        return out


def blur_regions(frame, boxes):
    h, w = frame.shape[:2]
    for x, y, bw, bh in boxes:
        x, y = max(0, int(x)), max(0, int(y))
        bw, bh = min(w - x, int(bw)), min(h - y, int(bh))
        if bw <= 1 or bh <= 1:
            continue
        roi = frame[y:y + bh, x:x + bw]
        frame[y:y + bh, x:x + bw] = cv2.GaussianBlur(roi, (0, 0), 30)
    return frame


class CropManager:
    """Keeps one ffmpeg publisher per approved patient bbox; syncs from the API."""

    def __init__(self, api, secret, fps):
        self.api, self.secret, self.fps = api, secret, fps
        self.crops = {}  # stream -> (camera_id, bbox, FFmpegOut)

    def sync(self, camera_id):
        try:
            data = http_json(f"{self.api}/internal/crops", self.secret)
        except Exception as e:
            print(f"[vision] crop sync failed: {e}", file=sys.stderr)
            return
        wanted = {
            c["stream"]: (c["camera_id"], c["bbox"])
            for c in data["crops"] if c["camera_id"] == camera_id
        }
        for stream in list(self.crops):
            if stream not in wanted:
                self.crops[stream][2].close()
                del self.crops[stream]
                print(f"[vision] stopped crop {stream}")
        for stream, (cam, bbox) in wanted.items():
            if stream not in self.crops:
                out = FFmpegOut(f"rtsp://publish:{self.secret}@{MEDIA_HOST}:8554/{stream}",
                                CROP_W, CROP_H, self.fps, self.secret)
                self.crops[stream] = (cam, bbox, out)
                print(f"[vision] started crop {stream} bbox={bbox}")

    def emit(self, blurred):
        # Strict privacy: pixels are taken ONLY from inside the assigned box.
        for _cam, bbox, out in self.crops.values():
            h, w = blurred.shape[:2]
            x, y = int(bbox["x"] * w), int(bbox["y"] * h)
            bw, bh = int(bbox["w"] * w), int(bbox["h"] * h)
            x, y = max(0, min(x, w - 2)), max(0, min(y, h - 2))
            bw, bh = max(2, min(bw, w - x)), max(2, min(bh, h - y))
            out.write(blurred[y:y + bh, x:x + bw])

    def close(self):
        for c in self.crops.values():
            c[2].close()


def serve_bed_api(bed_state, port, secret, host):
    """GET /beds?camera=... -> bed boxes from the latest raw frame."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            u = urlparse(self.path)
            if u.path != "/beds" or parse_qs(u.query).get("secret", [""])[0] != secret:
                self.send_response(403); self.end_headers(); return
            with bed_state["lock"]:
                frame = bed_state.get("frame")
                camera = bed_state.get("camera")
            if frame is None:
                body = b'{"beds":[]}'
            else:
                beds = bed_state["detector"].detect(frame)
                body = json.dumps({"camera": camera, "beds": beds}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    ThreadingHTTPServer((host, port), Handler).serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--camera", default="room_1", help="camera id (source RTSP path)")
    ap.add_argument("--src", default=None, help="override source URL")
    ap.add_argument("--api", default="http://localhost:3001")
    ap.add_argument("--port", type=int, default=5600, help="local bed-suggestion API port")
    ap.add_argument("--host", default="127.0.0.1", help="local bed-suggestion API bind host")
    ap.add_argument("--fps", type=int, default=25)
    nudity = ap.add_mutually_exclusive_group()
    nudity.add_argument("--mock", action="store_true", help="no-op classifier for known empty-scene demos only")
    nudity.add_argument("--model", action="store_true", help="run the GantMan NSFW classifier (the default)")
    ap.add_argument("--nsfw-model", default=os.path.join(os.path.dirname(__file__), "models", "nsfw_mobilenet2.224x224.h5"),
                    help="path to GantMan MobileNet v2 Keras weights")
    ap.add_argument("--bed-model", default=os.path.join(os.path.dirname(__file__), "models", "best.pt"))
    ap.add_argument("--bed-imgsz", type=int, default=1280, help="YOLO inference size; larger helps small beds in still images")
    ap.add_argument("--no-beds", action="store_true", help="disable YOLO bed detection")
    args = ap.parse_args()

    secret = os.environ.get("MEDIA_SECRET", "devmedia")
    src = args.src or f"rtsp://{MEDIA_HOST}:8554/{args.camera}"
    mode = "mock" if args.mock else "model"
    detect_nudity = make_nudity_detector(mode, args.nsfw_model)
    fail_until = 0.0

    bed_state = {"lock": threading.Lock(), "frame": None, "camera": args.camera,
                 "detector": None if args.no_beds else BedDetector(args.bed_model, args.bed_imgsz)}
    if bed_state["detector"]:
        threading.Thread(target=serve_bed_api, args=(bed_state, args.port, secret, args.host), daemon=True).start()

    out = FFmpegOut(f"rtsp://publish:{secret}@{MEDIA_HOST}:8554/{args.camera}_blurred",
                    1280, 720, args.fps, secret)
    crops = CropManager(args.api, secret, args.fps)
    print(f"[vision] camera={args.camera} mode={mode} src={src}")

    cap, last_sync, frame_i = None, 0.0, 0
    manual_blurs = []
    pending = []  # nudity boxes from the most recent detection, held between runs
    try:
        while True:
            if cap is None or not cap.isOpened():
                if cap is not None:
                    cap.release()
                time.sleep(1.0)
                cap = cv2.VideoCapture(src)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
                continue
            ok, frame = cap.read()
            if not ok:
                time.sleep(0.2)
                cap.release()
                cap = None
                continue

            with bed_state["lock"]:  # raw frame for bed suggestions (unblurred, never leaves)
                bed_state["frame"] = frame.copy()

            if frame_i % DET_EVERY == 0 and time.time() > fail_until:
                try:
                    pending = detect_nudity(frame) or []
                except Exception as e:
                    print(f"[vision] nudity detector error: {e} -> FAIL-CLOSED", file=sys.stderr)
                    pending = []
                    fail_until = time.time() + FAIL_COOLDOWN

            boxes = pending if pending else ([[0, 0, frame.shape[1], frame.shape[0]]]
                                             if time.time() < fail_until else [])
            blurred = blur_regions(frame.copy(), boxes)

            if time.time() - last_sync > 5:
                last_sync = time.time()
                crops.sync(args.camera)
                try:
                    data = http_json(f"{args.api}/internal/bed-blurs", secret)
                    manual_blurs = [b for b in data.get("boxes", []) if b["camera_id"] == args.camera]
                except Exception as e:
                    print(f"[vision] manual blur sync failed: {e}", file=sys.stderr)
            h, w = frame.shape[:2]
            all_boxes = list(boxes) + [[int(b["x"]*w), int(b["y"]*h), int(b["w"]*w), int(b["h"]*h)] for b in manual_blurs]
            blurred = blur_regions(frame.copy(), all_boxes)
            crops.emit(blurred)
            out.write(blurred)
            frame_i += 1
    except KeyboardInterrupt:
        pass
    finally:
        cap and cap.release()
        crops.close()
        out.close()


if __name__ == "__main__":
    main()
