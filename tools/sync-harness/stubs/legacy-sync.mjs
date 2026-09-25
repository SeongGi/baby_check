// 구버전 서버는 이번 검증 범위 밖이라 네트워크 호출 없이 비활성화합니다.
export const readLegacyCloud = async () => null;
export const writeLegacyCloud = async () => false;
