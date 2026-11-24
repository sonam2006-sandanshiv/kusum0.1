@echo off
rem Simulates an IP camera (test pattern, video file, or looping PNG image).
rem Usage: simulate_camera.cmd [room_1]
setlocal
set ROOM=%1
if "%ROOM%"=="" set ROOM=room_1
if "%SOURCE_PASSWORD%"=="" if not "%MEDIA_SECRET%"=="" set SOURCE_PASSWORD=%MEDIA_SECRET%
if "%SOURCE_PASSWORD%"=="" set SOURCE_PASSWORD=devmedia
if "%MEDIA_HOST%"=="" set MEDIA_HOST=127.0.0.1
if not defined FFMPEG set "FFMPEG=%~dp0bin\ffmpeg.exe"
if not exist "%FFMPEG%" set "FFMPEG=ffmpeg"
if not defined SAMPLE goto synthetic
for %%I in ("%SAMPLE%") do set "SAMPLE_EXT=%%~xI"
if /I "%SAMPLE_EXT%"==".png" goto still
if /I "%SAMPLE_EXT%"==".jpg" goto still
if /I "%SAMPLE_EXT%"==".jpeg" goto still
set "SRC=-re -stream_loop -1 -i "%SAMPLE%""
goto publish
:still
set "SRC=-re -loop 1 -framerate 25 -i "%SAMPLE%""
goto publish
:synthetic
set "SRC=-re -f lavfi -i testsrc2=size=1280x720:rate=25"
:publish
echo Publishing room "%ROOM%" to rtsp://%MEDIA_HOST%:8554/%ROOM%
"%FFMPEG%" -hide_banner -loglevel warning %SRC% -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -preset veryfast -tune zerolatency -g 50 -pix_fmt yuv420p -f rtsp -rtsp_transport tcp "rtsp://publish:%SOURCE_PASSWORD%@%MEDIA_HOST%:8554/%ROOM%"
