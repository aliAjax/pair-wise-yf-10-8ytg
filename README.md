# 手摇风琴纸带打孔 API

纯后端零依赖 Node 服务，持久化曲目、纸带区间、试奏问题，以及针床批次、针次与寿命台账。

## 目录结构（判定 / 存取 / 接口三分离）

```
server.js                       入口：装配存储并启动 HTTP
src/
  app.js                        应用组装：HTTP 收发、路由分发、统一 409/404/400 回送
  domain/                       判定层：纯业务规则，不碰文件系统和 HTTP
    errors.js                   BusinessError（NOT_FOUND=404 / INVALID=400 / CONFLICT=409）
    needles.js                  针床登记/校准/安装、批量放行、换针结清、针次计算、追溯
    catalogue.js                曲目/区间/问题草稿判定、进度统计
  store/
    jsonStore.js                存取层：data/db.json 加载、旧库迁移、临时文件原子写
  interfaces/                   接口层：HTTP 取参与响应
    httpUtil.js
    needleRoutes.js             针床/打孔/换针接口
    catalogueRoutes.js          曲目/区间/问题接口
test/                           node:test 单元 + 真实 HTTP 端到端测试
```

## 启动与测试

```bash
PORT=3019 node server.js       # DB_FILE 可用环境变量覆盖
npm test
```

## 业务规则

- **针床台账**：每台针床绑定安装批次 `batchId`、已打孔数 `punched`、寿命上限 `lifeLimit`，状态为
  `in_store → calibrated → in_service → retired`。
- **针次计算**：区间完工针次 = 拍号跨度（`endBeat - startBeat + 1`，闭区间）× 音轨数（解析 `laneRange`，如 `4-18` 为 15 轨）。
- **放行（批量完工）**：`POST /tunes/:id/sections/complete` 先整批预校验——
  无在役针床、针床未校准、寿命不足、区间重复打孔或不属于本曲目，任一不满足即**整批 409**，
  区间、问题登记与已打孔计数保持原样；全部通过才累加针次并逐区间标记完工针床。
- **换针**：`POST /tunes/:id/replace-needle` 先结清旧针床（退役、解除绑定），新针床必须已校准才能继续；
  已完工（含已校对）区间保留在旧针床不动，未完工区间改派新针床；同一针床不能同时服务两首曲目。
- **可追溯**：针床每次登记/校准/安装/打孔/结清都写入 `events` 流水，随库落盘，重启后
  `GET /tunes/:id/needle-trace` 仍可查。

## 接口

原曲目接口：

- `GET /health`、`GET /tunes`、`POST /tunes`
- `GET /tunes/:id/progress`（含 `currentBed` 针次与剩余寿命）
- `GET|POST /tunes/:id/sections`、`GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`、`POST /issues`、`PATCH /issues/:id/status`

针床与打孔接口：

- `GET /beds` 台账
- `POST /beds` `{ "batchId": "BATCH-01", "lifeLimit": 5000 }`
- `POST /beds/:id/calibrate`
- `POST /tunes/:id/install-bed` `{ "bedId": "..." }`
- `POST /tunes/:id/sections/complete` `{ "sectionIds": ["..."] }`
- `POST /tunes/:id/replace-needle` `{ "newBedId": "...", "oldBedId": "可选，默认当前在役" }`
- `GET /tunes/:id/needle-trace`

## 闭环示例

```bash
# 登记批次并校准
curl -X POST http://127.0.0.1:3019/beds \
  -H 'Content-Type: application/json' -d '{"batchId":"BATCH-09","lifeLimit":5000}'
curl -X POST http://127.0.0.1:3019/beds/bed_xxx/calibrate

# 安装到曲目并批量放行（section_demo_1 = 32拍 × 10轨 = 320 针次）
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/install-bed \
  -H 'Content-Type: application/json' -d '{"bedId":"bed_xxx"}'
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/sections/complete \
  -H 'Content-Type: application/json' -d '{"sectionIds":["section_demo_1"]}'

# 寿命不足 -> 409，响应体带 remaining / required，计数不动
# 换针：结清旧床，未完工区间转新床
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/replace-needle \
  -H 'Content-Type: application/json' -d '{"newBedId":"bed_yyy"}'
```
