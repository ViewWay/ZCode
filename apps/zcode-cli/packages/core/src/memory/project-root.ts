// 项目记忆目录定位的唯一实现已迁至 @zcode/shared/node/auto-distill/projectMemoryRoot.ts
// （自动沉淀"确认"需要 Desktop host 进程用同一公式定位项目记忆目录，packages
// 不能依赖 apps，故下沉到 shared）。core 内部与 index 出口经此文件保持原导入路径不变。
export { resolveProjectMemoryRoot } from "@zcode/shared/node";
