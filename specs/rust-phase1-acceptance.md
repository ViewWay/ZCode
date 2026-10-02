# Spec：阶段 1 —— V4 wire 编解码 Rust 化 · 验收标准清单

> 状态：v2（v1 由 bob 基于研究报告 §4 阶段 1 与仓库实测独立起草；v2 按 §10 与
> alice 的 `specs/rust-phase1-wire-codec-plan.md` 交叉对照后修订范围与口径）。
> 上游文档：`specs/rust-migration-research.md`（阶段 1 方向）；本文件是它的
> 可执行验收细化，不改变报告的推荐路线与范围。

## 0. 验收对象与接口边界（v2 修订：采纳方案 §0「Rust 只做字节面」收敛口径）

Rust 化对象精确到函数级（`packages/shared/src/zcode-protocol-v4/`，实测共 1,285 行）。
**v2 修订说明**：v1 曾把 `encodeTopicWireFrames` / `measureTopicNotificationEnvelopeBytes` /
`vqlByteLength` 整体列为 Rust 化对象；方案以「JSON 面进 Rust 会让键序/数字格式化/转义
语义的逐字节一致纳入差分范围，风险与工作量数量级上升」为由将其留在 TS。经对照采纳
方案口径，并作为验收基线：

| 层 | 函数/符号 | 归属 | 验收方式 |
| --- | --- | --- | --- |
| 字节面 | `crc32WireBytes`（CRC-32，多项式 `0xEDB88320`，8 位小写 hex） | **Rust**（napi） | 原语级 TS↔napi 差分 |
| 字节面 | `encodeWireBytesBase64` / `decodeWireBase64`（宽松解码器，接受非 canonical 尾 bit） | **Rust**（napi） | 原语级差分 + golden 专项 |
| 字节面 | `reassembleTopicWireFrames` 的字节阶段（base64 逐片解码、重复片冲突、字节累计上限、拼接、crc 校验、严格 UTF-8 + 前导 BOM 剥离） | **Rust**（napi `assembleFragments`） | 原语级差分 + 交叉互操作 |
| 元数据/语义面 | reassemble 的元数据一致性检查、`frameSchema.safeParse`（zod）、`WIRE_FAULT_INVALID_PAYLOAD` | **TS**（事实源不变） | golden 锁定行为不变 |
| JSON 面 | `encodeTopicWireFrames`（二分预算/分片判定）、`measureTopicNotificationEnvelopeBytes`、`vqlByteLength`、`utf8JsonByteLength`、`TopicWireFrameAssembler` 状态机 | **TS**（全部不迁） | 双后端等价差分（见 §2.2 口径 B） |

**接口边界（写入 FFI 契约与 crate 文档的硬约束，PR 评审 checklist 项）**：
- Rust 不出现 `JSON.stringify` / `JSON.parse` 对应逻辑、不引入 zod/serde schema 副本；schema 语义唯一事实源是 `packages/shared` 的 zod 定义（方案 §0、§7.4 同此约束）。
- Rust 侧 reasonCode 字符串为镜像常量，golden 断言 TS 常量 == Rust 常量（防双源漂移）。
- `reassembleTopicWireFrames` / `encodeTopicWireFrames` / `TopicWireFrameAssembler` 对外签名零变化；browser（packages/ui）零改动；SEA/CLI 固定 TS 后端。

## 1. 前置条件（依赖阶段 0 护栏，缺失即本清单整体不生效）

- [ ] A1 `crates/`（或 `native/`）Rust 工作区已建立，`cargo build --workspace` 在 darwin/linux/win32 × x64/arm64 矩阵通过。判据：CI/本地矩阵构建日志，0 error。
- [ ] A2 仓库存在统一 wire 测试入口（建议 `pnpm verify:wire`，内部 `node --import tsx --test`，框架沿用仓库现状 `node:test` + `node:assert/strict`，见 `packages/services/test/` 范式）。判据：root `package.json` scripts 中存在该入口且 `pnpm verify:wire` 退出码 0。
- [ ] A3 阶段 0 固化的双链路 E2E 各 1 条可运行（`desktop-continuous`、`web-remote-replayable`）。判据：两条用例在干净检出上通过。
- [ ] A4 `pnpm typecheck`、`pnpm lint`、`pnpm verify:pre-push` 全绿（未因新增 Rust 工作区破坏）。判据：三命令退出码 0。

## 2. 差分测试验收（核心项）

