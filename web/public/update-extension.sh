#!/usr/bin/env bash
# Updates the Job Board extension in place (macOS: Chrome, Edge, Brave).
#
#   curl -fsSL https://job-two-xi.vercel.app/update-extension.sh | bash
#
# Finds the folder your browser loads the extension from (its "Load
# unpacked" folder, recorded in the browser profile), downloads the latest
# version from the job board and copies it over. Version 1.16 and later
# reload themselves within a minute. Older copies need one browser restart:
# the script offers to do it (your tabs reopen). Set JOB_BOARD_RESTART=1 to
# restart without asking, or 0 to never restart.
set -euo pipefail
SITE='https://job-two-xi.vercel.app'
ID='deleknoaeibijjmfngfobapnpbekhcel'
NAME='Job Board Capture'

roots=(
  "$HOME/Library/Application Support/Google/Chrome"
  "$HOME/Library/Application Support/Microsoft Edge"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
  "$HOME/Library/Application Support/Chromium"
)

# Unpacked extensions that are this one, by ID or by the manifest's name.
# The profile files are JSON; macOS ships JavaScript for Automation to read them.
find_paths() {
  /usr/bin/osascript -l JavaScript - "$1" "$ID" "$NAME" <<'JS'
function run(argv) {
  ObjC.import('Foundation');
  const read = (p) => { const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null); return s.isNil() ? null : ObjC.unwrap(s); };
  let json; try { json = JSON.parse(read(argv[0]) || '{}'); } catch (e) { return ''; }
  const settings = (json.extensions || {}).settings || {};
  const out = [];
  for (const [id, v] of Object.entries(settings)) {
    if (!v || ![4, 8].includes(v.location) || !v.path) continue;
    let m; try { m = JSON.parse(read(v.path + '/manifest.json') || 'null'); } catch (e) { m = null; }
    if (m && (id === argv[1] || m.name === argv[2])) out.push(v.path + '\t' + m.version);
  }
  return out.join('\n');
}
JS
}

found=()
for root in "${roots[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r -d '' file; do
    while IFS= read -r line; do
      [ -n "$line" ] && found+=("$line"$'\t'"$root")
    done < <(find_paths "$file")
  done < <(find "$root" -maxdepth 2 \( -name 'Preferences' -o -name 'Secure Preferences' \) -type f -print0)
done

if [ ${#found[@]} -eq 0 ]; then
  echo "Couldn't find the extension in Chrome, Edge or Brave."
  echo "Install it once from $SITE/autofill (Load unpacked), then run this again."
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$SITE/downloads/job-board-extension.zip" -o "$tmp/extension.zip"
unzip -q "$tmp/extension.zip" -d "$tmp"
src="$tmp/job-board-extension"
latest=$(/usr/bin/plutil -extract version raw -o - "$src/manifest.json")
restart=0
printf '%s\n' "${found[@]}" | sort -u | while IFS=$'\t' read -r path version _; do
  cp -R "$src/." "$path/"
  echo "Updated $path: $version -> $latest"
done
old_roots=()
for entry in "${found[@]}"; do
  IFS=$'\t' read -r _ v root <<<"$entry"
  # Older than 1.16: no self-reload yet. Older than 1.12: no fixed ID yet.
  if [ "$(printf '%s\n1.16.0\n' "$v" | sort -V | head -1)" != "1.16.0" ]; then
    [ "$restart" = 0 ] && restart=1
    old_roots+=("$root")
  fi
  if [ "$(printf '%s\n1.12.0\n' "$v" | sort -V | head -1)" != "1.12.0" ]; then restart=2; fi
done

# The app that uses a profile folder.
app_for() {
  case "$1" in
    */Google/Chrome) echo 'Google Chrome' ;;
    */Microsoft\ Edge) echo 'Microsoft Edge' ;;
    */Brave-Browser) echo 'Brave Browser' ;;
    */Chromium) echo 'Chromium' ;;
  esac
}
is_running() { [ "$(/usr/bin/osascript -e "application \"$1\" is running" 2>/dev/null)" = true ]; }

# Copies older than 1.16 can't reload themselves: quit and reopen the browsers
# that load them, with their tabs. Only those apps are touched.
restart_browsers() {
  local apps=() app answer labels
  while IFS= read -r app; do
    [ -n "$app" ] && is_running "$app" && apps+=("$app")
  done < <(for r in "${old_roots[@]}"; do app_for "$r"; done | sort -u)
  if [ ${#apps[@]} -eq 0 ]; then
    echo "Your browser is closed: the new version loads the next time you open it."
    return
  fi
  labels=$(printf '%s and ' "${apps[@]}")
  labels=${labels% and }
  answer=${JOB_BOARD_RESTART:-}
  if [ -z "$answer" ]; then
    echo
    # Piped into bash, stdin is this script: ask on the terminal instead.
    if { exec 3</dev/tty; } 2>/dev/null; then
      printf 'Restart %s now to finish the update? Your tabs reopen; anything typed into a page and not saved is lost. [Y/n] ' "$labels" >/dev/tty
      read -r answer <&3 || answer=n
      exec 3<&-
      [ -z "$answer" ] && answer=y
    else
      answer=n
    fi
  fi
  case "$answer" in
    y | Y | yes | YES | 1) ;;
    *)
      echo "Restart $labels yourself once (or click Reload on the extension in chrome://extensions)."
      return
      ;;
  esac
  for app in "${apps[@]}"; do
    /usr/bin/osascript -e "quit app \"$app\"" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      is_running "$app" || break
      sleep 0.5
    done
    if is_running "$app"; then
      echo "$app didn't close. Restart it yourself once."
      continue
    fi
    open -a "$app" --args --restore-last-session
    echo "Restarted $app: the extension is on the new version and your tabs are back."
  done
}

if [ "$restart" != 0 ]; then
  if [ "$restart" = 2 ]; then
    echo
    echo "This copy was older than 1.12, so it gets a new ID this one time: connect it again with a token from $SITE/autofill."
  fi
  restart_browsers
  echo "Future updates reload by themselves."
else
  echo "The extension reloads itself within a minute. Nothing else to do."
  echo "(If the extension still shows the old version after that, restart your browser once.)"
fi
