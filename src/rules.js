import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { query, one } from "./db.js";
import { readPort } from "./paths.js";

const BEGIN = "<!-- pilo:begin -->";
const END = "<!-- pilo:end -->";

// codex reads AGENTS.md, claude reads CLAUDE.md. Unknown runtime gets AGENTS.md.
function ruleFile(agent) {
  return agent.runtime === "claude" ? "CLAUDE.md" : "AGENTS.md";
}

function piloRules(agent, base, agents) {
  const roster = agents
    .filter((a) => a.role !== "pilo")
    .map((a) => `| ${a.id} | ${a.name} | ${a.role} | ${a.projectName || "—"} | ${a.aliases || "—"} | ${a.specialty || "—"} |`)
    .join("\n");
  return `## Pilo 대표 agent

너는 Pilo의 대표 agent(\`role=pilo\`)다. 사용자는 Pilo TUI로 말하고, 화면에는 네가 저장한 \`final_reply\`만 보인다.

API base: \`${base}\`

### wake 처리

| 받은 메시지 | 할 일 |
| --- | --- |
| \`[pilo:inbox] 요청 도착 #N\` | \`GET ${base}/api/inbox/N\` 으로 원문 확인 → 담당 PM에게 task 생성 |
| \`[pilo:result] 결과 도착 #N\` | \`GET ${base}/api/inbox/N\` 으로 \`tasks[].pmResult\` 확인 → \`final_reply\` 저장 |

### task 생성

\`\`\`bash
curl -s -X POST ${base}/api/inbox/N/tasks \\
  -H 'content-type: application/json' \\
  -d '{"toAgentId": 2, "fromAgentId": ${agent.id}, "title": "짧은 제목", "request": "PM이 읽을 요청 전문"}'
\`\`\`

### 최종 답변 저장

\`\`\`bash
curl -s -X POST ${base}/api/inbox/N/reply \\
  -H 'content-type: application/json' \\
  -d '{"body": "사용자에게 보여줄 최종 답변"}'
\`\`\`

### 등록된 agent

| id | name | role | project | aliases | specialty |
| --- | --- | --- | --- | --- | --- |
${roster || "| — | 아직 PM이 없다 | | | | |"}

목록이 오래됐으면 \`GET ${base}/api/agents\` 로 다시 읽는다.

### 규칙

- 프로젝트 작업을 직접 하지 않는다. 라우팅과 취합만 한다.
- 담당 PM이 없는 요청만 직접 답한다.
- 중간 안내("요청 등록했습니다")는 저장하지 않는다. 저장하는 것은 \`final_reply\` 하나뿐이다.
- PM이 실패(\`status=failed\`)로 보고하면 그 사실과 원인을 \`final_reply\`에 담는다.
- 계층 밖 협업은 만들지 않는다. 다른 프로젝트가 필요하면 그 PM에게 별도 task를 만든다.`;
}

function workerRules(agent, base) {
  const kind = agent.role === "pm" ? "PM agent" : "worker agent";
  const extra =
    agent.role === "pm"
      ? `- 필요하면 자기 worker에게 task를 만든다: \`POST ${base}/api/inbox/<inboxId>/tasks\` 에 \`{"toAgentId": <workerId>, "parentTaskId": N, ...}\`.
- worker 결과를 취합해 하나의 \`pmResult\`로 보고한다.`
      : `- 결과는 자기 parent PM이 취합한다. 사용자에게 직접 보고하지 않는다.`;
  return `## Pilo ${kind}

너는 Pilo의 ${kind}(\`role=${agent.role}\`, id \`${agent.id}\`, name \`${agent.name}\`)다.

API base: \`${base}\`

### wake 처리

\`[pilo:task] 작업 도착 #N\` 을 받으면 \`N\`을 task id로 본다.

\`\`\`bash
curl -s ${base}/api/tasks/N
\`\`\`

\`request\` 가 요청 전문이고 \`userRequest\` 가 사용자 원문이다.

### 완료 보고

\`\`\`bash
curl -s -X POST ${base}/api/tasks/N/result \\
  -H 'content-type: application/json' \\
  -d '{
    "pmResult": "20줄 이하 보고",
    "status": "done",
    "tokensIn": 0,
    "tokensOut": 0,
    "runLog": [{"t": "00:12", "text": "무엇을 했는지"}],
    "artifacts": [{"path": "src/foo.ts", "delta": "+7 −2", "diff": "변경 내용"}]
  }'
\`\`\`

실패하면 \`"status": "failed"\` 와 \`"error"\` 를 함께 보낸다.

### 규칙

- \`tokensIn\`/\`tokensOut\` 은 반드시 채운다. Pilo는 세션 밖이라 직접 셀 수 없다.
- 보고는 20줄 이하. 확인한 파일, 핵심 요약, 남은 TODO, 사용자 확인 필요를 담는다.
- 변경한 파일은 \`artifacts\` 에 넣는다. 대시보드 Artifacts 탭에서 diff로 열린다.
- 긴 로그는 \`runLog\` 로 보낸다. 사용자 화면에는 올라가지 않는다.
- \`.env*\`, token, credential 은 만들거나 노출하지 않는다.
${extra}`;
}

export async function buildRules(id) {
  const agent = await one(
    `SELECT a.id, a.name, a.role, a.runtime, a.cwd, a.aliases, a.specialty, p.name AS "projectName"
     FROM agents a LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.id = $1 AND a.archived_at IS NULL`,
    [id]
  );
  if (!agent) throw Object.assign(new Error("agent not found"), { status: 404 });
  if (!agent.cwd) throw Object.assign(new Error("agent has no cwd"), { status: 400 });

  const base = `http://127.0.0.1:${readPort()}`;
  const agents = await query(
    `SELECT a.id, a.name, a.role, a.aliases, a.specialty, p.name AS "projectName"
     FROM agents a LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.archived_at IS NULL ORDER BY a.role, a.name`
  );
  const body = agent.role === "pilo" ? piloRules(agent, base, agents) : workerRules(agent, base);
  const file = join(agent.cwd, ruleFile(agent));

  let current = "";
  let exists = true;
  try {
    current = await readFile(file, "utf8");
  } catch {
    exists = false;
  }

  return {
    agent: { id: agent.id, name: agent.name, role: agent.role, runtime: agent.runtime },
    file,
    exists,
    hasBlock: current.includes(BEGIN),
    block: `${BEGIN}\n${body}\n${END}`,
    preview: body
  };
}

export async function writeRules(id) {
  const plan = await buildRules(id);
  const dir = plan.file.slice(0, plan.file.lastIndexOf("/"));
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error(`cwd not found: ${dir}`), { status: 400 });

  let current = "";
  try {
    current = await readFile(plan.file, "utf8");
  } catch {
    current = "";
  }

  // Only the marked block is ours; anything the user wrote stays untouched.
  let next;
  if (current.includes(BEGIN) && current.includes(END)) {
    const head = current.slice(0, current.indexOf(BEGIN));
    const tail = current.slice(current.indexOf(END) + END.length);
    next = head + plan.block + tail;
  } else {
    next = current.trimEnd() ? `${current.trimEnd()}\n\n${plan.block}\n` : `${plan.block}\n`;
  }

  await writeFile(plan.file, next);
  return { file: plan.file, updated: current.includes(BEGIN), bytes: next.length };
}
