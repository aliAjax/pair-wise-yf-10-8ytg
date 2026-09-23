"use strict";

// 曲目、区间、试奏问题的判定层（纯业务规则）

const { BusinessError } = require("./errors");
const needles = require("./needles");

function buildTuneDraft(input) {
  const title = String(input.title || "").trim();
  if (!title) throw new BusinessError("INVALID", "缺少字段：title");
  if (!input.stripSpec) throw new BusinessError("INVALID", "缺少字段：stripSpec");
  return {
    id: input.id,
    title,
    composer: input.composer || "",
    stripSpec: input.stripSpec,
    currentBedId: null,
    createdAt: input.now
  };
}

function buildSectionDraft(tuneId, input) {
  const startBeat = Number(input.startBeat);
  const endBeat = Number(input.endBeat);
  if (!Number.isInteger(startBeat) || !Number.isInteger(endBeat)) {
    throw new BusinessError("INVALID", "startBeat/endBeat 必须为整数");
  }
  if (endBeat < startBeat) {
    throw new BusinessError("INVALID", "endBeat 不能小于 startBeat");
  }
  // 顺带校验音轨范围，非法范围在打孔前就拦住
  const laneCount = needles.parseLaneCount(input.laneRange);

  return {
    id: input.id,
    tuneId,
    startBeat,
    endBeat,
    laneRange: String(input.laneRange).trim(),
    laneCount,
    checked: Boolean(input.checked),
    punched: false, // 是否已打孔放行
    bedId: null, // 完工或归属的针床
    punchedAt: null,
    note: input.note || ""
  };
}

function buildIssueDraft(state, input) {
  const tune = state.tunes.find((item) => item.id === input.tuneId);
  if (!tune) throw new BusinessError("NOT_FOUND", "曲目不存在");
  const section = state.sections.find(
    (item) => item.id === input.sectionId && item.tuneId === input.tuneId
  );
  if (!section) throw new BusinessError("INVALID", "区间不存在或不属于该曲目");
  if (!input.type) throw new BusinessError("INVALID", "缺少字段：type");
  if (!input.description) throw new BusinessError("INVALID", "缺少字段：description");

  return {
    id: input.id,
    tuneId: input.tuneId,
    sectionId: input.sectionId,
    type: input.type,
    beat: input.beat === undefined ? null : Number(input.beat),
    lane: input.lane === undefined ? null : Number(input.lane),
    description: input.description,
    status: "open",
    createdAt: input.now,
    resolvedAt: null
  };
}

function resolveIssue(state, issueId, status, now) {
  const issue = state.issues.find((item) => item.id === issueId);
  if (!issue) throw new BusinessError("NOT_FOUND", "问题不存在");
  if (!status) throw new BusinessError("INVALID", "缺少字段：status");
  issue.status = status;
  issue.resolvedAt = status === "resolved" ? now : null;
  return issue;
}

// 曲目进度：原有校对统计 + 针床/针次统计
function buildProgress(state, tuneId) {
  const tune = state.tunes.find((item) => item.id === tuneId);
  if (!tune) throw new BusinessError("NOT_FOUND", "曲目不存在");
  const sections = state.sections.filter((item) => item.tuneId === tuneId);
  const issues = state.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const punchedCount = sections.filter((item) => item.punched).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  const bed = needles.tuneCurrentBed(state, tuneId);
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    punchedSections: punchedCount,
    unpunchSections: sections.length - punchedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0,
    currentBed: bed
      ? {
          id: bed.id,
          batchId: bed.batchId,
          punched: bed.punched,
          lifeLimit: bed.lifeLimit,
          remaining: bed.lifeLimit - bed.punched
        }
      : null
  };
}

module.exports = {
  buildTuneDraft,
  buildSectionDraft,
  buildIssueDraft,
  resolveIssue,
  buildProgress
};
