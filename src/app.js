"use strict";

// 应用组装：HTTP 收发 -> 接口层（路由）-> 判定层（业务）-> 存取层（落盘）
// 业务规则全部在 src/domain，文件读写全部在 src/store，路由全部在 src/interfaces。

const http = require("http");
const { JsonStore } = require("./store/jsonStore");
const { send, parseUrl, parseBody, sendError } = require("./interfaces/httpUtil");
const { catalogueRoutes } = require("./interfaces/catalogueRoutes");
const { needleRoutes } = require("./interfaces/needleRoutes");

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues?tuneId=&status=",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /beds",
  "POST /beds",
  "POST /beds/:id/calibrate",
  "POST /tunes/:id/install-bed",
  "POST /tunes/:id/sections/complete",
  "POST /tunes/:id/replace-needle",
  "GET /tunes/:id/needle-trace"
];

function createApp(store) {
  return http.createServer(async (req, res) => {
    try {
      const { pathname, searchParams } = parseUrl(req);

      if (req.method === "GET" && pathname === "/health") {
        return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
      }

      const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await parseBody(req) : {};
      const ctx = {
        pathname,
        searchParams,
        body,
        state: store.state,
        mutated: false
      };

      // 先试针床接口，再试曲目目录接口；判定层抛 BusinessError 时不写盘
      const handled =
        (await needleRoutes(req, res, ctx)) !== false
          ? true
          : (await catalogueRoutes(req, res, ctx)) !== false;

      if (handled && ctx.mutated) await store.persist();
      if (!handled) return send(res, 404, { error: "接口不存在", routes });
      return undefined;
    } catch (error) {
      // 409 等业务冲突在此统一回送：判定层此前未改动任何数据
      if (res.headersSent) {
        // 响应已发出后才出错（如落盘失败），只能销毁连接，不能再写头
        res.destroy(error);
        return undefined;
      }
      return sendError(res, error);
    }
  });
}

module.exports = { createApp, routes };