### 2.1 golden 向量集构成（固定向量，人工评审后冻结）

向量集格式：JSONL，每行含 `case_id`、`op`（crc32/base64_encode/base64_decode/encode_frames/reassemble/measure_envelope）、`input`（bytes 以 hex；frames 以 JSON）、`expected`（输出或 `error.reasonCode`）。

- [ ] B1 覆盖 CRC-32 标准校验值：空字节（`crc32WireBytes(new Uint8Array(0))` = `"00000000"`）、`"123456789"` = `"cbf43926"`（业界 check value）、`"The quick brown fox jumps over the lazy dog"` = `"414fa339"`、全 0x00 1KiB、全 0xff 1KiB。判据：TS 与 Rust 对每个向量输出逐字符相等。
- [ ] B2 覆盖 base64 padding 三态：输入长度 %3 = 0 / 1 / 2 各 ≥3 个向量（含 0 长度）；非法输入向量（非字母表字符、错误 padding、长度非 4 倍数、空串以外的畸形）→ TS 返回 `null`，Rust 返回同语义 `null/None`。判据：双向逐字节一致。
- [ ] B3 覆盖变长编码边界（v2：JSON 面留 TS，本条改为 **TS 侧行为锁定**，不涉 Rust）：`measureTopicNotificationEnvelopeBytes` / `vqlByteLength` 在值 0、1、127、128、16383、16384、`Number.MAX_SAFE_INTEGER` 处的三层计量结果在双后端（ts/rust）下逐位相等。判据：golden 中保留该组向量，双后端运行结果一致。
- [ ] B4 覆盖帧分类边界（v2 口径：`encodeTopicWireFrames` 主体留 TS，验收对象为**双后端等价**——注入 native crc32/base64 后端与纯 TS 后端，输出必须逐字节相等）：
  - complete 帧（logical ≤ 预算，输出单帧 `kind:"complete"`）；
  - 恰好压线（计量结果 == `maxPhysicalFrameBytes`）与超 1 字节（→分片）；
  - `logical` 恰为 `maxFrameBytes`(1 MiB) 边界；
  - 多分片（≥2 片，且至少 1 例 fragmentIndex > 0）；
  - UTF-8 多字节内容跨分片切割（中文、4 字节 emoji，分片按 bytes 切割不保 UTF-8 边界，重组后内容必须完整）。
  - 判据：同一输入双后端输出的 frames 数组 JSON 序列化逐字节相等（含 `checksum.value`、`dataBase64`、`fragmentCount`、`fragmentIndex`）。
- [ ] B5 覆盖 fail-closed 错误路径（两侧必须抛出**相同 reasonCode 字符串**）：
  - `proto.frameAssemblyTooLarge`（logical > 16 MiB）；
  - `proto.frameEnvelopeTooLarge`（分片预算 <1 或计量漂移超限）；
  - `proto.frameFragmentCountExceeded`（> 1024 片）；
  - `proto.invalidLimit.*`（maxPhysicalFrameBytes / maxAssemblyBytes 为 0、负数、NaN、Infinity）。
  - 判据：差分脚本对每个错误向量断言 `error.reasonCode` 相等。
- [ ] B6 覆盖 `reassembleTopicWireFrames` 全部结果分支（v2 口径：Rust 侧 `assembleFragments` 返回 `{ok, reasonCode, missingIndexes?}`，TS wrapper 转回现有三态形状——两种表示都要断言）：
  - `complete`（单帧 complete 与多片重组两种）；
  - `incomplete`（`missingIndexes` 数组逐元素相等）；
  - `rejected` 全部 reasonCode（`proto.frameAssemblyEmpty`、`proto.frameFragmentCountExceeded`、`proto.frameAssemblyMetadataMismatch`、`proto.frameAssemblyTooLarge`、`proto.frameAssemblyInvalidBase64`、`proto.frameAssemblyFragmentConflict`、`proto.frameAssemblyLengthMismatch`、`proto.frameAssemblyChecksumMismatch`、`proto.frameAssemblyInvalidUtf8`、`WIRE_FAULT_INVALID_PAYLOAD`）。
  - 判据：三态 result 的 JSON 表达逐字节相等；其中 Rust 直产的 6 个 reasonCode（InvalidBase64/FragmentConflict/TooLarge/LengthMismatch/ChecksumMismatch/InvalidUtf8）两侧字符串逐字符相等。

