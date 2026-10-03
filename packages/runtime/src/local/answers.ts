/** Pull approval answers one at a time from a line source (piped stdin). Returns '' once the source is exhausted. */
export function createAnswerSource(lines: AsyncIterable<string>): () => Promise<string> {
  const it = lines[Symbol.asyncIterator]();
  return async () => {
    const { value, done } = await it.next();
    return done ? '' : value;
  };
}

export function isApproval(answer: string): boolean {
  return answer.trim().toLowerCase() === 'y';
}
