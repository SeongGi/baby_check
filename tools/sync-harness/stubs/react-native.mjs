// 하네스는 안드로이드 기기를 흉내 냅니다. 동기화 계층이 쓰는 것은 Platform 뿐입니다.
export const Platform = { OS: 'android', select: (options) => options.android ?? options.default };