### 2.2 随机帧差分（报告「≥10^5 随机帧零差异」的落地定义）

- [ ] B7 随机帧生成器要求：
  - **种子可复现**：生成器采用自实现确定性 PRNG（如 splitmix64，避免运行时随机源），主种子写死在仓库文件（建议 `specs/../native/wire-diff/seed-v1.txt` 或随向量集目录提交）。任何一次 CI 失败可用同一 seed 精确重放。
  - **种子版本化**：种子文件变更 = 向量集变更 = 必须重新冻结基线（写入脚本断言）。
- [ ] B8 分布覆盖要求（10^5 帧主跑的构成下限，由生成器配置文件声明并在报告中输出实际分布）：
  | 维度 | 桶 | 每桶下限 |
  | --- | --- | --- |
  | 帧长度 | 0 B / 1–15 / 16–255 / 256–64 KiB / 64 KiB–1 MiB / 1 MiB–16 MiB | 各 ≥1,000 帧 |
  | 内容类型 | ASCII / 含中文 UTF-8 / 含 4 字节 emoji / 均匀随机字节 / 全 0x00 / 全 0xff | 每类 ≥5% |
  | 边界扰动 | maxPhysicalFrameBytes ∈ {`PROTOCOL_V4_LIMITS.maxFrameBytes`, 随机小值, 恰好压线值}；分片数 ∈ {1, 2, 1023, 1024} 邻域 | 显式覆盖 |
  | deliveryKind | **v3 修正**（alice 指出 v2 维度错误，经 `wire.ts:16` 核实：`topicFrameDeliveryKindSchema = z.enum(["initial","online","recovery"])`——desktop-continuous / web-remote-replayable 是 clientMode/deliveryProfile 维度，不是帧级 deliveryKind）：`initial` / `online` 各 50%；`recovery` 字节面仅参与元数据等值比较，由 golden 显式覆盖 ≥3 例，不进随机分布 | 三态全覆盖 |
- [ ] B9 主跑判据（v2 档位对齐方案 §4.2：同进程双实现对拍，分两档）：
  - CI/pre-push 常规档：`pnpm verify:wire`（或方案指定的对等入口）跑 10^4 帧零差异，阻塞；
  - 验收里程碑档：10^5 帧零差异（全分布），输出 `frames=100000 mismatch=0` 且退出码 0。
  - mismatch 定义：任一字段（含错误 reasonCode）不相等即计 1；失败必须打印种子与最小复现用例。
- [ ] B10 交叉互操作（v2 口径按方案 §3.3/§4.2：同进程共存，对拍天然交叉）：同一输入喂「纯 TS 路径」与「napi 路径」，encode 侧与 reassemble 侧均深比较；对同一随机集交叉组合至少 10^4 帧。判据：双路径 `kind:"complete"` 且 frame 深相等。
- [ ] B11 故障注入差分：随机帧集合上做字节翻转、分片截断、checksum 篡改、`fragmentCount` 抬高四类注入，两侧 `reasonCode` 必须一致。判据：注入用例 mismatch=0。
- [ ] B12 放大跑（不阻塞合并，夜间/手动）：随机 seed 跑 10^6 帧，结果写入 job 摘要。判据：脚本存在且有产物（仓库当前无远端 CI 时，为本地可运行脚本 + 结果文件约定）。

### 2.3 CI 接入点

仓库现状**没有** `.github/workflows`（实测），现有阻塞机制是 husky pre-push（`verify:pre-push` = lint + architecture:check）。因此：

- [ ] B13 阻塞点（必须，v2：infra CI 未落地前的唯一强制防线）：`pnpm verify:wire` 挂入 husky pre-push 链（与 `verify:pre-push` 并列或并入），含 B1–B6 固定向量 + B9 常规档 10^4 随机帧；验收里程碑时手动跑 10^5 档。**性质：阻塞**（失败禁止 push，除非显式 `--no-verify` 留痕）。方案需补此条（见 §10.3 P1）。
- [ ] B14 条件项（仓库引入远端 CI 时生效）：`.github/workflows/wire-diff.yml`，matrix darwin/linux/win32 × x64/arm64；固定向量 + 随机主跑为**阻塞检查**，B12 放大跑为非阻塞 job。未引入远端 CI 时此项标记 N/A 并注明。
- [ ] B15 差分脚本自身有单测（种子重放确定性：同 seed 两次运行输出相同摘要）。判据：`pnpm verify:wire -- --selftest` 通过。

