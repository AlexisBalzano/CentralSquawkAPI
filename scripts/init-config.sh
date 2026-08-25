#!/bin/sh
# Fetch the config repository into CONFIG_DIR, then start the API.
#
# Failure here is fatal on purpose. The service has nothing to serve without
# config, and starting anyway would mean answering with an empty assignment map
# as though it were real.
set -e

CONFIG_REPO_URL=${CONFIG_REPO_URL:-""}
CONFIG_BRANCH=${CONFIG_BRANCH:-"main"}
CONFIG_DIR=${CONFIG_DIR:-"/app/data"}
CONFIG_SKIP_FETCH=${CONFIG_SKIP_FETCH:-"0"}

mkdir -p "$CONFIG_DIR"

if [ "$CONFIG_SKIP_FETCH" = "1" ]; then
    # Local development: CONFIG_DIR is a bind mount of a config checkout on the
    # host. Nothing is fetched, because a fetch would run `git reset --hard`
    # against the host's working tree and destroy uncommitted work.
    echo "CONFIG_SKIP_FETCH=1: using $CONFIG_DIR as supplied"
elif [ -z "$CONFIG_REPO_URL" ]; then
    echo "CONFIG_REPO_URL is not set, and CONFIG_SKIP_FETCH is not 1"
    exit 1
elif [ -d "$CONFIG_DIR/.git" ]; then
    echo "updating config in $CONFIG_DIR"
    git -C "$CONFIG_DIR" fetch --depth 1 origin "$CONFIG_BRANCH"
    git -C "$CONFIG_DIR" reset --hard "origin/$CONFIG_BRANCH"
else
    echo "cloning $CONFIG_REPO_URL into $CONFIG_DIR"
    # Clone into a scratch path first so a partial clone never leaves the volume
    # looking like a valid checkout.
    rm -rf /tmp/config-clone
    git clone --branch "$CONFIG_BRANCH" --depth 1 "$CONFIG_REPO_URL" /tmp/config-clone
    cp -a /tmp/config-clone/. "$CONFIG_DIR/"
    rm -rf /tmp/config-clone
fi

# Fail here rather than deep inside the loader: the message is far clearer, and
# a missing config.json is the most likely way this goes wrong.
for required in config.json modes_area.geojson fix.txt airway.txt procedure.txt; do
    if [ ! -f "$CONFIG_DIR/$required" ]; then
        echo "missing $required in $CONFIG_DIR"
        echo "contents:"
        ls -1 "$CONFIG_DIR" || true
        exit 1
    fi
done

echo "config ready in $CONFIG_DIR"

exec node dist/index.js
