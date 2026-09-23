// 判定层：纸带打孔/针床寿命/换针的全部业务规则。
// 只接收内存中的 db 对象做判定与变更，不直接读写文件。

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw new HttpError(400, `缺少字段：${missing.join(", ")}`);
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) throw new HttpError(404, "曲目不存在");
  return tune;
}

// ---- 针次计算：拍号跨度 × 音轨数 ----

// laneRange 形如 "1-10" / "4-18"，取闭区间音轨数。
function laneCount(laneRange) {
  if (typeof laneRange !== "string") {
    throw new HttpError(400, "音轨范围格式应为 \"起-止\"，如 1-10");
  }
  const match = laneRange.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) throw new HttpError(400, `音轨范围格式非法：${laneRange}`);
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (to < from) throw new HttpError(400, `音轨范围起止颠倒：${laneRange}`);
  return to - from + 1;
}

// 拍号跨度为闭区间拍数。
function beatSpan(section) {
  const start = Number(section.startBeat);
  const end = Number(section.endBeat);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
    throw new HttpError(400, `区间 ${section.id || ""} 拍号非法：${start}-${end}`);
  }
  return end - start + 1;
}

function sectionPunches(section) {
  return beatSpan(section) * laneCount(section.laneRange);
}

function bedRemaining(bed) {
  return bed.lifespanLimit - bed.punchesUsed;
}

// ---- 针床 ----

function registerBed(db, body) {
  required(body, ["installBatch", "lifespanLimit"]);
  const lifespanLimit = Number(body.lifespanLimit);
  if (!Number.isInteger(lifespanLimit) || lifespanLimit <= 0) {
    throw new HttpError(400, "寿命上限必须为正整数");
  }
  if (db.needleBeds.some((bed) => bed.installBatch === body.installBatch)) {
    throw new HttpError(409, `安装批次已登记：${body.installBatch}`, {
      code: "DUPLICATE_BATCH"
    });
  }
  const calibrated = Boolean(body.calibrated);
  const bed = {
    id: makeId("bed"),
    installBatch: body.installBatch,
    punchesUsed: 0,
    lifespanLimit,
    calibrated,
    calibratedAt: calibrated ? new Date().toISOString() : null,
    status: "in_stock",
    boundTuneId: null,
    installedAt: null,
    settledAt: null
  };
  db.needleBeds.push(bed);
  return bed;
}

function calibrateBed(db, bedId, body) {
  const bed = db.needleBeds.find((item) => item.id === bedId);
  if (!bed) throw new HttpError(404, "针床不存在");
  if (bed.status === "settled") {
    throw new HttpError(409, "针床已结清，不能再校准", { code: "BED_SETTLED" });
  }
  bed.calibrated = body.calibrated !== undefined ? Boolean(body.calibrated) : true;
  bed.calibratedAt = bed.calibrated ? new Date().toISOString() : null;
  return bed;
}

// ---- 针床与曲目绑定（上机/换针）----

function activeBinding(db, tuneId) {
  return db.bindings.find((item) => item.tuneId === tuneId && item.endedAt === null) || null;
}

function activeBed(db, tuneId) {
  const binding = activeBinding(db, tuneId);
  if (!binding) return null;
  return db.needleBeds.find((item) => item.id === binding.bedId) || null;
}

function summarizeBinding(db, binding) {
  if (!binding) return null;
  const bed = db.needleBeds.find((item) => item.id === binding.bedId) || null;
  return {
    bindingId: binding.id,
    tuneId: binding.tuneId,
    bedId: binding.bedId,
    installBatch: binding.installBatch,
    bedExists: Boolean(bed),
    calibrated: bed ? bed.calibrated : null,
    bedStatus: bed ? bed.status : "missing",
    punchesUsed: bed ? bed.punchesUsed : null,
    lifespanLimit: bed ? bed.lifespanLimit : null,
    remaining: bed ? bedRemaining(bed) : null,
    startedAt: binding.startedAt,
    startingPunches: binding.startingPunches ?? null,
    endedAt: binding.endedAt,
    endingPunches: binding.endingPunches ?? null
  };
}

function tuneNeedle(db, tuneId) {
  findTune(db, tuneId);
  return summarizeBinding(db, activeBinding(db, tuneId));
}

function tuneNeedleHistory(db, tuneId) {
  findTune(db, tuneId);
  return db.bindings
    .filter((item) => item.tuneId === tuneId)
    .map((item) => summarizeBinding(db, item));
}

