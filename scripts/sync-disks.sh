#!/usr/bin/env bash
# Push disk chunks and ROMs to R2, then verify the live site can serve every one.
#
#   scripts/sync-disks.sh
#   scripts/sync-disks.sh --verify-only
#   scripts/sync-disks.sh --base https://macemu.pages.dev --jobs 6
#
# Neither chunks nor ROMs ever enter git: the chunks are built from Apple system
# software and third-party titles, and the ROMs are Apple's.
#
# Uploads go through the R2 REST API with curl rather than `wrangler r2 object
# put`. Wrangler spends ten to twenty seconds resolving itself per invocation,
# which turned a sixty-object sync into a quarter of an hour; a curl PUT takes
# under two seconds.
#
# Every upload is verified against the LIVE SITE afterwards, not against the API
# response. An earlier parallel run lost 56 of 76 objects while reporting
# nothing, and a missing chunk does not produce an error — the emulator simply
# waits forever, which reads to a visitor as "this site is broken".
set -uo pipefail
cd "$(dirname "$0")/.."

BUCKET="macemu-disk"
BASE="https://macemu.pages.dev"
ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-ea509cdff27d40d5e3e4cb92dec2473f}"
JOBS=6
verify_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --verify-only) verify_only=1; shift ;;
    --base) BASE="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done

TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  cfg="$HOME/Library/Preferences/.wrangler/config/default.toml"
  [ -f "$cfg" ] || cfg="$HOME/.wrangler/config/default.toml"
  TOKEN=$(grep -E '^oauth_token' "$cfg" 2>/dev/null | sed 's/.*= *"\(.*\)"/\1/')
fi
if [ -z "$TOKEN" ]; then
  echo "No Cloudflare credential. Set CLOUDFLARE_API_TOKEN, or run: npx wrangler login"
  exit 2
fi
export TOKEN ACCOUNT BUCKET

# Upload one object. Retries, and treats a non-success JSON body as a failure —
# the API returns 200 with success:false for some errors.
upload_one() {
  local f="$1" key="$2"
  for try in 1 2 3; do
    resp=$(curl -s --max-time 120 -X PUT \
      "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/r2/buckets/$BUCKET/objects/$key" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$f")
    case "$resp" in
      *'"success":true'*) echo "  put    $key"; return 0 ;;
    esac
    sleep 2
  done
  echo "  FAILED $key"
  return 1
}
export -f upload_one

# What the live site cannot serve. Cache-busted, because a cached 404 would look
# like a permanent failure and loop forever.
missing() {
  BASE="$BASE" python3 - <<'PY'
import json, os, glob, urllib.request, concurrent.futures, random, sys
BASE=os.environ["BASE"]; UA={"User-Agent":"macemu-sync/1.0"}
want=set()
for mf in glob.glob("public/mac/disks/*.json"):
    for c in json.load(open(mf)).get("chunks", []):
        if c: want.add(("chunk", c))
for r in glob.glob("Images/rom/*.rom"):
    want.add(("rom", os.path.basename(r)[:-4]))
def ck(item):
    kind, name = item
    p = f"/Disk/{name}.chunk" if kind=="chunk" else f"/rom/{name}.rom"
    try:
        urllib.request.urlopen(urllib.request.Request(
            f"{BASE}{p}?cb={random.randint(0,10**9)}", headers=UA, method="HEAD"), timeout=40)
        return None
    except Exception:
        return f"{kind} {name}"
out=[]
with concurrent.futures.ThreadPoolExecutor(12) as ex:
    for r in ex.map(ck, sorted(want)):
        if r: out.append(r)
print("\n".join(out))
sys.stderr.write(f"  {len(want)} objects referenced, {len(out)} missing\n")
PY
}

if [ "$verify_only" = 0 ]; then
  for round in 1 2 3 4; do
    echo "round $round"
    list=$(missing)
    [ -z "$list" ] && { echo "  nothing to upload"; break; }
    echo "$list" | while read -r kind name; do
      [ -z "${name:-}" ] && continue
      if [ "$kind" = chunk ]; then echo "Images/build/$name.chunk|$name.chunk"
      else echo "Images/rom/$name.rom|rom/$name.rom"; fi
    done | xargs -P "$JOBS" -I{} bash -c 'IFS="|" read -r f k <<< "{}"; upload_one "$f" "$k"'
  done
fi

echo "Verifying against $BASE"
left=$(missing)
if [ -n "$left" ]; then
  echo "$left" | sed 's/^/  still missing: /'
  echo "Not safe to call this deployed: a missing chunk makes a title hang rather than fail."
  exit 1
fi
echo "Every chunk and ROM referenced by a manifest is being served."
