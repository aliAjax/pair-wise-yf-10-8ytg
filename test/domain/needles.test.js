"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { seedData } = require("../../src/store/jsonStore");
const needles = require("../../src/domain/needles");
const { BusinessError } = require("../../src/domain/errors");

const T = "2026-09-23T00:00:00.000Z";

function fresh() {
  return seedData();
}

function expectConflict(fn, messageIncludes) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof BusinessError);
      assert.equal(error.status, 409);
      if (messageIncludes) assert.match(error.message, new RegExp(messageIncludes));
      return true;
    },
    "应抛出 409 CONFLICT"
  );
}

test("针次 = 拍号跨度 × 音轨数", () => {
  assert.equal(needles.parseLaneCount("1-10"), 10);
  assert.equal(needles.parseLaneCount("4-18"), 15);
  assert.equal(needles.parseLaneCount("1-3,7"), 4);
  // section_demo_1: (32-1+1)*10 = 320
  assert.equal(needles.requiredStrokes(fresh().sections[0]), 320);
  // section_demo_2: (64-33+1)*15 = 480
  assert.equal(needles.requiredStrokes(fresh().sections[1]), 480);
});

test("未装针床的曲目不能放行，返回 409", () => {
  const state = fresh();
  expectConflict(
    () => needles.completeSections(state, "tune_demo", ["section_demo_1"], T),
    "没有已校准"
  );
});

test("未校准针床不能安装，409 且计数不动", () => {
  const state = fresh();
  needles.registerBed(state, { id: "b_raw", batchId: "BX1", lifeLimit: 1000, now: T });
  expectConflict(() => needles.installBed(state, "tune_demo", "b_raw", T), "未校准");
  assert.equal(state.beds.find((b) => b.id === "b_raw").status, "in_store");
});

test("放行成功：针次累加，区间标记完工针床", () => {
  const state = fresh();
  needles.installBed(state, "tune_demo", "bed_demo", T);
  const result = needles.completeSections(state, "tune_demo", ["section_demo_1"], T);
  assert.equal(result.totalStrokes, 320);
  assert.equal(result.bed.punched, 320);
  assert.equal(result.bed.remaining, 100000 - 320);
  const section = state.sections[0];
  assert.equal(section.punched, true);
  assert.equal(section.bedId, "bed_demo");
});

test("寿命不足：整批 409，区间、问题与计数保持原样", () => {
  const state = fresh();
  needles.registerBed(state, { id: "b_small", batchId: "BX2", lifeLimit: 300, now: T });
  needles.calibrateBed(state, "b_small", T);
  needles.installBed(state, "tune_demo", "b_small", T);
  const issuesBefore = JSON.stringify(state.issues);
  expectConflict(
    () => needles.completeSections(state, "tune_demo", ["section_demo_1"], T),
    "剩余寿命不足"
  );
  const bed = state.beds.find((b) => b.id === "b_small");
  assert.equal(bed.punched, 0, "已打孔数应保持 0");
  assert.equal(state.sections[0].punched, false, "区间应保持未完工");
  assert.equal(JSON.stringify(state.issues), issuesBefore, "问题登记应原样不动");
});

test("批量中有一个区间寿命不够：整批回退，全部不打孔", () => {
  const state = fresh();
  needles.registerBed(state, { id: "b_600", batchId: "BX3", lifeLimit: 600, now: T });
  needles.calibrateBed(state, "b_600", T);
  needles.installBed(state, "tune_demo", "b_600", T);
  // 320 单独够，320+480 不够，整批退回
  expectConflict(() =>
    needles.completeSections(state, "tune_demo", ["section_demo_1", "section_demo_2"], T)
  );
  assert.equal(state.beds.find((b) => b.id === "b_600").punched, 0);
  assert.ok(state.sections.every((s) => !s.punched));
});

test("重复完工和跨曲目区间：409 原样退回", () => {
  const state = fresh();
  needles.installBed(state, "tune_demo", "bed_demo", T);
  needles.completeSections(state, "tune_demo", ["section_demo_1"], T);
  expectConflict(
    () => needles.completeSections(state, "tune_demo", ["section_demo_1"], T),
    "重复打孔"
  );
  assert.throws(
    () => needles.completeSections(state, "tune_demo", ["section_other"], T),
    (error) => error.status === 404
  );
  // 混批里只要有一个已完工，整批 409
  assert.throws(
    () =>
      needles.completeSections(state, "tune_demo", ["section_demo_1", "section_demo_2"], T),
    (error) => error.status === 409
  );
});

