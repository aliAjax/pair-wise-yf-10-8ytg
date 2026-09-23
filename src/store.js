// 存取层：只负责 data/db.json 的初始化、读取与写入，不包含任何业务判定。
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "..", "data", "db.json");

const DEMO_TS = "2026-06-16T00:00:00.000Z";

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: DEMO_TS
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏",
      released: true,
      releasedAt: DEMO_TS,
      bedId: "bed_demo",
      installBatch: "B2026-001",
      punches: 320
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
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
      createdAt: DEMO_TS,
      resolvedAt: null
    }
  ],
  needleBeds: [
    {
      id: "bed_demo",
      installBatch: "B2026-001",
      punchesUsed: 320,
      lifespanLimit: 2000,
      calibrated: true,
      calibratedAt: DEMO_TS,
      status: "in_use", // in_stock 在库 | in_use 服役中 | settled 已结清
      boundTuneId: "tune_demo",
      installedAt: DEMO_TS,
      settledAt: null
    },
    {
      id: "bed_demo_spare",
      installBatch: "B2026-002",
      punchesUsed: 0,
      lifespanLimit: 2400,
      calibrated: false,
      calibratedAt: null,
      status: "in_stock",
      boundTuneId: null,
      installedAt: null,
      settledAt: null
    }
  ],
  // 针床服役记录：每次绑定/换针生成一条，结清后闭合，供重启后追溯。
  bindings: [
    {
      id: "binding_demo",
      tuneId: "tune_demo",
      bedId: "bed_demo",
      installBatch: "B2026-001",
      startedAt: DEMO_TS,
      startingPunches: 0,
      endedAt: null,
      endingPunches: null
    }
  ]
};

// 旧版本数据文件补齐新集合，缺省一律为空，不猜测业务状态。
function migrate(db) {
  for (const key of ["tunes", "sections", "issues", "needleBeds", "bindings"]) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return migrate(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = { DB_FILE, initialData, ensureDb, readDb, writeDb };
