"use strict";

// 针床与针次的判定层（纯业务规则，不碰文件系统、不发 HTTP）
// 状态副本由调用方传入，所有函数在校验通过后才就地改写副本；
// 校验失败抛 BusinessError，不产生任何副作用 —— 供接口层实现“整批 409，原样不动”。

const { BusinessError } = require("./errors");

// 针床生命周期：在库 -> 已校准 -> 服役中（绑定一首曲目）-> 已结清退役
const BED_STATUS = {
  IN_STORE: "in_store", // 刚登记，尚未校准
  CALIBRATED: "calibrated", // 校准完成，等待安装
  IN_SERVICE: "in_service", // 正在为某首曲目打孔
  RETIRED: "retired" // 换针结清，永久退役
};

// ---------- 纯计算 ----------

// 解析音轨范围，支持 "1-10"、"1,3,5"、"1-3,7"
function parseLaneCount(laneRange) {
  if (typeof laneRange !== "string" || !laneRange.trim()) {
    throw new BusinessError("INVALID", "音轨范围 laneRange 非法");
  }
  const lanes = new Set();
  for (const part of laneRange.split(",")) {
    const token = part.trim();
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const from = Number(rangeMatch[1]);
      const to = Number(rangeMatch[2]);
      if (to < from) throw new BusinessError("INVALID", "音轨范围起点不能大于终点");
      for (let lane = from; lane <= to; lane += 1) lanes.add(lane);
    } else if (/^\d+$/.test(token)) {
      lanes.add(Number(token));
    } else {
      throw new BusinessError("INVALID", "音轨范围 laneRange 非法");
    }
  }
  if (lanes.size === 0) throw new BusinessError("INVALID", "音轨范围 laneRange 非法");
  return lanes.size;
}

// 拍号跨度：闭区间 [startBeat, endBeat]
function beatSpan(startBeat, endBeat) {
  return endBeat - startBeat + 1;
}

// 区间完工需要的针次 = 拍号跨度 × 音轨数
function requiredStrokes(section) {
  return beatSpan(section.startBeat, section.endBeat) * parseLaneCount(section.laneRange);
}

// ---------- 取数辅助 ----------

const getTune = (state, tuneId) => {
  const tune = state.tunes.find((item) => item.id === tuneId);
  if (!tune) throw new BusinessError("NOT_FOUND", "曲目不存在");
  return tune;
};

const getBed = (state, bedId) => {
  const bed = state.beds.find((item) => item.id === bedId);
  if (!bed) throw new BusinessError("NOT_FOUND", "针床不存在");
  return bed;
};

const getSection = (state, sectionId) => {
  const section = state.sections.find((item) => item.id === sectionId);
  if (!section) throw new BusinessError("NOT_FOUND", "区间不存在");
  return section;
};

const tuneCurrentBed = (state, tuneId) =>
  state.beds.find(
    (bed) => bed.tuneId === tuneId && bed.status === BED_STATUS.IN_SERVICE
  ) || null;

const appendBedEvent = (bed, type, detail, at) => {
  bed.events.push({ at, type, detail: detail || {} });
};

// ---------- 判定：登记针床（安装批次、寿命上限） ----------

function registerBed(state, input) {
  const batchId = String(input.batchId || "").trim();
  const lifeLimit = Number(input.lifeLimit);
  if (!batchId) throw new BusinessError("INVALID", "缺少安装批次 batchId");
  if (!Number.isInteger(lifeLimit) || lifeLimit <= 0) {
    throw new BusinessError("INVALID", "寿命上限 lifeLimit 必须为正整数");
  }
  const bed = {
    id: input.id,
    batchId,
    lifeLimit,
    punched: 0, // 已打孔数（针次累计）
    status: BED_STATUS.IN_STORE,
    tuneId: null,
    installedAt: null,
    retiredAt: null,
    events: [
      { at: input.now, type: "registered", detail: { batchId, lifeLimit } }
    ]
  };
  state.beds.push(bed);
  return bed;
}

// ---------- 判定：针床校准 ----------