## 3. 功能等价与运行时守卫

- [ ] C1 TS 实现的既有测试全绿：`pnpm verify:wire -- --ts-only`（或阶段 0 建立的对等入口）全部通过，证明 golden 集对 TS 侧自洽。
- [ ] C2 napi 导出签名与 TS 函数同形：TS wrapper（`wire-binary.ts` 等原文件改为按 flag 分派）对外签名、`TopicWireFrameEncodingError.reasonCode` 行为不变。判据：`pnpm typecheck` 全绿 + C1。
- [ ] C3 运行时 canary 对拍（灰度期守卫）：开启 Rust 路径后，host 启动时及每 10,000 帧抽 1 帧（确定性抽样）用 TS 实现重放对拍；不一致时记录 `wire.codec.mismatch` 告警日志并累计计数，**不中断运行**。判据：守卫代码存在 + 演练中触发一次人为注入能观测到告警。

## 4. 性能基线与对比（报告「性能基线有据可查」的落地）

- [ ] D1 基线脚本 `scripts/bench-wire.mjs`（或 `native/wire-diff/bench.mjs`）存在：参数化帧大小（1 KiB / 64 KiB / 1 MiB × 各 ≥1,000 次 encode + reassemble）、双路径（flag=ts / flag=rust）、输出 ops/s 与 p50/p95 及进程 RSS。判据：脚本可运行并产出 JSON 结果。
- [ ] D2 基线入库：TS 路径基线在 Rust 接入**前**采集并提交（建议 `native/wire-diff/baseline-ts-<date>.json`），Rust 灰度后同参数采集对比结果。判据：两份结果文件入库，报告中引用路径。
- [ ] D3 通过标准（记录性，非合并阻塞）：Rust 路径编解码吞吐 p95 ≥ TS 路径 2 倍为达标；低于 2 倍不阻塞合并但必须在阶段 1 收尾报告中给出解释。判据：D2 两份数据 + 结论一行。

## 5. feature flag 灰度

- [ ] E1 flag 设计（v2 对齐方案 §5）：后端解析为 `wireCodecBackend`，环境变量 `ZCODE_WIRE_CODEC_BACKEND` ∈ `rust | ts | auto`，默认 `auto`（Node + napi 可用 → rust；否则 ts）；SEA/CLI 显式 `ts`；browser 不生效；非法值按 `auto` 处理并 warn 一次。**灰度时序：首发版本默认钉 `ts`（发布零行为变化），下一版本转 `auto`**。判据：flag 定义与解析顺序代码合入 + 各档（未设置/rust/ts/非法值/SEA/browser）单测覆盖。
- [ ] E2 默认关闭等价性：首发版本（默认 ts）对阶段 0 固定 E2E 的输出与 Rust 合入前的基线逐字节一致。判据：双链路 E2E 通过 + 产物 diff 为空。
- [ ] E3 灰度顺序（建议步骤，方案未硬性规定）：dev/test 环境先行（可经 `scripts/dev-desktop-env.mjs` 注入）→ desktop host 链路（`desktop-continuous`）→ server 链路（`entry-stdio` / `entry-http`，`web-remote-replayable`）。每步判据：对应 E2E 通过。
- [ ] E4 跨平台/加载失败兜底（v2 对齐方案 fail-closed 语义）：napi 加载失败或调用抛错 → 该进程 warn 一次并永久回落 TS，不崩溃、不加掩盖性兜底分支；win32 / Linux 缺产物同路径。判据：模拟删除 `.node` 产物后进程正常起、日志含回退记录；E2E 不降级。

## 6. 回滚演练（报告「可回退 TS」的落地）

- [ ] F1 flag 切回演练：灰度态（rust）→ 运行中切 `ZCODE_WIRE_CODEC=ts` 重启 → 双链路 E2E 通过 → golden 差分（TS 侧）通过。判据：演练记录（命令 + 输出）写入收尾报告。
- [ ] F2 无残留状态验证：切回 TS 后确认无 Rust 侧 staging/缓存被 TS 路径读取（reassemble 的原子语义保证无跨实现状态共享——由接口边界 §0 保障）。判据：代码评审记录 + F1 通过。
- [ ] F3 产物缺失演练：重命名 napi `.node` 文件模拟产物损坏 → flag=ts 功能正常（验证 TS 实现在 1 个版本周期内独立可用，支撑「保留到阶段 2 结束后 1 个版本再删」的承诺）。判据：演练通过。
- [ ] F4 回滚文档：flag 名称、切换命令、预期日志、E2E 验证步骤写入收尾报告附录，供值班直接照做。