// 上机：曲目当前没有服役针床时，把校准好的在库针床装上去。
function attachBed(db, tuneId, body) {
  findTune(db, tuneId);
  required(body, ["bedId"]);

  const current = activeBinding(db, tuneId);
  if (current) {
    throw new HttpError(409, "曲目仍有服役中的针床，换针须先结清旧针床", {
      code: "BED_STILL_ACTIVE",
      current: summarizeBinding(db, current)
    });
  }

  const bed = db.needleBeds.find((item) => item.id === body.bedId);
  if (!bed) throw new HttpError(404, "针床不存在");

  if (bed.status === "settled") {
    throw new HttpError(409, "针床已结清，不能上机", { code: "BED_SETTLED" });
  }
  // 同一针床不能同时服务两首曲目。
  if (bed.status === "in_use" && bed.boundTuneId !== tuneId) {
    throw new HttpError(409, `针床正服务于另一首曲目（${bed.boundTuneId}）`, {
      code: "BED_BOUND_TO_OTHER_TUNE",
      boundTuneId: bed.boundTuneId
    });
  }
  if (!bed.calibrated) {
    throw new HttpError(409, "针床未校准，校准后才能继续", { code: "BED_NOT_CALIBRATED" });
  }

  const now = new Date().toISOString();
  bed.status = "in_use";
  bed.boundTuneId = tuneId;
  bed.installedAt = now;

  const binding = {
    id: makeId("binding"),
    tuneId,
    bedId: bed.id,
    installBatch: bed.installBatch,
    startedAt: now,
    startingPunches: bed.punchesUsed,
    endedAt: null,
    endingPunches: null
  };
  db.bindings.push(binding);
  return summarizeBinding(db, binding);
}

// 换针第一步：结清旧针床（闭合服役记录、释放针床供留档）。
function settleBed(db, tuneId) {
  findTune(db, tuneId);
  const binding = activeBinding(db, tuneId);
  if (!binding) throw new HttpError(404, "曲目当前没有服役中的针床");

  const bed = db.needleBeds.find((item) => item.id === binding.bedId);
  const now = new Date().toISOString();

  binding.endedAt = now;
  binding.endingPunches = bed ? bed.punchesUsed : null;

  let bedView = null;
  if (bed) {
    bed.status = "settled";
    bed.boundTuneId = null;
    bed.settledAt = now;
    bedView = bed;
  }

  return {
    settled: summarizeBinding(db, binding),
    bed: bedView
  };
}

// ---- 整批放行（区间完工累加针次）----

// 全部判定通过后才落任何变更：寿命不足或针床未校准则整批返回409，
// 区间、问题与计数保持原样。
function releaseSections(db, tuneId, body) {
  findTune(db, tuneId);
  required(body, ["sectionIds"]);
  if (!Array.isArray(body.sectionIds) || body.sectionIds.length === 0) {
    throw new HttpError(400, "sectionIds 必须是非空数组");
  }

  const sectionIds = body.sectionIds.map(String);
  if (new Set(sectionIds).size !== sectionIds.length) {
    throw new HttpError(400, "放行批次中存在重复区间");
  }

  const binding = activeBinding(db, tuneId);
  if (!binding) {
    throw new HttpError(409, "曲目未绑定在用针床，请先安装针床", {
      code: "NO_ACTIVE_BED"
    });
  }
  const bed = db.needleBeds.find((item) => item.id === binding.bedId);
  if (!bed) {
    throw new HttpError(409, "绑定的针床记录缺失，无法放行", { code: "BED_MISSING" });
  }
  if (!bed.calibrated) {
    throw new HttpError(409, "针床未校准，整批退回", {
      code: "BED_NOT_CALIBRATED",
      bed: { id: bed.id, installBatch: bed.installBatch, calibrated: false }
    });
  }

  // 先全部判定：区间归属、重复放行、针次合计是否超限。
  const plan = sectionIds.map((sectionId) => {
    const section = db.sections.find((item) => item.id === sectionId);
    if (!section) throw new HttpError(404, `区间不存在：${sectionId}`);
    if (section.tuneId !== tuneId) {
      throw new HttpError(400, `区间 ${sectionId} 不属于该曲目`);
    }
    if (section.released) {
      throw new HttpError(409, `区间 ${sectionId} 已放行，不能重复计数`, {
        code: "SECTION_ALREADY_RELEASED",
        sectionId
      });
    }
    return { section, punches: sectionPunches(section) };
  });

  const batchPunches = plan.reduce((sum, item) => sum + item.punches, 0);
  const remainingBefore = bedRemaining(bed);
  if (batchPunches > remainingBefore) {
    throw new HttpError(409, "针床寿命不足，整批退回", {
      code: "INSUFFICIENT_LIFESPAN",
      bed: {
        id: bed.id,
        installBatch: bed.installBatch,
        punchesUsed: bed.punchesUsed,
        lifespanLimit: bed.lifespanLimit,
        remaining: remainingBefore
      },
      required: batchPunches,
      shortBy: batchPunches - remainingBefore
    });
  }

  // 全部通过后才变更：区间记录所用针床，针床累加已打孔数。
  const releasedAt = new Date().toISOString();
  const releasedSections = plan.map(({ section, punches }) => {
    section.released = true;
    section.releasedAt = releasedAt;
    section.bedId = bed.id;
    section.installBatch = bed.installBatch;
    section.punches = punches;
    return {
      id: section.id,
      startBeat: section.startBeat,
      endBeat: section.endBeat,
      laneRange: section.laneRange,
      punches,
      bedId: bed.id
    };
  });
  bed.punchesUsed += batchPunches;

  return {
    tuneId,
    bed: {
      id: bed.id,
      installBatch: bed.installBatch,
      punchesUsed: bed.punchesUsed,
      lifespanLimit: bed.lifespanLimit,
      remaining: bedRemaining(bed)
    },
    sectionCount: releasedSections.length,
    batchPunches,
    releasedSections
  };
}

