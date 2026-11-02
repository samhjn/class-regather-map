# 阿里云 FC 3.0 / RDS

应用使用 FC Custom Runtime（Debian 11）中的 Python 3.12，在 9000 端口运行 Gunicorn。静态文件在部署前收集到 ZIP，由 WhiteNoise 提供。数据库、会话和限流记录均保存在 RDS。

注意运行时的对应关系：FC 的 `custom.debian11` 提供 `/var/fc/lang/python3.12/bin/python3`；`custom.debian12` 默认提供 Python 3.11，不能直接套用这个启动命令。见[官方运行时说明](https://www.alibabacloud.com/help/en/functioncompute/custom-runtime/)。

## 准备

1. 选择与 FC 同地域、同 VPC 的现有 RDS MySQL 8.0+ 实例。
2. 在 RDS 中创建独立的 utf8mb4 数据库与普通账号，只授予该数据库的读写权限。不要复用其他应用账号或高权限账号。
3. 为 FC 创建专用安全组，选定 VPC 交换机；确保 RDS 白名单允许该交换机的地址段。不要为了部署放开 RDS 公网。
4. VPC 配置使用已授权给 FC 的 RAM 角色（如具有 AliyunFCDefaultRolePolicy 的 AliyunFCDefaultRole）。应用不需要云 API 权限，角色填写在 vpcConfig.role。

安装本地工具：

```bash
python -m pip install -r requirements.txt -r requirements-fc-tools.txt
python scripts/build_fc.py
```

脚本会构建 `.fc/code.zip`。原生依赖指定 Linux x86_64 / CPython 3.12，不能把 Windows 的虚拟环境直接上传。构建目录、部署 ZIP、凭据和本地数据库不会进入 Git；打包只包含应用目录、必要入口、静态文件及运行依赖，不含部署 SDK。

## 首次创建

复制 `deploy/fc-function.example.json` 到 `.fc/function.json`，填写 VPC、交换机、安全组、角色 ARN 和 RDS 内网地址。配置文件中不填写 AK/SK 或数据库密码。

```bash
python scripts/fc_manage.py create --account <阿里云账号ID> --region cn-hangzhou --function class-regather-map --config .fc/function.json --public-http --prompt-credentials
```

该命令通过无回显提示读取 AK/SK、数据库密码，只在进程内存中使用；也支持官方 SDK 凭据链及 `MYSQL_PASSWORD` 环境变量。随机 Django SECRET_KEY 与数据库密码写入 FC 的应用环境变量，不写进代码包或部署报告。AK/SK 不会传入函数。

创建顺序：Web 函数 → 临时 IAM 维护函数 → 迁移及数据库写入/回滚检查 → 删除维护函数 → HTTP 入口 → 精确设置 ALLOWED_HOSTS 和 CSRF_TRUSTED_ORIGINS。重复创建同名函数会失败，不覆盖旧资源。若中途失败，检查控制台中的已创建资源，再用 migrate/update 继续；脚本不会删除应用数据库。

临时维护函数使用完整 UUID 命名并记录归属标记。即使创建请求超时，脚本也会查询该名称并仅删除标记匹配的资源；创建结果不确定或清理失败时会输出函数名。若云端在查询后才完成创建，需按提示再次确认资源已移除。初始化时其中可能包含管理员密码，因此不要忽略清理提示。

`--public-http` 明确开放默认公网地址，允许 GET、HEAD、POST、PATCH、DELETE；应用登录、班级权限和 CSRF 检查照常生效。默认配置为 0.5 vCPU / 512 MB、单实例 4 个并发请求、函数并发上限 8，无预留实例，可缩容到零。连接每次请求后关闭，避免空闲实例长期占用 RDS 连接。

FC 的默认 `fcapp.run` 地址用于接口验证。实测响应附加 `Content-Disposition: attachment`，浏览器会下载页面；首页等重定向还会被平台拦截为 `ExternalRedirectForbidden`。完整网页访问需要配置自定义域名。保持应用认证与 HTTPS/Cookie 设置不变，使用 `/healthz/` 和直接 API 路径验证。参见[官方 HTTP 触发器说明](https://www.alibabacloud.com/help/en/functioncompute/configure-an-http-trigger-for-a-function-and-invoke-the-function-by-using-http-requests)。

## 验证与更新

```bash
python scripts/fc_manage.py check --account <阿里云账号ID> --region cn-hangzhou --prompt-credentials
curl https://<默认验证域名>/healthz/
```

check 在临时、无 HTTP 触发器的维护函数里检查迁移状态，并实际写入、读取、回滚一个隔离的探测记录；成功后不留下业务数据。HTTP 健康接口返回 `{"status":"ok"}` 表示 Web 进程也能连接 RDS。另检查 `/admin/login/`、静态资源和缺少 CSRF 的写请求是否被拒绝。

升级前按正常数据库备份流程备份。重新打包后：

```bash
python scripts/build_fc.py
python scripts/fc_manage.py update --account <阿里云账号ID> --region cn-hangzhou --prompt-credentials
```

update 先在临时函数中迁移，再更新 Web 代码，保留现有环境变量与网络配置。迁移应兼容旧版本运行中的请求；不兼容的迁移需要安排维护窗口。失败时不会自动回滚数据库。不要在每次 FC 冷启动时执行 migrate。

## 初始化班级与管理员

部署默认只建表，不创建班级、管理员、默认口令或演示名单。需要开始使用时显式执行：

```bash
python scripts/fc_manage.py bootstrap --account <阿里云账号ID> --region cn-hangzhou --prompt-credentials
```

命令交互读取管理员用户名、管理员密码、班级查看码和班级名称。密码只传给临时维护函数，完成后该函数被删除；已有班级或管理员不会被覆盖。首次初始化前，默认班级的直接地址返回 404 属于预期；健康接口与管理员登录页仍可用于部署验证。默认 FC 地址还受前述下载与重定向限制。

## 自定义域名与高德地图

在 FC 中创建同地域自定义域名，将 `/*` 路由到应用函数的 `LATEST`，允许 GET、HEAD、POST、PATCH、DELETE。为域名添加 CNAME，目标为 `<账号ID>.<地域>.fc.aliyuncs.com`；中国内地地域需满足 FC 的备案要求。上传包含域名的有效证书与私钥，开启 HTTPS，最低 TLS 1.2。证书私钥只交给 FC，不放入代码仓库或报告。

在函数环境变量 `ALLOWED_HOSTS` 中追加准确域名，在 `CSRF_TRUSTED_ORIGINS` 中追加 `https://域名`。保留 `SECURE_SSL_REDIRECT=1` 和 Secure Cookie，通过实际浏览器检查首页跳转和表单。

### 可选：通过 ESA 回源时的可信入口与真实客户端 IP

**不使用 ESA、只用 FC 自定义域名时，不设置 `ESA_ORIGIN_SECRET`，仍按下文实测结果选择可信 XFF 跳数。** 如果使用 ESA → FC → RDS，建议启用应用层回源认证，防止攻击者绕过 ESA、通过公开的 FC HTTP 触发器直接调用应用接口。

1. 在安全位置生成至少 32 字符的随机令牌，例如 `python -c 'import secrets; print(secrets.token_urlsafe(48))'`。令牌只应配置在 ESA 回源规则与 FC 环境变量，不要放入代码、浏览器、URL、截图或流水线日志。
2. 在 ESA 的 **规则 → 转换规则 → 修改请求头 → ESA 到源站** 中，为此站点所有回源请求设置两条**添加（覆盖同名客户端值）**规则：
   - `X-Regather-Origin-Token`：**静态**值，等于上一步生成的令牌。
   - `X-Regather-Client-IP`：**动态**表达式 `ip.src`，让 ESA 写入请求者的真实 IP。不要从原请求照搬这两个头，也不要使用“变更（只在原头存在时生效）”。
3. 在 FC 的应用函数环境变量设置 `ESA_ORIGIN_SECRET=<相同令牌>`，并建议将 `TRUSTED_PROXY_HOPS=0`；ESA 模式下应用只使用受令牌保护的 `X-Regather-Client-IP`，不再需要推断 ESA/FC 的 XFF 代理层数。部署该配置前要确保 ESA 回源规则已生效，否则业务接口和健康检查会被应用返回 403；注意 WhiteNoise 在本项目中先于业务安全中间件处理静态文件，因此静态资源可能仍能从 FC 直接访问，但不包含私有班级数据。
4. 绑定真实 HTTPS 域名，确认 Host、`X-Forwarded-Proto` 和 Django 的 `ALLOWED_HOSTS` 配置正确。必须在 ESA 中禁用 `/c/`、`/admin/`、`/_AMapService/` 等私有路径的缓存，并确认遵循 `Cache-Control: private, no-store`；静态文件可独立缓存。
5. 验证经过 ESA 的正常访问为 200，而直接访问 FC 默认验证 URL（未携带内部令牌）为 403。模拟浏览器伪造 `X-Regather-Origin-Token` 或 `X-Regather-Client-IP` 时，**由 ESA 回源规则覆盖请求头**，不得让客户端控制它们。令牌泄漏后应同时在 ESA 和 FC 中轮换。

这是一道**应用层内容访问门禁**：FC 的公开 HTTP 触发器依然可能被直接调用并产生少量函数调用费用，应用返回 403 不等于云网关/网络层已经拒绝流量。如需防止源站调用费用或 L7 DDoS，仍须结合产品实际可用的源站访问控制与限流能力。不要把 ESA 回源 IP 白名单假设为 FC 匿名 HTTP 触发器已经提供的能力，也不要在没有验证流量来源的情况下仅信任 `X-Forwarded-For`。

参考：[ESA 修改出站请求头](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/modify-outgoing-request-header)、[ESA 源站防护](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/origin-protection)、[FC HTTP 触发器](https://help.aliyun.com/zh/functioncompute/http-triggers-overview)。

### 跨域访问边界（必须验收）

FC 旧版默认 CORS 行为会回显浏览器请求中的 `Origin`，并可能附加 `Access-Control-Allow-Credentials: true`。同一注册域下不同子域（例如 `other.example.com` 与 `class.example.com`）在 `SameSite=Lax` 下仍属 same-site，因此不能靠 Cookie 的 SameSite 设置保护跨源读取。

应用的 `PrivateResponseMiddleware` 会拒绝 `Origin` 与实际 HTTPS scheme/Host 不一致的请求；对班级 API、后台和高德代理，也通过 `Sec-Fetch-Site` 阻止跨源子资源请求，但不拦截从其他网站跳转进入班级页面的顶层导航。**由于 FC 网关可能仍给 403 响应回显 CORS Header，验收标准是不会泄露私有内容，而不是单凭响应中不存在 CORS Header。** 部署时 `TRUST_PROXY=1` 的前提是网关可信地覆盖 `X-Forwarded-Proto`，并且 `ALLOWED_HOSTS` 只包含实际域名。

FC 的网关级 `corsConfig`（API Configured CORS）目前属于邀测能力，未开通的账号可能仍执行默认回显；应用安全不能依赖该功能。若账号已开通，建议额外配置仅允许应用的 HTTPS origin，且不向其他 origin 允许凭证。见[官方 CORS 说明](https://www.alibabacloud.com/help/en/functioncompute/http-triggers-overview)。

使用**已解锁的测试班级会话**验证，下例的 cookie 文件应仅放在本机安全位置，不打印到 CI 日志或提交到仓库：

```bash
# 同一份有效测试会话：请求同源时应返回 200；跨源 Origin 必须返回 403。
curl -si -b /secure/path/test-cookies.txt https://class.example.com/c/our-class/api/snapshot -H 'Origin: https://class.example.com'
curl -si -b /secure/path/test-cookies.txt https://class.example.com/c/our-class/api/snapshot -H 'Origin: https://other.example.com'
# 无 Origin、但声明为跨源子资源的浏览器请求也必须被拒绝。
curl -si -b /secure/path/test-cookies.txt https://class.example.com/c/our-class/api/snapshot -H 'Sec-Fetch-Site: same-site' -H 'Sec-Fetch-Mode: cors'
```


FC 无需 nginx 即可使用内置高德安全代理。在控制台设置以下环境变量，并将函数 `internetAccess` 设为 `true`：

```text
AMAP_JS_KEY=<高德 Web 端 JS API Key>
AMAP_PROXY_ENABLED=1
AMAP_PROXY_SECURITY_CODE=<与该 Key 配套的 securityJsCode>
AMAP_SERVICE_HOST=/_AMapService
# 以下为每一班级、每一客户端 IP 在 15 分钟内的预算；可按访问量调整
AMAP_PROXY_TILE_LIMIT=3000
AMAP_PROXY_API_LIMIT=300
```

代理只允许已有班级访问权限的浏览器会话，重新检查班级锁定状态。上游固定为高德官方 `webapi.amap.com`、`fmap01.amap.com` 和 `restapi.amap.com`，且路径限定为 `v4/map/styles`、`v3/vectormap`、`v3/config/district`、`v3/geocode/geo`、`v3/geocode/regeo` 和 `v3/assistant/coordinate/convert`（地图资源可有子路径；坐标转换用于设备 GPS 转 GCJ-02）；未来变更 SDK 时需先确认新请求并按需扩充白名单。使用 HTTPS，不跟随重定向，不转发浏览器 Cookie 或 Authorization；客户端不能覆盖服务端安全密钥。请求有长度、超时和响应体上限，还使用现有 RDS 限流桶分别限制瓦片与 REST API；达到限制返回 429。由于每次请求会产生一次数据库计数写入，访问量大时应转向入口限流或独立缓存服务。JS Key 会用于浏览器 SDK，安全密钥仅留在 FC 环境变量中。高德控制台的域名白名单也需包含网页域名。参见[高德安全代理说明](https://developer.amap.com/api/javascript-api/guide/abc/prepare)。

若继续使用独立 nginx 代理，保持 `AMAP_PROXY_ENABLED=0`，使用 `docs/nginx.conf.example`。生产环境不把安全密钥放进 `AMAP_SECURITY_JS_CODE` 或前端代码。

证书需要在到期前续签并更新 FC；DNS-01 验证记录应只清理本次创建的记录，保留其他服务的 DNS 配置。部署脚本不自动续签证书。验收应覆盖真实底图、行政区下钻、地理编码、应用认证与 CSRF；未提供有效地图凭据时不能声称地图已验证。

### 预发布验收门槛（合并/正式上线前）

在独立的、使用虚构成员与单独查看码的 staging 班级执行：

```bash
# 仅需公网 HTTPS 地址，无须提供云凭据；查看码通过无回显交互输入
python scripts/fc_smoke.py --url https://staging.example.com --class-slug preview
# 如果启用 ESA 回源认证，并且 FC 仍公开默认验证地址，额外检查直连被拦截
python scripts/fc_smoke.py --url https://staging.example.com --class-slug preview \
  --direct-fc-url https://<fc-verification-domain>
```

脚本只发起健康、解锁、读取、跨源拒绝、地图白名单及坐标转换等请求；不修改成员资料，不打印 Cookie/地图 Key/查看码/成员数据。检查通过不代表浏览器地图功能已经验收，还必须在 HTTPS 真实浏览器中确认：世界/中国/省市下钻、真实底图与审图号、浏览器地理定位 `AMap.convertFrom`、地理逆编码及无权限访问被拒绝。在 DevTools Network 中检查是否存在被 400 拦截的 `/_AMapService/` 请求，重点关注 `v3/assistant/coordinate/convert` 和后续版本新接口。

在两个独立公网出口测试少量正常请求，核对两者不会共享客户端 IP 限流身份；另外人为给客户端请求加入虚假 XFF 前缀、虚假 ESA 头，确认不会改写计数归属。必要时在**隔离的** staging RDS 中查询限流记录（哈希键不可直接当作原始 IP）；不要在真实班级对登录或地图接口做大规模压测。记录前端完整地图浏览、缩放、切换视角的请求数以及 RDS 写事务和 FC 调用，评估是否需要将瓦片限流从数据库移到边缘。验收失败应继续保持 PR 为 Draft，不应仅凭 CI 成功上线。

## 运行边界

- `REGATHER_FC=1` 禁止缺少 MYSQL_HOST 时退回 SQLite。FC 保留 `FC_` 前缀，因此自定义变量使用 `REGATHER_FC`、`PORT`、`GUNICORN_THREADS`。
- 只在 FC 可信入口后设置 TRUST_PROXY=1。新增代理时，应重新验证 HTTPS 判断、Host、CSRF 来源与 Cookie。
- **未启用 ESA 回源认证时**，客户端限流使用 `TRUSTED_PROXY_HOPS`：`REGATHER_FC=1` 时默认 1，其他环境默认 0（只使用连接对端地址），可显式设为 0–8。FC 模板声明为 1，从 `X-Forwarded-For` 右侧取网关写入的地址；客户端伪造的左侧前缀不参与计数。**启用 `ESA_ORIGIN_SECRET` 时**，必须同时具有合法回源令牌和 ESA 改写的客户端 IP，请求才会到达应用；限流不使用 XFF。解锁、登录/认领和后台登录共用此解析，账号级限流继续生效。
- 启用转发地址信任的前提是应用端口只能由这些代理访问，且入口覆盖或追加真实对端 IP。新增 CDN/WAF/nginx 后应先验证实际转发链，按固定可信层数配置，不能直接取最左侧值或盲目增加层数。缺失、过短或可信部分无效的头回退到连接对端。上线验收应确认不同来源 IP 独立计数，伪造 XFF 前缀无法绕过限流；参见 [XFF 的安全解析规则](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For)。
- **真实网关验收不能由单元测试代替**：在隔离的预览班级，从不同公网 IP 进行少量合法的地图请求，再使用伪造前缀的 `X-Forwarded-For` 重试，结合隔离环境的限流桶验证计数归属；如果 FC 网关并不覆盖/追加真实来源，先设 `TRUSTED_PROXY_HOPS=0`，并在可信入口建立限流，不要照搬 1 跳的模板。不要在真实班级上使用大量失败登录来做此测试。
- Gunicorn 使用 /tmp 保存工作文件，访问日志不记录查询串或 Cookie；不向应用函数注入长期 AK/SK。
- 后续需要定期运行 clearsessions / clearratelimits，并监控 RDS 连接数和备份状态；本次部署不自动添加定时任务。
- 默认验证地址和真实高德地图验证是两个独立环节。正式域名、高德安全代理与真实班级名单不由部署脚本自动创建。