## 7. 治理与产物

- [ ] G1 Rust 侧治理平移：单文件 ≤400 行、FFI 契约 ≤300 行（对齐 `architecture-policy.yaml`）；`cargo clippy -- -D warnings` 0 告警；`cargo-deny` / `cargo-udeps` 接入（对齐 knip 定位）。判据：各命令退出码 0。
- [ ] G2 分平台产物：napi 包进 darwin/linux/win32 × x64/arm64 构建矩阵（复用 `scripts/build-native-search-tools.mjs` 的分平台打包模式）。判据：矩阵产物清单与 SHA256 校验文件。
- [ ] G3 架构检查兼容：`pnpm architecture:check --changed` 通过（Rust 工作区不触发 forbidDeepImports / forbidCycles 误报；如需 policy 白名单，先改 policy 再合码）。
- [ ] G4 spec 更新：本文件与 `specs/rust-migration-research.md` 阶段 1 的偏差（若有）回写；含状态所有者与事件顺序图（AGENTS.md 对状态/时序方案的要求：TS/Rust 分派点、flag 读取时机、canary 对拍事件序）。

## 8. 明确不做（阶段 1 防蔓延边界）

- 不含 `wire-assembler.ts`（574 行会话级装配状态机）——阶段 3 传输层范围。
- 不含 `transport.ts`、hello/capability 握手、`zcode-protocol-legacy-types.ts` 与旧协议 `zcode-protocol/index.ts`——协议语义层一律不动。
- 不含搜索（embedded-search/native-search 管线）——阶段 2 范围。
- 不含传输层（node-pty、relay、permessage-deflate 压缩、mobile relay）——阶段 3 范围。
- 不改 `PROTOCOL_V4_LIMITS` 任何数值；不改任何 reasonCode 字符串。
- 不删 TS 实现（保留至阶段 2 结束后 1 个版本，见报告 §4 阶段 1 回滚条款）。
- 不引入 zod→serde 全量 schema 转译（仅帧内 JSON 字节层；schema 校验留在 TS，见 §0 接口边界）。
- 不在本阶段改 macOS 壳相关任何内容（swift-bridge 仍是占位包，阶段 4 才激活）。

## 9. 判定规则

- 阻塞项：A1–A4、B1–B11、B13、B15、C1–C2、D1–D2、E1–E3、F1、F3、G1–G3。任一未过 = 阶段 1 验收**不通过**，不得关闭灰度或进入阶段 2。
- 记录项（不阻塞但必须有数据/说明）：B12、B14（无远端 CI 时 N/A）、C3 演练观测、D3、E4、F2、F4、G4。
- 全部阻塞项通过 + 记录项有产物 = **阶段 1 验收通过**。

## 10. 与 alice 实施方案的交叉对照

对照方法：逐条核对方案是否为 §1–§7 每条 checklist 提供实现路径；方案新增内容回填本清单（补 checklist 或改判据）；方案与本清单冲突时以代码实测为准仲裁。v2 已完成对照，结论如下。

### 10.1 范围冲突仲裁（1 项，已按方案修订本清单）

| 冲突点 | 验收清单 v1 | 方案 | 仲裁 |
| --- | --- | --- | --- |
| Rust 化范围 | `encodeTopicWireFrames` / `measureTopicNotificationEnvelopeBytes` / `vqlByteLength` 整体 Rust 化 | 只做字节面（crc32 / base64 / `assembleFragments` / 严格 UTF-8+BOM）；JSON 面全留 TS | **采纳方案**。理由成立：JSON.stringify 与 serde_json 的键序/数字格式化/转义差异会把「逐字节一致」差分范围数量级放大，且字节面才是吞吐热点。本清单 §0 已重写。注意：报告原文「wire-binary + wire-codec + 分片重组 Rust 化」按方案口径解释为「其字节面 Rust 化」，需在阶段 1 收尾报告中显式说明该口径收敛，避免与研究报告读者产生理解偏差 |

### 10.2 方案已覆盖（无需补）

