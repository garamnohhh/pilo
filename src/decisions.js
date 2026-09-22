// What still waits on the user. The screens pin these under the conversation, so
// the rule for which ones show has to be the same in both, and has to let go of
// one the moment it is answered: a server that answers this question still sends
// nothing about answered ones, and an older one's list of them is ignored here.
export function waitingDecisions(overview) {
  const rows = overview?.decisions || [];
  return rows
    .filter((d) => d && d.taskId && d.open !== false && !d.answeredAt)
    .slice()
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}

// Two agents can end up asking the user the same thing about one request: a
// worker asks its PM for a go-ahead, the PM carries it up, and both sit blocked.
// The user saw two lines and could only answer one — pirep's in-1595 was exactly
// that pair. These fold such a pair into the one line the user should see.
//
// Only two things count as the same question, and both are stated rather than
// guessed:
//   1. the PM said so — it filed its block for a worker's block
//      (`pilo block <id> "…" --for <worker task>`). A PM relaying a question is
//      the rule the roster already sets out; this records which one.
//   2. word for word — the same request, and the same text once case, spacing
//      and markdown emphasis are taken out. A question pasted up verbatim.
//
// Wording is not measured, and lineage alone is not enough. Both were tried:
// "may I take a dump of the production database" and "may I delete the staging
// containers", asked by a PM and its own worker on one request, score 0.138 on
// token overlap — and the real duplicate pair scores 0.125. There is no
// threshold between them, so a guess would hide real decisions. Two questions
// nobody has linked stay two lines, which is the safe way to be wrong.
export function plainQuestion(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[*_`~#>]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?·:;,\s]+$/, "")
    .trim();
}

export function sameQuestion(a, b) {
  if (!a || !b) return false;
  if (String(a.inboxId ?? "") !== String(b.inboxId ?? "")) return false;
  if (String(a.taskId) === String(b.taskId)) return false;
  const carries = (x, y) => x.relayOf && String(x.relayOf) === String(y.taskId);
  if (carries(a, b) || carries(b, a)) return true;
  const one = plainQuestion(a.text);
  return Boolean(one) && one === plainQuestion(b.text);
}

// The line that stays is the one carrying the other: a PM that filed for its
// worker is who the user answers. Everyone who asked is kept on it, and
// answering it answers all of them.
export function groupDecisions(rows) {
  const kept = [];
  for (const row of rows || []) {
    const mate = kept.find((k) => sameQuestion(k, row));
    if (!mate) {
      kept.push({ ...row, askedBy: [row.agent].filter(Boolean), alsoTaskIds: [] });
      continue;
    }
    const rowCarries = row.relayOf && String(row.relayOf) === String(mate.taskId);
    const stay = rowCarries ? { ...row } : mate;
    const folded = rowCarries ? mate : row;
    stay.askedBy = [...new Set([...(mate.askedBy || [mate.agent]), ...(row.askedBy || [row.agent])].filter(Boolean))];
    stay.alsoTaskIds = [...new Set([...(mate.alsoTaskIds || []), ...(folded.alsoTaskIds || []), folded.taskId].map(String))]
      .filter((id) => id !== String(stay.taskId));
    kept[kept.indexOf(mate)] = stay;
  }
  return kept;
}
