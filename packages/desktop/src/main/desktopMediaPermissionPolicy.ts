// defaultSession 媒体权限收口（specs/voice-pipeline.md「麦克风权限」节）。
//
// 背景：main 此前未注册 setPermissionRequestHandler，Electron 对所有权限请求
// 默认放行——任何 renderer 发起的摄像头/麦克风请求都会被自动批准。语音输入
// 只需要麦克风，因此把 media 权限收窄为「纯音频放行、含视频拒绝」，其余权限
// 类别维持 Electron 默认放行，不改变既有行为（通知、剪贴板、全屏等）。
//
// 边界：只作用于 defaultSession；内置浏览器 partition（persist:zcode-embedded-browser）
// 由 desktopNetworkPolicy 独立管理，不受本策略影响。系统级麦克风授权仍由
// macOS TCC / Windows 隐私设置裁决，这里的 handler 只做方向（音频-only）收口。
import type { Session } from "electron";

export type DesktopPermissionDecision = "allow" | "deny" | "default";

interface DesktopMediaPermissionPolicyLogger {
  info: (...args: unknown[]) => void;
}

/** Electron details 是多权限类别联合类型；mediaTypes 仅 media 请求携带，按需窄化读取。 */
function readMediaTypes(details: unknown): readonly string[] | undefined {
  if (typeof details === "object" && details !== null && "mediaTypes" in details) {
    const mediaTypes = (details as { mediaTypes?: unknown }).mediaTypes;
    return Array.isArray(mediaTypes) ? mediaTypes.filter((item): item is string => typeof item === "string") : undefined;
  }
  return undefined;
}

/**
 * 纯决策函数：返回 "default" 表示非 media 权限，调用方应沿用 Electron 默认放行。
 * media 请求仅在可确认「只请求音频」时放行；mediaTypes 缺失按 fail-closed 拒绝
 * （Chromium getUserMedia({audio:true}) 恒携带 ["audio"]，缺失即非常规来源）。
 */
export function resolveDesktopMediaPermissionDecision(
  permission: string,
  mediaTypes: readonly string[] | undefined,
): DesktopPermissionDecision {
  if (permission !== "media") return "default";
  if (!mediaTypes || mediaTypes.length === 0) return "deny";
  const audioOnly = mediaTypes.every((mediaType) => mediaType === "audio");
  return audioOnly ? "allow" : "deny";
}

/**
 * 在目标 Session 上安装媒体权限策略。重复调用以最后一次注册为准
 * （Electron setPermissionRequestHandler 本身就是覆盖语义）。
 */
export function installDesktopMediaPermissionPolicy(
  targetSession: Pick<Session, "setPermissionRequestHandler">,
  logger: DesktopMediaPermissionPolicyLogger,
): void {
  targetSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const mediaTypes = readMediaTypes(details);
    const decision = resolveDesktopMediaPermissionDecision(permission, mediaTypes);
    if (decision === "default") {
      // 非 media 权限保持默认放行，避免本策略改变通知/剪贴板等既有行为。
      callback(true);
      return;
    }
    if (decision === "deny") {
      // 只记被拒绝的非常规请求；放行路径是语音输入主链路，不刷日志。
      logger.info(
        `[desktop-media-permission] denied media request (permission=${permission}, mediaTypes=${mediaTypes?.join(",") ?? "unknown"})`,
      );
    }
    callback(decision === "allow");
  });
}
