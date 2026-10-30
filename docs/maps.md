# 地图来源与坐标约定

## 图层

- 默认高德标准底图：由官方 SDK 请求和展示，保留原始地图标识。
- 世界：`AMap.DistrictLayer.World`，国家编码使用供应商 SOC / ISO alpha-3 口径。
- 中国：`AMap.DistrictLayer.Country({SOC: 'CHN', depth: 2})`，全国视图直接按地级市着色（2026-10-29 用真实 Key 在手机尺寸下验证可用）。
- 省份：`AMap.DistrictLayer.Province({adcode: [code], depth: 1})`，分市。直辖市及港澳按本省级单位作为业务城市；若供应商没有提供细一级边界，仍可从列表查看业务记录。
- 底图样式：`amap://styles/whitesmoke`（高德内置浅色样式），人数点为 HTML Marker，颜色只表达人数分档。
- 人数点位置：有坐标时取该城市同学坐标的平均值；没有坐标时国内取一次 `DistrictSearch('中国', subdistrict: 2)` 返回的行政区中心，只填省份的记录在省会旁偏移一点；海外取 `country-centers.js` 中的国家中心点（由公有领域的国家轮廓数据离线计算，只保留点坐标，不绘制任何边界）。
- 面板与地图：地图容器的底边随底部面板移动，高德的 logo、比例尺和审图号始终显示在面板上方，不移动、不隐藏供应商 DOM。
- 点选：`getDistrictByContainerPos`；行政区查询：`AMap.DistrictSearch`。采用其有明确示例的 v1.4.15 API。并非所有 v2 文档都包含相同拾取接口，不做未经验证的直接升级。
- 高德地图之外不加载其他瓦片或行政区矢量。代码不绘制国界或海上界线；不改写审图号，不伪造号段，也不隐藏供应商 logo / copyright DOM。

人数填充色不是边界修订。中国行政区业务标签包含 34 个省级单位；数据中的 HK/HKG、MO/MAC、TW/TWN 归一化为 CHN 下相应省级单位。国家标签来自 pycountry ISO 名录，不包含边界几何。

## 坐标

- 中国内地地图选点保存 GCJ-02。设备定位返回 GPS 坐标时，通过官方 `AMap.convertFrom(..., 'gps')` 转换后才能保存。
- 境外使用 WGS84。港澳台按供应商地图坐标选点，保留实际坐标系标签。
- 不执行自写的国内坐标转换算法。导入内地 WGS84 点位会被拒绝，提示先完成转换。
- 经纬度允许留空，省市记录仍参与人数统计；不会用 (0,0) 或随机城市中心冒充真实位置。
- 使用设备位置只在用户点击按钮后请求权限，不持续跟踪。选择坐标会调用地图供应商；保存后的姓名和备注只发往本站服务端，不提交给高德检索服务。

## 上线核对

填写真实 Key 与生产安全代理后，检查国家/省/市点击、海外地图加载、选择城市、境内 GPS 转换、日期筛选后的图层着色，以及手机窄屏下底图版权和审图号完整可见。尤其核对中国全图、台湾、港澳、边境和南海相关表示。代码中没有附带某次离线地图审核结论；使用官方服务也不能替代业务自身可能需要的审核和资质。

官方资料（2026-10-29 查阅）：

- [简易行政区图 v1.4：三个层级、字段与深度](https://lbs.amap.com/api/javascript-api/guide/layers/districtlayer/)
- [行政区拾取示例](https://developer.amap.com/demo/javascript-api/example/district/district-pick)
- [JS API 准备、Key 与安全代理](https://lbs.amap.com/api/javascript-api/guide/abc/prepare)
- [JS API 安全密钥使用](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)
- [开发者合规指南](https://developer.amap.com/api/compliance-center/check-and-reference/compliance)

不要照抄旧示例中硬编码审图号的做法。应展示实际服务提供的当前标识，并向供应商核对当前许可与覆盖范围。
