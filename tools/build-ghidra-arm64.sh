#!/data/data/com.dsharnessmobile.shell/files/usr/bin/bash
#
# 在 Android(aarch64) 上构建 Ghidra 的原生反编译器，供 REA 的 ghidra provider 使用。
#
# 为什么需要这个脚本（每一步都是踩过的坑）：
#   1. 官方 Ghidra 发布包**不含** linux/arm64 原生件（issue #9364 证实）；
#   2. 它自带的 Makefile 没有 arm64 分支，会掉进 `else ARCH_TYPE=-m32` 编译失败；
#   3. 本机的 make 把 SHELL 写死成 /data/data/com.termux/files/usr/bin/sh（不存在）；
#   4. 本机 apt/dpkg 前缀同样写死成 com.termux，装不了 bison/flex；
#   5. aarch64 上必须 JDK 21+（本机 PATH 上的 java 是 17）。
#
# 用法：
#   bash build-ghidra-arm64.sh [安装根目录]
# 默认安装根：$DSH_HOME/plugins/dsh-rea/vendor/ghidra
#
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DEST_ROOT="${1:-$DSH_HOME/plugins/dsh-rea/vendor/ghidra}"
PREFIX="${PREFIX:-/data/data/com.dsharnessmobile.shell/files/usr}"
WORK="$(cd "$(dirname "$0")/.." && pwd)/ghidra-build"
GHIDRA_VERSION="12.1.4"
GHIDRA_BUILD="20260921"
GHIDRA_DIRNAME="ghidra_${GHIDRA_VERSION}_PUBLIC"
ZIP="ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_BUILD}.zip"
URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/${ZIP}"
EXPECT_BYTES=569649598
MIRROR="https://mirrors.ustc.edu.cn/termux/termux-main"
TOOLCHAIN="$WORK/toolchain"
TP="$TOOLCHAIN/data/data/com.termux/files/usr"

log() { printf '\n=== %s ===\n' "$*"; }

command -v node >/dev/null || { echo "缺 node"; exit 1; }

# ---------------------------------------------------------------- 1) bison/flex
log "1/5 检查 bison / flex（Ghidra 的 ruleparse.cc 需要现场生成）"
if ! command -v bison >/dev/null 2>&1 || ! command -v flex >/dev/null 2>&1; then
  echo "本机没有 bison/flex。apt 在本环境前缀被写死成 com.termux，装不了，"
  echo "改为从镜像直接抓预编译 .deb 手工解包到 $TOOLCHAIN"
  mkdir -p "$WORK"
  cd "$WORK"
  curl -sSL -o Packages.gz "$MIRROR/dists/stable/main/binary-aarch64/Packages.gz"
  gunzip -c Packages.gz > Packages
  : > debs.txt
  for p in m4 bison flex; do
    fn=$(awk -v pkg="$p" 'BEGIN{RS="";FS="\n"} $1=="Package: "pkg{for(i=1;i<=NF;i++) if($i ~ /^Filename: /){sub(/^Filename: /,"",$i); print $i}}' Packages | head -1)
    [ -n "$fn" ] && echo "$MIRROR/$fn" >> debs.txt
  done
  mkdir -p "$TOOLCHAIN"
  while read -r u; do
    f=$(basename "$u")
    curl -sSL -o "$f" "$u"
    dpkg-deb -x "$f" "$TOOLCHAIN"
  done < debs.txt
fi
export PATH="$TP/bin:${PATH}"
export BISON_PKGDATADIR="$TP/share/bison"
command -v bison >/dev/null 2>&1 && bison --version | head -1
command -v flex  >/dev/null 2>&1 && flex --version

# ---------------------------------------------------------------- 2) 下载 Ghidra
log "2/5 下载 Ghidra ${GHIDRA_VERSION}（${EXPECT_BYTES} 字节，8 连接分片）"
mkdir -p "$WORK"; cd "$WORK"
if [ ! -f "$ZIP" ] || [ "$(stat -c%s "$ZIP" 2>/dev/null || echo 0)" != "$EXPECT_BYTES" ]; then
  rm -f part.* "$ZIP"
  N=8; SIZE=$((EXPECT_BYTES / N))
  for i in $(seq 0 $((N - 1))); do
    start=$((i * SIZE))
    if [ "$i" -eq $((N - 1)) ]; then end=$((EXPECT_BYTES - 1)); else end=$((start + SIZE - 1)); fi
    curl -sSL --retry 8 --retry-delay 3 --retry-all-errors -r "${start}-${end}" -o "part.$i" "$URL" &
  done
  wait
  cat part.0 part.1 part.2 part.3 part.4 part.5 part.6 part.7 > "$ZIP"
  rm -f part.*
fi
[ "$(stat -c%s "$ZIP")" = "$EXPECT_BYTES" ] || { echo "下载大小不对"; exit 1; }
unzip -tq "$ZIP" >/dev/null && echo "zip 完整性 OK"

# ---------------------------------------------------------------- 3) 解压
log "3/5 解压"
[ -d "$GHIDRA_DIRNAME" ] || unzip -q -o "$ZIP"

# ---------------------------------------------------------------- 4) 编译原生反编译器
log "4/5 编译 ghidra_opt（aarch64）"
cd "$GHIDRA_DIRNAME/Ghidra/Features/Decompiler/src/decompile/cpp"
# 两个关键覆盖：
#   SHELL=...        绕开本机 make 里烙死的 com.termux 路径
#   ARCH_TYPE= 空     绕开 Makefile 无 arm64 分支而落到 -m32 的误判
make -j"$(nproc)" ghidra_opt SHELL="$PREFIX/bin/sh" ARCH_TYPE= OSDIR=linux_arm_64
OSD="../../os/linux_arm_64"
mkdir -p "$OSD"
cp ghidra_opt "$OSD/decompile"
chmod 755 "$OSD/decompile"
file "$OSD/decompile"

# ---------------------------------------------------------------- 5) 安装
log "5/5 安装到 $DEST_ROOT/$GHIDRA_DIRNAME"
mkdir -p "$DEST_ROOT"
cd "$WORK"
if [ "$(dirname "$DEST_ROOT/$GHIDRA_DIRNAME")" != "$(dirname "$(pwd)/$GHIDRA_DIRNAME")" ]; then
  rm -rf "$DEST_ROOT/$GHIDRA_DIRNAME"
  mv "$GHIDRA_DIRNAME" "$DEST_ROOT/"
fi
ls -la "$DEST_ROOT/$GHIDRA_DIRNAME/Ghidra/Features/Decompiler/os/linux_arm_64/"

cat <<EOF

完成。

导出（或写进 dsh-rea 的 cordis.patch.yml）：
  ghidraInstallDir: '$DEST_ROOT/$GHIDRA_DIRNAME'

JDK 要求 21+；本机可用：
  javaHome: '$PREFIX/lib/jvm/java-21-openjdk'

验收：
  GHIDRA_INSTALL_DIR='$DEST_ROOT/$GHIDRA_DIRNAME' \\
  JAVA_HOME='$PREFIX/lib/jvm/java-21-openjdk' \\
  node '$DSH_HOME/plugins/dsh-rea/vendor/node_modules/rea-agents/scripts/rea.mjs' doctor --format json

注意：REA 的 Ghidra provider 在两张平台表里没有 android，插件启动时会自动补
（lib/paths.mjs 的 applyGhidraPatch），因此不需要手工改 REA 的 dist。
EOF
