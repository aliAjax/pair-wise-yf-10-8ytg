// 接口层：HTTP 路由与请求/响应适配，业务判定全部委托给 rules，持久化委托给 store。
const { readDb, writeDb } = require("./store");
const rules = require("./rules");

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "POST /tunes/:id/release",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /beds",
  "POST /beds",
  "PATCH /beds/:id/calibrate",
  "GET /tunes/:id/needle",
  "GET /tunes/:id/needle/history",
  "POST /tunes/:id/needle/attach",
  "POST /tunes/:id/needle/settle"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new rules.HttpError(400, "请求体必须是合法JSON");
    throw error;
  }
}

// 按声明顺序匹配：更长/更具体的路径放在前面，避免被通配模式抢先。
const handlers = [
  { method: "GET", pattern: /^\/health$/, handler: health },
  { method: "GET", pattern: /^\/tunes$/, handler: listTunes },
  { method: "POST", pattern: /^\/tunes$/, handler: createTune },

  { method: "POST", pattern: /^\/tunes\/([^/]+)\/release$/, handler: release },
  { method: "GET", pattern: /^\/tunes\/([^/]+)\/needle\/history$/, handler: needleHistory },
  { method: "GET", pattern: /^\/tunes\/([^/]+)\/needle$/, handler: needle },
  { method: "POST", pattern: /^\/tunes\/([^/]+)\/needle\/attach$/, handler: needleAttach },
  { method: "POST", pattern: /^\/tunes\/([^/]+)\/needle\/settle$/, handler: needleSettle },

  { method: "GET", pattern: /^\/tunes\/([^/]+)\/unchecked-sections$/, handler: uncheckedSections },
  { method: "GET", pattern: /^\/tunes\/([^/]+)\/progress$/, handler: progress },
  { method: "GET", pattern: /^\/tunes\/([^/]+)\/sections$/, handler: listSections },
  { method: "POST", pattern: /^\/tunes\/([^/]+)\/sections$/, handler: createSection },

  { method: "PATCH", pattern: /^\/sections\/([^/]+)\/check$/, handler: checkSection },

  { method: "GET", pattern: /^\/issues$/, handler: listIssues },
  { method: "POST", pattern: /^\/issues$/, handler: createIssue },
  { method: "PATCH", pattern: /^\/issues\/([^/]+)\/status$/, handler: issueStatus },

  { method: "GET", pattern: /^\/beds$/, handler: listBeds },
  { method: "POST", pattern: /^\/beds$/, handler: createBed },
  { method: "PATCH", pattern: /^\/beds\/([^/]+)\/calibrate$/, handler: calibrateBed }
];

async function health(req, res, params, db) {
  send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
}

async function listTunes(req, res, params, db) {
  const tunes = db.tunes.map((tune) => ({ ...tune, progress: rules.buildProgress(db, tune.id) }));
  send(res, 200, { data: tunes });
}

async function createTune(req, res, params, db) {
  const tune = rules.createTune(db, await parseBody(req));
  db.tunes.push(tune);
  await writeDb(db);
  send(res, 201, { data: tune });
}

async function progress(req, res, params, db) {
  send(res, 200, { data: rules.buildProgress(db, params[0]) });
}

async function listSections(req, res, params, db) {
  const tuneId = params[0];
  rules.findTune(db, tuneId);
  send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
}

async function createSection(req, res, params, db) {
  const section = rules.createSection(db, params[0], await parseBody(req));
  db.sections.push(section);
  await writeDb(db);
  send(res, 201, { data: section });
}

async function uncheckedSections(req, res, params, db) {
  const tuneId = params[0];
  rules.findTune(db, tuneId);
  send(res, 200, {
    data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked)
  });
}

async function checkSection(req, res, params, db) {
  const section = rules.checkSection(db, params[0], await parseBody(req));
  await writeDb(db);
  send(res, 200, { data: section });
}

async function release(req, res, params, db) {
  const result = rules.releaseSections(db, params[0], await parseBody(req));
  await writeDb(db);
  send(res, 200, { data: result });
}

async function listIssues(req, res, params, db, searchParams) {
  const tuneId = searchParams.get("tuneId");
  const status = searchParams.get("status");
  const issues = db.issues.filter(
    (item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status)
  );
  send(res, 200, { data: issues });
}

async function createIssue(req, res, params, db) {
  const issue = rules.createIssue(db, await parseBody(req));
  db.issues.push(issue);
  await writeDb(db);
  send(res, 201, { data: issue });
}

async function issueStatus(req, res, params, db) {
  const issue = rules.updateIssueStatus(db, params[0], await parseBody(req));
  await writeDb(db);
  send(res, 200, { data: issue });
}

async function listBeds(req, res, params, db, searchParams) {
  const status = searchParams.get("status");
  let beds = db.needleBeds;
  if (status) beds = beds.filter((bed) => bed.status === status);
  beds = beds.map((bed) => ({ ...bed, remaining: rules.bedRemaining(bed) }));
  send(res, 200, { data: beds });
}

async function createBed(req, res, params, db) {
  const bed = rules.registerBed(db, await parseBody(req));
  await writeDb(db);
  send(res, 201, { data: bed });
}

async function calibrateBed(req, res, params, db) {
  const bed = rules.calibrateBed(db, params[0], await parseBody(req));
  await writeDb(db);
  send(res, 200, { data: bed });
}

async function needle(req, res, params, db) {
  send(res, 200, { data: rules.tuneNeedle(db, params[0]) });
}

async function needleHistory(req, res, params, db) {
  send(res, 200, { data: rules.tuneNeedleHistory(db, params[0]) });
}

async function needleAttach(req, res, params, db) {
  const summary = rules.attachBed(db, params[0], await parseBody(req));
  await writeDb(db);
  send(res, 201, { data: summary });
}

async function needleSettle(req, res, params, db) {
  const result = rules.settleBed(db, params[0]);
  await writeDb(db);
  send(res, 200, { data: result });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = await readDb();

  for (const route of handlers) {
    const match = url.pathname.match(route.pattern);
    if (match && req.method === route.method) {
      return route.handler(req, res, match.slice(1), db, url.searchParams);
    }
  }
  return send(res, 404, { error: "接口不存在", routes });
}

function createRequestHandler() {
  return (req, res) => {
    handle(req, res).catch((error) => {
      const status = error.status || 500;
      const body = { error: error.message || "服务器错误" };
      if (error.code) body.code = error.code;
      for (const key of ["bed", "required", "shortBy", "current", "boundTuneId", "sectionId"]) {
        if (error[key] !== undefined) body[key] = error[key];
      }
      send(res, status, body);
    });
  };
}

module.exports = { routes, createRequestHandler };
