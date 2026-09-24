/** Search retained output, optionally keeping two surrounding lines per match. */
export function searchLogs(text: string, query: string, context: boolean) {
  const lines = text.split("\n");
  const needle = query.toLowerCase();
  const matches = lines.flatMap((line, index) =>
    line.toLowerCase().includes(needle) ? [index] : [],
  );
  const shown = new Set<number>();
  const padding = context ? 2 : 0;
  for (const index of matches) {
    const end = Math.min(lines.length - 1, index + padding);
    for (let i = Math.max(0, index - padding); i <= end; i++) shown.add(i);
  }
  const output: string[] = [];
  let previous = -1;
  for (const index of shown) {
    if (context && previous >= 0 && index > previous + 1) output.push("…");
    output.push(lines[index]);
    previous = index;
  }
  return { count: matches.length, text: output.join("\n") };
}
