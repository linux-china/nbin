#!/usr/bin/env sh
# cacher.sh -- Restore and rebuild cache.
# Cache paths are designed to work with multi-arch builds and are organized
# based on the branch or tag. The master branch cache is used as a fallback.
# This will download and package the cache but it will not upload it.

set -eu

# Try restoring from each argument in turn until we get something.
restore() {
  for branch in "$@" ; do
    if [ -n "$branch" ] ; then
      cache_path="https://nbin.cdr.sh/cache/$branch/$tar.tar.gz"
      if wget "$cache_path" ; then
        tar xzvf "$tar.tar.gz"
        break
      fi
    fi
  done
}

# We only need to cache the ccache directory. Everything inside the cache-upload
# directory will be uploaded as-is to the nbin bucket.
package() {
  mkdir -p "cache-upload/cache/$1"
  tar czfv "cache-upload/cache/$1/$tar.tar.gz" .cache/ccache
}

main() {
  cd "$(dirname "$0")/.."

  # Get the branch for this build. We can ignore the master branch since we'll
  # fall back to it below anyway.
  branch=${DRONE_BRANCH:-${DRONE_SOURCE_BRANCH:-${DRONE_TAG:-}}}
  [ "$branch" = "$DRONE_REPO_BRANCH" ] && branch=""

  # The cache will be named based on the arch, platform, and libc.
  arch=$DRONE_STAGE_ARCH
  platform=${PLATFORM:-linux}
   case $DRONE_STAGE_NAME in
     *alpine*) libc=musl  ;;
     *       ) libc=glibc ;;
   esac

  tar="$platform-$arch-$libc"

  # The action is determined by the name of the step.
  case $DRONE_STEP_NAME in
    *restore*) restore "$branch" "$DRONE_REPO_BRANCH" ;;
    *rebuild*|*package*) package "$branch" ;;
    *) exit 1 ;;
  esac
}

main "$@"
