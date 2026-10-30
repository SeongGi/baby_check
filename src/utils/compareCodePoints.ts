/**
 * 두 문자열을 유니코드 코드 포인트 순서로 비교합니다. JavaScript의 `<`, `>`는
 * UTF-16 코드 단위 순서라서 이모지(보충 평면)와 U+E000~U+FFFF 문자가 섞이면
 * SQLite의 기본 비교(UTF-8 바이트 순서 = 코드 포인트 순서)와 갈립니다.
 * 서버와 기기가 같은 쪽을 고르도록 타이브레이커는 모두 이 함수를 씁니다.
 */
export const compareCodePoints = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    // 앞부분이 같으므로 두 문자열의 위치는 항상 함께 움직입니다.
    i += ca > 0xffff ? 2 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
};
