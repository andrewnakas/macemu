#!/usr/bin/env bash
# Generate, gate, deploy, verify. In that order, and it stops at the first
# failure — because the alternative is what happened today: the gate reported
# three stale pages and the deploy ran anyway, because they were separate
# commands in the same line and only one of them was being read.
#
#   scripts/deploy.sh            # the whole thing
#   scripts/deploy.sh --dry      # generate and gate only
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> generating"
node scripts/gen-pages.mjs
node scripts/og-cards.mjs

echo "==> checking"
node scripts/check-consistency.mjs

if [ "${1:-}" = "--dry" ]; then
  echo "==> dry run, stopping before deploy"
  exit 0
fi

echo "==> deploying"
ok=0
for attempt in 1 2 3; do
  if npx wrangler pages deploy public --project-name=macemu --commit-dirty=true --branch=main 2>&1 | tee /tmp/macemu-deploy.log | tail -2; then
    grep -q "Deployment complete" /tmp/macemu-deploy.log && { ok=1; break; }
  fi
  echo "    attempt $attempt did not complete, retrying"
done
[ "$ok" = "1" ] || { echo "deploy failed after 3 attempts"; exit 1; }

echo "==> syncing disks"
bash scripts/sync-disks.sh --jobs 6 | tail -2

echo "==> smoke testing"
bash scripts/smoke-test.sh https://macemu.pages.dev | tail -2

echo "==> telling Bing (IndexNow)"
# Never fails the deploy: the site is already live by this point.
node scripts/indexnow.mjs --changed || echo "    indexnow did not accept; rerun: node scripts/indexnow.mjs --changed"

echo
echo "Deployed. Run scripts/boot-test.mjs --all to check the titles still start."
