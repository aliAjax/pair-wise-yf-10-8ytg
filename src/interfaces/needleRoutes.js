"use strict";

// 接口层：针床、针次、放行、换针的 HTTP 适配
// 只负责取参/调用判定层/回写响应；所有业务规则在 domain/needles.js。

const needles = require("../domain/needles");
const { send, makeId, nowIso } = require("./httpUtil");

async function needleRoutes(req, res, ctx) {
  const { pathname, state } = ctx;

  // 针床台账
  if (req.method === "GET" && pathname === "/beds") {
    return send(res, 200, { data: state.beds });
  }

  if (req.method === "POST" && pathname === "/beds") {
    const bed = needles.registerBed(state, {
      id: makeId("bed"),
      batchId: ctx.body.batchId,
      lifeLimit: ctx.body.lifeLimit,
      now: nowIso()
    });
    ctx.mutated = true;
    return send(res, 201, { data: bed });
  }

  const bedCalibrate = pathname.match(/^\/beds\/([^/]+)\/calibrate$/);
  if (bedCalibrate && req.method === "POST") {
    const bed = needles.calibrateBed(state, bedCalibrate[1], nowIso());
    ctx.mutated = true;
    return send(res, 200, { data: bed });
  }

  // 安装针床到曲目
  const install = pathname.match(/^\/tunes\/([^/]+)\/install-bed$/);
  if (install && req.method === "POST") {
    if (!ctx.body.bedId) return send(res, 400, { error: "缺少字段：bedId" });
    const bed = needles.installBed(state, install[1], ctx.body.bedId, nowIso());
    state.tunes.find((tune) => tune.id === install[1]).currentBedId = bed.id;
    ctx.mutated = true;
    return send(res, 200, { data: bed });
  }

  // 区间批量完工放行
  const complete = pathname.match(/^\/tunes\/([^/]+)\/sections\/complete$/);
  if (complete && req.method === "POST") {
    const result = needles.completeSections(
      state,
      complete[1],
      ctx.body.sectionIds,
      nowIso()
    );
    ctx.mutated = true;
    return send(res, 200, { data: result });
  }

  // 换针：结清旧床 + 新床校准后上岗
  const replace = pathname.match(/^\/tunes\/([^/]+)\/replace-needle$/);
  if (replace && req.method === "POST") {
    const tuneId = replace[1];
    if (!ctx.body.newBedId) return send(res, 400, { error: "缺少字段：newBedId" });
    const current = needles.tuneCurrentBed(state, tuneId);
    const oldBedId = ctx.body.oldBedId || (current && current.id);
    if (!oldBedId) {
      return send(res, 409, { error: "曲目当前没有服役针床，无需换针" });
    }
    const result = needles.replaceNeedle(
      state,
      tuneId,
      oldBedId,
      ctx.body.newBedId,
      nowIso()
    );
    state.tunes.find((tune) => tune.id === tuneId).currentBedId = result.newBed.id;
    ctx.mutated = true;
    return send(res, 200, { data: result });
  }

  // 针床流水追溯（重启后仍可查）
  const trace = pathname.match(/^\/tunes\/([^/]+)\/needle-trace$/);
  if (trace && req.method === "GET") {
    return send(res, 200, { data: needles.needleTrace(state, trace[1]) });
  }

  return false;
}

module.exports = { needleRoutes };
