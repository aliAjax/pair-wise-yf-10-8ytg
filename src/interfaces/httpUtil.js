"use strict";

// 接口层公共 HTTP 工具

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const nowIso = () => new Date().toISOString();

// 把判定层抛出的 BusinessError 翻译成 HTTP 响应
function sendError(res, error) {
  const status = error.status || 500;
  const payload = { error: error.message || "服务器错误" };
  if (error.code) payload.code = error.code;
  if (error.details) payload.details = error.details;
  send(res, status, payload);
}

module.exports = { send, parseUrl, parseBody, makeId, nowIso, sendError };
