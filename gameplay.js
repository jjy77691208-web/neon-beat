// gameplay.js — shared hit-judgment, scoring, and hold-note formulas.
//
// This does NOT unify the two apps' tuning constants (HIT_WINDOWS, per-app
// score numbers) — the real game and the editor's playtest mode intentionally
// use different timing windows (see js/shared/canvas-utils.js for why).
// What was actually duplicated, and fragile because of it, was the *formula*:
// the game (js/game/input.js, js/game/game.js) and the editor's test-play
// mode (js/editor/editor.js) each had their own copy of "how do we turn a
// timing delta into a judgement" and "how do we grade a hold note's tail",
// and the copies had already drifted (e.g. editor test-play never scored
// hold ticks or graded tail accuracy). Both apps now call these functions
// with their own config, so the formula can't silently re-diverge again.

/**
 * Turn a signed timing delta (input time − ideal hit time, ms) into a
 * judgement. Returns null if the delta is outside the miss window.
 * @param {number} signedDelta >0 = LATE input, <0 = EARLY input
 * @param {{perfect:number, great:number, good:number, miss:number}} windows
 */
function judgeDelta(signedDelta, windows){
  const abs = Math.abs(signedDelta);
  let judge, color, base;
  if(abs <= windows.perfect){
    judge = 'PERFECT'; color = '#3fe0ff';
    // Perfect 구간 안에서도 중심에 가까울수록 점수↑ (250~300)
    const t = abs / windows.perfect;
    base = Math.round(300 - t * 50);
  } else if(abs <= windows.great){
    judge = 'GREAT'; color = '#9a4dff'; base = 200;
  } else if(abs <= windows.good){
    judge = 'GOOD'; color = '#ffd23f'; base = 100;
  } else if(abs <= windows.miss){
    judge = 'BAD'; color = '#ff3d81'; base = 50;
  } else {
    return null;
  }
  let side = '';
  if(signedDelta < -2) side = 'EARLY';
  else if(signedDelta > 2) side = 'LATE';
  return { judge, color, points: base, side, abs };
}

/** Score multiplier applied to a hold note's head based on its hit judgement. */
function holdHeadMult(judge){
  if(judge === 'PERFECT') return 1;
  if(judge === 'GREAT') return 0.88;
  if(judge === 'GOOD') return 0.7;
  return 0.45; // BAD
}

/**
 * Grade how accurately a hold note was released relative to its end time.
 * @param {number} absTail |judgeTime − holdEndTime| at release, ms
 * @param {{perfect:number, great:number}} windows
 * @param {{tailPerfect:number, tailGreat:number, tailOk:number}} holdScore
 */
function holdTailJudgment(absTail, windows, holdScore){
  if(absTail > windows.great){
    return { bonus: holdScore.tailOk, label: 'HOLD OK', color: '#ffd23f' };
  }
  if(absTail > windows.perfect){
    return { bonus: holdScore.tailGreat, label: 'HOLD GREAT', color: '#9a4dff' };
  }
  return { bonus: holdScore.tailPerfect, label: 'HOLD PERFECT', color: '#3fe0ff' };
}

// Default hold-note scoring weights. The real game used to keep its own
// private copy of this object; the editor's test-play mode never had an
// equivalent at all (it awarded a flat, untuned hold score with no tick or
// tail grading). Both now share this so a test-play run in the editor is
// actually representative of the real game's scoring.
const DEFAULT_HOLD_SCORE = {
  headScale: 0.5,       // 헤드 = 일반 노트 점수의 50%
  tickBase: 28,         // 반박마다 틱 기본점
  completeBase: 120,    // 완주 기본점
  perBeat: 70,          // 홀드 1박당 길이 보너스
  tailPerfect: 90,
  tailGreat: 55,
  tailOk: 25
};
