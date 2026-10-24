#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
face_data_dir="${DATA_DIR:-${project_dir}/data}"
runtime_dir="${face_data_dir}/face-runtime"
model_dir="${face_data_dir}/models/faces"
face_python="${runtime_dir}/bin/python"
mkdir -p "${model_dir}"

python3 -m venv "${runtime_dir}"
"${face_python}" -m pip install --disable-pip-version-check --no-input 'opencv-contrib-python-headless==5.0.0.93'

curl --fail --location --retry 2 --max-time 120 \
  'https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx' \
  --output "${model_dir}/yunet.onnx.part"
curl --fail --location --retry 2 --max-time 180 \
  'https://github.com/opencv/opencv_zoo/raw/refs/heads/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx' \
  --output "${model_dir}/sface.onnx.part"

echo '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  yunet.onnx.part' | (cd "${model_dir}" && sha256sum --check --status)
echo '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79  sface.onnx.part' | (cd "${model_dir}" && sha256sum --check --status)
mv "${model_dir}/yunet.onnx.part" "${model_dir}/yunet.onnx"
mv "${model_dir}/sface.onnx.part" "${model_dir}/sface.onnx"

curl --fail --location --retry 2 --max-time 30 \
  'https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_detection_yunet/LICENSE' \
  --output "${model_dir}/yunet-LICENSE"
curl --fail --location --retry 2 --max-time 30 \
  'https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_recognition_sface/LICENSE' \
  --output "${model_dir}/sface-LICENSE"

"${face_python}" -c 'import cv2; print("OpenCV", cv2.__version__, "YuNet", hasattr(cv2, "FaceDetectorYN_create"), "SFace", hasattr(cv2, "FaceRecognizerSF_create"))'
printf 'Runtime: %s\nModels: %s\n' "${face_python}" "${model_dir}"