function calibrateBed(state, bedId, now) {
  const bed = getBed(state, bedId);
  if (bed.status !== BED_STATUS.IN_STORE) {
    throw new BusinessError("CONFLICT", "只有在库未校准的针床才能校准", {
      status: bed.status
    });
  }
  bed.status = BED_STATUS.CALIBRATED;
  bed.calibratedAt = now;
  appendBedEvent(bed, "calibrated", {}, now);
  return bed;
}

// ---------- 判定：给曲目安装针床 ----------

function installBed(state, tuneId, bedId, now) {
  getTune(state, tuneId);
  const bed = getBed(state, bedId);

  // 同一针床不能同时服务两首曲目
  if (bed.status === BED_STATUS.IN_SERVICE) {
    throw new BusinessError("CONFLICT", "针床正在服役中，不能同时服务两首曲目", {
      tuneId: bed.tuneId
    });
  }
  if (bed.status === BED_STATUS.RETIRED) {
    throw new BusinessError("CONFLICT", "针床已结清退役，不能再次安装");
  }
  // 针床未校准不得开工
  if (bed.status !== BED_STATUS.CALIBRATED) {
    throw new BusinessError("CONFLICT", "针床未校准，不能安装到曲目", {
      status: bed.status
    });
  }
  // 一首曲目同时只有一个服役针床（换针走 replaceNeedle 先结清旧床）
  const active = tuneCurrentBed(state, tuneId);
  if (active) {
    throw new BusinessError("CONFLICT", "曲目已有服役针床，换针需先结清旧针床", {
      bedId: active.id
    });
  }

  bed.status = BED_STATUS.IN_SERVICE;
  bed.tuneId = tuneId;
  bed.installedAt = now;
  appendBedEvent(bed, "installed", { tuneId }, now);

  // 尚未完工的区间归属当前针床（已完工区间保留原针床记录）
  for (const section of state.sections) {
    if (section.tuneId === tuneId && !section.punched) section.bedId = bedId;
  }
  return bed;
}

// ---------- 判定：区间批量完工（核心放行规则） ----------

function completeSections(state, tuneId, sectionIds, now) {
  getTune(state, tuneId);
  const bed = tuneCurrentBed(state, tuneId);

  // 未校准 / 无针床：整批 409，区间与计数原样不动
  if (!bed) {
    throw new BusinessError("CONFLICT", "曲目没有已校准且在役的针床，不能放行打孔");
  }

  const ids = sectionIds || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new BusinessError("INVALID", "sectionIds 必须为非空数组");
  }

  // —— 先整批预检查，任何一项不过都不动数据 ——
  const pending = [];
  for (const sectionId of ids) {
    const section = getSection(state, sectionId); // 缺区间直接 404
    if (section.tuneId !== tuneId) {
      throw new BusinessError("CONFLICT", "存在不属于该曲目的区间，整批退回", {
        sectionId
      });
    }
    if (section.punched) {
      throw new BusinessError("CONFLICT", "区间已完工，不能重复打孔", {
        sectionId
      });
    }
    pending.push(section);
  }

  // 按拍号跨度 × 音轨数累加针次，先算总账
  const needs = pending.map((section) => ({
    section,
    strokes: requiredStrokes(section)
  }));
  const totalStrokes = needs.reduce((sum, item) => sum + item.strokes, 0);

  // 寿命不足：整批 409，区间、问题与计数保持原样
  if (bed.punched + totalStrokes > bed.lifeLimit) {
    throw new BusinessError("CONFLICT", "针床剩余寿命不足以完成本批区间，整批退回", {
      bedId: bed.id,
      punched: bed.punched,
      lifeLimit: bed.lifeLimit,
      remaining: bed.lifeLimit - bed.punched,
      required: totalStrokes
    });
  }

  // —— 全部通过后才放行，逐区间累加针次 ——
  const completed = needs.map(({ section, strokes }) => {
    bed.punched += strokes;
    section.punched = true;
    section.punchedAt = now;
    section.bedId = bed.id;
    appendBedEvent(bed, "punched", { tuneId, sectionId: section.id, strokes }, now);
    return { id: section.id, strokes };
  });

  return {
    bed: {
      id: bed.id,
      batchId: bed.batchId,
      punched: bed.punched,
      lifeLimit: bed.lifeLimit,
      remaining: bed.lifeLimit - bed.punched
    },
    totalStrokes,
    completed
  };
}

