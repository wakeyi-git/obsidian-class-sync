// vitest.config.ts가 "pouchdb-browser"를 이 파일로 alias한다(정규식 ^pouchdb-browser$ — 깊은 import는 제외).
// 실제 PouchService는 그대로 두고, 로컬/원격 DB를 모두 인메모리 어댑터로 강제해
// 네트워크/IndexedDB 없이 실제 replication을 검증한다.
// 깊은 경로로 진짜 모듈을 가져와 alias 순환을 피한다(self 폴리필은 setup.ts가 먼저 수행).
// @ts-nocheck
import PouchDB from "pouchdb-browser/lib/index.js";
import memory from "pouchdb-adapter-memory";

PouchDB.plugin(memory);

// 생성 시 adapter를 항상 memory로 고정. 원격 URL은 그냥 메모리 DB 이름이 되어,
// 같은 URL을 쓰는 두 PouchService 인스턴스가 같은 "원격"을 공유한다.
const MemPouch = PouchDB.defaults({ adapter: "memory" });

export default MemPouch;
