#!/usr/bin/env bash
# GitHub Actions: install the same checksum-pinned compiler for each Linux target.
set -euo pipefail
target=${1:?usage: install-musl-toolchain.sh <rust-target>}
case "$target" in
  x86_64-unknown-linux-musl) checksum=5f20e367608d6e547c04534d37d00ecedbaa0c2e82730df12957b3332fa36a2d ;;
  arm-unknown-linux-musleabihf) checksum=80fc2984bff95cf3288fcba2b2107fccf29eefb07a29f497fc00dcdbfb952165 ;;
  aarch64-unknown-linux-musl) checksum=90282c463498dcdab9b96a464a0925d53f30c884b2d7b25e3998999416ae34b8 ;;
  *) echo "Unsupported musl target: $target" >&2; exit 1 ;;
esac
archive="$RUNNER_TEMP/$target.tar.xz"
toolchains="$RUNNER_TEMP/musl-cross"
curl --proto '=https' --tlsv1.2 --retry 5 --location --fail \
  "https://github.com/cross-tools/musl-cross/releases/download/20260515/$target.tar.xz" \
  --output "$archive"
echo "$checksum  $archive" | sha256sum -c -
mkdir -p "$toolchains"
tar -xJf "$archive" -C "$toolchains"
bin_dir="$toolchains/$target/bin"
cc="$bin_dir/$target-gcc"
ar="$bin_dir/$target-ar"
test -x "$cc"
test -x "$ar"
cargo_target=$(echo "$target" | tr '[:lower:]-' '[:upper:]_')
cc_target=${target//-/_}
{
  echo "CARGO_TARGET_${cargo_target}_LINKER=$cc"
  echo "CC_${cc_target}=$cc"
  echo "AR_${cc_target}=$ar"
  if [ "$target" = arm-unknown-linux-musleabihf ]; then
    echo "CFLAGS_${cc_target}=-march=armv6 -mfpu=vfp -mfloat-abi=hard"
  fi
} >> "$GITHUB_ENV"
echo "$bin_dir" >> "$GITHUB_PATH"
