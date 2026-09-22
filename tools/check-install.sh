#!/bin/sh
# install.sh 가 두 곳에 있다. 저장소 루트(지금 README 가 가리키는 raw 주소)와
# site/(pilo.pages.dev 가 배포되면 쓸 짧은 주소). 배포 전까지는 둘 다 살아 있어야
# 하고, 살아 있는 동안 내용이 갈라지면 어느 쪽으로 깔았느냐에 따라 결과가 달라진다.
# 배포 뒤 README 를 짧은 주소로 바꾸면 루트 사본과 이 파일을 같이 지운다.
set -eu
cd "$(dirname "$0")/.."
if cmp -s install.sh site/install.sh; then
  echo "install.sh 점검 통과 — 루트와 site/ 가 같다"
else
  echo "install.sh 가 갈라졌다 — 루트와 site/ 의 내용이 다르다" >&2
  diff install.sh site/install.sh >&2 || true
  exit 1
fi
