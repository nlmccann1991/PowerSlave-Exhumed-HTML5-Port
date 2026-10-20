#!/bin/sh
# Converts PowerSlave Exhumed's Theora cutscenes (movies/*.ogv) to WebM so they play in
# Chromium-based browsers, which dropped Theora. The .webm files are written next to the
# originals, which are left untouched. Needs ffmpeg built with libvpx (VP9) and libopus,
# or libsvtav1 for --av1.
#
#   sh html5/tools/convert-movies.sh [--av1] [path/to/PowerSlave Exhumed]
#
# The game folder defaults to the parent of html5/. Existing .webm files are skipped,
# so the script can be re-run after an interruption.

set -eu

codec=vp9
if [ "${1:-}" = "--av1" ]; then codec=av1; shift; fi

here=$(cd "$(dirname "$0")" && pwd)
game=${1:-"$here/../.."}
movies="$game/movies"
[ -d "$movies" ] || { echo "no movies folder in $game" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }

for src in "$movies"/*.ogv; do
    [ -e "$src" ] || continue
    out="${src%.ogv}.webm"
    if [ -s "$out" ]; then echo "skip   $(basename "$out")"; continue; fi
    echo "encode $(basename "$src") -> $(basename "$out") ($codec)"
    if [ "$codec" = av1 ]; then
        video="-c:v libsvtav1 -preset 6 -crf 32 -pix_fmt yuv420p"
    else
        video="-c:v libvpx-vp9 -crf 31 -b:v 0 -row-mt 1 -deadline good -cpu-used 3 -pix_fmt yuv420p"
    fi
    # the logo movies carry an extra Ogg skeleton stream, so map just the video and audio
    # shellcheck disable=SC2086
    ffmpeg -hide_banner -loglevel error -stats -y -i "$src" -map 0:v:0 -map "0:a:0?" \
        $video -c:a libopus -b:a 112k "$out.part.webm"
    mv "$out.part.webm" "$out"
done
echo "done"
