#!/bin/sh
# Launch DeepSeek Harness in the foreground with its output teed to a file,
# for diagnosing plugin activation. Quit the app first (Cmd+Q), then run this
# from Terminal; quit the app when done and read the log.
#
# The log lands next to this script, wherever the checkout lives.
set -e
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
LOG="$HERE/../host-launch.log"
/Applications/DeepSeek\ Harness.app/Contents/MacOS/DeepSeek\ Harness 2>&1 | tee "$LOG"
