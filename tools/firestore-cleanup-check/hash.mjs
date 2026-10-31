// 가족 id 해시. 앱(`src/database/firestoreImport.ts`의 firestoreFamilyCredentials)과
// 서버(`server/src/index.ts`의 getAuthContext)와 같은 계산을 Node crypto로 다시 만든 것입니다(07 2.3.1).
// 앱·서버 코드를 불러오지 않습니다. 같은 값이 나오는지는 check.test.mjs가 두 구현과 대조합니다.
import { hash } from 'node:crypto';

const sha256Hex = (text) => hash('sha256', text, 'hex');

/** Firestore 가족 id: 1.7.9와 같이 키를 대소문자 그대로 해시합니다. */
export const firestoreFamilyId = async (key) => sha256Hex(`babycheck:family:v2:${key}`);

/** D1 가족 id: 서버는 키를 소문자로 바꾼 뒤 해시합니다. */
export const d1FamilyId = async (key) => sha256Hex(`babycheck:family:v2:${key.toLowerCase()}`);

/** 출력용 힌트. 키나 해시는 길이와 앞 4자만 보여 줍니다(07 6장). */
export const hint = (secret) => `길이 ${secret.length}, 앞 4자 ${secret.slice(0, 4)}`;
