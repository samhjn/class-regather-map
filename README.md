# 同窗 · 班级蹭饭地图

面向中国同学聚会场景的小型位置目录。世界按国家、中国按省、各省按市查看同学；按日期回看班级分布，查看个人历次足迹。名单由管理员导入，同学凭一次性认领码认领后自己维护。

技术栈：Django 5.2 LTS + MySQL 8.4 + 原生 ES Modules + 高德地图。一个 Python 服务，无需前端构建、Redis 或邮件服务。SQLite 用于本地试用；生产使用 MySQL。

## 已实现

- 世界 / 中国 / 省级行政区地图、区域点选、同学列表、搜索、人数着色和位置点。中国视图默认打开，港澳台归入中国省级视图；直辖市作为城市分组。
- 指定日期快照、日期滑条、个人历史足迹及顺序连线。未填写位置和未填写坐标单独处理，不虚构当前城市或点位。
- 位置新增、编辑、删除；可只填省市，或选择地图点位、设备定位。境内 GPS 坐标通过高德转换。日期范围防重叠，新常住地可自动结束上一段。
- 可选班级查看码、姓名登录 / 认领、个人密码、一次性认领码（7 天）、个人改密、管理员重新认领。认领需要姓名和一次性认领码；同名登录保留编号备用入口。
- 同学列表每次打开页面随机排列，筛选和切换日期时保持稳定；地图按 48px 屏幕距离聚合附近点位，放大自动拆分，点击聚合点查看同学。
- 认领链接 / 查看链接预填；管理页可生成并复制链接，支持同时预填姓名、认领码和查看码。
- CSV / JSON 导入、预览、签名确认、事务回滚、按班级编号与到达日期更新已有记录。
- 班级管理页、只读系统审计页、移动端布局。所有业务查询从班级作用域进入，为多班级保留外键、路由和授权基础。

## 本地启动

需要 Python 3.12+；Node.js 22+ 只用于 JS 测试和预览辅助，并非运行依赖。

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export DEBUG=1
python manage.py migrate
python manage.py initclass --slug our-class --name '我们的班级'
python manage.py createsuperuser
python manage.py runserver
```

`initclass` 会隐藏输入班级解锁密码；也可从 `CLASS_UNLOCK_PASSWORD` 环境变量读取。只有显式传入 `--public` 才创建无解锁密码的班级。不要将口令放在命令行参数或 Git 中。

打开 `http://127.0.0.1:8000/`。管理员从页头登录，返回地图进入「班级管理」导入名单、生成认领码。尚未配置地图 Key 时，列表、导入和历史记录可用，地图区域显示配置提示。

如需虚构演示数据，仅在 `DEBUG=1` 时执行：

```bash
# 先设置一个仅用于本地演示的 DEMO_PASSWORD 环境变量
python manage.py seed_demo
# 打开 /c/demo/；后台用户名为 demo-admin，密码为 DEMO_PASSWORD
```

演示数据不会自动写入正式班级，命令也不会覆盖已有 demo 班级。请勿将演示数据库用于生产。

## 配置高德地图

