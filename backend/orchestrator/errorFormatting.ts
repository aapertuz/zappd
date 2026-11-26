const MAX_ERROR_LENGTH = 240;

export function formatApiError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const traceback = message.lastIndexOf('Traceback (most recent call last):');
  const lines = message.slice(Math.max(0, traceback)).split(/\r?\n/);
  const exception =
    traceback === -1
      ? undefined
      : lines.findLast((line) =>
          /^[\w.]*(?:Error|Exception|Interrupt|Exit|Warning):\s*\S/.test(line),
        );
  const summary =
    (traceback === -1 ? message : (exception ?? fallback)).replace(/\s+/g, ' ').trim() || fallback;
  return summary.length > MAX_ERROR_LENGTH
    ? `${summary.slice(0, MAX_ERROR_LENGTH - 1).trimEnd()}…`
    : summary;
}
