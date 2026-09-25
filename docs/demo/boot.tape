# Hidden setup, sourced after the last Set. Builds the demo world under
# /tmp/herdr-gc-demo and runs its events; see env.sh. None of that is
# interesting to watch, so it lives in env.sh where shellcheck can read it.

Hide
Type "source docs/demo/env.sh"
Enter
Wait+Line@60s /^\$ ?$/
Sleep 1s
Show
