"use strict";

// 存取层：只管 data/db.json 的加载、迁移、原子落盘。
// 不写业务判定，重启后重新读盘，针床流水（events）随针床一起持久化，保证可追溯。

const { readFile, writeFile, rename, mkdir } = require("fs/promises");
const path = require("path");
const needles = require("../domain/needles");

const nowIso = () => new Date().toISOString();

function seedData() {
  const createdAt = nowIso();
  return {
    tunes: [
      {
        id: "tune_demo",
        title: "雨后圆舞曲",
        composer: "匿名",
        stripSpec: { widthMm: 70, scale: "20音", tempoBpm: 82, paperType: "半透明纸带" },
        currentBedId: null,
        createdAt
      }
    ],
    sections: [
      {
        id: "section_demo_1",
        tuneId: "tune_demo",
        startBeat: 1,
        endBeat: 32,
        laneRange: "1-10",
        laneCount: 10,
        checked: true,
        punched: false,
        bedId: null,
        punchedAt: null,
        note: "开头主题已试奏"
      },
      {
        id: "section_demo_2",
        tuneId: "tune_demo",
        startBeat: 33,
        endBeat: 64,
        laneRange: "4-18",
        laneCount: 15,
        checked: false,
        punched: false,
        bedId: null,
        punchedAt: null,
        note: "副歌段等待校对"
      }
    ],
    issues: [
      {
        id: "issue_demo",
        tuneId: "tune_demo",
        sectionId: "section_demo_2",
        type: "漏孔",
        beat: 41,
        lane: 12,
        description: "第41拍高音孔漏打",
        status: "open",
        createdAt,
        resolvedAt: null
      }
    ],
    // 针床台账：每台针床绑定安装批次、已打孔数、寿命上限和完整流水
    beds: [
      {
        id: "bed_demo",
        batchId: "BATCH-2026-09-01",
        lifeLimit: 100000,
        punched: 0,
        status: needles.BED_STATUS.CALIBRATED,
        tuneId: null,
        calibratedAt: createdAt,
        installedAt: null,
        retiredAt: null,
        events: [
          { at: createdAt, type: "registered", detail: { batchId: "BATCH-2026-09-01", lifeLimit: 100000 } },
          { at: createdAt, type: "calibrated", detail: {} }
        ]
      }
    ]
  };
}

// 兼容旧版 db.json：补齐针床台账与新区间字段，不改动既有计数
function migrate(data) {
  if (!Array.isArray(data.beds)) data.beds = [];
  for (const tune of data.tunes) {
    if (tune.currentBedId === undefined) tune.currentBedId = null;
  }
  for (const section of data.sections) {
    if (section.laneCount === undefined) {
      try {
        section.laneCount = needles.parseLaneCount(section.laneRange);
      } catch {
        section.laneCount = null;
      }
    }
    if (section.punched === undefined) section.punched = false;
    if (section.bedId === undefined) section.bedId = null;
    if (section.punchedAt === undefined) section.punchedAt = null;
  }
  return data;
}

class JsonStore {
  constructor(file) {
    this.file = file;
    this._state = null;
  }

  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      this._state = migrate(JSON.parse(raw));
    } catch {
      this._state = seedData();
      await this.persist();
    }
    return this._state;
  }

  // 重新从磁盘加载（验证“重启后仍可追溯”）
  async reload() {
    const raw = await readFile(this.file, "utf8");
    this._state = migrate(JSON.parse(raw));
    return this._state;
  }

  get state() {
    if (!this._state) throw new Error("存储尚未初始化，请先 await init()");
    return this._state;
  }

  // 原子写：先写临时文件再改名，避免半截文件
  async persist() {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this._state, null, 2), "utf8");
    await rename(tmp, this.file);
  }
}

module.exports = { JsonStore, seedData, migrate };
