# Node-free counterpart to output.cjs, for help and bootstrap failures.
# Usage: gt_cli_print FD STYLE MESSAGE... (redirect stderr explicitly).
gt_cli_print() (
  gt_cli_fd=$1
  case "$2" in
    bold) gt_cli_open=1; gt_cli_close=22;;
    dim) gt_cli_open=2; gt_cli_close=22;;
    red) gt_cli_open=31; gt_cli_close=39;;
    green) gt_cli_open=32; gt_cli_close=39;;
    yellow) gt_cli_open=33; gt_cli_close=39;;
    cyan) gt_cli_open=36; gt_cli_close=39;;
    *) shift 2; printf '%s\n' "$@"; return;;
  esac
  shift 2
  gt_cli_color=0
  if [ "${NO_COLOR+x}" != x ] && [ "${NODE_DISABLE_COLORS+x}" != x ]; then
    if [ "${FORCE_COLOR+x}" = x ]; then
      case "$FORCE_COLOR" in ''|true|1|2|3) gt_cli_color=1;; esac
    elif [ "${TERM-}" != dumb ] && [ -t "$gt_cli_fd" ]; then
      gt_cli_color=1
    fi
  fi
  for gt_cli_text do
    if [ "$gt_cli_color" = 1 ]; then
      printf '\033[%sm%s\033[%sm\n' "$gt_cli_open" "$gt_cli_text" "$gt_cli_close"
    else
      printf '%s\n' "$gt_cli_text"
    fi
  done
)
