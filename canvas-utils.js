// canvas-utils.js — shared canvas drawing helpers, identical in both apps.

const LANE_COLORS = ['#ff3d81','#ffd23f','#3fe0ff','#9a4dff'];

function roundRect(ctx, x, y, w, h, r){
  if(h < 0){ y += h; h = -h; }
  r = Math.min(r, w/2, Math.max(h/2, 0.1));
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

// NOTE: HIT_WINDOWS is intentionally NOT unified here. The real game uses
// { perfect:36, great:72, good:110, miss:145 } while the editor's playtest
// mode uses a looser { perfect:40, great:80, good:120, miss:150 }. That's a
// real discrepancy in the original code (playtest timing doesn't quite match
// the real game), not incidental duplication — merging them would silently
// change one app's judging feel, so each file keeps its own HIT_WINDOWS
// constant rather than importing one from here.
