#!/usr/bin/env sh
# Simulates an IP camera: pushes a test pattern, looping still image, or video as RTSP into MediaMTX.
# Usage: SOURCE_PASSWORD=<MEDIA_SECRET> ./simulate_camera.sh [room_1]
set -e
ROOM="${1:-room_1}"
SECRET="${SOURCE_PASSWORD:-${MEDIA_SECRET:-devmedia}}"
MEDIA_HOST="${MEDIA_HOST:-127.0.0.1}"
echo "Publishing room '$ROOM' to rtsp://$MEDIA_HOST:8554/$ROOM"
if [ -n "$SAMPLE" ]; then
  case "$SAMPLE" in
    *.png|*.PNG|*.jpg|*.JPG|*.jpeg|*.JPEG)
      exec ffmpeg -hide_banner -loglevel warning -re -loop 1 -framerate 25 -i "$SAMPLE" \
        -vf 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2' \
        -c:v libx264 -preset veryfast -tune zerolatency -g 50 -pix_fmt yuv420p \
        -f rtsp -rtsp_transport tcp "rtsp://publish:$SECRET@$MEDIA_HOST:8554/$ROOM" ;;
    *)
      exec ffmpeg -hide_banner -loglevel warning -re -stream_loop -1 -i "$SAMPLE" \
        -vf 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2' \
        -c:v libx264 -preset veryfast -tune zerolatency -g 50 -pix_fmt yuv420p \
        -f rtsp -rtsp_transport tcp "rtsp://publish:$SECRET@$MEDIA_HOST:8554/$ROOM" ;;
  esac
fi
exec ffmpeg -hide_banner -loglevel warning -re -f lavfi -i testsrc2=size=1280x720:rate=25 \
  -vf 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2' \
  -c:v libx264 -preset veryfast -tune zerolatency -g 50 -pix_fmt yuv420p \
  -f rtsp -rtsp_transport tcp "rtsp://publish:$SECRET@$MEDIA_HOST:8554/$ROOM"
