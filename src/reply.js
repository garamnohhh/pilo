// What `pilo reply N "lead" --with-results` saves: the desk's short lead, then
// each PM's result as the PM wrote it. The desk still reads every result in full
// and still saves the answer; it just stops retyping what is already written.

// A worker that answers to a PM on the same request is left out: its PM has
// already folded that report into its own. A task sent again replaces the one
// before it, so a retry is not attached twice.
export function pickResults(tasks) {
  const holders = new Set(tasks.map((task) => String(task.agentId)));
  const latest = new Map();
  for (const task of tasks) {
    if (!["done", "failed"].includes(task.status)) continue;
    if (task.role === "worker" && task.parentRole === "pm" && holders.has(String(task.parentId))) continue;
    latest.set(String(task.agentId), task);
  }
  return [...latest.values()];
}

// One result goes straight under the lead; several are named, so the reader can
// tell whose is whose. A failure is always named, with its reason.
export function withResults(lead, results, failedWord = "failed") {
  const parts = [String(lead || "").trim()].filter(Boolean);
  const many = results.length > 1;
  for (const result of results) {
    const failed = result.status === "failed";
    const label = many || failed ? `**${result.agent}**${failed ? ` · ${failedWord}` : ""}\n\n` : "";
    const why = failed && result.error ? `${result.error}\n\n` : "";
    parts.push(`${label}${why}${String(result.pmResult || "").trim()}`.trim());
  }
  return parts.join("\n\n---\n\n");
}
