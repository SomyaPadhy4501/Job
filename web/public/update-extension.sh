#!/usr/bin/env bash
# Updates the Job Board extension in place (macOS: Chrome, Edge, Brave).
#
#   curl -fsSL https://job-two-xi.vercel.app/update-extension.sh | bash
#
# Finds the folder your browser loads the extension from (its "Load
# unpacked" folder, recorded in the browser profile), downloads the latest
# version from the job board and copies it over. Version 1.16 and later
# reload themselves within a minute; older copies need one browser restart.
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
      [ -n "$line" ] && found+=("$line")
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
printf '%s\n' "${found[@]}" | sort -u | while IFS=$'\t' read -r path version; do
  cp -R "$src/." "$path/"
  echo "Updated $path: $version -> $latest"
done
for entry in "${found[@]}"; do
  v=${entry##*$'\t'}
  # Older than 1.16: no self-reload yet. Older than 1.12: no fixed ID yet.
  if [ "$(printf '%s\n1.16.0\n' "$v" | sort -V | head -1)" != "1.16.0" ]; then restart=1; fi
  if [ "$(printf '%s\n1.12.0\n' "$v" | sort -V | head -1)" != "1.12.0" ]; then restart=2; fi
done
if [ "$restart" != 0 ]; then
  echo
  echo "Restart your browser once (or click Reload on the extension in chrome://extensions)."
  [ "$restart" = 2 ] && echo "This copy was older than 1.12, so it gets a new ID this one time: connect it again with a token from $SITE/autofill."
  echo "Future updates reload by themselves."
else
  echo "The extension reloads itself within a minute. Nothing else to do."
  echo "(If the extension still shows the old version after that, restart your browser once.)"
fi
