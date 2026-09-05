// storage.js — shared safe localStorage/sessionStorage access.
// 일부 브라우저의 프라이빗 모드·차단된 저장소 설정·특정 file:// 환경에서는
// localStorage 호출 자체가 예외를 던질 수 있다. 이 스크립트는 최상단에서
// 곧바로 localStorage를 읽으므로, 그 예외를 잡지 않으면 이후 코드가 전혀
// 실행되지 않아 게임/에디터가 통째로 먹통이 된다. 모든 접근을 이 헬퍼로
// 감싸서 그런 환경에서도 "설정 저장만 안 될 뿐" 앱 자체는 항상 뜨도록 한다.
// window.localStorage/sessionStorage 자체를 "읽는" 시점에 예외가 나는 샌드박스도
// 있으므로, 프로퍼티 접근까지 통째로 try 안에서 매번 새로 수행한다.
function makeSafeStorage(kind){
  return {
    get(key, fallback){
      try{ const v = window[kind].getItem(key); return v == null ? fallback : v; }
      catch(_){ return fallback; }
    },
    set(key, value){
      try{ window[kind].setItem(key, value); return true; }
      catch(_){ return false; }
    }
  };
}
