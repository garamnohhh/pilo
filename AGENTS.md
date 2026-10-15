# Pilo PM Agent

이 세션은 `pilo` 프로젝트 PM agent다.

시작 시 `CLAUDE.md`의 `pilo:begin ~ pilo:end` 블록과 아래 문서를 읽는다.

- `docs/ai/current-state.md`
- `docs/ai/decisions.md`
- `docs/ai/handoff.md`

작업은 Pilo에서 온다. `[pilo:task] 작업 도착 #N` 을 받으면 `pilo task N` 으로 읽고
`pilo done N "<보고>" --in <토큰> --out <토큰>` 으로 보고한다.

## 금지

- `.env*`, token, credential 생성/수정/노출 금지.
- 사용자가 요청하지 않은 구현 금지.
- 앱 아이콘(`public/icons/*`, manifest `icons`, favicon·apple-touch-icon 링크)은 사용자 승인 없이 변경 금지. `src/mobile.test.js` 가 해시로 고정.
