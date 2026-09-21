# xunjian — 安全设备批量巡检

针对安恒（DBAPP）系安全设备的批量巡检工具：自动登录各设备 Web 控制台，采集
**CPU / 内存 / 磁盘使用率**（日均值 + 峰值）与**版本号、授权到期、日志与终端状态**，
汇总成 Markdown / CSV 报表。

用 Node.js + Playwright 驱动真实浏览器（设备控制台普遍是 SPA + 验证码，纯 HTTP 接口拿不到鉴权），
验证码用 `ddddocr` 识别，识别不了的设备回落到人工弹窗输一次。

## 能采什么

| 类别 | 采集内容 |
|---|---|
| 资源利用率 | CPU% / 内存% / 磁盘%，以及各自的**峰值%** |
| 版本与授权 | 产品版本号、授权到期日、维保期、许可类型、客户与 SN |
| 运营指标 | 终端在线/离线数、病毒库与漏洞库版本、违规外联与 USB 日志量 |
| APT 专项 | 策略库版本、本日与近 7 天告警数、本日流量峰值 |

覆盖的设备类型见 `xunjian_devices/`，一个产品一个 `collect_<name>.js`：

- 本地部署：API 网关（迪普）、漏洞扫描、态势感知、数据安全管控平台（AiDSC）、
  终端安全（EDR）、UES 终端准入、运维审计堡垒机、LT 堡垒机、DasV 大屏、APT 攻击预警
- 安恒云**专享型实例**：数据库审计、数据库安全网关、Web 应用防火墙、下一代防火墙、
  日志审计、数据加解密服务、API 风险监测、主机安全、数据分类分级、APT 攻击预警

## 两条重要的采集设计

**1. 每次巡检都取实时数据。** 安恒云的专享实例走控制台 SSO 借道逐个重采
（`anheng_cloud_collect.js` 由 `xunjian_all.js` 每轮调用），不读离线快照。
只有实时快照、没有历史接口的产品用**单点序列**表示，备注里明确标
`(实时值, 峰值=当前值)` —— 不能让单点看起来像一条平稳曲线。

**2. 日均值与峰值分开分桶。** 有历史接口的产品拉 7 天，按天分桶两次：
日均 = 各小时均值再平均，日峰值 = 各小时峰值里取最大。混在一起算会把峰值抹平。

## 快速开始

```bash
npm install                      # 只需要 playwright-core
# 另外需要本机 Chrome，或设 XUNJIAN_CHROME 指向其它 Chromium
pip install ddddocr pillow numpy # 验证码识别

cp xunjian_config.local.example.js xunjian_config.local.js
# 编辑 xunjian_config.local.js，填入设备地址、账号、口令

node xunjian_all.js --write-app   # 全量巡检，并写回 app.js
node xunjian_table.js             # 由 app.js + xunjian_report.json 生成报表
```

报表输出 `xunjian_report_table.md` 和 `xunjian_report_table.csv`（Excel 直接打开，带 BOM）。
`app.js` 同时是数据文件和看板页面，用浏览器打开即可看图。

常用参数：

| 参数 | 作用 |
|---|---|
| `--write-app` | 采集后把结果写回 `app.js`（默认只生成 report） |
| `--dry-run` | 只生成报告，不写 `app.js` |
| `--no-browser` | 跳过所有需要浏览器的设备 |
| `--no-cloud` | 跳过安恒云实例的实时采集，复用现有 `anheng_collected.json` |

单个设备调试：

```bash
node xunjian_tool.js <设备名>       # 只跑一个采集器，打印明细
node anheng_cloud_collect.js --only 84,19   # 只采指定的安恒云实例
```

## 关于配置与凭据

**真实地址和口令一律不放代码里。** 它们只有两个来源，优先级从高到低：

1. 环境变量 `XUNJIAN_<设备名>_<字段名>`（如 `XUNJIAN_APIG_PASS`）—— 适合临时覆盖或 CI
2. `xunjian_config.local.js` —— 推荐，从 `xunjian_config.local.example.js` 复制而来

`xunjian_config.local.js`、所有 `*_session*.json`、采集结果与报表输出都已在 `.gitignore` 中，
**不会入库**。仓库里只有 `xunjian_config.js`（纯结构定义 + 占位地址）和
`xunjian_config.local.example.js`（模板）。

会话文件里存着登录态，等价于密码，同样不要提交。

## 会话保活

设备会话 TTL 普遍只有 1~1.5 小时，巡检跑之前会话往往已经过期。`session_keepalive.js`
定期探测并**自动重登**，连续失败才拉起有头窗口让人工输一次验证码：

```bash
node session_keepalive.js              # 探一轮
node session_keepalive.js --activate 漏扫   # 只激活指定设备
node install_keepalive_task.bat        # 注册 Windows 计划任务，定时跑
```

人工弹窗默认关闭；需要时 `set XUNJIAN_POPUP=1`。

⚠️ 几个设备有**账号锁定策略**，自动重试必须保守，否则会把生产账号锁掉：

- 终端安全（EDR）：连续登录失败会锁账号，重试上限 `maxAttempts`，并有 6 小时冷却
- 态势感知：1 分钟内累计 5 次验证码错误即锁号
- 验证码普遍与当前会话绑定且**一次性**，重取一次旧的就作废 —— 不要把多个 OCR 候选串行全试，
  第一个错候选就会把验证码消耗掉，正确候选必然被拒

## 目录

```
xunjian_all.js           一键巡检主入口
xunjian_config.js        配置结构（真实值在 .local.js）
xunjian_lib.js           共用工具：浏览器、会话存取、分桶、验证码候选投票
xunjian_devices/         各产品采集器 collect_<name>.js
anheng_cloud_collect.js  安恒云专享实例采集（走控制台 SSO）
session_keepalive.js     会话保活与自动重登
session_activate.js      各设备的重登实现
xunjian_report.js        汇总成报告，并写回 app.js
xunjian_table.js         生成 Markdown / CSV 报表
xunjian_tool.js          单设备调试台
app.js                   采集数据 + 看板页面
ocr_ls.py 等             验证码识别脚本
```

## 说明

仓库里的 `app.js` 只保留了一份**脱敏样例数据**（3 台示例设备，覆盖"有历史曲线 / 只有实时值 /
无资源接口"三种形态），跑一次真实巡检就会被覆盖。报表里的设备 IP 与授权日期来自
`xunjian_config.local.js`，未配置时显示 `—`。
