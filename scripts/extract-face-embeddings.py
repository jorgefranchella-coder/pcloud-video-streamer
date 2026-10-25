#!/usr/bin/env python3
"""Extract a bounded set of local face embeddings from one video."""

import argparse
import base64
import json
import subprocess
import sys

import cv2
import numpy as np


def extract_frame(video_path, at_seconds, max_dimension):
    scale = f"scale={max_dimension}:{max_dimension}:force_original_aspect_ratio=decrease"
    result = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-ss", str(at_seconds), "-i", video_path, "-frames:v", "1",
            "-vf", scale, "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "-",
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    if not result.stdout or len(result.stdout) > 8 * 1024 * 1024:
        return None
    return cv2.imdecode(np.frombuffer(result.stdout, dtype=np.uint8), cv2.IMREAD_COLOR)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--yunet", required=True)
    parser.add_argument("--sface", required=True)
    parser.add_argument("--times", required=True, help="JSON array of sample timestamps")
    parser.add_argument("--max-dimension", type=int, default=960)
    parser.add_argument("--min-face-size", type=int, default=48)
    parser.add_argument("--detection-threshold", type=float, default=0.75)
    args = parser.parse_args()

    times = json.loads(args.times)
    if not isinstance(times, list) or len(times) > 200 or any(
        not isinstance(value, (int, float)) or value < 0 for value in times
    ):
        raise ValueError("Invalid sampling timestamps")

    cv2.setNumThreads(1)
    detector = cv2.FaceDetectorYN_create(
        args.yunet, "", (320, 320), args.detection_threshold, 0.3, 5000
    )
    recognizer = cv2.FaceRecognizerSF_create(args.sface, "")
    faces = []
    frames_processed = 0
    frames_failed = 0
    last_frame_error = ""
    for at_seconds in times:
        try:
            frame = extract_frame(args.video, at_seconds, args.max_dimension)
        except subprocess.CalledProcessError as error:
            frames_failed += 1
            last_frame_error = error.stderr.decode("utf-8", errors="replace")[-300:].strip()
            continue
        except subprocess.TimeoutExpired:
            frames_failed += 1
            last_frame_error = "FFmpeg agotó el tiempo de espera de 60 segundos"
            continue
        if frame is None:
            frames_failed += 1
            continue
        frames_processed += 1
        frame_height, frame_width = frame.shape[:2]
        detector.setInputSize((frame_width, frame_height))
        _, detections = detector.detect(frame)
        if detections is None:
            continue
        valid = sorted(detections, key=lambda item: (int(item[1]), int(item[0])))
        face_index = 0
        for detection in valid:
            x, y, width, height = (int(round(value)) for value in detection[:4])
            if min(width, height) < args.min_face_size:
                continue
            aligned = recognizer.alignCrop(frame, detection)
            vector = recognizer.feature(aligned).reshape(-1).astype(np.float32)
            norm = float(np.linalg.norm(vector))
            if not norm:
                continue
            vector /= norm
            faces.append({
                "at_seconds": float(at_seconds),
                "face_index": face_index,
                "x": max(0, x),
                "y": max(0, y),
                "width": min(width, frame_width - max(0, x)),
                "height": min(height, frame_height - max(0, y)),
                "frame_width": frame_width,
                "frame_height": frame_height,
                "detection_score": float(detection[-1]),
                "vector": base64.b64encode(vector.tobytes()).decode("ascii"),
            })
            face_index += 1

    if frames_processed == 0:
        raise RuntimeError(f"No se pudo extraer ningún fotograma ({frames_failed} fallidos): {last_frame_error}")

    json.dump({"frames_processed": frames_processed, "faces": faces}, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Face extraction failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