- §0 接口边界（schema 留 TS、reasonCode 镜像、公共签名零变化、browser/SEA 隔离）——方案 §0/§3.2/§3.3/§6.4 全覆盖。
- B2 base64、B6 reassemble 分支、B11 故障注入——方案 §4.1/§4.2 覆盖且更细（宽松解码器语义、`"AB=="` 非 canonical、重复片去重/冲突）。
- 方案独有的三个确定性边角（§1.2 BOM 剥离 / 非 canonical base64 / 重复片冲突）为真实代码事实，价值高，golden 必须含（本清单 B6 已并入 BOM 与冲突断言）。
- E flag（命名/解析顺序/灰度时序/SEA 双保险）、E4 fail-closed、F3 等价物（§6.5 注入加载失败演练）、G1 clippy/deny、G2 6-triple 产物 + native-policy、G3 policy 前置项——方案 §5/§6.7/§7.6 覆盖。
- §8 不做边界：方案 §8 补充「不做 musl / 不做 wasm / reason code 词表零扩充」，优于本清单，已认受。

### 10.3 缺口清单（请 alice 在方案中补；补齐前对应阻塞项不得判定通过）

| 优先级 | 缺口 | 方案现状 | 需补内容 |
| --- | --- | --- | --- |
| P1 | **测试入口与阻塞机制**（本清单 A2/B13） | §3.4.3 把 CI job 列为「验收项而非既有事实」，§7.9 承认 CI 宿主是开放问题；但未定义 infra CI 落地前 `packages/shared/test/wire*.test.ts` 的强制执行点 | 明确：pre-push 挂 `pnpm verify:wire`（或等价 script）跑 golden 全量 + 10^4 常规档对拍，作为 infra CI 落地前的阻塞防线；scripts 命令形态写进方案 |
| P1 | **随机对拍分布量化下限**（本清单 B8） | §4.2 定性列举（多字节 UTF-8、BOM、空段、乱序、重复、丢片、篡改、超限），无量化桶 | 补分布表：帧长度 6 桶（0 / 1–15 / 16–255 / 256–64Ki / 64Ki–1Mi / 1Mi–16Mi）各 ≥1,000 帧；内容 6 类各 ≥5%；分片数 1/2/1023/1024 邻域显式覆盖；deliveryKind 两态各 50%；脚本输出实际分布供验收核对 |
| P2 | **性能基线结果入库**（本清单 D2） | §6.6 数值只记 PR 描述 | PR 描述不可检索、不可跨阶段比对；改为基准结果 JSON 随 PR 入库（如 `rust/bench/`，spec 只引用路径），TS 基线在 Rust 接入前采集 |
| P2 | **CRC-32 业界标准校验值进 golden**（本清单 B1） | §4.1 crc32 清单无标准 check value | 补 `"123456789"` → `"cbf43926"` 与 `"The quick brown fox jumps over the lazy dog"` → `"414fa339"` 两个业界回归锚点（防实现级错位，成本≈0） |
| P3 | 回滚演练显式化（本清单 F1/F4） | §5 有双开关回退设计，无演练步骤与文档要求 | 补：灰度态切 ts → 双链路 E2E + golden 复跑的演练记录；回滚操作写入收尾报告附录 |
| P3 | Rust 文件行数治理（本清单 G1） | §7.6 只对齐 policy/clippy/deny | 明确单文件 ≤400 行、FFI 契约 ≤300 行约束（对齐 architecture-policy 精神） |
| P3 | 可选项（可显式豁免，豁免理由写入收尾报告） | — | 10^6 放大跑（B12）；差分脚本自检（B15）；灰度期运行时 canary 对拍（C3——方案靠 golden+10^5 差分兜正确性，若豁免运行时对拍需 lead 确认接受该残余风险） |

### 10.4 对照结论

方案整体质量高，范围收敛决策（字节面 only）与三个确定性边角（BOM/非 canonical/重复片）被验收清单 v2 采纳。

**闭环状态（2026-09-26，bob 终核）**：方案 v3（314 行版）已补齐本节全部缺口——P1-1（verify:wire 强制防线，§3.4.3）、P1-2（分布量化 + **reasonCode 命中矩阵 7 码各 ≥50 次定向注入**，§4.2）、P2×2（基线 JSON 入库含独立提交采集顺序要求、CRC 业界校验值双锚点）、P3×3（演练 A/B/C 留痕即验收标准 §6.8、400 行进强制自检、§9 豁免台账含 canary 裁决与重新评估时机）、§10 口径收敛说明（三栏对照表要求）。**两项复核依据均已落地**：① fail-closed 进程级语义显式化（§5「该进程」+ 演练 B「重启自动回 rust」）；② reasonCode 定向注入（按目标码反推扰动，注入帧与正常帧同路径对拍）。方案达到完整执行条件，**阶段 1 验收设计闭环**。canary 豁免会签已经 lead 确认属实（2026-09-26，裁决经 lead→alice 整改单通道传达：阶段 1 豁免运行时 canary 对拍，阶段 3 深水区失去纯函数性质时重新评估），§9 台账有效，**无遗留**。

