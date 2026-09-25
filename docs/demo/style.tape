# Look only: Require and Set, never a Type. Sourced first by every tape.
#
# vhs applies Set to the terminal it is about to start, so every Set has to come
# before the first keystroke.

Require bash
Require git
Require node

Set Shell bash
Set FontSize 15
# In real use the HUD is a herdr popup. 1240 x 560 gives it about 130 columns
# and 28 rows: the list, and the selected run's log below it, both fit.
Set Width 1240
Set Height 560
Set Padding 22
# Tokyo Night, from folke/tokyonight.nvim, with ANSI green kept green.
Set Theme { "name": "TokyoNight", "black": "#15161e", "red": "#f7768e", "green": "#9ece6a", "yellow": "#e0af68", "blue": "#7aa2f7", "magenta": "#bb9af7", "cyan": "#7dcfff", "white": "#a9b1d6", "brightBlack": "#414868", "brightRed": "#f7768e", "brightGreen": "#9ece6a", "brightYellow": "#e0af68", "brightBlue": "#7aa2f7", "brightMagenta": "#bb9af7", "brightCyan": "#7dcfff", "brightWhite": "#c0caf5", "background": "#1a1b26", "foreground": "#c0caf5", "selection": "#33467c", "cursor": "#c0caf5" }
Set TypingSpeed 40ms
Set Framerate 24
