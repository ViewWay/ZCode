# Spec：阶段 1 —— V4 wire 编解码层 Rust 化实施方案

> 状态：方案 v3（bob 复核 7/9 通过后的补齐版）。本任务只产出方案，不含业务代码改动。
> v3 变更：P1 补 reasonCode 命中矩阵（§4.2 定向注入模式，7 个字节面结果各 ≥50）；P2 修订 §9 canary 行为「lead 已会签」、§10 明确 §0 分界与研究报告 §4 原文表述的对应关系。
> v2 变更：补 P1×2（verify:wire 强制防线、对拍分布量化）、P2×2（基线 JSON 入库、CRC 业界校验值）、P3×3（回滚演练、Rust 400 行上限、豁免台账含 canary 裁决）、收尾报告口径收敛说明（§10）。
> 上游依据：`specs/rust-migration-research.md` §4 阶段 1（已通过 bob 五项验证，用户已批准启动）。
> 所有函数签名、reason code、调用点均从当前检出的 `packages/shared/src/zcode-protocol-v4/wire*.ts`（合计 1,285 行）与消费方逐一实测提取。

## 0. 目标与范围

把 V4 physical wire 的**字节面**热点（crc32、base64 编解码、分片拼装、严格 UTF-8 解码）用 Rust 实现为 napi 模块，TS 实现原样保留并通过差分测试保证两实现逐字节一致；Node 侧调用点可按后端开关切换，browser 侧不受影响。

**明确分界（本方案的最重要的设计决策）**：

- **Rust 只做字节面；JSON 面全部留在 TS。** 即 `JSON.stringify` / `JSON.parse`、zod schema 校验、`measurePhysicalFrameBytes` 回调、`measureTopicNotificationEnvelopeBytes`（含 `vqlByteLength`）、`TopicWireFrameAssembler` 的状态机（Map staging、ordinal tombstone、超时清理）**都不迁**。
- 理由：JS `JSON.stringify` 与 serde_json 在键序（插入序 vs 结构体序）、数字格式化（`1e+21`、`-0`、`Number.MAX_SAFE_INTEGER`）、字符串转义上语义不同，一旦 JSON 进 Rust 就要把"序列化逐字节一致"也纳入差分范围，风险与工作量数量级上升；而字节面（crc32/base64/拼接/UTF-8）才是吞吐热点且语义可精确对齐。
- 由此，`reassembleTopicWireFrames` 中 **`WIRE_FAULT_INVALID_PAYLOAD`（schema 拒收）路径天然留在 TS**，Rust 只负责到"产出 logical bytes + crc 校验通过"为止。

## 1. 现状事实（实测，方案的输入）

### 1.1 待迁函数与精确语义（TS 侧为事实源）

| TS 函数（文件） | 语义要点（Rust 必须逐字节复刻） |
| --- | --- |
| `crc32WireBytes(bytes): string`（wire-binary.ts:10） | IEEE CRC-32（反射多项式 `0xEDB88320`，初值 `0xffffffff`，终值异或 `0xffffffff`），输出 **小写 hex、8 位左补零**。与 `crc32fast` crate 结果一致，仅输出格式需手工格式化 |
| `encodeWireBytesBase64(bytes): string`（wire-binary.ts:23） | 标准 RFC 4648 字母表 + `=` 补齐；TS 内部 16,384 块批量拼接对输出无影响。Rust `base64` crate STANDARD 模式输出一致；**空输入 → 空串** |
| `decodeWireBase64(value): Uint8Array \| null`（wire-binary.ts:46） | **宽松解码器，不能用 base64 crate 的严格模式**：先过正则 `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==\|[A-Za-z0-9+/]{3}=)?$`（min 4），随后按"padding 数决定输出长度"截断，**不校验尾部 bit 是否 canonical**（如 `"AB=="` 解出 `[0x00]`）。需在 Rust 手写同语义解码器 |
| `reassembleTopicWireFrames` 的字节阶段（wire-reassembly.ts:86-207） | 元数据一致性检查（留在 TS）之后：base64 逐片解码（失败→`proto.frameAssemblyInvalidBase64`）、重复片冲突检测（`proto.frameAssemblyFragmentConflict`）、**每接纳一片即累计字节**的上限检查（`proto.frameAssemblyTooLarge` / `proto.frameAssemblyLengthMismatch`）、缺片报告 `incomplete.missingIndexes`、按 index 顺序拼接、crc32 校验（`proto.frameAssemblyChecksumMismatch`）、**`TextDecoder("utf-8",{fatal:true})` 严格解码**（`proto.frameAssemblyInvalidUtf8`） |
| 限制常量（core.ts `PROTOCOL_V4_LIMITS`） | `maxFrameBytes=1MiB`、`logicalFrameAssemblyMaxBytes=16MiB`、`logicalFrameAssemblyMaxFragments=1024`。Rust 侧作为参数传入，不硬编码，避免双源 |

