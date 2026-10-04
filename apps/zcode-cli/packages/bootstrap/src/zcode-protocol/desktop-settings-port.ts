// ============================================================
// Desktop Settings 协议端口 - agent 可调桌面设置的宿主转发实现
// ============================================================
// 与 offpeak-port / smart-routing-port 同族：core 的 get/set_desktop_setting
// 工具经 DesktopSettingsPort 读写桌面设置；本实现跑在协议 server（CLI 进程）内，
// 把请求反向转发给宿主（desktop main / web host）兑现：
// - scope=app：宿主经 settingService.update 写入（AppSettings 唯一路径）。
// - scope=appearance：宿主触达 renderer 既有主题 setter 链路（不建第二写入路径）。
// 双重白名单：本端口先用 contracts 的按 key value Schema 校验（防绕过工具入参层
// 的直调），协议边界与宿主侧再用 @zcode/shared 的白名单枚举校验；敏感 key
// （httpProxy* 等）两层都过不去。宿主不可达/超时按 JSON-RPC error 上浮，
// 由 handler 翻译为可读 CoreError，不静默降级。

import type {
  DesktopSettingKey,
  DesktopSettingSnapshot,
  DesktopSettingsPort,
  DesktopSettingValue,
} from "@zcode/contracts";
import { DESKTOP_SETTING_VALUE_SCHEMAS } from "@zcode/contracts";
import {
  zcodeDesktopSettingsSetResultSchema,
  zcodeDesktopSettingsSnapshotResultSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** 宿主反向请求超时；须小于工具超时（DESKTOP_SETTING_TIMEOUT_MS=15s）留出翻译余量。 */
const DESKTOP_SETTINGS_REQUEST_TIMEOUT_MS = 10_000;

const SET_VALUE_REJECTED_MESSAGE =
  "Value does not match the whitelist schema for this desktop setting key. " +
  "Use get_desktop_setting allowed keys with their documented values only.";

export function createProtocolDesktopSettingsPort(
  context: ZCodeProtocolAgentServerContext,
): DesktopSettingsPort {
  return {
    async get(key: DesktopSettingKey): Promise<DesktopSettingSnapshot> {
      const result = await context.requestClient(
        zcodeProtocolMethods.desktopSettingsGet,
        { key },
        zcodeDesktopSettingsSnapshotResultSchema,
        { timeoutMs: DESKTOP_SETTINGS_REQUEST_TIMEOUT_MS },
      );
      if (result.key !== key) {
        // 宿主回包 key 与请求不一致属接线故障：不能把别的设置值当作请求项返回。
        throw new Error(
          `DesktopSettings host returned ${result.key} while desktopSettings/get requested ${key}`,
        );
      }
      return { key: result.key, value: result.value as DesktopSettingValue, scope: result.scope };
    },

    async set(key: DesktopSettingKey, value: DesktopSettingValue): Promise<DesktopSettingSnapshot> {
      // 契约尺：按 key 的 value Schema 在转发前再校验一次（handler 入参层之外的第二层）。
      const valueCheck = DESKTOP_SETTING_VALUE_SCHEMAS[key].safeParse(value);
      if (!valueCheck.success) {
        throw new Error(SET_VALUE_REJECTED_MESSAGE);
      }
      const result = await context.requestClient(
        zcodeProtocolMethods.desktopSettingsSet,
        { key, value: valueCheck.data },
        zcodeDesktopSettingsSetResultSchema,
        { timeoutMs: DESKTOP_SETTINGS_REQUEST_TIMEOUT_MS },
      );
      if (result.key !== key || result.applied !== true) {
        throw new Error(
          `DesktopSettings host returned ${result.key} while desktopSettings/set requested ${key}`,
        );
      }
      return { key: result.key, value: result.value as DesktopSettingValue, scope: result.scope };
    },
  };
}
