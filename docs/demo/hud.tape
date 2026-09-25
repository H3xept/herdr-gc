# The HUD: pending suggestions over the recent runs. Accept a checkout
# deletion, then trust a new config and replay the event it blocked.
#
# Recorded against the demo world of env.sh, with fake gh, yarn, aspire and
# herdr binaries, so the recording needs neither herdr nor a network. In real
# use the HUD opens in a herdr popup; here it runs in the terminal itself,
# which draws the same.

Source docs/demo/style.tape

Output docs/hud.gif

Source docs/demo/boot.tape

Type "herdr-gc hud"
Sleep 500ms
Enter
# The top suggestion: delete feat-checkout, whose PR is merged.
Wait+Screen@10s /3 pending/
Sleep 3.5s

# Down to the close run that queued it: the classifier's verdict, then the
# AppHost it stopped.
Type "jjj"
Sleep 4s
Type "g"
Sleep 1.5s

# Accept the deletion. herdr-gc sees the checkout gone and runs remove.
Type "y"
Wait+Screen@5s /y\/n/
Sleep 1.5s
Type "y"
Wait+Screen@15s /2 pending/
Sleep 3.5s

# The billing config is new, so its open event waits. Trust it, then replay.
Type "j"
Sleep 2.5s
Type "t"
Wait+Screen@5s /y\/n/
Sleep 1.5s
Type "y"
Wait+Screen@5s /trusted/
Sleep 2s
Type "y"
Wait+Screen@5s /y\/n/
Sleep 1s
Type "y"
# The cursor stays on the new run: the replayed open, and its install.
Wait+Screen@20s /1 pending/
Sleep 4.5s
Type "q"
Sleep 1s