### 1.2 已识别的三个确定性边角（必须进 golden 向量）

1. **BOM 剥离**：`new TextDecoder("utf-8", { fatal: true }).decode()` 默认 `ignoreBOM: false`，会**剥掉开头 `EF BB BF`**；Rust `String::from_utf8` 保留 BOM。若 logical bytes 带 BOM：TS 侧 JSON.parse 成功，Rust 不处理则失败——**Rust 必须复刻"剥前导 BOM"**（并把剥除后的字节作为逻辑输出，因为 TS 的 `JSON.parse(decoded)` 消费的是剥过 BOM 的串）。
2. **非 canonical base64**：`"AB=="` 等尾部 bit 非零的输入，TS 解码产出确定字节而非报错；宽松解码器必须逐位复刻。
3. **重复片冲突**：同 `fragmentIndex` 二次出现时逐字节比较（长度不等或任一字节不等 → `proto.frameAssemblyFragmentConflict`）；相同则静默去重。

### 1.3 调用点与运行时矩阵（决定接入面）

| 调用点 | 运行时 | 阶段 1 后端 |
| --- | --- | --- |
| `packages/ui/src/v4/topicWireDecoder.ts`（`TopicWireFrameAssembler`） | **browser / WebView** | **只能 TS**（napi 不可用） |
| `packages/desktop/src/host/windowHostSessionsIndexObserver.ts` | desktop host（Electron utilityProcess，Node） | rust（默认） |
| `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts`（2 个 assembler） | Node（desktop host / server 复用） | rust（默认） |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`（`encodeTopicWireFrames`，line 515） | Node，但 CLI 以 **SEA** 发布 | **固定 ts**（SEA 无法 dlopen .node） |
| `packages/server` | Node | 经 services 间接获得 rust |

其他事实：`@zcode/shared` **无构建步骤**（exports 直指 `src/*.ts`，只有 lint 脚本）；desktop 用 tsup 打包 + `desktopNodeRuntimeExternals` + `electron-builder` 的 `desktop-native-package-policy`（对额外平台 native 会抛错，line 440）与 `asarUnpack` 清单；仓库已有 `@lydell/node-pty-darwin-arm64` 等**分平台 optionalDependencies** 先例；`packages/desktop/native/` 是 Swift/C# 小助手目录（无 cargo，不混用）；测试约定为 `node:test` 的 `*.test.ts`；仓库内未提交 CI 配置（无 `.github`），CI job 落地时以实际流水线为准补齐；`pnpm-workspace.yaml` 平台矩阵 = darwin/linux/win32 × x64/arm64（glibc）。

## 2. Crate 结构

### 2.1 选址：仓库根新建 `rust/` workspace（推荐），不进 `apps/zcode-cli`，不进 `packages/shared/native`

```text
rust/
  Cargo.toml                  # [workspace] members = ["crates/*"]，统一 edition/rust-version/lints；
                              # 文件上限沿用根 AGENTS.md：所有 .rs ≤400 行（verify:wire 自检强制）
  rust-toolchain.toml         # mise 同步钉版（与 mise.toml 增加 [tools] rust 条目一致）
  crates/
    zcode-wire/               # 纯 Rust 核心：不依赖 napi，可独立 cargo test
      src/
        lib.rs                # re-export + 模块文档（写明"字节面 only"边界）
        crc32.rs              # ← wire-binary.ts crc32WireBytes
        base64.rs             # ← wire-binary.ts encodeWireBytesBase64 / decodeWireBase64（宽松解码器）
        assemble.rs           # ← wire-reassembly.ts 字节阶段（见 §3.2 签名）
        utf8.rs               # ← TextDecoder fatal + 前导 BOM 剥离
      tests/
        golden/*.json         # 提交进 git 的 golden 向量（§4.1）
        golden.rs             # cargo test 读 golden 目录逐条断言
        fuzz_invariants.rs    # 种子化 PRNG 的内部不变量（round-trip、上限、冲突）测试
    zcode-wire-napi/          # napi 绑定薄层：只做类型转换与错误映射，零逻辑
      src/lib.rs
```

**取舍说明**：

- **不放 `apps/zcode-cli`**：协议事实源是 `packages/shared`（root workspace 的治理对象），消费者横跨 desktop/server/cli；zcode-cli 有独立的 pnpm workspace、turbo 与 SEA 发布节拍，放进去会把协议 crate 的构建绑定到 CLI 管线，且 desktop/server 依赖 CLI 目录方向错误。
- **不放 `packages/shared/native`**：`architecture-policy.yaml` 对 `shared` 的 `roots` 指向 `src/`；把 cargo 工具链与 target/ 混进 TS 包目录会让 policy、清理脚本、knip 扫描全部变复杂。新顶层目录只需 policy 增加一个模块条目（见 §7 前置项）。
- `packages/desktop/native/` 维持现状（Swift/C# 单文件助手，无 cargo），不收编。
- **npm 侧包装包**：`packages/shared-wire-native`（root workspace 新包，仅 JS 加载器，无 src 业务逻辑）：

```text
packages/shared-wire-native/
  package.json        # name: @zcode/shared-wire-native
  src/index.ts        # loadNativeWire(): WireNativeApi | null（lazy、fail-closed）
  src/backend.ts      # resolveWireCodecBackend()（§5）
  optionalDependencies:
    @zcode/shared-wire-native-darwin-arm64 / -darwin-x64
    @zcode/shared-wire-native-linux-arm64-gnu / -linux-x64-gnu
    @zcode/shared-wire-native-win32-arm64-msvc / -win32-x64-msvc
```

与仓库既有 `@lydell/node-pty-*` 同构：每个 triple 一个 optionalDependencies 子包，装不上不算失败。平台矩阵与 `pnpm-workspace.yaml` `supportedArchitectures`（darwin/linux/win32 × x64/arm64，glibc）完全一致。

### 2.2 模块映射总表

| TS（现状，保留为事实源） | Rust（新增） | napi 暴露 |
| --- | --- | --- |
| `crc32WireBytes` | `zcode-wire::crc32` | 是 |
| `encodeWireBytesBase64` | `zcode-wire::base64::encode` | 是 |
| `decodeWireBase64` | `zcode-wire::base64::decode_lenient` | 是 |
| `reassembleTopicWireFrames` 字节阶段 | `zcode-wire::assemble` | 是（§3.2） |
| `reassembleTopicWireFrames` 元数据阶段 + schema | 留 TS | 否 |
| `encodeTopicWireFrames`（含二分预算 + measure 回调） | 留 TS（仅其内部 base64/crc32 走 native） | 否 |
| `measureTopicNotificationEnvelopeBytes` / `utf8JsonByteLength` / `vqlByteLength` | 留 TS | 否 |
| `TopicWireFrameAssembler` 状态机 | 留 TS | 否 |
| `wire-fault.ts` 常量 | Rust 侧镜像字符串常量 + golden 断言对齐 | 否 |

## 3. napi 绑定设计

### 3.1 原则

- **稳定 ABI**：napi-rs 产物与 Node/Electron 版本解耦，无需 `@electron/rebuild`，每个 triple 一个 `.node`。
- **不抛异常表达业务拒绝**：rejection reason code 是**数据**不是错误，napi 层返回 tagged 结果对象；仅非法入参（非字符串/Buffer）抛 `TypeError`。
- **无隐藏分配**：16MiB 上限内一次分配；`assemble` 返回 `Buffer` 与（可选）解码后字符串，避免二次拷贝（Rust 侧 `into` 语义直接移交 V8 buffer）。

### 3.2 暴露的函数签名（与 TS 逐一对应）

```ts
// @zcode/shared-wire-native 暴露的 WireNativeApi（TS 侧视图，Rust#[napi] 一一对应）
export interface WireNativeApi {
  /** ← crc32WireBytes：小写 hex 8 位；输入空 Buffer 返回 "00000000" */
  crc32Hex(bytes: Buffer): string;

  /** ← encodeWireBytesBase64：RFC 4648 标准 + padding；空输入返回 "" */
  base64Encode(bytes: Buffer): string;

  /** ← decodeWireBase64：宽松解码（接受非 canonical 尾 bit）；非法返回 null */
  base64DecodeLenient(value: string): Buffer | null;

  /**
   * ← reassembleTopicWireFrames 的字节阶段（元数据检查之后的全部工作）。
   * 入参为已通过 TS 元数据一致性检查的有序分片（index 升序去重可乱序）。
   * 成功返回 { ok: true, logical: Buffer, logicalText: string }，
   * 其中 logicalText 为"严格 UTF-8 + 剥前导 BOM"后的字符串（对应 TextDecoder fatal 产物）。
   * 失败返回 { ok: false, reasonCode }，reasonCode ∈
   *   proto.frameAssemblyInvalidBase64 | proto.frameAssemblyFragmentConflict
   * | proto.frameAssemblyTooLarge | proto.frameAssemblyLengthMismatch
   * | proto.frameAssemblyChecksumMismatch | proto.frameAssemblyInvalidUtf8
   * | proto.frameAssemblyIncomplete（附带 missingIndexes）
   */
  assembleFragments(
    fragments: Array<{ index: number; dataBase64: string }>,
    expectedLogicalBytes: number,
    checksumHex: string,
    maxAssemblyBytes: number,
  ): WireAssembleResult;
}

