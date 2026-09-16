#!/usr/bin/env bash
# Post-deploy smoke test. Checks the things that are invisible in the HTML and
# only observable against the live edge: which routes are cross-origin isolated,
# which are framable, whether the R2 bindings resolved, and whether a
# non-browser user agent gets a page rather than a bot-challenge 403.
#
#   scripts/smoke-test.sh https://macemu.com
#
# Every check here corresponds to a way the site can be broken while looking
# completely fine in a browser.
set -uo pipefail
U="${1:-https://macemu.com}"
fails=0
pass() { printf "  ok    %s\n" "$1"; }
fail() { printf "  FAIL  %s — %s\n" "$1" "$2"; fails=$((fails+1)); }

hdr() { curl -s -D - -o /dev/null "$1" | tr -d '\r'; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "Smoke testing $U"

# Which mode the site is in is decided by ISOLATE_CONTENT in scripts/site.mjs,
# not by what this script assumes. Read it, so the two cannot disagree — this
# check failed for a while purely because the site had been isolated on purpose
# and the test still believed the old arrangement.
isolate=$(grep -oE 'ISOLATE_CONTENT = (true|false)' scripts/site.mjs | awk '{print $3}')
echo "Content pages (ISOLATE_CONTENT = ${isolate:-unknown})"
h=$(hdr "$U/run/marathon/")
if [ "$isolate" = "true" ]; then
  grep -qi "^cross-origin-embedder-policy" <<<"$h" \
    && pass "/run/ is isolated, as the flag says" \
    || fail "/run/ COEP" "missing; the emulator would fall back to the slow path everywhere"
else
  grep -qi "^cross-origin-embedder-policy" <<<"$h" \
    && fail "/run/ COEP" "present while ISOLATE_CONTENT is false; ads could never render here" \
    || pass "/run/ has no COEP, as the flag says"
fi
[ "$(code "$U/run/marathon/")" = "200" ] && pass "/run/marathon/ 200" || fail "/run/marathon/" "not 200"

echo "Isolated player"
h=$(hdr "$U/play/marathon/")
if grep -qi "^cross-origin-opener-policy: same-origin" <<<"$h" && grep -qi "^cross-origin-embedder-policy: require-corp" <<<"$h"; then
  pass "/play/ is cross-origin isolated"
else
  fail "/play/ isolation" "missing COOP or COEP; the emulator would silently run in slow mode"
fi
[ "$(grep -ci "^cross-origin-opener-policy" <<<"$h")" -le 1 ] && pass "/play/ has exactly one COOP" || fail "/play/ COOP" "duplicated; conflicting values behave as neither"

echo "Embeds must be framable by anyone"
h=$(hdr "$U/embed/marathon/")
grep -qi "^x-frame-options" <<<"$h" && fail "/embed/ X-Frame-Options" "present; embeds would be blocked" || pass "/embed/ has no X-Frame-Options"

echo "R2-backed routes resolved their bindings"
body=$(curl -s "$U/Disk/0000000000000000.chunk")
[ "$body" = "no bucket binding" ] && fail "/Disk/" "DISK_BUCKET binding is missing on the deployment" || pass "/Disk/ binding resolved"
[ "$(code "$U/rom/Quadra-650.rom")" = "200" ] && pass "/rom/Quadra-650.rom 200" || fail "/rom/Quadra-650.rom" "not 200 — upload ROMs with scripts/sync-disks.sh"
[ "$(code -I "$U/rom/Quadra-650.rom")" = "200" ] && pass "/rom/ answers HEAD" || fail "/rom/ HEAD" "404 on HEAD means only onRequestGet is exported"
[ "$(code "$U/Disk/..%2F..%2Fetc%2Fpasswd")" != "200" ] && pass "/Disk/ rejects a traversal-shaped name" || fail "/Disk/" "accepted a bad name"

echo "Disk manifests resolve to real chunks"
for mf in public/mac/disks/*.json; do
  [ -e "$mf" ] || continue
  name=$(basename "$mf" .json)
  miss=0; total=0
  for h in $(python3 -c "
import json,sys
c=[x for x in json.load(open('$mf'))['chunks'] if x]
u=sorted(set(c))
print(' '.join(u[::max(1,len(u)//8)][:8]))
"); do
    total=$((total+1))
    [ "$(code "$U/Disk/$h.chunk?cb=$RANDOM")" = "200" ] || miss=$((miss+1))
  done
  [ "$miss" = "0" ] && pass "$name: $total sampled chunks all present" \
    || fail "$name" "$miss of $total sampled chunks are missing from R2 — titles will hang, not error"
done

echo "Crawler surface"
for p in sitemap.xml robots.txt llms.txt favicon.ico og.png; do
  [ "$(code "$U/$p")" = "200" ] && pass "/$p" || fail "/$p" "not 200"
done
curl -s "$U/robots.txt" | grep -q "Disallow: /play/" && pass "robots disallows /play/" || fail "robots.txt" "missing /play/ disallow"

echo "A non-browser fetcher gets the page, not a challenge"
for ua in "Mediapartners-Google" "Googlebot/2.1" "GPTBot/1.0" "ClaudeBot/1.0"; do
  c=$(code -A "$ua" "$U/run/marathon/")
  [ "$c" = "200" ] && pass "$ua → 200" || fail "$ua" "got $c — check Bot Fight Mode and the WAF"
done

echo
if [ "$fails" -gt 0 ]; then echo "$fails failure(s)."; exit 1; fi
echo "All checks passed."