// ---- 原有曲目/区间/问题规则 ----

function createTune(db, body) {
  required(body, ["title", "stripSpec"]);
  return {
    id: makeId("tune"),
    title: body.title,
    composer: body.composer || "",
    stripSpec: body.stripSpec,
    createdAt: new Date().toISOString()
  };
}

function createSection(db, tuneId, body) {
  findTune(db, tuneId);
  required(body, ["startBeat", "endBeat", "laneRange"]);
  const startBeat = Number(body.startBeat);
  const endBeat = Number(body.endBeat);
  if (!Number.isInteger(startBeat) || !Number.isInteger(endBeat) || endBeat < startBeat) {
    throw new HttpError(400, "区间拍号非法");
  }
  laneCount(body.laneRange);
  return {
    id: makeId("section"),
    tuneId,
    startBeat,
    endBeat,
    laneRange: body.laneRange,
    checked: Boolean(body.checked),
    note: body.note || ""
  };
}

function checkSection(db, sectionId, body) {
  const section = db.sections.find((item) => item.id === sectionId);
  if (!section) throw new HttpError(404, "区间不存在");
  section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
  section.note = body.note ?? section.note;
  return section;
}

function createIssue(db, body) {
  required(body, ["tuneId", "sectionId", "type", "description"]);
  findTune(db, body.tuneId);
  const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
  if (!section) throw new HttpError(400, "区间不存在或不属于该曲目");
  return {
    id: makeId("issue"),
    tuneId: body.tuneId,
    sectionId: body.sectionId,
    type: body.type,
    beat: body.beat === undefined ? null : Number(body.beat),
    lane: body.lane === undefined ? null : Number(body.lane),
    description: body.description,
    status: "open",
    createdAt: new Date().toISOString(),
    resolvedAt: null
  };
}

function updateIssueStatus(db, issueId, body) {
  const issue = db.issues.find((item) => item.id === issueId);
  if (!issue) throw new HttpError(404, "问题不存在");
  required(body, ["status"]);
  issue.status = body.status;
  issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
  issue.note = body.note ?? issue.note;
  return issue;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const releasedCount = sections.filter((item) => item.released).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  const bed = activeBed(db, tuneId);
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    releasedSections: releasedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    currentBed: bed
      ? {
          id: bed.id,
          installBatch: bed.installBatch,
          calibrated: bed.calibrated,
          punchesUsed: bed.punchesUsed,
          lifespanLimit: bed.lifespanLimit,
          remaining: bedRemaining(bed)
        }
      : null,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

module.exports = {
  HttpError,
  makeId,
  required,
  laneCount,
  beatSpan,
  sectionPunches,
  bedRemaining,
  registerBed,
  calibrateBed,
  activeBinding,
  activeBed,
  tuneNeedle,
  tuneNeedleHistory,
  attachBed,
  settleBed,
  releaseSections,
  findTune,
  createTune,
  createSection,
  checkSection,
  createIssue,
  updateIssueStatus,
  buildProgress
};
