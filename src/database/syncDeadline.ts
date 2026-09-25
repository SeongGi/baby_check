/** Release the caller even if Firebase never settles; late writers inspect this token. */
export async function withSyncDeadline<T>(
  operation: Promise<T>,
  token: { aborted: boolean },
  onTimeout: () => T,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>(resolve => {
        timer = setTimeout(() => {
          token.aborted = true;
          resolve(onTimeout());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