---

## 11. 机器可判定性与演练设计（应 lead 要求：验收设计专项）

> 前提核对（2026-09-26 00:52 方案版）：方案 §10.3 所列 P1×2 / P2×2 缺口**均未补**（无 pre-push 挂载、无分布量化、基线仍记 PR 描述、golden 无 CRC 业界校验值）。本节设计在缺口补齐后即为完整执行方案；缺口未补期间，受影响条目按 §11.4 判定为「不可判定通过」。

### 11.1 判定级别定义与方案 §6 验收标准矩阵

- **L1 全自动**：单条命令 + 退出码/输出断言，可进 pre-push 或 CI，无人参与。
- **L2 半自动**：命令产出机器可读产物（JSON/日志），数值或内容需人工核对一次并留档。
- **L3 人工评审**：代码评审/spec 核对，无可靠机器判据。

| 方案验收标准 | 机器判定方式 | 级别 | 判据 |
| --- | --- | --- | --- |
| §6.1 cargo fmt/clippy/test + typecheck/lint/verify:pre-push | 6 条命令退出码 | L1 | 全部退出码 0 |
| §6.2 golden 三方一致（TS/cargo/napi） | `cargo test --test golden` + `packages/shared/test/wireGolden.native.test.ts` 退出码 | L1* | 退出码 0；*前置：napi 产物已构建。产物缺失时 native 测试必须**显式 skip 并输出原因**，禁止静默绿（防「没测到」冒充「测过」） |
| §6.3 1e5 帧零差异 | `wireFuzz.diff.test.ts` 档位环境变量，stdout 末行输出 `frames=<N> mismatch=<M> seed=<s>` | L1 | `mismatch=0` 且 N=100000；失败时脚本自动打印最小复现 case（机器产出，非人工定位） |
| §6.4 公共签名零变化 + packages/ui 零改动 | `pnpm typecheck` 退出码 + `git diff --stat -- packages/ui/src` 输出为空 | L1 | 两判据均通过。注意「零改动」用 diff 行数判定，评审不复述 |
| §6.5 双链路 E2E + 注入回退 | E2E 命令退出码（阶段 0 产物）+ §11.3 演练 R2 脚本 | L2 | E2E 全绿；R2 演练记录留档 |
| §6.6 性能基线 | bench 脚本产出 JSON（方案现状：数值仅记 PR 描述） | L2 | 存在两份可比对结果文件（TS 基线 + Rust 实测）；达标线（吞吐 p95 ≥ 2×）为记录性，人工判读 |
| §6.7 6-triple 产物 + native-policy | 构建产物清单 + `electron-builder` native-policy 校验退出码 + `doctor:macos-release` | L2 | 校验命令退出码 0；产物清单 6/6 且 SHA256SUMS 与清单一致 |

### 11.2 golden / fuzz 覆盖度的可证实机制（当前方案为散文清单，需机器化）

覆盖「写了」不等于覆盖「可证实」。四项机制，全部机器可核对：

