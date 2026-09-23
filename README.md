# 手摇风琴纸带打孔 API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题，
以及针床（安装批次 / 已打孔数 / 寿命上限）与换针服役记录。

## 启动

```bash
PORT=3019 node server.js
```

## 代码结构（业务三拆）

| 文件 | 职责 |
| --- | --- |
| `src/rules.js` | 判定层：针次计算（拍号跨度 × 音轨数）、寿命/校准/独占判定、换针结清、整批放行 |
| `src/store.js` | 存取层：`data/db.json` 的初始化、迁移、读写，不含业务规则 |
| `src/api.js` | 接口层：HTTP 路由与请求/响应适配，不做业务判定 |
| `server.js` | 启动入口 |

## 针床与放行规则

- 每首曲目同一时刻只有一个**在用针床**，针床登记安装批次、已打孔数、寿命上限。
- 区间放行（完工）按 **拍号跨度 × 音轨数** 累加针次：
  拍号跨度为闭区间拍数（33-64 → 32），音轨数取自 `laneRange`（4-18 → 15）。
- 整批放行时：**针床未校准**或**剩余寿命不足整批针次**，整批返回 `409`，
  区间、问题与针床计数全部保持原样（先全量判定，后统一落库）。
- 换针分两步：先 `POST /tunes/:id/needle/settle` **结清旧针床**，
  再 `POST /tunes/:id/needle/attach` 安装新针床；新针床必须已校准。
- 同一针床不能同时服务两首曲目（`in_use` 状态的针床对其他曲目上机返回 409）。
- 换针后：已放行（已校对）区间保留旧针床记录不动；未完工区间放行时记新针床。
  每次绑定生成服役记录（`bindings`），结清后闭合，**重启后仍可追溯**。

## 接口

原有：

- `GET /health`
- `GET /tunes` / `POST /tunes`
- `GET /tunes/:id/progress`（含当前针床与剩余寿命）
- `GET /tunes/:id/sections` / `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=` / `POST /issues` / `PATCH /issues/:id/status`

针床与换针：

- `GET /beds?status=in_stock|in_use|settled`
- `POST /beds`：`{ "installBatch": "B2026-002", "lifespanLimit": 2400, "calibrated": false }`
- `PATCH /beds/:id/calibrate`：`{ "calibrated": true }`
- `GET /tunes/:id/needle`：当前在用针床
- `GET /tunes/:id/needle/history`：历次服役记录（换针追溯）
- `POST /tunes/:id/needle/attach`：`{ "bedId": "..." }`，无在用针床时上机
- `POST /tunes/:id/needle/settle`：结清当前针床（换针第一步）
- `POST /tunes/:id/release`：整批放行，`{ "sectionIds": ["section_demo_2"] }`

放行成功返回本批针次与针床最新计数；失败 409 携带 `code`
（`BED_NOT_CALIBRATED` / `INSUFFICIENT_LIFESPAN` / `SECTION_ALREADY_RELEASED` 等）
及 `required`、`remaining`、`shortBy` 等明细。

## 闭环示例

```bash
# 1. 新批次针床上架（尚未校准）
curl -X POST http://127.0.0.1:3019/beds \
  -H 'Content-Type: application/json' \
  -d '{"installBatch":"B2026-003","lifespanLimit":5000}'

# 2. 校准
curl -X PATCH http://127.0.0.1:3019/beds/<bedId>/calibrate \
  -H 'Content-Type: application/json' -d '{"calibrated":true}'

# 3. 结清旧针床，再装新针床
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/needle/settle
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/needle/attach \
  -H 'Content-Type: application/json' -d '{"bedId":"<bedId>"}'

# 4. 整批放行（32拍 × 15轨 = 480 针次）
curl -X POST http://127.0.0.1:3019/tunes/tune_demo/release \
  -H 'Content-Type: application/json' \
  -d '{"sectionIds":["section_demo_2"]}'

# 5. 查看换针追溯
curl http://127.0.0.1:3019/tunes/tune_demo/needle/history
```
