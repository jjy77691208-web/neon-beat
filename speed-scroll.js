// speed-scroll.js — shared "scroll-time integration" for speed-change triggers.
// ===== 속도 트리거용 스크롤-시간 적분 =====
// 노트 위치를 "지금 속도 × 남은시간"으로 근사하면, 속도가 바뀌는 순간
// 화면 위 노트마다 남은시간이 달라서 서로 다른 비율로 튀어 간격이 일그러진다.
// 대신 시간 t까지 누적된 "스크롤량(rate를 시간에 대해 적분한 값)"을 구간별로
// 미리 계산해두고, 각 노트는 자신의 hitTime에 해당하는 스크롤값을 스폰 시 한 번만
// 캐싱한다. 그러면 트리거 순간에도 위치가 끊기지 않고 이어지며(연속),
// 노트 사이의 상대적 간격이 항상 정확하게 유지된다.
//
// Both the game and the editor's playtest mode need their own independent
// timeline (they run at different times, sometimes concurrently in memory),
// so this is a factory rather than a single shared module-level state.
function createSpeedTimeline(){
  let segs = [{ t0: 0, rate: 1 }];
  let cum = [0];

  // 시작 배속 + 차트 속도 트리거로 구간별 rate 적분 테이블 구성.
  // 위치는 항상 적분값 차이로 계산하므로 트리거 순간에도 끊기지 않음.
  function build(startRate, triggers){
    segs = [{ t0: 0, rate: startRate }];
    let lastRate = startRate;
    for(const tr of (triggers || [])){
      const t0 = Number(tr.t);
      const rate = Math.max(0.75, Math.min(2, Number(tr.rate) || 1));
      if(!isFinite(t0) || t0 < 0) continue;
      if(Math.abs(rate - lastRate) < 1e-6) continue;
      if(segs.length && Math.abs(segs[segs.length-1].t0 - t0) < 1e-6){
        segs[segs.length-1].rate = rate;
      } else {
        segs.push({ t0, rate });
      }
      lastRate = rate;
    }
    cum = [0];
    for(let i = 1; i < segs.length; i++){
      const prev = segs[i-1];
      const dt = segs[i].t0 - prev.t0;
      cum[i] = cum[i-1] + prev.rate * Math.max(0, dt);
    }
  }

  // 스캐너를 여러 개로 분리해서 만들 수 있게 팩토리로 제공: 하나는 노트 스폰 시
  // hitTime(미래, 오름차순) 조회용, 하나는 매 프레임 현재 songTime(단조 증가) 조회용.
  // 하나만 쓰면 서로 다른 시간대를 오가며 스캔 위치가 매번 앞뒤로 튀어 불필요한
  // 탐색이 늘어난다.
  function makeScroller(){
    let idx = 0;
    return function(t){
      let i = Math.min(idx, segs.length - 1);
      while(i > 0 && segs[i].t0 > t) i--;
      while(i < segs.length - 1 && segs[i+1].t0 <= t) i++;
      idx = i;
      return cum[i] + segs[i].rate * (t - segs[i].t0);
    };
  }

  return { build, makeScroller };
}
