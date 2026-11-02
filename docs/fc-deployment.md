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

高德 Key 与生产安全代理需另外配置。未提供真实地图凭据时，只能验证无地图配置时的界面，不能声称真实底图已验证。应用默认不访问互联网；若后续把高德安全代理实现于 FC 内，需要单独配置受限的上游代理和出网能力。

## 运行边界

- `REGATHER_FC=1` 禁止缺少 MYSQL_HOST 时退回 SQLite。FC 保留 `FC_` 前缀，因此自定义变量使用 `REGATHER_FC`、`PORT`、`GUNICORN_THREADS`。
- 只在 FC 可信入口后设置 TRUST_PROXY=1。新增代理时，应重新验证 HTTPS 判断、Host、CSRF 来源与 Cookie。
- Gunicorn 使用 /tmp 保存工作文件，访问日志不记录查询串或 Cookie；不向应用函数注入长期 AK/SK。
- 后续需要定期运行 clearsessions / clearratelimits，并监控 RDS 连接数和备份状态；本次部署不自动添加定时任务。
- 默认验证地址和真实高德地图验证是两个独立环节。正式域名、高德安全代理与真实班级名单不由部署脚本自动创建。
