"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");

const { createApp } = require("../../src/app");
const { JsonStore } = require("../../src/store/jsonStore");

async function startServer(dbFile) {
  const store = new JsonStore(dbFile);
  await store.init();
  const server = createApp(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, store, base };
}

const jsonPost = (base, url, body, method = "POST") =>
  fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

test("完整闭环：登记批次 -> 校准 -> 安装 -> 批量放行 -> 寿命不足 409 -> 换针 -> 重启追溯", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "punch-"));
  const dbFile = path.join(dir, "db.json");
  const { server, store, base } = await startServer(dbFile);
  t.after(async () => {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 1. 登记针床：安装批次 + 寿命上限（故意设小）
  let res = await jsonPost(base, "/beds", { batchId: "BATCH-A", lifeLimit: 400 });
  assert.equal(res.status, 201);
  const bedA = (await res.json()).data;
  assert.equal(bedA.punched, 0);
  assert.equal(bedA.status, "in_store");

  // 2. 未校准先安装 -> 409
  res = await jsonPost(base, `/tunes/tune_demo/install-bed`, { bedId: bedA.id });
  assert.equal(res.status, 409);
  const conflictBody = await res.json();
  assert.equal(conflictBody.code, "CONFLICT");

  // 3. 校准后安装
  res = await jsonPost(base, `/beds/${bedA.id}/calibrate`, {});
  assert.equal(res.status, 200);
  res = await jsonPost(base, `/tunes/tune_demo/install-bed`, { bedId: bedA.id });
  assert.equal(res.status, 200);

  // 4. 批量完工：section_demo_1 需 320 针，放行成功
  res = await jsonPost(base, `/tunes/tune_demo/sections/complete`, {
    sectionIds: ["section_demo_1"]
  });
  assert.equal(res.status, 200);
  let body = (await res.json()).data;
  assert.equal(body.totalStrokes, 320);
  assert.equal(body.bed.punched, 320);
  assert.equal(body.bed.remaining, 80);

  // 5. section_demo_2 需 480 针，只剩 80 -> 409，计数不动
  res = await jsonPost(base, `/tunes/tune_demo/sections/complete`, {
    sectionIds: ["section_demo_2"]
  });
  assert.equal(res.status, 409);
  body = await res.json();
  assert.equal(body.details.remaining, 80);
  assert.equal(body.details.required, 480);

  res = await fetch(base + `/tunes/tune_demo/progress`);
  let progress = (await res.json()).data;
  assert.equal(progress.currentBed.punched, 320, "409 后已打孔数保持 320");
  assert.equal(progress.punchedSections, 1);

  // 6. 登记并校准新针床
  res = await jsonPost(base, "/beds", { batchId: "BATCH-B", lifeLimit: 5000 });
  const bedB = (await res.json()).data;
  res = await jsonPost(base, `/beds/${bedB.id}/calibrate`, {});
  assert.equal(res.status, 200);

  // 7. 换针：旧床结清退役，未完工区间改派新床
  res = await jsonPost(base, `/tunes/tune_demo/replace-needle`, { newBedId: bedB.id });
  assert.equal(res.status, 200);
  body = (await res.json()).data;
  assert.equal(body.retiredBed.id, bedA.id);
  assert.equal(body.retiredBed.punched, 320);
  assert.deepEqual(body.reassignedSectionIds, ["section_demo_2"]);

  res = await fetch(base + `/tunes/tune_demo/sections`);
  const sections = (await res.json()).data;
  assert.equal(sections[0].bedId, bedA.id, "已完工区间留在旧床");
  assert.equal(sections[0].punched, true);
  assert.equal(sections[1].bedId, bedB.id, "未完工区间改派新床");
  assert.equal(sections[1].punched, false);

  // 8. 新床继续放行 section_demo_2（480 针）
  res = await jsonPost(base, `/tunes/tune_demo/sections/complete`, {
    sectionIds: ["section_demo_2"]
  });
  assert.equal(res.status, 200);
  body = (await res.json()).data;
  assert.equal(body.bed.id, bedB.id);
  assert.equal(body.totalStrokes, 480);

  // 9. 重启：重新从磁盘加载，台账与流水仍可追溯
  // 先在运行中的进程上验证 reload 后内存仍可查询
  await store.reload();

  // 再起一个全新 app 指向同一个 db 文件（先关掉旧服务，避免并发写盘竞争）
  server.close();
  await once(server, "close");
  const second = await startServer(dbFile);
  t.after(() => second.server.close());
  const res2 = await fetch(second.base + `/tunes/tune_demo/needle-trace`);
  assert.equal(res2.status, 200);
  const trace = (await res2.json()).data;
  assert.equal(trace.currentBedId, bedB.id);
  const batches = trace.beds.map((b) => b.batchId);
  assert.deepEqual(batches.sort(), ["BATCH-A", "BATCH-B"]);
  const bedAView = trace.beds.find((b) => b.id === bedA.id);
  assert.equal(bedAView.status, "retired");
  assert.equal(bedAView.punched, 320);
  const eventTypes = bedAView.events.map((e) => e.type);
  assert.deepEqual(eventTypes, ["registered", "calibrated", "installed", "punched", "settled"]);

  const progressBody = await (await fetch(second.base + `/tunes/tune_demo/progress`)).json();
  assert.equal(progressBody.data.punchedSections, 2);
  assert.equal(progressBody.data.currentBed.remaining, 5000 - 480);
  second.server.close();
});

test("同一针床不能同时服务两首曲目", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "punch-"));
  const dbFile = path.join(dir, "db.json");
  const { server, base } = await startServer(dbFile);
  t.after(async () => {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  let res = await jsonPost(base, "/tunes", { title: "第二首", stripSpec: { scale: "20音" } });
  const tune2 = (await res.json()).data;

  res = await jsonPost(base, `/beds/bed_demo/calibrate`, {});
  // bed_demo 在种子数据里已校准，重复校准应 409 或先安装
  assert.ok([200, 409].includes(res.status));
  res = await jsonPost(base, `/tunes/tune_demo/install-bed`, { bedId: "bed_demo" });
  assert.equal(res.status, 200);

  res = await jsonPost(base, `/tunes/${tune2.id}/install-bed`, { bedId: "bed_demo" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /同时服务两首曲目/);
});

test("旧库迁移：没有 beds 字段的老 db.json 能正常加载", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "punch-"));
  const dbFile = path.join(dir, "db.json");
  await fs.writeFile(
    dbFile,
    JSON.stringify({
      tunes: [{ id: "old", title: "老曲目", stripSpec: {}, createdAt: "x" }],
      sections: [
        { id: "old_s", tuneId: "old", startBeat: 1, endBeat: 4, laneRange: "1-2", checked: false }
      ],
      issues: []
    })
  );
  const { server, base } = await startServer(dbFile);
  t.after(async () => {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const sections = await (await fetch(base + "/tunes/old/sections")).json();
  assert.equal(sections.data[0].laneCount, 2);
  assert.equal(sections.data[0].punched, false);
  const beds = await (await fetch(base + "/beds")).json();
  assert.deepEqual(beds.data, []);
});
