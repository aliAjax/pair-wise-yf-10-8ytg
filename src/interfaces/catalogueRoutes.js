"use strict";

// 接口层：曲目、区间、试奏问题的 HTTP 适配
// 业务规则（字段校验、进度统计）在 domain/catalogue.js。

const catalogue = require("../domain/catalogue");
const needles = require("../domain/needles");
const { send, makeId, nowIso } = require("./httpUtil");

async function catalogueRoutes(req, res, ctx) {
  const { pathname, searchParams, state, body } = ctx;

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = state.tunes.map((tune) => ({
      ...tune,
      progress: catalogue.buildProgress(state, tune.id)
    }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const tune = catalogue.buildTuneDraft({
      id: makeId("tune"),
      title: body.title,
      composer: body.composer,
      stripSpec: body.stripSpec,
      now: nowIso()
    });
    state.tunes.push(tune);
    ctx.mutated = true;
    return send(res, 201, { data: tune });
  }

  const tuneSections = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSections && req.method === "GET") {
    needles.getTune(state, tuneSections[1]);
    return send(res, 200, {
      data: state.sections.filter((item) => item.tuneId === tuneSections[1])
    });
  }

  if (tuneSections && req.method === "POST") {
    const tuneId = tuneSections[1];
    needles.getTune(state, tuneId);
    const section = catalogue.buildSectionDraft(tuneId, {
      id: makeId("section"),
      startBeat: body.startBeat,
      endBeat: body.endBeat,
      laneRange: body.laneRange,
      checked: body.checked,
      note: body.note
    });
    // 新登记的区间若曲目已有在役针床，直接归属它；否则等装针/换针时再指派
    const current = needles.tuneCurrentBed(state, tuneId);
    section.bedId = current ? current.id : null;
    state.sections.push(section);
    ctx.mutated = true;
    return send(res, 201, { data: section });
  }

  const unchecked = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (unchecked && req.method === "GET") {
    needles.getTune(state, unchecked[1]);
    return send(res, 200, {
      data: state.sections.filter((item) => item.tuneId === unchecked[1] && !item.checked)
    });
  }

  const progress = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progress && req.method === "GET") {
    return send(res, 200, { data: catalogue.buildProgress(state, progress[1]) });
  }

  const check = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (check && req.method === "PATCH") {
    const section = needles.getSection(state, check[1]);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    ctx.mutated = true;
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = state.issues.filter(
      (item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status)
    );
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const issue = catalogue.buildIssueDraft(state, {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat,
      lane: body.lane,
      description: body.description,
      now: nowIso()
    });
    state.issues.push(issue);
    ctx.mutated = true;
    return send(res, 201, { data: issue });
  }

  const issueStatus = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatus && req.method === "PATCH") {
    const issue = catalogue.resolveIssue(state, issueStatus[1], body.status, nowIso());
    if (body.note !== undefined) issue.note = body.note;
    ctx.mutated = true;
    return send(res, 200, { data: issue });
  }

  return false;
}

module.exports = { catalogueRoutes };