test("换针：旧床先结清退役，新床必须已校准", () => {
  const state = fresh();
  needles.installBed(state, "tune_demo", "bed_demo", T);
  needles.completeSections(state, "tune_demo", ["section_demo_1"], T);
  needles.registerBed(state, { id: "b_new_raw", batchId: "BX9", lifeLimit: 9000, now: T });
  // 未校准的新床不能换
  expectConflict(
    () => needles.replaceNeedle(state, "tune_demo", "bed_demo", "b_new_raw", T),
    "尚未校准"
  );
  needles.calibrateBed(state, "b_new_raw", T);
  const result = needles.replaceNeedle(state, "tune_demo", "bed_demo", "b_new_raw", T);
  assert.equal(result.retiredBed.punched, 320);
  assert.equal(state.beds.find((b) => b.id === "bed_demo").status, "retired");
  assert.equal(state.beds.find((b) => b.id === "b_new_raw").status, "in_service");
});

test("换针后：已完工区间留在旧床，未完工区间改派新床", () => {
  const state = fresh();
  needles.installBed(state, "tune_demo", "bed_demo", T);
  needles.completeSections(state, "tune_demo", ["section_demo_1"], T);
  // 加一个未完工区间
  state.sections.push({
    id: "s3", tuneId: "tune_demo", startBeat: 65, endBeat: 70,
    laneRange: "1-5", laneCount: 5, checked: false, punched: false,
    bedId: "bed_demo", punchedAt: null, note: ""
  });
  needles.registerBed(state, { id: "b_new", batchId: "BXN", lifeLimit: 9000, now: T });
  needles.calibrateBed(state, "b_new", T);
  const result = needles.replaceNeedle(state, "tune_demo", "bed_demo", "b_new", T);

  assert.equal(state.sections[0].bedId, "bed_demo", "已完工区间不动");
  assert.equal(state.sections[0].punched, true);
  assert.equal(state.sections[1].bedId, "b_new", "未完工区间改用新针床");
  assert.equal(state.sections.find((s) => s.id === "s3").bedId, "b_new");
  assert.deepEqual(result.reassignedSectionIds.sort(), ["s3", "section_demo_2"]);

  // 新床继续打孔，针次从 0 起算
  const next = needles.completeSections(state, "tune_demo", ["section_demo_2"], T);
  assert.equal(next.bed.id, "b_new");
  assert.equal(next.totalStrokes, 480);
});

test("同一针床不能同时服务两首曲目", () => {
  const state = fresh();
  state.tunes.push({
    id: "t2", title: "二", composer: "", stripSpec: {}, currentBedId: null, createdAt: T
  });
  needles.installBed(state, "tune_demo", "bed_demo", T);
  expectConflict(() => needles.installBed(state, "t2", "bed_demo", T), "同时服务两首曲目");
  // 退役床也不能拿去装第二首
  needles.registerBed(state, { id: "b2", batchId: "B2", lifeLimit: 500, now: T });
  needles.calibrateBed(state, "b2", T);
  needles.replaceNeedle(state, "tune_demo", "bed_demo", "b2", T);
  expectConflict(() => needles.installBed(state, "t2", "bed_demo", T), "已结清退役");
});

test("追溯：每首曲目保留各针床流水", () => {
  const state = fresh();
  needles.installBed(state, "tune_demo", "bed_demo", T);
  needles.completeSections(state, "tune_demo", ["section_demo_1"], T);
  const trace = needles.needleTrace(state, "tune_demo");
  assert.equal(trace.currentBedId, "bed_demo");
  const bedView = trace.beds.find((b) => b.id === "bed_demo");
  const types = bedView.events.map((e) => e.type);
  // 完整履历：登记、校准（种子数据）、安装、打孔
  assert.deepEqual(types, ["registered", "calibrated", "installed", "punched"]);
});

test("404 与 400 的状态码区分", () => {
  const state = fresh();
  assert.throws(() => needles.getBed(state, "nope"), (error) => error.status === 404);
  assert.throws(
    () => needles.registerBed(state, { id: "x", batchId: "", lifeLimit: 10, now: T }),
    (error) => error.status === 400
  );
});
