// 启动入口：判定见 src/rules.js，存取见 src/store.js，接口见 src/api.js。
const http = require("http");
const { createRequestHandler } = require("./src/api");

const PORT = Number(process.env.PORT || 3019);

const server = http.createServer(createRequestHandler());

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});

module.exports = server;
