"use strict";

// 入口：装配存取层并启动 HTTP 服务
// 启动参数可用环境变量覆盖：PORT、DB_FILE

const path = require("path");
const { createApp } = require("./src/app");
const { JsonStore } = require("./src/store/jsonStore");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const store = new JsonStore(DB_FILE);

store.init().then(() => {
  const server = createApp(store);
  server.listen(PORT, () => {
    console.log(`Organ strip punch API running at http://127.0.0.1:${PORT} (db: ${DB_FILE})`);
  });
});
