`video.webm` is a generated silent navy rectangle, 160×90, 2 fps, 90 seconds long.
It contains no third-party media. Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=navy:s=160x90:r=2:d=90 -c:v libvpx -b:v 30k -an -y tests/fixtures/video.webm
```
