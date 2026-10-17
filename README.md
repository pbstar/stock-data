# A股日K查看器

一个零依赖的本地 K 线查看工具：Node 后端直接读取 `kline.json` 并按需返回单只股票数据，前端用 Canvas 绘制蜡烛图，不加载整份数据文件。

## 功能

- 全市场股票搜索（代码 / 中文名），点击切换
- 日 K 蜡烛图（红涨绿跌）+ 成交量，MA7 / MA21 均线
- 十字光标、悬停提示（开高低收、涨跌幅、成交量、成交额）
- 1月 / 3月 / 6月 / 1年 / 全部 区间切换
- 滚轮缩放、拖拽平移、双击复位
- 窄屏自适应，侧栏折叠为抽屉

## 目录结构

```
server.mjs          Node 后端：索引数据文件并提供查询接口
viewer/
  index.html        页面
  app.js            Canvas 绘图与交互
  style.css          样式
kline.json.gz       压缩后的行情数据（约 85MB）
preview.json        数据格式小样本
.claude/launch.json 启动配置（可选）
```

## 运行

需要 Node.js 18+，无需安装任何依赖。

```bash
node server.mjs
```

浏览器打开 http://localhost:5173 。换端口：

```bash
node server.mjs --port 5180
# 或 PORT=5180 node server.mjs
```

服务启动时会扫描一遍 `kline.json`，只记录每只股票 K 线数组的字节偏移（约 600ms），之后每次请求按字节区间读取，不会把数据复制或常驻内存。服务仅监听 `127.0.0.1`。

可选环境变量 `KLINE_FILE` 指定数据文件路径。

## API

| 接口 | 说明 |
|---|---|
| `GET /api/meta` | `{ stocks, firstDate, lastDate }` |
| `GET /api/stocks?q=&limit=` | 代码 / 名称过滤，返回 `{ total, stocks: [{code, name}] }` |
| `GET /api/kline?code=&from=&to=&limit=` | 单只股票 K 线，返回 `{ code, name, k }` |

`code` 支持 `sh600519`、`600519.SH`、`600519` 三种写法；`from` / `to` 为 `YYYYMMDD`。

## 数据文件

仓库包含压缩后的 `kline.json.gz`（约 85MB，原始 JSON 约 313MB）。服务启动时发现没有 `kline.json` 会自动解压 `.gz` 并在内存中索引，无需手动解压；如果根目录同时存在未压缩的 `kline.json`，会优先使用它（启动更快、运行时内存占用更低，gz 模式常驻内存约 400MB）。

数据来源：同花顺金融数据 API 的[全市场数据导出](https://fuyao.aicubes.cn/docs/api-reference/market-dumps/)（`a_share_daily_k_1d_none_10y` 日 K dump，不复权）。转换后的 JSON 结构：

```json
{
  "stocks": [
    {
      "code": "sh600000",
      "name": "浦发银行",
      "k": [
        { "date": "20240102", "o": 6.63, "h": 6.65, "l": 6.6, "c": 6.6, "v": 22066700, "t": 146066303.72 }
      ]
    }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `code` | 交易所前缀小写 + 6 位代码（`sh` / `sz` / `bj`） |
| `name` | 中文名称 |
| `date` | 交易日，`YYYYMMDD` |
| `o` / `h` / `l` / `c` | 开 / 高 / 低 / 收，元，未复权 |
| `v` | 成交量，股 |
| `t` | 成交额，元 |

`preview.json` 是同样格式的 3 只股票小样本，便于核对字段。

## 说明

- 价格为不复权，除权除息日前后会有跳空。
- 数据仅用于个人研究，请遵守数据源的授权条款，不要公开再分发。
- 本项目以 MIT License 发布。