type WireAssembleResult =
  | { ok: true; logical: Buffer; logicalText: string }
  | { ok: false; reasonCode: string; missingIndexes?: number[] };
```

- `incomplete` 在 Rust 里同样建模为 `{ ok: false, reasonCode: "proto.frameAssemblyIncomplete", missingIndexes }`；TS 包装层把它转回现有 `ReassembleTopicWireFramesResult` 的 `{ kind: "incomplete", ... }` 形状，**对外 API（`reassembleTopicWireFrames`、`encodeTopicWireFrames`、`TopicWireFrameAssembler`）签名零变化**。
- `schema` 校验（含 `WIRE_FAULT_INVALID_PAYLOAD`）由 TS 包装层在拿到 `logicalText` 后继续执行，路径与现状完全一致。

### 3.3 TS 侧接入方式：工厂注入，不改动 shared 公共导出

- `packages/shared/src/zcode-protocol-v4` 新增**纯 TS** 的 codec 抽象（同文件内实现 TS 版本，作为默认实现）：

```ts
export interface WireCodec {
  crc32WireBytes(bytes: Uint8Array): string;
  encodeWireBytesBase64(bytes: Uint8Array): string;
  decodeWireBase64(value: string): Uint8Array | null;
  /** 供 reassembleTopicWireFrames 内部委托；undefined = 走内置 TS 路径 */
  readonly assembleNative?: WireNativeApi["assembleFragments"];
}
export function createWireCodec(overrides?: Partial<WireCodec>): WireCodec;
```

- 默认导出/`export *` 行为不变（纯 TS），**browser 侧（packages/ui）零改动**。
- Node 侧 4 个调用点中需要 rust 后端的（desktop host、services/zcodeTaskIndexSyncer）在构造 assembler/调用 reassemble 时通过依赖注入传入 `createWireCodec({ assembleNative: loadNativeWire()?.assembleFragments })`——对齐 AGENTS.md「通过依赖注入处理环境差异」；`v4-gateway.ts`（SEA）不注入，保持 TS。
- 不采用「shared 内部动态 import napi 包」方案：shared 会被 vite 打进 browser bundle，workspace 动态导入会增加 bundler 解析面；注入式让 napi 依赖只出现在 Node 侧包的 `package.json` 里，依赖方向干净（desktop/services → `@zcode/shared-wire-native` → 加载 `@zcode/shared-wire-native-<triple>`）。

### 3.4 构建与 CI 集成

1. **本地开发**：`mise.toml` 增加 `[tools] rust`；新增任务 `rust:build` / `rust:test` / `rust:clippy` / `rust:fmt`。`napi build --platform --release` 产出到对应 triple 子包目录。
2. **pnpm 管线**：triple 子包各自带预构建 `.node`（CI 产物上传后由发布流程填充；本地开发用 `rust:build` 生成，`.gitignore` 排除 `*.node` 与 `target/`）。`packages/shared-wire-native/src/index.ts` 按表尝试 `import` 对应 triple 包，全部失败返回 `null`（不抛错）。
3. **CI / 强制防线（P1-1）**：infra CI 落地前，**`pnpm verify:wire` 挂进 pre-push 是唯一强制防线**，不得降级为"建议运行"：
   - 根 `package.json` 增加：`"verify:wire": "node scripts/verify-wire.mjs"`；
   - `scripts/verify-wire.mjs` 依次执行并任一失败即非零退出：
     1. 环境自检：`cargo --version`（工具链经 mise `rust:build` 前置项保证；缺失时输出安装指引并失败，**不静默跳过**）；
     2. golden 全量：`cargo test -p zcode-wire`（含 §4.1 全部向量与不变量）；
     3. Rust 400 行上限自检（§9 台账：`find rust -name "*.rs" -not -path "*/target/*" | xargs wc -l` 断言 ≤400）；
     4. 常规档对拍：`WIRE_FUZZ_FRAMES=10000 node --import tsx --test packages/shared/test/wireFuzz.diff.test.ts`（runner 形态以仓库 node:test 现行约定为准，落地时对齐）；
   - `.husky/pre-push` 追加 `pnpm run verify:wire`（与既有 `verify:pre-push` 串联）；
   - infra CI 就绪后，同一 `verify:wire` 命令平移为 CI 必跑 job，pre-push 防线保留为本地前置。
4. **desktop 打包**：`packages/desktop/package.json` 增加 `@zcode/shared-wire-native`；tsup `desktopNodeRuntimeExternals` 增加该包（保持 external，不 bundle .node）；`electron-builder.config.js` 的 `desktop-native-package-policy` 登记允许的 6 个 triple 文件（否则现有"边界校验失败"守卫会抛错），并加入 `asarUnpack` 清单（与 node-pty 同策略）。
5. **SEA**：`build-sea.mjs` 管线不引入 napi 包（CLI 依赖树中不含 `@zcode/shared-wire-native`），bootstrap 侧通过 §5 flag 固定 `ts`。

## 4. 差分测试（验收核心）

### 4.1 Golden 向量：TS 生成、双向消费、进 git

- **生成器**：`packages/shared/test/wireGolden.generate.test.ts`（node:test，加 `--golden-update` 才写盘，常规运行只校验）调用 **TS 实现**（事实源）产出向量，写入 `rust/crates/zcode-wire/tests/golden/*.json`。生成即 PR 可见 diff，防止两实现静默漂移。
- **向量结构**：`{ case, fn, input, expected }`；覆盖清单（验收时逐项勾验）：
  - crc32：空、1B、跨 64B/64KB 边界、全 0xFF、全 0x00、16MiB 采样；**业界标准校验值（P2-4，已用当前 TS 实现实测核对）：`"123456789"` → `"cbf43926"`、`"The quick brown fox jumps over the lazy dog"` → `"414fa339"`**——作为向量集首位锚点，任何 crc32 实现改动先破这两条；
  - base64 encode/decode：长度 3n/3n+1/3n+2、空串、`"AB=="`（非 canonical）、尾部 bit 非零的 `{2,3}==` 形态、含 `+/` 的输入、非法字符/长度不整/缺失 padding → null；
  - assemble：单片 complete 语义外的 fragment 组合——收齐/缺片（missingIndexes 顺序）、重复片（相同→去重；不同→conflict）、字节累计超限（每片递进检查）、logicalBytes 不符、crc 篡改、非法 UTF-8（截断多字节）、**带 BOM 的合法 JSON**（断言 logicalText 已剥 BOM）、末片字节越界（decoded 超出 logicalBytes）；
  - reason code 全集：§3.2 列表 + TS 侧 `proto.frameAssemblyEmpty` / `proto.invalidLimit.maxAssemblyBytes` / `proto.frameAssemblyMetadataMismatch` / `proto.frameAssemblyTooLarge` / `proto.frameFragmentCountExceeded` / `WIRE_FAULT_INVALID_PAYLOAD`（后六者留 TS，向量用于锁定 Rust 不参与时的行为不变 + Rust 常量镜像一致）。
- **消费**：`rust` 侧 `tests/golden.rs`（serde_json 读入逐条断言）；Node 侧同一份 JSON 由 `packages/shared/test/wireGolden.native.test.ts` 断言 napi 产物与向量一致——**同一向量三处消费（TS 生成基线、cargo、napi），天然锁死三方一致**。

### 4.2 随机模糊对拍 ≥10^5 帧：跑在 Node 层（唯一能同时调两个实现的地方）

- `packages/shared/test/wireFuzz.diff.test.ts`：种子化 PRNG（`node:crypto` 派生，种子打印可复现）生成随机 logical bytes（含多字节 UTF-8、BOM、空段）→ 随机分片（乱序、重复、丢片、篡改、超限）→ **同一输入分别喂 TS 实现与 Rust napi 实现 → 深比较结果**（kind/reasonCode/bytes/hex 逐字节）。
- 规模：常规档（pre-push/CI）跑 `10^4`，验收档跑 `10^5`（本地/夜间），由 `WIRE_FUZZ_FRAMES` 控制；失败时打印种子与最小复现用例，并提示固化进 golden。

**分布量化（P1-2，验收档为基准，常规档按比例 ×0.1）**——生成器按下列配额分层抽样，脚本运行结束**打印实际分布表并断言下限**（写入 stdout 与 `packages/shared/test/out/wire-fuzz-distribution.json` 供 PR 附带核对）：

| 维度 | 取值与配额 | 说明 |
| --- | --- | --- |
| 帧长度 6 桶 | `0`B ≥1,000；`1–15`B ≥1,000；`16–255`B ≥1,000；`256B–64Ki` ≥1,000；`64Ki–1Mi` ≥1,000；`1Mi–16Mi` ≥1,000 | 桶内均匀抽样；大桶生成用 PRNG 填充不落盘全量保留，逐案处理完即释放 |
| 内容 6 类 | ① 纯 ASCII JSON ② 多字节 UTF-8（CJK） ③ 4 字节 UTF-8（emoji/补充平面，含**截断在码点中间**的形态） ④ 前导 BOM ⑤ 高熵随机字节（非法 UTF-8，专走 `invalidUtf8`） ⑥ 结构化边界（嵌套/转义/超长字符串） | 每类 ≥ 总帧数 5% |
| 分片数 | `1`、`2`、`1023`、`1024`（含其 ±1 邻域越界 `1025` 拒绝路径）显式用例各 ≥50；其余在 `3–64` 随机 | 1024 为 `logicalFrameAssemblyMaxFragments` 上界 |
| deliveryKind | `initial` / `online` **各 50%**（v2 清单口径） | schema 实际为三态；第三态 `recovery` 在字节面仅参与元数据等值比较，由 golden 向量显式覆盖（≥3 例），不进随机分布 |
| **reasonCode 命中矩阵（bob 复核 P1）** | 7 个字节面结果各命中 **≥50 次**（`10^4` / `10^5` 两档同一下限）：`proto.frameAssemblyInvalidBase64`、`proto.frameAssemblyFragmentConflict`、`proto.frameAssemblyTooLarge`、`proto.frameAssemblyLengthMismatch`、`proto.frameAssemblyChecksumMismatch`、`proto.frameAssemblyInvalidUtf8`、`incomplete`（missingIndexes 非空） | 命中矩阵并入分布摘要 JSON 并对下限断言；没有它，"零差异"只证明 happy path，不能作为**错误路径**的差分证据。TS 侧专属拒绝码（`frameAssemblyEmpty`/`invalidLimit.*`/`metadataMismatch`/`fragmentCountExceeded`/`invalidPayload`）不经 napi，由 golden 向量锁定，不入本矩阵 |

**错误码定向注入模式**：生成器按目标 reasonCode 反推扰动，保证命中是"构造出来的"而非撞运气——

- `InvalidBase64`：向某片 `dataBase64` 注入非法字符 / 长度不整 4 的倍数；
- `FragmentConflict`：同 `fragmentIndex` 二次出现且字节不同；
- `TooLarge`：分片累计解码字节超过 `maxAssemblyBytes`（含逐片递进触发）；
- `LengthMismatch`：`logicalBytes` 元数据与实际解码总量不符 / 末片解码越界；
- `ChecksumMismatch`：篡改 `checksumHex` 后收齐全部片；
- `InvalidUtf8`：内容类⑤（高熵非法 UTF-8）+ 收齐 + crc 正确（先篡改 bytes 再重算 crc，确保到达 UTF-8 关）；
- `incomplete`：随机丢弃 ≥1 片，断言双方 `missingIndexes` 逐元素相等。

注入帧与正常帧共用同一条对拍路径（TS 与 Rust 同输入、深比较 kind/reasonCode/bytes/hex），错误路径与 happy path 的差分证据同源。

- Rust 侧 `fuzz_invariants.rs` 用固定种子的内部 PRNG 跑 round-trip 与上限不变量（不依赖网络/外部 crate），保证 cargo test 自包含。
- TS 实现与 Rust 实现并存方式：§3.3 工厂注入使两实现**同进程共存**，对拍无需跨进程协议。

## 5. Feature flag 与回滚

- **flag 名**：`wireCodecBackend`，解析顺序（`packages/shared-wire-native/src/backend.ts`，进程内一次求值并缓存）：
  1. 内部覆写：环境变量 `ZCODE_WIRE_CODEC_BACKEND` ∈ `rust | ts | auto`（按 AGENTS.md 环境变量例外流程，在本 spec 定义用途/优先级/错误行为：非法值按 `auto` 并 warn 一次）；
  2. `auto`（默认）：Node 运行时 + `loadNativeWire()` 非 null → `rust`；否则 `ts`；
  3. SEA/CLI bootstrap：构造时显式传 `ts`（依赖树层面已隔离，此为双保险）；
  4. browser：仅存在 TS 路径，flag 不生效。
- **灰度**：首发版本 wrapper 默认值钉 `ts`（发布不含行为变化）→ 下一版本默认 `auto`；desktop 可经 `scripts/dev-desktop-env.mjs` 注入环境变量在 dev/test 环境先行。
- **一键回退（两个独立开关点，均可不发版生效其一）**：
  1. 运行时开关：`ZCODE_WIRE_CODEC_BACKEND=ts`（进程环境即可，desktop host/server 均继承）；
  2. 代码开关：`packages/shared-wire-native/src/backend.ts` 中默认常量 `DEFAULT_WIRE_CODEC_BACKEND` 一行改回 `ts`。
- **fail-closed 语义**：napi 加载失败或调用抛错时，**该进程**记录 warn（service logger，`debug` 级别含加载错误详情）并永久回落 TS——只影响性能，不影响正确性；**不新增兜底分支掩盖 bug**（对齐 AGENTS.md），warn 是唯一观测点。
- flag 求值结果注入 `createWireCodec`，测试可显式构造 `rust`/`ts` 两个实例对拍。

**回滚演练（P3-5，对应验收清单 F1/F4，三项全部完成并留痕才算验收通过）**：

1. **演练 A（F1，运行时 flag 切回）**：desktop dev 环境以 `ZCODE_WIRE_CODEC_BACKEND=ts` 启动 → 经 codec 探测点（`resolveWireCodecBackend` 结果日志）断言后端为 `ts` → 双链路 E2E 绿；随后去掉变量恢复 `auto`，断言回到 `rust`。
2. **演练 B（F4，加载失败 fail-closed）**：临时移走当前平台 triple 包的 `.node`（或置空 optionalDependencies）→ 启动 → 断言 warn 恰好一次、全流程回落 TS、双链路 E2E 绿；恢复文件后重启自动回 `rust`，不留任何手工状态。
3. **演练 C（发布通道回退）**：以 PR 形式把 `DEFAULT_WIRE_CODEC_BACKEND` 一行改回 `ts` → `pnpm verify:wire` + `pnpm verify:pre-push` 全绿即具备合入条件（演练不必真合入，留 PR 链接即可）。

三项演练的命令、日志摘录与结论记入阶段 1 收尾报告（§10）。

## 6. 验收标准

1. `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`（golden 全量 + 不变量）全绿；`pnpm typecheck`、`pnpm lint`、`pnpm verify:pre-push`、**`pnpm verify:wire`** 全绿（如实执行并报告）。
2. golden 向量覆盖 §4.1 清单全部条目（含两条 CRC 业界校验值锚点）；TS/cargo/napi 三方对同一向量结果一致。
3. 模糊对拍 `10^5` 帧零差异（种子可复现），pre-push 常规档 `10^4` 通过；**§4.2 分布表各项下限（含 reasonCode 命中矩阵 7 项各 ≥50）由脚本断言通过，实际分布与命中矩阵 JSON 随 PR 附带**。
4. `reassembleTopicWireFrames` / `encodeTopicWireFrames` / `TopicWireFrameAssembler` 公共签名零变化；packages/ui 零改动；v4-gateway 行为零变化（固定 ts）。
5. desktop host + server 在 `rust` 后端下：双链路（desktop-continuous / web-remote-replayable）E2E 全绿；人为注入 napi 加载失败后自动回 TS 且功能不降级。
6. 性能基线（P2-3）：**TS 基线必须在 Rust 接入前的独立提交采集**（同一基准脚本、同一机器）；结果以 JSON 入库（`rust/bench-results/wire-codec-baseline.json`，含 `{ date, commit, cpu, backend, cases[{ name, bytes, nsPerByte, notes }] }`），Rust 版结果同格式追加并同 PR 提交；"相对 TS 提升"以两份 JSON 对比得出，不写死进 spec。
7. 6 triples 产物在 CI 构建；desktop 打包后含且仅含当前平台 `.node`（native-policy 校验通过）。
8. 回滚演练 A/B/C 三项完成并留痕（§5）。
9. `rust/` 下所有 `.rs` 文件 ≤400 行（P3-6，`verify:wire` 自检强制）。
10. 阶段 1 收尾报告含 §10 口径收敛说明与豁免台账（§9）终版状态。

## 7. 风险与开放问题

| # | 风险/问题 | 处置 |
| --- | --- | --- |
| 1 | **Win/Linux 产物矩阵**：win32 需 MSVC（arm64 runner 可得性一般）；linux 需钉 glibc 基线版本 | 用 `cargo-zigbuild` 统一交叉编译或分平台 runner；glibc 目标按仓库支持基线声明；musl 是否支持列为开放问题（当前 supportedArchitectures 未含 musl，阶段 1 不做） |
| 2 | **宽松 base64 语义漂移**（非 canonical、`"AB=="`） | 手写解码器逐位复刻 + 专项 golden；禁止替换为严格 crate |
| 3 | **TextDecoder BOM 剥离**与 `String::from_utf8` 差异 | Rust 复刻前导 BOM 剥离；golden 含 BOM 用例 |
| 4 | **JSON 面误入 Rust**（范围蔓延） | §0 分界写入 crate lib.rs 文档与 code review checklist；任何涉及 `JSON.stringify/parse` 的 PR 一律退回 |
| 5 | **electron-builder native 边界守卫**误报（额外平台 .node 进包） | policy 登记先行（前置项），打包后跑 `doctor:macos-release` 与体积对比 |
| 6 | **architecture-policy 漂移**：新顶层目录与新包不在 modules 表 | 前置项：`rust/crates/zcode-wire`、`zcode-wire-napi`、`shared-wire-native` 增补 module 条目（managed 视治理就绪度先 `false`，随阶段 3 转正）；`global.forbidCycles/forbidDeepImports` 语义对 Rust 以 workspace 成员边界 + `cargo deny` 对应 |
| 7 | **reason code 双源**（Rust 字符串镜像） | golden 断言 TS 常量 == Rust 常量；新增 reason code 必须同步三处（TS、Rust、golden），写入 PR checklist |
| 8 | napi Buffer 生命周期/大内存拷贝 | `assembleFragments` 返回值一次性移交；基准测试含 16MiB 规模内存观测 |
| 9 | CI 未在仓库内（无 `.github`），矩阵 job 归属不明 | **已由 P1-1 收敛**：infra CI 落地前，pre-push 挂 `pnpm verify:wire`（golden 全量 + `10^4` 常规档对拍 + 环境自检 + 400 行自检）为唯一强制防线（§3.4.3）；infra 就绪后同一命令平移为 CI job，属开放问题只剩"宿主与 6-triple 产物发布方式" |

### 前置工作项（开工前完成，均不改行为）

1. `mise.toml` 增加 rust 工具链与任务；`rust-toolchain.toml` 钉版。
2. `architecture-policy.yaml` 增补三个模块条目；`.gitignore` 增加 `rust/target/`、`**/*.node`。
3. `packages/desktop` 的 tsup externals 与 electron-builder native-policy 登记字段。
4. 与 infra 确认 CI 宿主与 6-triple 构建方案（zigbuild vs runner 矩阵）。
5. **P2-3 顺序要求**：在 Rust 接入前的独立提交中，用基准脚本采集 TS 实现基线并入库 `rust/bench-results/wire-codec-baseline.json`（否则性能对比失去参照）。

## 8. 非目标

- 不迁移 JSON 面（stringify/parse/schema/measure/二分预算/assembler 状态机）。
- 不迁移 `wire-assembler.ts` 状态机、不新增任何协议语义；reason code 词表零扩充。
- 不改 browser 行为；SEA/CLI 不引入 napi。
- 不做 musl、不做 wasm（browser 侧如需加速，留待后续单独立项）。
- 不删除 TS 实现的任何一行（并存是长期事实，删除另行评估）。

## 9. 可选项与豁免台账（P3-7）

可选项一律"默认不承诺、豁免须留痕"：每项记录状态、裁决理由与重新评估时机；状态变更必须改本表并随 PR 说明。

| 可选项 | 状态 | 裁决与理由 | 重新评估时机 |
| --- | --- | --- | --- |
| 运行时 canary 对拍（真实流量下双实现并行比对） | **豁免（lead 已会签）** | 字节面为纯函数、`10^5` 帧差分 + golden 三方一致已锁定行为等价，且首发默认 `ts` 灰度，残余风险可接受 | **阶段 3 深水区（传输/进程/IO 边界 Rust 化）时重新评估**——彼时不再具备纯函数性质 |
| `10^6` 帧放大对拍 | 豁免 | 验收档 `10^5` 已满足分布配额；`10^6` 边际收益低且拖慢迭代 | 字节面 API 面扩大（新增函数或修改 base64/crc 语义）时升格为验收项 |
| 脚本环境自检独立化（脱离 verify:wire 单独运行） | 不豁免（已并入强制防线） | `verify:wire` 第一步即环境自检（§3.4.3），失败给出安装指引不静默跳过 | — |

## 10. 收尾报告要求（含口径收敛说明，bob v2 追加项）

阶段 1 收尾报告必须包含以下三项，缺一不验收：

1. **口径收敛说明**：本方案 §0 的「**Rust 只做字节面**」分界，即对研究报告（`specs/rust-migration-research.md` §4 阶段 1）原文「**wire-codec Rust 化**」的落地口径：研究报告说的是"把 wire-codec 层迁 Rust"，该层由字节面（crc32 / base64 宽松编解码 / 分片拼装 / 严格 UTF-8+BOM）与编排面（JSON 计量、二分预算、`measurePhysicalFrameBytes` 回调）组成——本方案迁移前者、保留后者，两者是同一承诺的收窄执行而非缩水。收敛依据：字节面是可确定性差分且有吞吐意义的部分；JSON 面进 Rust 会把"序列化逐字节一致"（键序/数字格式化/转义）拉进差分范围，风险与收益不成比例。收尾报告须附**三栏对照表**：研究报告承诺 → 本方案实际迁移清单 → 未迁部分及理由。
2. **演练与豁免留痕**：§5 三项回滚演练的命令、日志摘录、结论；§9 台账终版状态（含 canary 豁免的 lead 裁决引用）。
3. **数据齐套**：`wire-codec-baseline.json`（TS 前置基线 + Rust 结果）、`wire-fuzz-distribution.json`（验收档实际分布）、种子清单与失败-固化记录（如有）。