// ---------- 判定：换针（结清旧床 -> 新床校准后安装） ----------

function replaceNeedle(state, tuneId, oldBedId, newBedId, now) {
  getTune(state, tuneId);
  const oldBed = getBed(state, oldBedId);
  const newBed = getBed(state, newBedId);

  if (oldBedId === newBedId) {
    throw new BusinessError("INVALID", "新针床不能与旧针床相同");
  }
  if (oldBed.tuneId !== tuneId || oldBed.status !== BED_STATUS.IN_SERVICE) {
    throw new BusinessError("CONFLICT", "旧针床并非该曲目当前服役针床，无法结清", {
      status: oldBed.status,
      tuneId: oldBed.tuneId
    });
  }
  // 先结清旧针床
  if (newBed.status === BED_STATUS.IN_SERVICE) {
    throw new BusinessError("CONFLICT", "新针床正在为其他曲目服役，同一针床不能同时服务两首曲目", {
      tuneId: newBed.tuneId
    });
  }
  if (newBed.status === BED_STATUS.RETIRED) {
    throw new BusinessError("CONFLICT", "新针床已退役，不能使用");
  }
  // 新针床校准后才能继续
  if (newBed.status !== BED_STATUS.CALIBRATED) {
    throw new BusinessError("CONFLICT", "新针床尚未校准，不能换针放行", {
      status: newBed.status
    });
  }

  // 结清旧床：退役、解除绑定
  oldBed.status = BED_STATUS.RETIRED;
  oldBed.retiredAt = now;
  appendBedEvent(oldBed, "settled", { tuneId, punched: oldBed.punched }, now);

  // 新床上岗
  newBed.status = BED_STATUS.IN_SERVICE;
  newBed.tuneId = tuneId;
  newBed.installedAt = now;
  appendBedEvent(newBed, "installed", { tuneId, replacedFrom: oldBedId }, now);

  // 已校对/已完工区间不动；未完工区间改用新针床
  const reassigned = [];
  for (const section of state.sections) {
    if (section.tuneId === tuneId && !section.punched) {
      section.bedId = newBedId;
      reassigned.push(section.id);
    }
  }

  return {
    retiredBed: {
      id: oldBed.id,
      batchId: oldBed.batchId,
      punched: oldBed.punched,
      lifeLimit: oldBed.lifeLimit
    },
    newBed: {
      id: newBed.id,
      batchId: newBed.batchId,
      punched: newBed.punched,
      lifeLimit: newBed.lifeLimit
    },
    reassignedSectionIds: reassigned
  };
}

// ---------- 追溯：重启后仍可查到每首曲目的针床流水 ----------

function needleTrace(state, tuneId) {
  getTune(state, tuneId);
  const current = tuneCurrentBed(state, tuneId);
  // 凡是曾为该曲目服务过的针床（含已退役），整份流水都保留，便于重启后追溯
  const beds = state.beds
    .filter((bed) => bed.events.some((event) => event.detail.tuneId === tuneId))
    .map((bed) => ({
      id: bed.id,
      batchId: bed.batchId,
      lifeLimit: bed.lifeLimit,
      punched: bed.punched,
      remaining: bed.lifeLimit - bed.punched,
      status: bed.status,
      tuneId: bed.tuneId,
      installedAt: bed.installedAt,
      retiredAt: bed.retiredAt,
      // 登记、校准发生在绑定曲目之前，也属于该针床的完整履历，原样返回
      events: bed.events.map((event) => ({
        at: event.at,
        type: event.type,
        detail: event.detail
      }))
    }));
  return {
    tuneId,
    currentBedId: current ? current.id : null,
    beds
  };
}

module.exports = {
  BED_STATUS,
  parseLaneCount,
  beatSpan,
  requiredStrokes,
  getTune,
  getBed,
  getSection,
  tuneCurrentBed,
  registerBed,
  calibrateBed,
  installBed,
  completeSections,
  replaceNeedle,
  needleTrace
};