1. 在[高德开放平台](https://console.amap.com/)创建「Web端（JS API）」Key，设置部署域名白名单。
2. 设置 `AMAP_JS_KEY`。本地调试还可设置 `AMAP_SECURITY_JS_CODE`（仅 DEBUG 模式使用）。
3. 生产配置同源安全代理 `AMAP_SERVICE_HOST=/_AMapService`，将 securityJsCode 仅放在代理服务器配置中。完整示例见 [docs/nginx.conf.example](docs/nginx.conf.example)。
4. 配置后检查世界、中国、边境省份、港澳台、南海及手机窄屏下的地图来源和审图号显示。

地图使用高德官方标准底图和 `DistrictLayer.World / Country / Province`。选用文档明确提供 `getDistrictByContainerPos` 的 JS API 1.4.15；将其集中封装在 `map.js`，便于将来替换。没有引入外部 GeoJSON、Natural Earth、OSM 或自行重绘中国边界。区域着色仅表达人数，边界几何与线型交给 SDK。

本地也可将上述变量写入不入库的 `.env`，启动前执行 `set -a; . ./.env; set +a` 导出到环境；`manage.py` 不会自动读取该文件。SDK 动态加载必须等待高德的 `callback` 及插件回调，不能仅依赖脚本的 `load` 事件。

**使用官方底图不等同于整个业务自动获得地图审核或运营许可。** 不移除或遮挡 SDK 的版权、审图号与相关标识；按供应商要求检查使用许可、配额与业务场景。详细来源和上线检查见 [docs/maps.md](docs/maps.md)。未提供真实 Key 的环境只能验证降级界面，不能据此声称已验证真实地图加载和边界展示。

## MySQL / Docker 部署

阿里云函数计算 FC 3.0 部署见 [docs/fc-deployment.md](docs/fc-deployment.md)：提供 Linux/Python 3.12 ZIP 打包、函数配置模板、独立迁移与更新工具。FC 使用 RDS 内网，不使用本地 SQLite。

应用依赖标准 MySQL 事务、唯一约束及行锁。对于一个班级，MySQL 更适合身份认领、导入与时间区间更新；本版不实现 OTS 适配。需要迁往 OTS 时应重新实现条件写、并发控制和历史查询索引，不可仅替换数据库连接串。

```bash
cp .env.example .env
# 编辑 .env：随机 SECRET_KEY、域名、数据库口令和高德 Key
# .env 由 Compose 读取；manage.py 不会自动加载它。
docker compose up -d db
docker compose build app
docker compose run --rm app python manage.py migrate
docker compose run --rm app python manage.py initclass --slug our-class --name '我们的班级'
docker compose run --rm app python manage.py createsuperuser
docker compose up -d app
```

在宿主机 Nginx 配置 HTTPS 和高德安全代理（见上述示例）。应用仅绑定 `127.0.0.1:8000`，MySQL 不映射公网端口。`TRUST_PROXY=1` 只适用于该可信反向代理，代理必须覆盖 `X-Forwarded-Proto`。生产默认强制 HTTPS、Secure/HttpOnly 会话 Cookie、CSRF 防护和私有 no-store 响应。

直接连接已有 MySQL 时配置 `MYSQL_HOST/PORT/DATABASE/USER/PASSWORD`；远程实例可设置 `MYSQL_SSL_CA` 开启证书与主机名校验。数据库编码使用 utf8mb4。每个班级的写入在事务内按「班级 → 同学」顺序加锁，避免并发认领或重叠位置；SQLite 只用于单进程开发，不作为多进程生产替代。

部署不会自动创建班级、管理员、默认口令或导入演示数据。运行迁移后启动 Gunicorn。`GET /healthz/` 检查应用与数据库连通性。备份 MySQL 数据卷；升级前备份、执行迁移，并定期运行：

```bash
docker compose exec app python manage.py clearsessions
docker compose exec app python manage.py clearratelimits
```

## 管理员与身份认领

- 全站管理员：`createsuperuser` 后从 `/admin/login/` 登录，再回地图管理。后台数据页只读，避免绕开时间区间校验。
- 班级管理员：同学认领后可通过 `python manage.py classadmin our-class 001` 授权，仅能管理该班。追加 `--revoke` 撤销。
- 认领码仅以密码哈希保存，明文仅在生成时返回。重新生成会替换旧码；已认领用户必须确认「重新认领」，这会撤销旧密码与既有会话，保留足迹。
- 班级密码用于访客查看；已认领且登录的本班同学无需重复解锁。更改班级密码使旧的访客解锁失效；个人登录仍以成员身份授权。
- 管理员导入时使用的 `student_code` 是稳定编号，可以是学号或自定义短编号。普通访客看不到他人的编号。
- 普通同学默认以名单中的姓名登录，也可用姓名与认领码认领；同名认领由各自的认领码区分，同名登录请展开「同名或使用原来的班级编号」。原有编号登录 API 仍兼容。修改姓名后使用新姓名登录。
- 普通成员设置和修改个人密码只需 6–200 位，允许纯数字，不要求复杂度。班级管理员、Django 管理员以及班级查看码仍保留原有密码校验；会话、CSRF、登录限流和一次性认领规则保持不变。

## 预填链接

推荐使用班级页面 URL 的 fragment（`#` 后参数），例如：

```text
/c/our-class/#name=张三&claim_code=一次性认领码
/c/our-class/#view_code=班级查看码
/c/our-class/#name=张三&claim_code=一次性认领码&view_code=班级查看码
```

| 参数 | 含义 |
| --- | --- |
| `name` | 名单中的姓名，可预填登录 / 认领 |
| `claim_code` | 一次性认领码，解锁后打开认领表单 |
| `view_code` | 班级查看码，预填解锁表单 |
| `student_code` | 兼容原有编号入口；通常无需提供 |

参数使用 `URLSearchParams` 编码，尤其是中文、空格、`+`、`&` 和 `#`。也支持相同字段的 query 参数（`?name=...&claim_code=...`）；同一字段以 fragment 为准。管理页生成的链接统一使用 fragment，避免这些参数随 HTTP 请求进入服务器访问日志。页面读取后会从地址栏清除上述参数，不写入 localStorage；关闭或刷新页面后若仍需预填，请重新打开原链接。

打开链接只预填，不自动解锁、认领或设置个人密码。锁定班级仍须提交查看码；解锁后认领信息会保留并自动展示。链接含有访问凭据，应只发给对应同学。管理员可在生成认领链接时额外填入当前查看码，或单独生成查看链接；服务器不保存查看码明文，因此需要管理员自行输入。

## 历史语义与导入

一段位置有效于 **`[started_on, ended_on)`**：包括到达日，不包括离开日。空离开日期表示仍在此处；下一段可以从离开当天开始。只有资料存在覆盖时才显示该同学的位置，不用最后已知城市补齐未知时段。回看使用当前保存的历史资料，不是「当时数据库原样」的审计快照；后续纠错会反映在历史地图上。

`updated_at` 单独记录资料最后修改时间。个人足迹按到达时间排序；虚线仅表示记录先后，不代表实际交通路线。跨日期变更线的记录不直接画连接线，避免横跨整幅图。

管理页可下载 CSV 模板，仓库也提供 [docs/import-example.csv](docs/import-example.csv)。字段、更新规则和直辖市处理见 [docs/data-model.md](docs/data-model.md)。导入不生成默认个人密码，不会自动认领或授予管理员权限。

## 测试

```bash
DEBUG=1 python manage.py collectstatic --noinput
DEBUG=1 python manage.py check
DEBUG=1 python manage.py makemigrations --check --dry-run
DEBUG=1 python manage.py test tests
npm run check
npm test
```

CI 分别测试 SQLite 和 MySQL 8.4。核心覆盖：班级隔离、所有写接口权限、CSRF、密码轮换、认领过期和重放、区间边界与重叠、乐观锁、导入预览与回滚、行政区归一化、高德代理的权限和上游限制。MySQL 作业额外执行并发区间写入测试。

2026-10-29 使用真实高德开发凭据与虚构同学数据完成浏览器联调：底图与审图号、世界国界点击进入中国、中国省界、浙江市界点击筛选杭州、历史日期切换、个人足迹编号和连线、城市检索与地图选点回填。该次联调通过只读前端测试服务进行，未覆盖浏览器提交至 Django、生产安全代理、正式域名或真实班级数据；业务写入由上述后端测试验证。凭据与联调数据不提交到仓库。

2026-10-30 完成 FC + RDS 部署及 HTTPS 测试子域名联调：浏览器提交班级查看码、中国底图与浙江行政区、历史日期切换、个人足迹编号及连线均通过；同源高德代理的行政区与地理编码接口返回成功。安全密钥只保存在服务端。预览使用带查看密码的独立虚构班级，没有正式名单或默认管理员账号。部署步骤见 [FC 部署说明](docs/fc-deployment.md)。

## 边界

- 已验证 FC、RDS、自定义域名和高德安全代理；尚未接入真实班级数据。每个新环境仍需独立配置数据库、地图凭据与 HTTPS，并维护证书续签。
- 已预留多班级数据隔离，但没有自助开班、租户计费、跨班账号合并或租户域名管理。
- 单点位置由用户主动选择，不后台跟踪。城市级分享足以使用主要功能。共享班级密码意味着所有持有密码的人都能浏览班级资料。
- 省市列表由高德行政区服务提供，失败时可以手工填写城市名及市级行政区代码。服务配额、海外覆盖与特定地区数据可用性取决于供应商账号。
- 应用认证限流持久化在数据库，默认使用 REMOTE_ADDR，不盲目信任来路不明的 X-Forwarded-For；反代部署中可能共享一个 IP 限额。大型部署应在可信入口增加按真实客户端 IP 的限流。

## 许可证

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 ShadowMov。高德地图及其他第三方依赖、资源遵循各自的许可与服务条款。
