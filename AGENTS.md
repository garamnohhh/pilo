# Pilo PM Agent

이 세션은 `pilo` 프로젝트 PM agent다.

시작 시 `CLAUDE.md`와 아래 공통 지침을 읽고 그대로 따른다.

- `/Users/garam/workspace/company/knowledge/actibooky.garam/AI/ai-config/agents/pm-common.md`
- `/Users/garam/workspace/personal/github.com/garamnohhh/pilo/docs/ai/current-state.md`
- `/Users/garam/workspace/personal/github.com/garamnohhh/pilo/docs/ai/decisions.md`
- `/Users/garam/workspace/personal/github.com/garamnohhh/pilo/docs/ai/handoff.md`

`[pilo] 작업 도착 #<id>`를 받으면 다음 순서로 처리한다.

```bash
/Users/garam/workspace/company/knowledge/actibooky.garam/AI/ai-config/agent-bus/bus.sh read <id>
/Users/garam/workspace/company/knowledge/actibooky.garam/AI/ai-config/agent-bus/bus.sh claim <id>
/Users/garam/workspace/company/knowledge/actibooky.garam/AI/ai-config/agent-bus/bus.sh done <id> "<최종 보고>"
```
