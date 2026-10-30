/**
 * 문자열의 UTF-8 바이트 수입니다. 코드 포인트를 직접 세므로 `TextEncoder`가 없는
 * 런타임에서도 같은 값을 냅니다. 짝 없는 서로게이트는 `TextEncoder`처럼
 * U+FFFD(3바이트)로 셉니다.
 */
export const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
};