1. **分布摘要强制输出**：`wireFuzz` 结束时输出机器可读 JSON 摘要（路径约定如 `rust/bench/fuzz-summary-<seed>.json`），字段：长度桶计数（0 / 1–15 / 16–255 / 256–64Ki / 64Ki–1Mi / 1Mi–16Mi）、内容类型计数、分片数直方图、deliveryKind 计数、**reasonCode 命中矩阵**。验收脚本对摘要做下限断言（长度桶各 ≥1,000、内容类各 ≥5% 等，见 B8）。
2. **reasonCode 命中矩阵（覆盖度证实的核心）**：6 个 Rust 侧错误码（InvalidBase64 / FragmentConflict / TooLarge / LengthMismatch / ChecksumMismatch / InvalidUtf8）+ `incomplete` 在 fuzz 结果中各自命中次数 ≥ 阈值（建议 ≥50）。没有命中矩阵，1e5 帧可能全部走 happy path，「零差异」不构成对错误路径的差分证据。
3. **golden 覆盖清单 manifest 对账**：把方案 §4.1 的覆盖清单机器化为 fixture manifest（`golden/manifest.json`：每个条目 = 必需 case_id 模式 + 最低数量）；对账脚本核对 `golden/*.json` 与 manifest 一致，缺条目即失败。业界校验值两个锚点（`"123456789"`→`cbf43926`、quick brown fox→`414fa339`）作为 manifest 固定条目。
4. **边界探针内置生成器**：`1MiB±1`、`16MiB±1`、分片数 `1023/1024/1025` 邻域由生成器确定性产出（非概率命中），进 golden 而非只进 fuzz。
5. （增强项，非阻塞）`cargo llvm-cov` 行覆盖对 `zcode-wire` ≥90% 且错误分支不豁免；结果文件随 PR 入库。

### 11.3 回滚开关演练剧本（对应方案 §5 双开关 + fail-closed）

| 演练 | 触发条件 | 步骤（命令 → 断言） | 级别 |
| --- | --- | --- | --- |
| R1 运行时开关回退 | 灰度态（rust 生效） | ① `ZCODE_WIRE_CODEC_BACKEND=ts` 重启 host → 日志无 napi 加载记录、后端解析为 ts ② 双链路 E2E 全绿 ③ golden 校验模式（TS 路径）全绿 | L2（建议脚本化为 `scripts/rollback-drill-wire.mjs`，退出码判定） |
| R2 产物缺失 fail-closed | flag=auto | ① 重命名 `.node` → 启动 → **warn 日志出现且仅一次**、E2E 全绿（功能不降级）② 恢复产物 → 重启 → 后端回到 rust（日志断言）③ 二次注入确认「永久回落」为进程级语义（新进程重试加载） | L2 |
| R3 代码开关回退（发版级） | 需发版的兜底 | `DEFAULT_WIRE_CODEC_BACKEND` 改回 ts → 构建 → 产物内 flag 求值为 ts（单测断言解析顺序），不依赖 env、不要求卸载 napi 依赖 | L1（解析顺序单测）+ L2（发布产物核验） |
| R4 SEA 隔离验证 | 每次发布前 | `pnpm build:sea` → 断言 CLI 依赖树/SEA 产物不含 `@zcode/shared-wire-native`（检查 build-sea 输入清单或产物 grep）→ 运行 encode 路径确认走 TS | L1 |

演练记录要求：R1/R2 各演练一次并留档（命令 + 关键日志行 + E2E 结果），写入阶段 1 收尾报告附录（即 F4）。

### 11.4 判定缺口与当前前置条件（重申 §10.3，阻断判定路径）

1. **P1-1 未补** → L1 判定无强制执行点：仓库无远端 CI，方案未定义 pre-push 挂载，`packages/shared/test/wire*.test.ts` 目前「存在但没人强制跑」。后果：§6.2/§6.3 的 L1 判据形同虚设。补法：`pnpm verify:wire`（golden 校验模式 + 1e4 fuzz）挂 pre-push。
2. **P1-2 未补** → 覆盖度不可证实：无分布摘要与 reasonCode 命中矩阵，§6.3 的「1e5 零差异」无法排除同质帧虚胖与错误路径零覆盖。补法：§11.2 机制 1+2。
3. **P2-1 未补** → §6.6 无跨阶段可比对数据（PR 描述不可检索）。
4. **P2-2 未补** → golden 缺业界回归锚点（成本≈0，但缺了就少一道实现级错位防线）。
5. 开放问题处置（lead 点名的三项）：6-triple 构建（zigbuild vs runner 矩阵）**不阻塞验收设计**——§6.7 判据与构建方式解耦，产物清单+校验退出码即可判定；musl 不做（方案已声明，验收不设该项）；CI 宿主未定 → 以 P1-1 的 pre-push 作为过渡阻塞点，CI 宿主确定后 B14 条件项生效，两者不重复设卡。

**结论**：验收设计已完备（§11.1–§11.3）；阻塞项中 L1 级判定 7 条、L2 级 5 条、L3 级仅 §0 接口边界评审 1 条，机器判定占比 >85%。当前唯一系统性风险是 P1-1/P1-2 缺口使差分测试的 L1 判据没有执行载体——补齐前阶段 1 不得判定验收通过。
